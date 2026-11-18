/**
 * 结尾收束 · 通用尾段追加（2026-10-24 全版块收束下沉）
 *
 * 面向「成片视频已合成完毕」的链路（口播 / 分镜直出 / 分镜 AI 配音）：
 *   源视频完整保留 → 结尾淡出至黑（吃源视频尾巴，FADE.voiceOut 1.5s）
 *   → tpad 黑停一拍（ENDING_TAIL.endHoldSec 0.35s）
 *   → CTA 结尾卡淡入浮出（fadeInSec 0.85s + 持续，总长 ctaSec 2.6s）
 *   → 追加 2.95s，不截断、不加速源视频。
 *
 * 与 @jansee/video-dub 的关系：video-dub 的尾段烧在 composeDubTrack 单次滤镜图里
 * （音画对齐目标 = 源视频 + 尾段，拆两次 pass 会多一次全片重编码，故保留内联实现），
 * 但两者消费同一份时间口径（ENDING_TAIL）与同一份 PNG 渲染（renderEndingPng）——
 * 「同一单在任何链路看到同一张结尾卡」由真源单文件保证，不由调用方式保证。
 *
 * 结尾卡画幅适配（fitEndingCard）：1080×1920 整卡 contain 缩放 + 黑边 pad 到视频宽高，
 * 不猜尺寸、不拉伸；黑边落在本来就是黑底的尾段里，视觉无缝。原在 video-dub/dubKernel，
 * 2026-10-24 上移至此（口播/分镜两条新链路同需要，第二消费方上升口径）。
 */
import { execFile } from 'node:child_process';
import path from 'node:path';
import { aiMetaArgs } from '@jansee/subtitle-kit/aiBadge.js';
import { acquireComposeSlot } from '@jansee/ffmpeg-kit/composeGate.mjs';
import ffmpegStatic from 'ffmpeg-static';
import { hasAudioStream, probeDurationSec, probeVideoSize } from '@jansee/ffmpeg-kit/probe.mjs';
import { FADE } from '@jansee/ffmpeg-kit/constitutionEffects.js';
import { ENDING_TAIL, renderEndingPng } from './render.js';
import { pickEndingForTask } from './seed.js';
import { sceneForEngine } from './ending.js';

function runFfmpeg(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile(ffmpegStatic, args, { cwd, maxBuffer: 100 * 1024 * 1024, windowsHide: true }, (err, _stdout, stderr) => {
      if (err) {
        const tail = String(stderr || '').split('\n').slice(-6).join(' ').trim();
        reject(new Error(tail || err.message));
        return;
      }
      resolve();
    });
  });
}

function rel(cwd, p) {
  return path.relative(cwd, p).replace(/\\/g, '/');
}

/**
 * 结尾卡适配用户视频画幅：1080×1920 整卡 contain 缩放 + 黑边 pad 到视频宽高。
 * @param {string} cwd 工作目录（ffmpeg 执行目录）
 * @param {string} endingPng 整幅结尾卡 PNG 绝对路径
 * @param {{width:number,height:number}|null} size 源视频探测尺寸
 * @returns {Promise<string|null>} 适配后的 PNG 路径；尺寸不可用返回 null（不出结尾卡）
 */
export async function fitEndingCard(cwd, endingPng, size) {
  if (!size || !(size.width > 0) || !(size.height > 0)) return null;
  const out = path.join(cwd, 'ending_fit.png');
  await runFfmpeg(
    [
      '-nostdin', '-y',
      '-i', rel(cwd, endingPng),
      '-vf',
      `scale=${size.width}:${size.height}:force_original_aspect_ratio=decrease,` +
      `pad=${size.width}:${size.height}:(ow-iw)/2:(oh-ih)/2:color=black`,
      '-frames:v', '1',
      rel(cwd, out),
    ],
    cwd,
  );
  return out;
}

/**
 * 给一条已合成完毕的成片视频追加结尾收束卡尾段（全版块标配，2026-10-24）。
 * 单次滤镜图完成：结尾淡出 → 黑停一拍 → CTA 淡入浮出；音轨 apad 补满尾段并在收尾淡出。
 * 恒不抛错：任何失败（探测/渲染/编码）console.error 后返回 null——调用方保持原片交付，
 * 结尾卡是加分项，绝不为它把成片搞失败。
 *
 * @param {object} p
 * @param {string} p.workDir 工作目录（输出目录，ffmpeg cwd；ending.png / ending_fit.png 落此）
 * @param {string} p.videoFile 源成片绝对路径（完整保留，不被截断/加速）
 * @param {string} p.outPath 尾段成片输出绝对路径（建议 final_tail.mp4，由调用方 rename 转正）
 * @param {string} p.taskId 任务 ID（派生结尾卡 seed：同 taskId 重出同款）
 * @param {string} p.scene 场景（sell/local/personal，决定 CTA 卡池；口播 local、分镜跟随用户场景）
 * @param {string} [p.endingId] 钉结尾卡款（缺省按 seed 从场景池抽）
 * @param {string} [p.brandZh] 竖柱骨架左侧副字（缺省「原 创 呈 现」）
 * @param {string} [p.brandEn] 竖柱骨架右侧副字（缺省「JANSEE AI STUDIO」）
 * @returns {Promise<{output:string, durationSec:number, endingId:string}|null>} 失败返回 null
 */
export async function appendEndingTail({ workDir, videoFile, outPath, taskId, scene, endingId, brandZh, brandEn, slotAlreadyHeld = false }) {
  let releaseSlot = null;
  try {
    if (!slotAlreadyHeld) releaseSlot = await acquireComposeSlot(`ending_tail:${taskId}`);
    const baseDur = probeDurationSec(videoFile);
    if (!Number.isFinite(baseDur) || baseDur <= 0) throw new Error('成片时长探测失败，文件可能已损坏');

    const ending = pickEndingForTask(taskId, { scene: sceneForEngine(scene), endingId });
    const endingPng = renderEndingPng({ ending, brandZh, brandEn, outPath: path.join(workDir, 'ending.png') });
    const ctaFile = await fitEndingCard(workDir, endingPng, probeVideoSize(videoFile));
    if (!ctaFile) throw new Error('视频画幅探测失败，无法适配结尾卡');

    const tailSec = ENDING_TAIL.endHoldSec + ENDING_TAIL.ctaSec;
    const totalDur = baseDur + tailSec;
    const fadeSt = Math.max(0, baseDur - FADE.voiceOut).toFixed(2);
    const audioEndFadeSt = Math.max(0, totalDur - 0.5).toFixed(2);

    // 输入索引：0 = 源成片，1 = CTA 卡；无音轨源片补一路静音（anullsrc）作为输入 2
    const withAudio = hasAudioStream(videoFile);
    const args = [
      '-nostdin', '-y',
      '-i', rel(workDir, videoFile),
      '-loop', '1', '-framerate', '30', '-t', tailSec.toFixed(2), '-i', rel(workDir, ctaFile),
    ];
    if (!withAudio) {
      args.push('-f', 'lavfi', '-t', totalDur.toFixed(2), '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100');
    }

    const filters = [
      `[0:v]fade=t=out:st=${fadeSt}:d=${FADE.voiceOut},` +
      `tpad=stop_mode=add:stop_duration=${tailSec.toFixed(2)}:color=black[vbody]`,
      `[1:v]format=rgba,fade=t=in:st=0:d=${ENDING_TAIL.fadeInSec}:alpha=1,` +
      `tpad=start_duration=${(baseDur + ENDING_TAIL.endHoldSec).toFixed(3)}:start_mode=add:color=0x00000000[cta]`,
      '[vbody][cta]overlay=0:0:eof_action=pass:format=auto[v]',
      withAudio
        ? `[0:a]apad,atrim=0:${totalDur.toFixed(2)},asetpts=PTS-STARTPTS,afade=t=out:st=${audioEndFadeSt}:d=0.5[aout]`
        : `[2:a]afade=t=out:st=${audioEndFadeSt}:d=0.5[aout]`,
    ];
    args.push(
      '-filter_complex', filters.join(';'),
      '-map', '[v]', '-map', '[aout]',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast', '-crf', '20',
      '-c:a', 'aac', '-b:a', '192k',
      '-movflags', '+faststart+use_metadata_tags',
      /* AIGC 隐式标识：字段单一真源 = subtitle-kit aiMetaArgs（与全平台同口径） */
      ...aiMetaArgs(taskId),
      rel(workDir, outPath),
    );
    await runFfmpeg(args, workDir);

    const finalDur = probeDurationSec(outPath);
    if (!Number.isFinite(finalDur) || finalDur <= 0) throw new Error('尾段成片时长探测失败');
    return { output: outPath, durationSec: finalDur, endingId: ending.id };
  } catch (err) {
    console.error(`[ending-kit] 结尾卡尾段追加失败（保持原片交付）: ${err?.message || err}`);
    return null;
  } finally {
    if (typeof releaseSlot === 'function') releaseSlot();
  }
}
