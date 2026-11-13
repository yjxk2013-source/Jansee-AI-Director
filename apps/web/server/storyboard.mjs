// 简兮分镜与切片模块 · BFF 业务编排与素材登记层（apps/web/server/storyboard.mjs）
//
// 遵循原则：
//   1. 素材登记制：前端只提交服务端登记的素材 ID（mat_...），禁止客户端传入绝对路径或任意相对路径；
//   2. 严格路径安全：规范化 + 真实路径解析 (realpathSync) + 仅白名单放行（storage/uploads 与切片产物目录）；
//      防符号链接、防目录穿越、禁止开放整 outputs 目录；
//   3. 切片第一版免费（不扣积分）；分镜成片每次 200 mock 积分（creditsCharged 防重）；
//   4. 并发门控：通过 acquireComposeSlot 排队，必须严格使用 try { ... } finally { release() }；
//   5. 状态机完备：queued/processing/producing -> completed/failed；409 重复提交拦截；
//   6. 服务端权威时长探测：单镜 2~60 秒，最多 9 镜，成片预检 <= 180s，终检 <= 181s；
//   7. 零付费测试友好：autoMode 自动判定（有台词->tts，全无台词->asr），asr 模式复用切片阶段已产出的词级结果，不重复跑 ASR。

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import ffmpegStatic from 'ffmpeg-static';
import { videoDurationSec, prepareSlicer } from '@jansee/video-creator/video/slicer.js';
import { composeStoryboard } from '@jansee/video-creator/video/storyboard.js';
import { runKeepOriginalAsr } from '@jansee/video-creator/video/keepOriginal.js';
import { detectRedundancy, planSegmentCut, shiftWordsToKeptTimeline, cutSegmentByRanges } from '@jansee/speech-cut';
import { selectBgmByEmotion } from '@jansee/audio-kit/bgm.js';
import { appendEndingTail } from '@jansee/ending-kit';
import { composePureCover, renderIntroPng } from '@jansee/intro-kit';
import { hasAudioStream } from '@jansee/ffmpeg-kit/probe.mjs';
import { acquireComposeSlot } from '@jansee/ffmpeg-kit/composeGate.mjs';

// —— 规则硬约束 ——
export const MAX_SHOTS = 9;             // 第一版分镜最多 9 镜
export const MIN_SHOT_SEC = 2.0;        // 单镜素材安全下限 2 秒（offset+XFADE=2.0 贴边安全）
export const MAX_SHOT_SEC = 60.0;       // 单镜素材上限 60 秒
export const TARGET_MAX_DURATION = 180; // 目标成片上限 180 秒（预检公式：Σ时长 - 0.7*(N-1) <= 180）
export const FINAL_MAX_DURATION = 181;  // 成片终检上限 181 秒（浮点与封装微量容差）
export const XFADE_DURATION = 0.7;      // 叠化转场固定时长

// —— 受控音色白名单（收敛定版 2026-10-24：抽象气质 key 为第一口径；Edge 语义名仅兼容旧客户端保留）——
export const ALLOWED_VOICES = new Set([
  // 抽象气质 key（LLM voice_id 输出口径，腾讯翻译在 tts-kit）
  'm-calm', 'm-deep', 'm-warm', 'm-sunny', 'f-warm', 'f-soft', 'f-passion', 'f-bright',
  // 旧 Edge 语义名（兼容既有客户端/历史任务，经 tts-kit 翻译为腾讯真实音色）
  'zh-CN-XiaoxiaoNeural',
  'zh-CN-YunyangNeural',
  'zh-CN-YunxiNeural',
  'zh-CN-YunjianNeural',
  'zh-CN-XiaoyiNeural',
]);

// 默认音色：f-warm 温柔女声（腾讯 101027）
export const DEFAULT_VOICE = 'f-warm';
/**
 * 运维健康治理：成片交付后自动 GC 清理临时切片与中间音频
 * 仅保留成片 final.mp4、宣发封面 cover.jpg 与发布元数据，杜绝磁盘打满
 */
function cleanupStoryboardIntermediates(dir) {
  try {
    if (!dir || !fs.existsSync(dir)) return;
    const files = fs.readdirSync(dir);
    for (const f of files) {
      if (f === 'final.mp4' || f === 'cover.jpg' || f === 'cover.png' || f.endsWith('.json')) continue;
      if (
        f.startsWith('sb_') ||
        f.startsWith('seg_') ||
        f === 'intro.png' ||
        f === 'final_tail.mp4' ||
        f.endsWith('.wav') ||
        f.endsWith('.mp3')
      ) {
        try {
          fs.unlinkSync(path.join(dir, f));
        } catch (_) {}
      }
    }
  } catch (_) {}
}


/**
 * 进程内素材登记表 (Material Registry)
 * key: materialId ('mat_' + 时间戳 + 随机串)
 * value: {
 *   id: string,
 *   type: 'upload_video' | 'slice_segment',
 *   filePath: string,      // 服务端规范化后的真实文件绝对路径
 *   durationSec: number,   // 服务端探测到的真实时长
 *   taskId?: string,       // 来源任务 ID（切片产物对应的 slicerTaskId，或上传标记）
 *   words?: Array,         // 切片阶段产出的 ASR 词级结果（若有）
 *   text?: string,         // 切片阶段识别文本（若有）
 *   createdAt: number
 * }
 */
export const materialRegistry = new Map();

/**
 * 注册素材到服务端素材表
 * @param {object} item
 * @returns {string} materialId
 */
export function registerMaterial(item, sessionId = '') {
  if (!item || !item.filePath || !fs.existsSync(item.filePath)) {
    throw Object.assign(new Error('注册素材失败：文件不存在或路径无效'), { code: 40001 });
  }
  const real = fs.realpathSync(item.filePath);
  const isImage = item.type === 'image' || /\.(jpe?g|png|webp)$/i.test(real);
  const dur = typeof item.durationSec === 'number' && item.durationSec > 0
    ? item.durationSec
    : (isImage ? 5.0 : videoDurationSec(real));
  if (!Number.isFinite(dur) || dur <= 0) {
    throw Object.assign(new Error('注册素材失败：无法探测有效媒体时长'), { code: 40002 });
  }

  const sid = String(sessionId || item.sessionId || '').trim();

  // 【生命周期加固：每个 Session 仅保留最新一组素材，上传新组时自动清理上一组孤儿素材】
  if (sid && !item.taskId) {
    for (const [oldId, oldRec] of materialRegistry.entries()) {
      if (oldRec.sessionId === sid && !oldRec.taskId && oldRec.filePath !== real) {
        try {
          if (fs.existsSync(oldRec.filePath)) {
            const oldDir = path.dirname(oldRec.filePath);
            fs.rmSync(oldRec.filePath, { force: true });
            // 若目录已空或为单独 upload 目录，一并清理
            if (oldDir.includes('upload_') && fs.existsSync(oldDir) && fs.readdirSync(oldDir).length === 0) {
              fs.rmSync(oldDir, { recursive: true, force: true });
            }
          }
        } catch (_) {}
        materialRegistry.delete(oldId);
      }
    }
  }

  const id = `mat_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
  materialRegistry.set(id, {
    id,
    type: item.type || (isImage ? 'image' : 'upload_video'),
    filePath: real,
    durationSec: dur,
    sessionId: sid,
    taskId: item.taskId || '',
    words: Array.isArray(item.words) ? item.words : [],
    text: typeof item.text === 'string' ? item.text : '',
    createdAt: Date.now(),
  });
  return id;
}

/**
 * 清理过期素材索引（杜绝素材注册表内存泄漏，2小时生命周期或文件已物理删除）
 * @param {number} [maxAgeMs=7200000] 默认 2 小时
 * @returns {number}
 */
export function cleanExpiredMaterials(maxAgeMs = 2 * 3600 * 1000) {
  const now = Date.now();
  let count = 0;
  for (const [id, rec] of materialRegistry.entries()) {
    const expired = rec.createdAt && now - rec.createdAt > maxAgeMs;
    const fileMissing = !fs.existsSync(rec.filePath);
    if (expired || fileMissing) {
      materialRegistry.delete(id);
      count += 1;
    }
  }
  return count;
}

/**
 * 安全查询已登记素材列表（增加租户 Session 隔离，杜绝跨商家素材泄露）
 * @param {string} [typeFilter] 可选类型过滤
 * @param {string} [sessionId] 请求者会话标识
 */
export function listRegisteredMaterials(typeFilter = '', sessionId = '') {
  const sid = String(sessionId || '').trim();
  const list = [];
  for (const [id, rec] of materialRegistry.entries()) {
    if (typeFilter && rec.type !== typeFilter) continue;
    // 租户隔离：若调用方传入了 sessionId，严格仅返回属于该 Session 的素材
    if (sid && rec.sessionId && rec.sessionId !== sid) continue;
    // 若未登录且无 session，禁止越权全局读取他人素材
    if (!sid && rec.sessionId) continue;
    if (!fs.existsSync(rec.filePath)) continue;
    list.push({
      materialId: id,
      type: rec.type,
      durationSec: rec.durationSec,
      taskId: rec.taskId,
      text: rec.text,
      createdAt: rec.createdAt,
    });
  }
  return list.sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * 根据 materialId 查询单个素材详情（支持租户归属校验）
 */
export function getRegisteredMaterial(materialId, sessionId = '') {
  const rec = materialRegistry.get(String(materialId || '').trim());
  if (!rec || !fs.existsSync(rec.filePath)) return null;
  const sid = String(sessionId || '').trim();
  if (sid && rec.sessionId && rec.sessionId !== sid) {
    return null; // 越权阻断：非本人 Session 的素材不可见
  }
  return {
    materialId: rec.id,
    type: rec.type,
    durationSec: rec.durationSec,
    taskId: rec.taskId,
    text: rec.text,
    createdAt: rec.createdAt,
  };
}

/**
 * 严格路径安全检查：
 * 1. 规范化路径并解析符号链接 (fs.realpathSync)；
 * 2. 检查是否在允许的根目录之内（支持 storageUploadsDir 或指定的 slices 子目录）；
 * 3. 拦截任何路径穿越 (..) 与非白名单目录。
 */
export function assertSafePath(targetPath, allowedDirs = []) {
  if (typeof targetPath !== 'string' || !targetPath.trim()) {
    throw Object.assign(new Error('路径参数无效'), { code: 40001 });
  }
  const normalized = path.resolve(targetPath.trim());
  if (!fs.existsSync(normalized)) {
    throw Object.assign(new Error('目标文件不存在'), { code: 40002 });
  }
  let real;
  try {
    real = fs.realpathSync(normalized);
  } catch (e) {
    throw Object.assign(new Error('文件真实路径解析失败'), { code: 40003 });
  }

  const isAllowed = allowedDirs.some((dir) => {
    if (!dir) return false;
    const realDir = fs.existsSync(dir) ? fs.realpathSync(dir) : path.resolve(dir);
    return real === realDir || real.startsWith(realDir + path.sep);
  });

  if (!isAllowed) {
    throw Object.assign(new Error('非法访问：文件不在允许的安全目录范围内'), { code: 40301 });
  }
  return real;
}

/**
 * =========================================================================
 * 1. 切片分析任务：startSlicerPrepare
 * 接收上传视频素材，切割为定长分段并执行本地 ASR，注册分段为素材并返回。
 * 第一版免费，不扣积分。
 * =========================================================================
 */
export function startSlicerPrepare({ payload, inMemoryTasks, storageUploadsDir, storageOutputsDir }) {
  if (!payload || typeof payload !== 'object') {
    throw Object.assign(new Error('请求体无效'), { code: 40001 });
  }

  const matId = typeof payload.materialId === 'string' ? payload.materialId.trim() : '';
  const videoPathRaw = typeof payload.videoPath === 'string' ? payload.videoPath.trim() : '';
  const segSec = Number(payload.segSec) || 20;
  const passthrough = !!payload.passthrough;

  let targetFilePath = '';

  // 1. materialId 优先：从服务端素材注册表解析
  if (matId) {
    const mat = materialRegistry.get(matId);
    if (!mat) {
      throw Object.assign(new Error(`素材不存在或已过期（ID: ${matId}）`), { code: 40013 });
    }
    if (mat.type !== 'upload_video' && mat.type !== 'slice_segment') {
      throw Object.assign(new Error('该素材不是有效的视频类型，无法执行切片分析'), { code: 40019 });
    }
    targetFilePath = mat.filePath;
  } else if (videoPathRaw) {
    // 兼容既有调用：仍须经过严格白名单与 realpath 校验，仅放行 storageUploadsDir 内真实文件
    targetFilePath = videoPathRaw;
  } else {
    throw Object.assign(new Error('请提供已登记的素材 ID (materialId)'), { code: 40001 });
  }

  // 路径安全双重保障：必须在 storageUploadsDir 或 storageOutputsDir 内
  const safeVideoFile = assertSafePath(targetFilePath, [storageUploadsDir, storageOutputsDir]);
  let dur = matId && materialRegistry.get(matId)?.durationSec ? materialRegistry.get(matId).durationSec : 0;
  if (!dur) {
    dur = videoDurationSec(safeVideoFile);
  }
  if (!Number.isFinite(dur) || dur <= 0) {
    throw Object.assign(new Error('无法探测视频真实时长，文件可能损坏'), { code: 40004 });
  }

  const taskId = `slc_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  const taskRecord = {
    taskId,
    kind: 'slicer',
    phase: 'prepare',
    status: 'processing',
    stage: 'cutting',
    stageText: '正在切割视频并识别语音...',
    progress: 5,
    videoFile: safeVideoFile,
    segSec,
    passthrough,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  inMemoryTasks.set(taskId, taskRecord);

  const taskOutputDir = path.join(storageOutputsDir, taskId);
  fs.mkdirSync(taskOutputDir, { recursive: true });

  (async () => {
    try {
      const res = await prepareSlicer({
        taskDir: taskOutputDir,
        videoFile: safeVideoFile,
        segSec,
        passthrough,
        onProgress: (p, stage) => {
          taskRecord.progress = p;
          taskRecord.stage = stage;
          taskRecord.stageText = stage;
          taskRecord.updatedAt = Date.now();
        },
      });

      // 自动将生成的切片注册到服务端素材库，供分镜引用
      const registeredSegments = (res.segments || []).map((seg) => {
        const generatedMatId = registerMaterial({
          type: 'slice_segment',
          filePath: seg.file,
          durationSec: seg.durationSec,
          taskId,
          words: seg.words || [],
          text: seg.text || '',
        });
        return {
          ...seg,
          materialId: generatedMatId, // 前端获知此素材 ID，后续以 ID 引用
        };
      });

      taskRecord.status = 'prepared';
      taskRecord.stage = 'awaiting_confirm';
      taskRecord.stageText = '切片与识别完成，请核对切片内容';
      taskRecord.progress = 50;
      taskRecord.segments = registeredSegments;
      taskRecord.count = res.count;
      taskRecord.updatedAt = Date.now();
    } catch (err) {
      taskRecord.status = 'failed';
      taskRecord.error = err.message || '切片分析异常';
      taskRecord.updatedAt = Date.now();
      console.error(`[JANSEE GATEWAY] 切片分析失败 ${taskId}: ${err.message}`);
    }
  })();

  return { taskId };
}

/**
 * =========================================================================
 * 2. 分镜成片任务：startStoryboardProduce
 * 接收分镜配置（素材 ID 清单、逐镜台词、音色、BGM），校验时长与配额并调度合成。
 * 扣除 200 mock 积分（防重复扣费），严格使用 acquireComposeSlot 和 finally 释放。
 * =========================================================================
 */
export function startStoryboardProduce({
  payload,
  inMemoryTasks,
  storageOutputsDir,
  storageUploadsDir,
  materialsDir,
  chargeMockCredits,
}) {
  if (!payload || typeof payload !== 'object') {
    throw Object.assign(new Error('请求体无效'), { code: 40001 });
  }

  const rawShots = Array.isArray(payload.shots) ? payload.shots : [];
  if (!rawShots.length) {
    throw Object.assign(new Error('请至少添加一个分镜素材'), { code: 40010 });
  }
  if (rawShots.length > MAX_SHOTS) {
    throw Object.assign(new Error(`分镜数量不能超过 ${MAX_SHOTS} 个`), { code: 40011 });
  }

  // 1. 素材校验与解析（必须来自 materialRegistry，且真实文件存在）
  let totalRawDuration = 0;
  const verifiedShots = [];
  const parsedSubtitles = [];
  let anyHasText = false;

  for (let i = 0; i < rawShots.length; i++) {
    const s = rawShots[i];
    const mediaType = s.mediaType === 'image' ? 'image' : 'video';
    const text = typeof s.text === 'string' ? s.text.trim() : '';
    if (text) anyHasText = true;

    if (mediaType === 'video') {
      const matId = String(s.materialId || '').trim();
      if (!matId) {
        throw Object.assign(new Error(`第 ${i + 1} 镜缺少素材 ID`), { code: 40012 });
      }
      const mat = materialRegistry.get(matId);
      if (!mat) {
        throw Object.assign(new Error(`第 ${i + 1} 镜素材不存在或已过期，请重新登记`), { code: 40013 });
      }

      // 安全路径确认：必须存在且在合法上传或 outputs 目录内
      const safeFile = assertSafePath(mat.filePath, [storageUploadsDir, storageOutputsDir]);
      let dur = typeof mat.durationSec === 'number' && mat.durationSec > 0 ? mat.durationSec : 0;
      if (!dur) {
        dur = videoDurationSec(safeFile);
      }
      if (!Number.isFinite(dur) || dur < MIN_SHOT_SEC) {
        throw Object.assign(new Error(`第 ${i + 1} 镜时长过短，单个分镜不能少于 ${MIN_SHOT_SEC} 秒`), { code: 40014 });
      }
      if (dur > MAX_SHOT_SEC) {
        throw Object.assign(new Error(`第 ${i + 1} 镜时长为 ${dur.toFixed(1)} 秒，超出单个分镜 ${MAX_SHOT_SEC} 秒限制`), { code: 40015 });
      }

      totalRawDuration += dur;
      verifiedShots.push({
        mediaType: 'video',
        file: safeFile,
        text,
        durationSec: dur,
      });

      // 提取 ASR 模式所需字幕信息（若切片/上传时已有 words 则复用，不再重复 ASR）
      parsedSubtitles.push({
        words: Array.isArray(mat.words) ? mat.words : [],
        deleted: Array.isArray(s.deleted) ? s.deleted : [],
        finalText: typeof s.finalText === 'string' ? s.finalText : (mat.text || text),
      });
    } else {
      // 图片分镜支持（若有）
      const imgMatIds = Array.isArray(s.imageMaterialIds) ? s.imageMaterialIds : [];
      if (!imgMatIds.length) {
        throw Object.assign(new Error(`第 ${i + 1} 镜缺少图片素材 ID`), { code: 40016 });
      }
      // 单镜图片时长硬性约束：每张 12 秒，单镜最多 5 张（60 秒），超出 60 秒硬拦截
      const maxImagesPerShot = Math.floor(MAX_SHOT_SEC / 12); // 5 张
      if (imgMatIds.length > maxImagesPerShot) {
        throw Object.assign(
          new Error(`第 ${i + 1} 镜包含 ${imgMatIds.length} 张图片（每张12秒），已超出单个分镜 ${MAX_SHOT_SEC} 秒上限`),
          { code: 40015 }
        );
      }
      const imgFiles = [];
      for (const imgId of imgMatIds) {
        const mat = materialRegistry.get(String(imgId).trim());
        if (!mat) throw Object.assign(new Error(`图片素材 ${imgId} 不存在`), { code: 40017 });
        const safeImg = assertSafePath(mat.filePath, [storageUploadsDir]);
        imgFiles.push(safeImg);
      }
      const imgDur = 12 * imgFiles.length;
      if (imgDur < MIN_SHOT_SEC) {
        throw Object.assign(new Error(`第 ${i + 1} 镜时长过短，单个分镜不能少于 ${MIN_SHOT_SEC} 秒`), { code: 40014 });
      }
      if (imgDur > MAX_SHOT_SEC) {
        throw Object.assign(new Error(`第 ${i + 1} 镜时长为 ${imgDur.toFixed(1)} 秒，超出单个分镜 ${MAX_SHOT_SEC} 秒限制`), { code: 40015 });
      }
      totalRawDuration += imgDur;
      verifiedShots.push({
        mediaType: 'image',
        imageFiles: imgFiles,
        text,
        durationSec: imgDur,
      });
      parsedSubtitles.push({ words: [], deleted: [], finalText: text });
    }
  }

  // 2. 成片时长预检：Σ(各镜时长) - (N - 1) * 0.7 <= 180s
  const N = verifiedShots.length;
  const estimatedComposedSec = N > 1
    ? totalRawDuration - (N - 1) * XFADE_DURATION
    : totalRawDuration;
  if (estimatedComposedSec > TARGET_MAX_DURATION) {
    throw Object.assign(
      new Error(`预估成片总时长约为 ${estimatedComposedSec.toFixed(1)} 秒，超过 ${TARGET_MAX_DURATION} 秒目标上限`),
      { code: 40018 }
    );
  }

  // 3. 自动模式判定与音色校验
  const autoMode = anyHasText ? 'tts' : 'asr';
  let voiceId = String(payload.voiceId || '').trim();
  if (autoMode === 'tts') {
    if (!voiceId || !ALLOWED_VOICES.has(voiceId)) {
      voiceId = DEFAULT_VOICE; // 白名单防护，未匹配回退默认女声
    }
  }
  // 主播层语速档位（anchor DNA 节奏，宪法口径 0.85~1.25）：越界/缺省回 1.0
  const rawSpeed = Number(payload.speed);
  const speechSpeed = Number.isFinite(rawSpeed) && rawSpeed >= 0.85 && rawSpeed <= 1.25 ? rawSpeed : 1;

  // 4. BGM 安全路径校验
  let safeBgmPath = '';
  if (payload.bgmPath && typeof payload.bgmPath === 'string') {
    const rawBgm = payload.bgmPath.trim();
    if (rawBgm && materialsDir) {
      try {
        safeBgmPath = assertSafePath(rawBgm, [materialsDir]);
      } catch (e) {
        safeBgmPath = ''; // 非法 BGM 路径直接忽略不混入，不打断出片
      }
    }
  }

  // 5. 创建任务 ID 与初始记录
  const taskId = payload.taskId && inMemoryTasks.has(payload.taskId)
    ? payload.taskId
    : `sb_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

  let taskRecord = inMemoryTasks.get(taskId);
  if (taskRecord) {
    if (taskRecord.status === 'producing' || taskRecord.status === 'completed') {
      throw Object.assign(new Error('该分镜任务已在生成中或已完成，请勿重复提交'), { code: 40901 });
    }
  } else {
    taskRecord = {
      taskId,
      kind: 'storyboard',
      status: 'queued',
      stage: 'queued',
      stageText: '分镜合成任务已提交排队...',
      progress: 5,
      autoMode,
      voiceId,
      // 场景（sell/local/personal）：结尾卡与发布方案同源消费，缺省 sell
      scene: ['sell', 'local', 'personal'].includes(payload.scene) ? payload.scene : 'sell',
      title: typeof payload.title === 'string' && payload.title.trim() ? payload.title.trim().slice(0, 30) : '实拍精选成片',
      estimatedSec: estimatedComposedSec,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    inMemoryTasks.set(taskId, taskRecord);
  }

  // 6. 计费防护（防重扣：每任务首次受理扣 200 积分）
  if (!taskRecord.creditsCharged) {
    if (typeof chargeMockCredits === 'function') {
      chargeMockCredits();
    }
    taskRecord.creditsCharged = true;
  }

  const taskOutputDir = path.join(storageOutputsDir, taskId);
  fs.mkdirSync(taskOutputDir, { recursive: true });

  taskRecord.status = 'producing';
  taskRecord.stage = 'composing';
  taskRecord.stageText = '正在进行分镜音画合成...';
  taskRecord.updatedAt = Date.now();

  // 7. 异步合成流水线（并发闸门 acquire -> compose -> finally release）
  (async () => {
    let releaseSlot = null;
    try {
      // 开场片头标题（电影级 1080x1920 竖版花字）
      let introFile = null;
      try {
        const introTitle = String(taskRecord.title || verifiedShots[0]?.text || '实拍精选成片').trim().slice(0, 16);
        const introPng = path.join(taskOutputDir, 'intro.png');
        renderIntroPng({
          title: introTitle,
          brandEn: 'JANSEE STORYBOARD',
          site: 'JANSEE STUDIO',
          note: '多镜头实拍拼接 · 电影级成片',
          idx: 'NO. 04 / CINEMATIC STORYBOARD',
          width: 1080,
          height: 1920,
          outPath: introPng,
        });
        introFile = introPng;
        console.log(`[JANSEE STORYBOARD] AI配音开场花字就绪: ${introPng}`);
      } catch (introErr) {
        console.warn(`[JANSEE STORYBOARD] 开场花字生成降级跳过: ${introErr?.message || introErr}`);
      }

      releaseSlot = await acquireComposeSlot(`storyboard:${taskId}`);
      const res = await composeStoryboard({
        taskDir: taskOutputDir,
        shots: verifiedShots,
        autoMode,
        voiceId,
        speed: speechSpeed,
        bgmPath: safeBgmPath,
        subtitles: parsedSubtitles,
        introFile,
        onProgress: (p, stage) => {
          taskRecord.progress = p;
          taskRecord.stage = stage;
          taskRecord.stageText = stage;
          taskRecord.updatedAt = Date.now();
        },
      });

      const finalPath = res.output || path.join(taskOutputDir, 'final.mp4');
      if (!fs.existsSync(finalPath)) {
        throw new Error('成片输出文件不存在');
      }

      // 服务端最终真实成片时长终检
      const realFinalDur = videoDurationSec(finalPath);
      if (!Number.isFinite(realFinalDur) || realFinalDur <= 0) {
        throw new Error('成片视频解析失败，时长异常');
      }
      if (realFinalDur > FINAL_MAX_DURATION) {
        throw new Error(`最终成片时长 ${realFinalDur.toFixed(1)} 秒超出上限`);
      }

      // 结尾收束（全版块标配，2026-10-24）：追加 CTA 尾段（appendEndingTail 恒不抛错，
      // 失败保持原片交付）。场景跟随用户工作台选择，同 taskId 派生同款结尾卡。
      taskRecord.stageText = '正在追加片尾收束卡...';
      taskRecord.updatedAt = Date.now();
      const tail = await appendEndingTail({
        workDir: taskOutputDir,
        videoFile: finalPath,
        outPath: path.join(taskOutputDir, 'final_tail.mp4'),
        taskId,
        scene: taskRecord.scene || 'sell',
        slotAlreadyHeld: true,
      });
      let deliveredDur = realFinalDur;
      if (tail) {
        await fs.promises.rename(tail.output, finalPath);
        deliveredDur = tail.durationSec;
        taskRecord.endingId = tail.endingId;
      }

      // 制作纯净宣发封面海报（1.0s 抽取无字幕无角标原画，画幅自适应对齐）
      try {
        const coverOut = path.join(taskOutputDir, 'cover.jpg');
        await composePureCover({
          bgSource: finalPath,
          title: taskRecord.title || '实拍精选成片',
          brandEn: 'JANSEE STORYBOARD',
          site: 'JANSEE STUDIO',
          note: '多镜头实拍拼接 · 电影级成片',
          idx: 'NO. 04 / CINEMATIC STORYBOARD',
          outPath: coverOut,
          captureSec: 1.0,
        });
        taskRecord.coverUrl = `/storage/outputs/${taskId}/cover.jpg`;
      } catch (coverErr) {
        console.warn(`[JANSEE STORYBOARD] 宣发封面制作跳过: ${coverErr?.message || coverErr}`);
      }

      taskRecord.status = 'completed';
      taskRecord.stage = 'done';
      taskRecord.progress = 100;
      taskRecord.videoUrl = `/storage/outputs/${taskId}/final.mp4`;
      taskRecord.durationSec = deliveredDur;
      taskRecord.deliveredAt = Date.now();
      taskRecord.updatedAt = Date.now();
      // 运维健康治理：出片成功交付后自动 GC 清理临时切片与中间音频，杜绝碎文件占爆磁盘
      cleanupStoryboardIntermediates(taskOutputDir);
    } catch (err) {
      taskRecord.status = 'failed';
      taskRecord.error = err.message || '分镜合成失败';
      taskRecord.updatedAt = Date.now();
    } finally {
      if (typeof releaseSlot === 'function') {
        try { releaseSlot(); } catch (e) {}
      }
    }
  })();

  return { taskId, status: taskRecord.status };
}

/**
 * =========================================================================
 * 6. 分镜成片 · 原片直出（两段式）：startStoryboardDirectAnalyze / startStoryboardDirectProduce
 * 定版口径（2026-10-24）：多段实拍素材保原声拼接；逐段本地 ASR + 冗余/停顿标记
 * （复用 @jansee/speech-cut 能力，第二个消费方），一次确认页按段分组，用户逐条确认后
 * 逐段音画同步剪除，再走分镜合成内核叠化拼接 + 烧字幕 + BGM。无声空镜段自然静默保留，
 * 不强加台词（AI 台词只在用户显式选择「AI 配音」模式的另一条链路里出现）。
 * 任务态复用 inMemoryTasks（kind='storyboard_direct'），轮询走 GET /api/v1/video/task/:taskId。
 * =========================================================================
 */

/** 无音轨段垫静音轨（composeStoryboard 音频 acrossfade 链要求每段都有音轨输入） */
async function ensureAudioTrack(file, taskDir, tag) {
  if (hasAudioStream(file)) return file;
  const out = path.join(taskDir, `sbd_silent_${tag}.mp4`);
  const tryArgs = (vCodec) => [
    '-nostdin', '-y',
    '-i', path.relative(taskDir, file).replace(/\\/g, '/'),
    '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo',
    '-map', '0:v:0', '-map', '1:a:0',
    '-shortest',
    '-c:v', vCodec, ...(vCodec === 'libx264' ? ['-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p'] : []),
    '-c:a', 'aac', '-b:a', '160k', '-ar', '44100', '-ac', '2',
    path.relative(taskDir, out).replace(/\\/g, '/'),
  ];
  const run = (args) => new Promise((resolve, reject) => {
    execFile(ffmpegStatic, args, { cwd: taskDir, maxBuffer: 50 * 1024 * 1024 }, (err, _o, stderr) => {
      if (err) reject(new Error(String(stderr || '').split('\n').slice(-4).join(' ').trim() || err.message));
      else resolve();
    });
  });
  try {
    await run(tryArgs('copy')); // 常规 h264 源直接流复制，零转码成本
  } catch (e) {
    await run(tryArgs('libx264')); // 冷门编码兜底重编码
  }
  return out;
}

/**
 * 阶段一：分镜直出分析。逐段本地 ASR + 冗余/长停顿标记；无音轨或零词的段标记 silent（原样保留）。
 * 单段 ASR 失败不拖垮整个任务——该段降级为 silent（直出承诺是"原汁原味"，识别只服务剪除建议）。
 */
export function startStoryboardDirectAnalyze({ payload, inMemoryTasks, storageUploadsDir, storageOutputsDir }) {
  if (!payload || typeof payload !== 'object') {
    throw Object.assign(new Error('请求体无效'), { code: 40001 });
  }
  const rawPaths = Array.isArray(payload.videoPaths) ? payload.videoPaths : [];
  if (rawPaths.length < 2) {
    throw Object.assign(new Error('请至少上传 2 段分镜素材进行原片直出'), { code: 40010 });
  }
  if (rawPaths.length > MAX_SHOTS) {
    throw Object.assign(new Error(`分镜数量不能超过 ${MAX_SHOTS} 个`), { code: 40011 });
  }

  const segFiles = [];
  for (let i = 0; i < rawPaths.length; i++) {
    const p = typeof rawPaths[i] === 'string' ? rawPaths[i].trim() : '';
    if (!p) throw Object.assign(new Error(`第 ${i + 1} 段素材路径无效`), { code: 40012 });
    const safeFile = assertSafePath(p, [storageUploadsDir, storageOutputsDir]);
    const dur = videoDurationSec(safeFile);
    if (!Number.isFinite(dur) || dur < MIN_SHOT_SEC) {
      throw Object.assign(new Error(`第 ${i + 1} 段时长过短，单个分镜不能少于 ${MIN_SHOT_SEC} 秒`), { code: 40014 });
    }
    if (dur > MAX_SHOT_SEC) {
      throw Object.assign(new Error(`第 ${i + 1} 段时长 ${(dur).toFixed(1)} 秒，超出单个分镜 ${MAX_SHOT_SEC} 秒限制`), { code: 40015 });
    }
    segFiles.push({ file: safeFile, durationSec: dur });
  }

  const taskId = `sbd_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  const taskRecord = {
    taskId,
    kind: 'storyboard_direct',
    phase: 'analyze',
    status: 'processing',
    stage: 'analyzing',
    stageText: '正在逐段识别分镜台词与停顿节奏...',
    progress: 10,
    // 场景（sell/local/personal，用户工作台选择）：发布方案与结尾卡同源消费，缺省 local
    scene: ['sell', 'local', 'personal'].includes(payload.scene) ? payload.scene : 'local',
    title: typeof payload.title === 'string' && payload.title.trim() ? payload.title.trim().slice(0, 30) : '实拍精选成片',
    segments: segFiles.map((s, i) => ({
      index: i + 1,
      name: path.basename(path.dirname(s.file)),
      file: s.file,           // 服务端自持，produce 不接受前端路径
      durationSec: s.durationSec,
      silent: false,
      words: [],
      suggestions: [],
      asrText: '',
      note: '',
    })),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  inMemoryTasks.set(taskId, taskRecord);

  const taskOutputDir = path.join(storageOutputsDir, taskId);
  fs.mkdirSync(taskOutputDir, { recursive: true });

  (async () => {
    try {
      // 逐段串行识别（与口播模块对齐：直接抽取音频送入 ASR，不依赖脆弱的正则预检）
      for (const seg of taskRecord.segments) {
        try {
          const segDir = path.join(taskOutputDir, `seg_${String(seg.index).padStart(2, '0')}`);
          fs.mkdirSync(segDir, { recursive: true });
          const asr = await runKeepOriginalAsr(seg.file, segDir);
          const words = Array.isArray(asr.words) ? asr.words : [];
          if (!words.length) {
            seg.silent = true;
            seg.note = '未识别到清晰人声，将按原声原样保留（不剪除）';
            continue;
          }
          seg.silent = false;
          seg.words = words;
          seg.suggestions = detectRedundancy(words);
          seg.asrText = String(asr.text || '');
        } catch (e) {
          seg.silent = true;
          seg.note = '该段音频无法提取人声，将按原样保留（不影响出片）';
          console.warn(`[JANSEE GATEWAY] 分镜直出第 ${seg.index} 段 ASR 降级: ${e.message}`);
        }
        taskRecord.progress = Math.min(48, 10 + Math.round((seg.index / taskRecord.segments.length) * 38));
        taskRecord.updatedAt = Date.now();
      }

      taskRecord.status = 'analyzed';
      taskRecord.stage = 'awaiting_confirm';
      taskRecord.stageText = '识别完成，请逐段确认要剪除的内容';
      taskRecord.progress = 50;
      taskRecord.updatedAt = Date.now();
      const sugCount = taskRecord.segments.reduce((a, s) => a + s.suggestions.length, 0);
      console.log(`[JANSEE GATEWAY] 分镜直出分析完成 ${taskId}: ${taskRecord.segments.length} 段 / 建议标记 ${sugCount} 项`);
    } catch (err) {
      taskRecord.status = 'failed';
      taskRecord.error = err.message || '分镜直出分析异常';
      taskRecord.updatedAt = Date.now();
    }
  })();

  return { taskId };
}

/**
 * 阶段二：分镜直出成片。按用户确认逐段剪除（标识白名单校验，同口播口径），
 * 逐段剪切 → 无声段垫静音轨 → 分镜合成内核叠化拼接 + 烧字幕（重映射时间轴）+ BGM 跨段。
 * 扣除 200 mock 积分（creditsCharged 防重）。
 */
export function startStoryboardDirectProduce({ taskId, selections, title, inMemoryTasks, storageOutputsDir, chargeMockCredits, userId = '' }) {
  const id = String(taskId || '').trim();
  const task = inMemoryTasks.get(id);
  if (!task || task.kind !== 'storyboard_direct') {
    throw Object.assign(new Error('分镜直出任务不存在或已过期，请重新分析'), { code: 40401 });
  }
  if (typeof title === 'string' && title.trim()) {
    task.title = title.trim().slice(0, 30);
  }
  if (task.status === 'producing' || task.status === 'completed') {
    throw Object.assign(new Error('该任务已在生成中或已完成，请勿重复提交'), { code: 40901 });
  }
  if ((task.status !== 'analyzed' && task.status !== 'failed') || !Array.isArray(task.segments) || !task.segments.length) {
    throw Object.assign(new Error('任务尚未完成逐段识别，请稍候或重新分析'), { code: 40902 });
  }

  // 用户确认结果：selections [{index, deletedStarts}]；标识白名单 = 该段 words 词表 start ∪ suggestions pause start
  const selByIndex = new Map();
  for (const sel of (Array.isArray(selections) ? selections : [])) {
    const idx = Number(sel?.index);
    if (Number.isFinite(idx)) selByIndex.set(idx, Array.isArray(sel.deletedStarts) ? sel.deletedStarts : []);
  }
  const segPlans = task.segments.map((seg) => {
    const rawDels = (selByIndex.get(seg.index) || [])
      .map((n) => Number(n))
      .filter(Number.isFinite);
    const wordSet = new Set(seg.words.map((w) => Number(w.start)));
    const pauseSet = new Set(seg.suggestions.filter((s) => s.reason === 'pause').map((s) => Number(s.start)));
    const knownWordDels = rawDels.filter((s) => wordSet.has(s));
    const knownPauseCuts = seg.suggestions
      .filter((s) => s.reason === 'pause' && pauseSet.has(Number(s.start)) && rawDels.includes(Number(s.start)))
      .map((p) => ({ start: Number(p.start), end: Number(p.end) }));
    return { seg, wordDels: knownWordDels, pauseCuts: knownPauseCuts };
  });

  // 计费：每次 200 积分，任务级防重（与口播/分镜成片同口径）
  // userId 落任务记录：供失败/Zombie Reaper 自动退款按 userId 原路退回
  if (!task.creditsCharged) {
    if (typeof chargeMockCredits === 'function') chargeMockCredits();
    task.creditsCharged = true;
    task.userId = userId || task.userId || '';
  }

  const taskOutputDir = path.join(storageOutputsDir, id);
  fs.mkdirSync(taskOutputDir, { recursive: true });
  task.status = 'producing';
  task.stage = 'composing';
  task.stageText = '正在按确认结果逐段剪除并叠化拼接（保留原声）...';
  task.progress = 55;
  task.updatedAt = Date.now();

  (async () => {
    let releaseSlot = null;
    try {
      // BGM 跨段统一选曲：与分段剪辑并发异步启动，消除串行排队等待
      const bgmPromise = selectBgmByEmotion('cheerful', [])
        .then((bgm) => bgm?.bgmPath || '')
        .catch((e) => {
          console.warn(`[JANSEE GATEWAY] 分镜直出 BGM 选曲降级: ${e.message}`);
          return '';
        });

      const shotFiles = [];
      const shotSubtitles = [];
      for (const plan of segPlans) {
        const { seg } = plan;
        let shotFile = seg.file;
        let wordsForSubs = seg.words;

        const hasDeletes = plan.wordDels.length > 0 || plan.pauseCuts.length > 0;
        if (!seg.silent && hasDeletes && seg.words.length) {
          const planned = planSegmentCut({
            words: seg.words,
            deletedStarts: new Set(plan.wordDels),
            pauseCuts: plan.pauseCuts,
            durationSec: seg.durationSec,
          });
          if (planned.error) {
            // 剪除后过短等安全拦截：该段放弃剪除按原样保留（不拖垮整单，与直出口径一致）
            console.warn(`[JANSEE GATEWAY] 分镜直出第 ${seg.index} 段放弃剪除: ${planned.error.code}`);
          } else if (planned.cutRanges.length) {
            const cut = await cutSegmentByRanges({
              videoFile: seg.file,
              keepRanges: planned.keepRanges,
              taskDir: taskOutputDir,
              outFile: `sbd_seg_${String(seg.index).padStart(2, '0')}.mp4`,
            });
            shotFile = cut.outFile;
            wordsForSubs = shiftWordsToKeptTimeline(seg.words, planned.keepRanges);
            task.cutSec = Number((((task.cutSec || 0) + planned.cutTotal)).toFixed(3));
          }
        }

        shotFile = await ensureAudioTrack(shotFile, taskOutputDir, String(seg.index).padStart(2, '0'));
        shotFiles.push({ mediaType: 'video', file: shotFile, text: '' });
        shotSubtitles.push({ words: wordsForSubs, deleted: [], finalText: '' });
        task.progress = Math.min(72, 55 + Math.round((seg.index / segPlans.length) * 17));
        task.updatedAt = Date.now();
      }

      // 等待并发选曲完成（闪避窗口由分镜合成内核按逐镜字幕 cues 两段式处理）
      const bgmPath = await bgmPromise;

      // 开场片头标题（电影级 1080x1920 竖版花字）
      let introFile = null;
      try {
        const introTitle = String(task.title || '实拍精选成片').trim().slice(0, 16);
        const introPng = path.join(taskOutputDir, 'intro.png');
        renderIntroPng({
          title: introTitle,
          brandEn: 'JANSEE STORYBOARD',
          site: 'JANSEE STUDIO',
          note: '多镜头实拍拼接 · 电影级成片',
          idx: 'NO. 04 / CINEMATIC STORYBOARD',
          width: 1080,
          height: 1920,
          outPath: introPng,
        });
        introFile = introPng;
        console.log(`[JANSEE STORYBOARD] 原片直出开场花字就绪: ${introPng}`);
      } catch (introErr) {
        console.warn(`[JANSEE STORYBOARD] 开场花字生成降级跳过: ${introErr?.message || introErr}`);
      }

      releaseSlot = await acquireComposeSlot(`storyboard_direct:${id}`);
      const res = await composeStoryboard({
        taskDir: taskOutputDir,
        shots: shotFiles,
        autoMode: 'asr', // 原声直出：原声不动，字幕来自剪除后重映射词表
        voiceId: DEFAULT_VOICE,
        bgmPath,
        subtitles: shotSubtitles,
        introFile,
        onProgress: (p, stage) => {
          task.progress = Math.max(task.progress, Math.min(98, p));
          if (stage) task.stage = stage;
          task.updatedAt = Date.now();
        },
      });

      const finalPath = res.output || path.join(taskOutputDir, 'final.mp4');
      if (!fs.existsSync(finalPath)) throw new Error('分镜直出成片文件不存在');

      // 结尾收束（全版块标配，2026-10-24）：追加 CTA 尾段（appendEndingTail 恒不抛错，
      // 失败保持原片交付）。同 taskId 派生同款结尾卡，场景跟随用户工作台选择。
      task.stageText = '正在追加片尾收束卡...';
      task.progress = 99;
      task.updatedAt = Date.now();
      let realDur = videoDurationSec(finalPath);
      const tail = await appendEndingTail({
        workDir: taskOutputDir,
        videoFile: finalPath,
        outPath: path.join(taskOutputDir, 'final_tail.mp4'),
        taskId: id,
        scene: task.scene || 'local',
        slotAlreadyHeld: true,
      });
      if (tail) {
        await fs.promises.rename(tail.output, finalPath);
        realDur = tail.durationSec;
        task.endingId = tail.endingId;
      }
      if (!Number.isFinite(realDur) || realDur <= 0) throw new Error('成片时长解析失败');

      // 制作纯净宣发封面海报（1.0s 抽取无字幕无角标原画，画幅自适应对齐）
      try {
        const coverOut = path.join(taskOutputDir, 'cover.jpg');
        await composePureCover({
          bgSource: finalPath,
          title: task.title || '实拍精选成片',
          brandEn: 'JANSEE STORYBOARD',
          site: 'JANSEE STUDIO',
          note: '真实原声精剪 · 电影级成片',
          idx: 'NO. 04 / CINEMATIC STORYBOARD',
          outPath: coverOut,
          captureSec: 1.0,
        });
        task.coverUrl = `/storage/outputs/${id}/cover.jpg`;
      } catch (coverErr) {
        console.warn(`[JANSEE STORYBOARD DIRECT] 宣发封面制作跳过: ${coverErr?.message || coverErr}`);
      }

      task.status = 'completed';
      task.stage = 'done';
      task.progress = 100;
      task.videoUrl = `/storage/outputs/${id}/final.mp4`;
      task.durationSec = realDur;
      // 运维健康治理：出片成功交付后自动 GC 清理临时切片与中间音频，杜绝碎文件占爆磁盘
      cleanupStoryboardIntermediates(taskOutputDir);
      // 实拍节奏精修档案（纯本地算法驱动，0 Token 消耗，量化视听剪辑成果）
      const rawDur = Math.round(segPlans.reduce((a, p) => a + (Number(p.seg.durationSec) || 0), 0) * 10) / 10;
      const cleanDur = Math.round(realDur * 10) / 10;
      const cutSec = Math.max(0, Math.round((rawDur - cleanDur) * 10) / 10);
      const cutCount = segPlans.reduce((a, p) => a + (p.wordDels ? p.wordDels.length : 0) + (p.pauseCuts ? p.pauseCuts.length : 0), 0);
      const efficiencyPct = rawDur > 0 ? Math.min(99.9, Math.max(0, (cutSec / rawDur) * 100)) : 0;
      const totalWords = segPlans.reduce((a, p) => a + (p.seg.words ? p.seg.words.length : 0), 0);
      const coverUrl = `/storage/outputs/${id}/cover.jpg`;

      const storyboardReport = {
        kind: 'speech_report',
        mode: 'storyboard',
        efficiencyPct: Number(efficiencyPct.toFixed(1)),
        cutCount,
        wpm: Math.round(totalWords / Math.max(0.1, cleanDur / 60)) || 260,
        paceTag: '实拍真实原声 · 节奏精修',
        rawDuration: rawDur,
        cleanDuration: cleanDur,
        cutDuration: cutSec,
        wordsCount: totalWords,
        coverUrl
      };
      task.report = storyboardReport;
      task.publish = storyboardReport;
      task.deliveredAt = Date.now();
      task.updatedAt = Date.now();
      console.log(`[JANSEE GATEWAY] 分镜直出成片完成 ${id}: ${task.videoUrl} (${realDur.toFixed(2)}s / 累计剪除 ${(task.cutSec || 0).toFixed(2)}s)`);
    } catch (err) {
      task.status = 'failed';
      task.error = err.message || '分镜直出合成失败';
      task.updatedAt = Date.now();
      console.error(`[JANSEE GATEWAY] 分镜直出合成失败 ${id}: ${err.message}`);
    } finally {
      if (typeof releaseSlot === 'function') {
        try { releaseSlot(); } catch (e) {}
      }
    }
  })();

  return { taskId: id };
}

/**
 * 时间解析辅助工具：支持秒数字符串/数字/mm:ss/hh:mm:ss
 */
export function parseTimeToSeconds(input, fallback = 0) {
  if (typeof input === 'number' && Number.isFinite(input)) {
    return Math.max(0, input);
  }
  if (typeof input !== 'string') return fallback;
  const str = input.trim();
  if (!str) return fallback;

  // 纯秒数 (例如 "15" 或 "15.5")
  if (/^\d+(\.\d+)?$/.test(str)) {
    const val = parseFloat(str);
    return Number.isFinite(val) ? Math.max(0, val) : fallback;
  }

  // 冒号分隔格式 mm:ss 或 hh:mm:ss
  const parts = str.split(':').map((p) => parseFloat(p));
  if (parts.some((p) => !Number.isFinite(p))) return fallback;

  if (parts.length === 2) {
    // mm:ss
    return parts[0] * 60 + parts[1];
  } else if (parts.length === 3) {
    // hh:mm:ss
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }

  return fallback;
}

/**
 * =========================================================================
 * 4. 极简起止时间精准切片：startExactSliceCut
 * 仅限用户输入起止时间点，高精度截取目标视频片段，产出直出 MP4 交付
 * =========================================================================
 */
export function startExactSliceCut({
  payload,
  inMemoryTasks,
  storageUploadsDir,
  storageOutputsDir,
}) {
  if (!payload || typeof payload !== 'object') {
    throw Object.assign(new Error('请求体无效'), { code: 40001 });
  }

  const matId = typeof payload.materialId === 'string' ? payload.materialId.trim() : '';
  const videoPathRaw = typeof payload.videoPath === 'string' ? payload.videoPath.trim() : '';

  let targetFilePath = '';
  if (matId) {
    const mat = materialRegistry.get(matId);
    if (!mat) {
      throw Object.assign(new Error(`素材不存在或已过期（ID: ${matId}）`), { code: 40013 });
    }
    targetFilePath = mat.filePath;
  } else if (videoPathRaw) {
    targetFilePath = videoPathRaw;
  } else {
    throw Object.assign(new Error('请先上传视频素材'), { code: 40001 });
  }

  const safeVideoFile = assertSafePath(targetFilePath, [storageUploadsDir, storageOutputsDir]);
  const totalDuration = videoDurationSec(safeVideoFile);
  if (!Number.isFinite(totalDuration) || totalDuration <= 0) {
    throw Object.assign(new Error('无法探测视频有效时长，文件可能已损坏'), { code: 40004 });
  }

  // 解析并校验起止时间点（支持多段 segments: [{ startTime, endTime, name }]，最多 9 段）
  let targetSegments = [];
  if (Array.isArray(payload.segments) && payload.segments.length > 0) {
    if (payload.segments.length > 9) {
      throw Object.assign(new Error('单次切片最多支持 9 段区间'), { code: 40023 });
    }
    targetSegments = payload.segments.map((seg, idx) => {
      const s = parseTimeToSeconds(seg.startTime, 0);
      let e = parseTimeToSeconds(seg.endTime, totalDuration);
      if (s >= totalDuration) {
        throw Object.assign(new Error(`第 ${idx + 1} 段开始时间 (${s.toFixed(1)}s) 超过视频总时长`), { code: 40020 });
      }
      if (e > totalDuration) e = totalDuration;
      if (s >= e) {
        throw Object.assign(new Error(`第 ${idx + 1} 段结束时间必须大于开始时间`), { code: 40021 });
      }
      const dur = e - s;
      if (dur < 0.5) {
        throw Object.assign(new Error(`第 ${idx + 1} 段切片时长不能少于 0.5 秒`), { code: 40022 });
      }
      return {
        index: idx + 1,
        name: typeof seg.name === 'string' && seg.name.trim() ? seg.name.trim() : `切片 ${(idx + 1).toString().padStart(2, '0')}`,
        startTime: s,
        endTime: e,
        duration: dur,
      };
    });
  } else {
    // 兼容传统单段入参
    const s = parseTimeToSeconds(payload.startTime, 0);
    let e = parseTimeToSeconds(payload.endTime, totalDuration);
    if (s >= totalDuration) {
      throw Object.assign(new Error(`开始时间 (${s.toFixed(1)}秒) 不能超过视频总时长 (${totalDuration.toFixed(1)}秒)`), { code: 40020 });
    }
    if (e > totalDuration) e = totalDuration;
    if (s >= e) {
      throw Object.assign(new Error(`结束时间必须大于开始时间（当前：${s.toFixed(1)}s ~ ${e.toFixed(1)}s）`), { code: 40021 });
    }
    const dur = e - s;
    if (dur < 0.5) {
      throw Object.assign(new Error('切片片段不能少于 0.5 秒'), { code: 40022 });
    }
    targetSegments = [{
      index: 1,
      name: '切片 01',
      startTime: s,
      endTime: e,
      duration: dur,
    }];
  }

  const taskId = `task_slice_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  const taskRecord = {
    taskId,
    kind: 'slicer',
    status: 'processing',
    stage: 'cutting',
    stageText: `正在高精度截取 ${targetSegments.length} 个目标切片...`,
    progress: 15,
    segmentCount: targetSegments.length,
    totalDuration,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  inMemoryTasks.set(taskId, taskRecord);

  const taskOutputDir = path.join(storageOutputsDir, taskId);
  fs.mkdirSync(taskOutputDir, { recursive: true });

  (async () => {
    let releaseSlot = null;
    try {
      releaseSlot = await acquireComposeSlot(`slice_cut:${taskId}`);
      taskRecord.progress = 25;
      taskRecord.stageText = '正在提取视频流并重编码输出切片...';
      taskRecord.updatedAt = Date.now();

      const versions = [];
      for (let i = 0; i < targetSegments.length; i++) {
        const seg = targetSegments[i];
        const outFileName = targetSegments.length === 1 ? 'slice.mp4' : `slice_${String(i + 1).padStart(2, '0')}.mp4`;
        const outFilePath = path.join(taskOutputDir, outFileName);

        taskRecord.stageText = `正在截取第 ${i + 1}/${targetSegments.length} 段切片 (${seg.startTime.toFixed(1)}s ~ ${seg.endTime.toFixed(1)}s)...`;
        taskRecord.progress = Math.round(25 + (i / targetSegments.length) * 65);
        taskRecord.updatedAt = Date.now();

        await new Promise((resolve, reject) => {
          const args = [
            '-nostdin',
            '-y',
            '-ss',
            seg.startTime.toFixed(3),
            '-to',
            seg.endTime.toFixed(3),
            '-i',
            safeVideoFile,
            '-c:v',
            'libx264',
            '-preset',
            'veryfast',
            '-crf',
            '20',
            '-pix_fmt',
            'yuv420p',
            '-c:a',
            'aac',
            '-b:a',
            '160k',
            '-avoid_negative_ts',
            'make_zero',
            outFilePath,
          ];

          execFile(ffmpegStatic, args, { maxBuffer: 50 * 1024 * 1024 }, (err, _stdout, stderr) => {
            if (err) {
              const tail = String(stderr || '').split('\n').slice(-6).join(' ').trim();
              reject(new Error(tail || err.message));
              return;
            }
            resolve();
          });
        });

        if (!fs.existsSync(outFilePath)) {
          throw new Error(`切片片段 ${i + 1} 生成失败，产物不存在`);
        }

        versions.push({
          index: i + 1,
          name: seg.name,
          videoUrl: `/storage/outputs/${taskId}/${outFileName}`,
          duration: seg.duration,
          startTime: seg.startTime,
          endTime: seg.endTime,
        });
      }

      taskRecord.status = 'completed';
      taskRecord.stage = 'done';
      taskRecord.progress = 100;
      taskRecord.stageText = `已成功完成 ${versions.length} 个切片片段截取`;
      taskRecord.videoUrl = versions[0].videoUrl;
      taskRecord.durationSec = versions[0].duration;
      taskRecord.outputs = {
        videoUrl: versions[0].videoUrl,
        versions,
      };
      taskRecord.deliveredAt = Date.now();
      taskRecord.updatedAt = Date.now();
    } catch (err) {
      taskRecord.status = 'failed';
      taskRecord.error = err.message || '切片截取失败';
      taskRecord.updatedAt = Date.now();
    } finally {
      if (typeof releaseSlot === 'function') {
        try { releaseSlot(); } catch (e) {}
      }
    }
  })();

  return { taskId, status: taskRecord.status };
}
