// 简兮 · 媒体探测小工具
//
// 从 composer.js 尾部拆出来的两个函数。V1 单体合成器（compose）已删除，但这两个
// 被切片 / 口播 / 语音口播三条链路当成"读文件基本信息"的通用工具在用，与合成无关。
//
// 实现范式：用 `ffmpeg -i` 读裸文件信息（不给输出文件时 ffmpeg 正常报错，信息在 stderr）。
// 不引 ffprobe —— 项目只装了 ffmpeg-static，多一个二进制就多一份部署负担。

import { execFileSync } from 'node:child_process';
import ffmpegStatic from 'ffmpeg-static';

function readMediaInfo(file) {
  try {
    return execFileSync(ffmpegStatic, ['-i', file], {
      encoding: 'utf8',
      stdio: ['ignore', 'ignore', 'pipe'],
      timeout: 8000, // 8秒硬超时保护：畸形/死锁媒体直接强杀，杜绝挂起 Node.js 主事件循环
    });
  } catch (e) {
    return e?.stderr || ''; // 无输出文件时 ffmpeg 以非 0 退出，stream/Duration 信息在 stderr
  }
}

// 文件是否含音频流。返回 Boolean。
// 解析到文件本身损坏（无任何 stream）也视为无音频。
export function hasAudioStream(file) {
  const out = readMediaInfo(file);
  if (!out) return false;
  if (!/Stream #/.test(out)) return false;
  return /Stream #0:\s*\d+.*audio/i.test(out);
}

// 文件实际时长（秒）；无法解析（文件损坏、无 Duration 行）时返回 NaN，由调用方判失败。
// 兼容无前导零（0:01:23）与无小数秒（00:01:23）的 Duration 格式（2026-10-18 回归实测）。
export function probeDurationSec(file) {
  const out = readMediaInfo(file);
  const m = /Duration:\s*(\d+):(\d{1,2}):(\d{2}(?:\.\d+)?)/.exec(out || '');
  if (!m) return NaN;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

// 首个视频流的像素尺寸 {width,height}；解析失败返回 null。
// 用途：整幅素材（如结尾 CTA 卡）要适配用户视频画幅时，先问真实尺寸再缩放+pad，
// 不猜、不默认 1080×1920——用户视频横竖皆有，猜错的后果是卡面被拉伸或贴错位置。
export function probeVideoSize(file) {
  const out = readMediaInfo(file);
  const m = /Stream #\d+:\d+.*?Video:.*?(\d{2,5})x(\d{2,5})/.exec(out || '');
  if (!m) return null;
  return { width: Number(m[1]), height: Number(m[2]) };
}
