// @jansee/speech-cut —— 口播精剪模块（对外 API：startSpeechAnalyze / startSpeechProduce 两段式）
//
// 功能链路（市场对齐：剪映「智能剪口播」同款流程）：
//   上传视频（保留原声）→ 本地 whisper ASR 词级时间戳 → 冗余规则标记（语气词/重复/短语）
//   + 长停顿标记（≥0.8s，剪映同款口径）→ 用户逐条确认 → 音画同步剪切 + 字幕重映射烧录
//   + BGM 人声闪避 → final.mp4
//
// 安全与权威性约定（定版约束）：
//   1) 剪辑区间只由「服务端保存的 ASR 词级时间戳 + 用户确认的删除标识」决定，
//      不接受前端传入的任何时间范围；videoFile 由服务端在 analyze 时自持，produce 不再接受路径；
//   2) 计费口径与现有出片路由完全一致（2026-10-14 业务定版：统一每次 200 积分）：
//      produce 受理时由 index.mjs 注入 chargeMockCredits 闭包扣内存 mock 点数（每次 200，余额不足不拦截任务）；
//      每任务仅首次受理扣一次（creditsCharged 防重），failed 携删除集重试与 409 重复提交均不重复扣费。
//   3) 任务态复用网关 inMemoryTasks（与视频配音/图片链路同源），轮询走既有 GET /api/v1/video/task/:taskId。
//
// 消费方式：
//   import { startSpeechAnalyze, startSpeechProduce } from '@jansee/speech-cut';
//   （编排层原 apps/web/server/speechcut.mjs，2026-10-24 模块化上移；ASR 能力经
//    @jansee/video-creator/video/keepOriginal.js 公开入口消费，与 image-film 消费引擎同范式）
//
// 分镜直出能力（2026-10-24，第二消费方=分镜成片「原片直出」）：
//   import { detectRedundancy, planSegmentCut, shiftWordsToKeptTimeline, cutSegmentByRanges } from '@jansee/speech-cut';
//   编排层（apps/web/server/storyboard.mjs）逐段调用：识别检测 → 区间规划 → 单段剪除 → 下游叠化拼接。
import fs from 'node:fs';
import path from 'node:path';
import { runKeepOriginalAsr } from '@jansee/video-creator/video/keepOriginal.js';
import { detectRedundancy } from './detect.js';
import { composeSpeechcut, planSegmentCut, shiftWordsToKeptTimeline, cutSegmentByRanges } from './compose.js';
import { appendEndingTail } from '@jansee/ending-kit';
import { renderIntroPng, composePureCover } from '@jansee/intro-kit';
import { hasAudioStream, probeDurationSec, probeVideoSize } from '@jansee/ffmpeg-kit/probe.mjs';

// —— 分镜直出能力再导出（纯能力层，编排逻辑在 BFF）——
export { detectRedundancy, planSegmentCut, shiftWordsToKeptTimeline, cutSegmentByRanges };

// —— 可调参数 ——
const MAX_SPEECH_SEC = 180;          // 口播素材时长上限 3 分钟 (180秒)（黄金完播与 4核4G 极速交付约束，超出拒绝并提示）
const MIN_KEEP_SEC = 1.0;            // 保留内容下限（与 compose 层安全线一致）

/**
 * 阶段一：提交口播分析任务（上传完成后调用）
 * 同步完成安全校验并创建任务，异步执行本地 ASR + 冗余/长停顿标记，轮询同一任务端点。
 * @returns {{taskId}} 校验失败时抛出 {code,message}
 */
export function startSpeechAnalyze({ payload, inMemoryTasks, storageUploadsDir, storageOutputsDir }) {
  const videoPathRaw = typeof payload.videoPath === 'string' ? payload.videoPath.trim() : '';
  const durationHint = Number(payload.durationSec);

  // 路径安全：仅放行 storage/uploads 目录内的真实文件（与视频配音分支同一白名单规则）
  const resolved = path.resolve(videoPathRaw);
  const inUploads = resolved === storageUploadsDir || resolved.startsWith(storageUploadsDir + path.sep);
  if (!videoPathRaw || !inUploads) {
    throw Object.assign(new Error('视频素材路径无效或不在允许的上传目录内'), { code: 40001 });
  }
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    throw Object.assign(new Error('视频素材不存在或已被清理，请重新上传'), { code: 40002 });
  }
  if (!hasAudioStream(resolved)) {
    throw Object.assign(new Error('该视频没有音轨，口播处理需要原始人声，请上传含人声的视频'), { code: 40003 });
  }
  if (Number.isFinite(durationHint) && durationHint > MAX_SPEECH_SEC) {
    throw Object.assign(new Error(`口播素材暂支持 ${MAX_SPEECH_SEC / 60} 分钟以内，请先剪辑后再上传`), { code: 40004 });
  }

  const taskId = `spk_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  const taskRecord = {
    taskId,
    kind: 'speechcut',
    phase: 'analyze',
    status: 'processing',
    stage: 'analyzing',
    stageText: '第 1 步：正在识别口播台词与停顿节奏...',
    progress: 10,
    videoFile: resolved, // 服务端自持素材路径，produce 阶段不再接受前端传入
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  inMemoryTasks.set(taskId, taskRecord);

  const taskOutputDir = path.join(storageOutputsDir, taskId);
  // 异步流水线：真实时长终检 → 本地 ASR → 冗余规则 + 长停顿标记 → analyzed（等待用户确认）
  (async () => {
    try {
      const realDur = probeDurationSec(resolved);
      if (!Number.isFinite(realDur) || realDur <= 0) throw new Error('视频真实时长探测失败，文件可能已损坏，请重新上传');
      if (realDur > MAX_SPEECH_SEC) throw new Error(`口播素材暂支持 ${MAX_SPEECH_SEC / 60} 分钟以内，请先剪辑后再上传`);
      taskRecord.durationSec = realDur;
      taskRecord.progress = 25;
      taskRecord.updatedAt = Date.now();

      const asr = await runKeepOriginalAsr(resolved, taskOutputDir);
      const words = Array.isArray(asr.words) ? asr.words : [];
      if (!words.length) {
        throw new Error('未能识别出有效语音内容：请确认视频包含清晰人声，或尝试更换更安静的录制环境');
      }

      const suggestions = detectRedundancy(words);
      // 商业带货语速与节奏健康诊断：测算全片语速（字/分钟）
      const totalWordsCount = words.length;
      const wpm = realDur > 0 ? Math.round((totalWordsCount / realDur) * 60) : 0;
      let paceTag = '商业带货黄金节奏';
      let paceLevel = 'gold';
      if (wpm < 220) {
        paceTag = '语速偏缓 · 建议剪除停顿';
        paceLevel = 'slow';
      } else if (wpm > 300) {
        paceTag = '紧凑快节奏 · 信息密集';
        paceLevel = 'fast';
      }
      taskRecord.pace = {
        wpm,
        paceTag,
        paceLevel,
        wordsCount: totalWordsCount
      };

      taskRecord.status = 'analyzed';
      taskRecord.stage = 'awaiting_confirm';
      taskRecord.stageText = '语音识别完成，请确认要删除的内容后点击生成';
      taskRecord.progress = 50;
      taskRecord.words = words;                 // 服务端权威词级时间戳（produce 唯一依据）
      taskRecord.suggestions = suggestions;     // 建议删除列表（词冗余 + 长停顿，默认勾选，用户可逐条取消）
      taskRecord.asrText = String(asr.text || '');
      taskRecord.updatedAt = Date.now();
      const pauseCount = suggestions.filter((s) => s.reason === 'pause').length;
      console.log(`[JANSEE GATEWAY] 口播分析完成 ${taskId}: ${words.length} 词 (${wpm}字/分 · ${paceTag}) / 建议 ${suggestions.length} 项（含长停顿 ${pauseCount} 处）/ ${realDur.toFixed(1)}s`);
    } catch (err) {
      taskRecord.status = 'failed';
      taskRecord.error = err.message || '口播分析异常';
      taskRecord.updatedAt = Date.now();
      console.error(`[JANSEE GATEWAY] 口播分析失败 ${taskId}: ${err.message}`);
    }
  })();

  return { taskId };
}

/**
 * 阶段二：按用户确认结果生成口播成片
 * 同步完成状态机校验并锁定任务（防重复提交），异步执行剪切合成。
 * @param {Array<number>} deletedStarts 用户确认删除的标识列表（词 start 或长停顿间隙 start；
 *                                      区间由服务端词表/建议表决定，前端只传标识）
 * @param {Function} chargeMockCredits 计费闭包（index.mjs 注入，与现有出片路由同口径扣 200 mock 积分）
 */
export function startSpeechProduce({ taskId, deletedStarts, wordEdits, introTitle, inMemoryTasks, storageOutputsDir, chargeMockCredits, generatePublish, scene = 'local', userId = '' }) {
  const id = String(taskId || '').trim();
  const task = inMemoryTasks.get(id);
  if (!task || task.kind !== 'speechcut') {
    throw Object.assign(new Error('口播任务不存在或已过期，请重新上传分析'), { code: 40401 });
  }
  if (task.status === 'producing' || task.status === 'completed') {
    throw Object.assign(new Error('该任务已在生成中或已完成，请勿重复提交；如需重新处理请重新分析'), { code: 40901 });
  }
  // 状态机：仅 analyzed 可生成；failed 但词表完好时允许携新删除集重试（合成失败无需重复 ASR）
  // producing/completed 拒绝（重复提交拦截）；processing/analyze 失败（words 为空）一律要求重新分析
  if ((task.status !== 'analyzed' && task.status !== 'failed') || !Array.isArray(task.words) || !task.words.length) {
    throw Object.assign(new Error('任务尚未完成语音识别，请稍候或重新分析'), { code: 40902 });
  }

  // 支持用户纠正错别字（方言/口音修正）：更新词表显示文本，原物理时间戳保持不变
  if (wordEdits && typeof wordEdits === 'object') {
    task.words = task.words.map((w) => {
      const s = Number(w.start);
      if (wordEdits[s] !== undefined && typeof wordEdits[s] === 'string' && wordEdits[s].trim()) {
        return { ...w, word: wordEdits[s].trim() };
      }
      return w;
    });
  }

  // 服务端权威剪辑依据：words 全量来自 analyze 存档；前端只提供「删除标识」集合。
  // 标识分两类：词 start（∈words 词表）与长停顿 start（∈suggestions 的 pause 项）；
  // 不在两类白名单中的伪造值被自然忽略；空数组 = 全部保留。
  const suggestions = Array.isArray(task.suggestions) ? task.suggestions : [];
  const pauseSuggests = suggestions.filter((s) => s.reason === 'pause');
  const delSet = (Array.isArray(deletedStarts) ? deletedStarts : [])
    .map((n) => Number(n))
    .filter(Number.isFinite);
  const knownWordDels = delSet.filter((s) => task.words.some((w) => Number(w.start) === s));
  const knownPauseCuts = pauseSuggests
    .filter((p) => delSet.includes(Number(p.start)))
    .map((p) => ({ start: Number(p.start), end: Number(p.end) }));
  if (task.words.length - knownWordDels.length === 0) {
    throw Object.assign(new Error('不能删除全部内容，请至少保留 1 秒以上的人声'), { code: 40005 });
  }

  // 计费：每次任务 200 积分，与现有出片路由同口径（闭包由 index.mjs 注入真实 creditStore 扣费，余额不足在闭包内抛 402 阻断受理）。
  // 每任务仅首次受理扣一次：failed 重试不重复扣；producing/completed 重复提交已在上方 409 拦截，不会走到这里。
  // userId 落任务记录：供轮询端点沉淀至 creationStore 后，失败/Zombie Reaper 自动退款按 userId 原路退回。
  if (!task.creditsCharged) {
    chargeMockCredits();
    task.creditsCharged = true;
    task.userId = userId || task.userId || '';
  }

  const taskOutputDir = path.join(storageOutputsDir, id);
  try { fs.mkdirSync(taskOutputDir, { recursive: true }); } catch (e) {}
  task.status = 'producing';
  task.stage = 'composing';
  task.stageText = '第 2 步：正在按确认结果剪切合成（音画同步，保留原声）...';
  task.progress = 60;
  task.updatedAt = Date.now();


  (async () => {
    try {
      // 0. 视频画幅尺寸自适应（低于 1080 按原画自适应，高于 1080 等比缩放至 1080）
      const realSize = probeVideoSize(task.videoFile) || { width: 1080, height: 1920 };
      let fitW = realSize.width;
      let fitH = realSize.height;
      const minEdge = Math.min(fitW, fitH);
      if (minEdge > 1080) {
        const scale = 1080 / minEdge;
        fitW = Math.round((fitW * scale) / 2) * 2;
        fitH = Math.round((fitH * scale) / 2) * 2;
      }

      // 开场片头标题（方案 B：来自用户输入；未输入则为空字符串纯装饰模式）
      const finalIntroTitle = typeof introTitle === 'string' ? introTitle.trim().slice(0, 16) : '';
      let introFile = null;
      try {
        const introPng = path.join(taskOutputDir, 'intro.png');
        renderIntroPng({
          title: finalIntroTitle,
          brandEn: 'JANSEE HOST',
          site: 'JANSEE HOST',
          note: '留一席留白 · 慢下来品味',
          idx: 'NO. 01 / CINEMATIC HOST',
          width: fitW,
          height: fitH,
          outPath: introPng,
        });
        introFile = introPng;
      } catch (introErr) {
        console.warn(`[JANSEE SPEECHCUT] 开场花字制作跳过: ${introErr?.message || introErr}`);
      }

      // 制作纯净宣发封面海报（1.0s 抽取无字幕无角标原画，画幅自适应对齐）：与视频合成并发异步推进
      const coverPromise = (async () => {
        try {
          const coverOut = path.join(taskOutputDir, 'cover.jpg');
          await composePureCover({
            bgSource: task.videoFile,
            title: finalIntroTitle,
            brandEn: 'JANSEE HOST',
            site: 'JANSEE HOST',
            note: '留一席留白 · 慢下来品味',
            idx: 'NO. 01 / CINEMATIC HOST',
            width: fitW,
            height: fitH,
            outPath: coverOut,
            captureSec: 1.0,
          });
          task.coverUrl = `/storage/outputs/${id}/cover.jpg`;
        } catch (coverErr) {
          console.warn(`[JANSEE SPEECHCUT] 宣发封面制作跳过: ${coverErr?.message || coverErr}`);
        }
      })();

      const r = await composeSpeechcut({
        videoFile: task.videoFile,
        taskDir: taskOutputDir,
        words: task.words,
        deletedStarts: new Set(knownWordDels),
        pauseCuts: knownPauseCuts,
        durationSec: task.durationSec,
        introFile,
        onProgress: (stage) => {
          task.stageText = stage === '正在导出视频' ? '第 2 步：正在导出视频（剪切拼接 + 字幕 + 背景乐）...' : stage;
          task.progress = stage === '正在导出视频' ? 80 : 70;
          task.updatedAt = Date.now();
        },
      });

      await coverPromise;

      // 结尾收束（全版块标配，2026-10-24）：追加 CTA 尾段（结尾淡出→黑停一拍→结尾卡淡入，
      // 追加 2.95s 不动原片）。appendEndingTail 内部恒不抛错，失败返回 null 保持原片交付。
      task.stageText = '第 2 步：正在追加片尾收束卡...';
      task.progress = 90;
      task.updatedAt = Date.now();
      const finalAbs = path.join(taskOutputDir, 'final.mp4');
      const tail = await appendEndingTail({
        workDir: taskOutputDir,
        videoFile: finalAbs,
        outPath: path.join(taskOutputDir, 'final_tail.mp4'),
        taskId: id,
        scene,
      });
      let durSec = r.durationSec;
      if (tail) {
        await fs.promises.rename(tail.output, finalAbs);
        durSec = tail.durationSec;
      }

      // 产物落任务（compose 内已做时长/音轨校验，异常直接抛出）
      task.status = 'completed';
      task.stage = 'done';
      task.progress = 100;
      task.videoUrl = `/storage/outputs/${id}/final.mp4`;
      task.duration = durSec;
      task.cutSec = r.cutSec;
      task.cuesCount = r.cuesCount;
      // 专业出镜精修档案报告（为主播量化每一次镜头表达与剪辑提效数据，0 Token、0 网络依赖）
      task.report = {
        kind: 'speech_report',
        rawDuration: Number(task.durationSec.toFixed(1)),
        cleanDuration: Number(durSec.toFixed(1)),
        cutDuration: Number(r.cutSec.toFixed(1)),
        efficiencyPct: task.durationSec > 0 ? Number(((r.cutSec / task.durationSec) * 100).toFixed(1)) : 0,
        wpm: task.pace?.wpm || (durSec > 0 ? Math.round((task.words.length / durSec) * 60) : 260),
        paceTag: task.pace?.paceTag || '商业带货黄金节奏',
        paceLevel: task.pace?.paceLevel || 'gold',
        wordsCount: task.words.length,
        cutCount: knownWordDels.length + knownPauseCuts.length,
        coverUrl: task.coverUrl || '',
        effects: [
          '环境稳态频谱降噪 (afftdn)',
          '动态人声广播级平准 (dynaudnorm)',
          '物理级 Sidechain 动态人声避让',
          '双机位景别交替推拉（消除跳切）',
          '国家 AIGC 隐式元数据注入 (GB 45438)'
        ]
      };
      task.publish = null; // 口播专版纯粹出片，由专业出镜精修档案替代生硬的营销四件套
      task.deliveredAt = Date.now();
      task.updatedAt = Date.now();
      // 运维健康治理：清理中间剪除切片，仅保留 final.mp4 与 cover.jpg
      try {
        const outFiles = fs.readdirSync(taskOutputDir);
        for (const f of outFiles) {
          if (f === 'final.mp4' || f === 'cover.jpg' || f.endsWith('.json')) continue;
          if (f.startsWith('seg_') || f === 'intro.png' || f.endsWith('.wav')) {
            try { fs.unlinkSync(path.join(taskOutputDir, f)); } catch (_) {}
          }
        }
      } catch (_) {}
      console.log(`[JANSEE GATEWAY] 口播成片完成 ${id}: ${task.videoUrl} (${durSec.toFixed(2)}s / 剪除 ${r.cutSec.toFixed(2)}s / ${task.report.wpm}字/分 · ${task.report.paceTag})`);
    } catch (err) {
      task.status = 'failed';
      task.error = err.message || '口播合成异常';
      task.updatedAt = Date.now();
      console.error(`[JANSEE GATEWAY] 口播合成失败 ${id}: ${err.message}`);
    }
  })();

  return { taskId: id };
}
