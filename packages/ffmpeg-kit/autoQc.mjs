/**
 * 简兮 (JANSEE) · 成片轻量级自动质检守门员 (packages/ffmpeg-kit/autoQc.mjs)
 * 职责：
 *   实现 DeepSeek 提出的“从开环管线走向质量闭环”：
 *   1. 物理文件与流有效性探查（杜绝 0 字节、空壳或损坏视频输出）；
 *   2. 音画时长对账与漂移检测（防止音画失步）；
 *   3. 视频分辨率、编码与音频轨道合规性校验；
 *   4. 国家广电总局《办法》AIGC 隐式元数据注入合规校验。
 */

import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import ffmpegStatic from 'ffmpeg-static';
import { hasAudioStream, probeDurationSec, probeVideoSize } from './probe.mjs';

export const QC_THRESHOLDS = {
  MIN_FILE_SIZE_BYTES: 100 * 1024,      // 最小文件大小 100KB
  MAX_DRIFT_MS: 350,                     // 允许音画偏差毫秒数
  STANDARD_VERTICAL_WIDTH: 1080,
  STANDARD_VERTICAL_HEIGHT: 1920,
};

function readMediaStderr(file) {
  try {
    return execFileSync(ffmpegStatic, ['-i', file], {
      encoding: 'utf8',
      stdio: ['ignore', 'ignore', 'pipe'],
      timeout: 8000,
    });
  } catch (e) {
    return e?.stderr || '';
  }
}

/**
 * 对渲染生成的 MP4 文件执行自动质检 (Auto-QC)
 * @param {string} filePath 待检测的视频绝对路径
 * @param {object} [options]
 */
export async function performAutoQc(filePath, options = {}) {
  const errors = [];
  const warnings = [];
  const suggestedCorrections = [];

  // 1. 物理文件存在性与大小底线校验
  if (!fs.existsSync(filePath)) {
    return {
      passed: false,
      grade: 'REJECT',
      metrics: {},
      warnings: [],
      errors: [`[Auto-QC] 目标文件不存在: ${filePath}`],
      suggestedCorrections: [
        {
          issue: 'FILE_NOT_FOUND',
          action: 'FULL_RERUN',
          recommendation: '渲染中间件未产出目标文件，建议检查工作目录权限并从首分镜全量重跑'
        }
      ]
    };
  }

  const stat = fs.statSync(filePath);
  const minSize = options.minSizeBytes || QC_THRESHOLDS.MIN_FILE_SIZE_BYTES;
  if (stat.size < minSize) {
    errors.push(`[Auto-QC] 输出视频文件异常过小 (${stat.size} 字节 < 阈值 ${minSize})，疑似转码未完成或空壳`);
    suggestedCorrections.push({
      issue: 'CORRUPTED_OR_EMPTY_OUTPUT',
      action: 'REGENERATE_ENCODE',
      recommendation: '检查 FFmpeg 退出码与滤镜图显存是否耗尽，降低并发或切换为极速流式转码'
    });
  }

  // 2. 媒体流与时长分析
  const mediaStderr = readMediaStderr(filePath);
  const durationSec = probeDurationSec(filePath);
  const videoSize = probeVideoSize(filePath);
  const hasAudio = hasAudioStream(filePath);

  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    errors.push('[Auto-QC] 视频时长探测失败或为 0s（文件格式可能损坏）');
  }

  if (!videoSize) {
    errors.push('[Auto-QC] 未检测到有效视频画面轨道 (Video Stream Missing)');
  } else {
    // 检查是否对齐标准分辨率
    if (options.requireStandardVertical) {
      if (videoSize.width !== QC_THRESHOLDS.STANDARD_VERTICAL_WIDTH || videoSize.height !== QC_THRESHOLDS.STANDARD_VERTICAL_HEIGHT) {
        warnings.push(`[Auto-QC] 视频分辨率为 ${videoSize.width}x${videoSize.height}，非标准 1080x1920 竖屏`);
        suggestedCorrections.push({
          issue: 'RESOLUTION_MISMATCH',
          action: 'APPLY_CANVAS_PAD',
          target: { width: QC_THRESHOLDS.STANDARD_VERTICAL_WIDTH, height: QC_THRESHOLDS.STANDARD_VERTICAL_HEIGHT },
          filterComplexSuggestion: 'scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black'
        });
      }
    }
  }

  // 检查编码格式
  let videoCodec = 'unknown';
  const videoMatch = /Stream #\d+:\d+.*?Video:\s*([a-zA-Z0-9_-]+)/.exec(mediaStderr);
  if (videoMatch) {
    videoCodec = videoMatch[1].toLowerCase();
  }

  let audioCodec = null;
  const audioMatch = /Stream #\d+:\d+.*?Audio:\s*([a-zA-Z0-9_-]+)/.exec(mediaStderr);
  if (audioMatch) {
    audioCodec = audioMatch[1].toLowerCase();
  }

  if (options.requireAudio !== false && !hasAudio) {
    warnings.push('[Auto-QC] 输出成片缺少音频轨道 (Silent Video)');
    suggestedCorrections.push({
      issue: 'AUDIO_TRACK_MISSING',
      action: 'ATTACH_AUDIO_OR_MUTE',
      recommendation: '成片缺少音轨，需补齐人声音轨或附加静音音轨防播放器死机'
    });
  }

  // 检查音画时长漂移 (若调用方传入预期音频时长)
  if (options.expectedAudioDurationSec && Number.isFinite(durationSec)) {
    const driftMs = Math.round(Math.abs(durationSec - options.expectedAudioDurationSec) * 1000);
    const maxDrift = options.maxAvSyncDriftMs || QC_THRESHOLDS.MAX_DRIFT_MS;
    if (driftMs > maxDrift) {
      warnings.push(`[Auto-QC] 音画时长漂移 (${driftMs}ms > 阈值 ${maxDrift}ms)`);
      suggestedCorrections.push({
        issue: 'AV_SYNC_DRIFT',
        action: durationSec > options.expectedAudioDurationSec ? 'PAD_AUDIO_TAIL' : 'TRIM_VIDEO_TAIL',
        driftMs,
        targetDurationSec: options.expectedAudioDurationSec,
        recommendation: durationSec > options.expectedAudioDurationSec
          ? `视频长于音频 ${driftMs}ms，建议在音频尾部追加静音补齐`
          : `音频长于视频 ${driftMs}ms，建议以音频时长重裁视频尾部收束帧`
      });
    }
  }

  // 3. 检查国标 AIGC 标识
  let hasAigcUdta = false;
  try {
    if (mediaStderr.includes('AIGC') || mediaStderr.includes('Jansee') || mediaStderr.includes('ai-generated')) {
      hasAigcUdta = true;
    } else {
      const fd = fs.openSync(filePath, 'r');
      const buf = Buffer.alloc(Math.min(stat.size, 8192));
      fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);
      const str = buf.toString('utf8');
      if (str.includes('AIGC') || str.includes('Jansee') || str.includes('udta')) {
        hasAigcUdta = true;
      }
    }
  } catch { }

  if (options.requireUdtaAigc && !hasAigcUdta) {
    warnings.push('[Auto-QC] 未能检测到国标 MP4 udta AIGC 隐式合规元数据');
    suggestedCorrections.push({
      issue: 'METADATA_AIGC_MISSING',
      action: 'INJECT_UDTA_AIGC',
      tool: '@jansee/subtitle-kit',
      api: 'injectAigcUdtaMetadata(filePath)',
      recommendation: '使用 subtitle-kit 单遍流式注入《生成式人工智能服务管理暂行办法》udta:AIGC 标识'
    });
  }

  // 4. 评级决策
  const passed = errors.length === 0;
  let grade = 'A';
  if (!passed) {
    grade = 'REJECT';
  } else if (warnings.length > 0) {
    grade = 'B';
  }

  return {
    passed,
    grade,
    metrics: {
      fileSizeBytes: stat.size,
      durationSec: Number.isFinite(durationSec) ? durationSec : 0,
      video: videoSize ? {
        codec: videoCodec,
        width: videoSize.width,
        height: videoSize.height,
      } : null,
      audio: hasAudio ? {
        hasAudio: true,
        codec: audioCodec,
      } : null,
      hasAigcUdta,
      checkedAt: new Date().toISOString()
    },
    warnings,
    errors,
    suggestedCorrections
  };
}
