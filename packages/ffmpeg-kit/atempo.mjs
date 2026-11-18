// 简兮 · atempo 滤镜串生成（从 video_creator/video/dub.js 下沉，2026-10-24）
// 消费方：modules/video_creator/video/storyboard.js（分镜解说音画同步）。
// 放 ffmpeg-kit 的理由：纯 ffmpeg 滤镜零件，与探测/宪法参数同层，不绑任何业务模块。

/**
 * 生成 atempo 滤镜串：ffmpeg 单条 atempo 仅支持 0.5~2.0，超出需链式分解。
 * rate>1 加速（拆成若干 ≤2.0 的因子相乘），rate<1 减速（拆成若干 ≥0.5 的因子）。
 * @param {number} rate 目标倍速（1=原速）
 * @returns {string} 如 "atempo=1.500" 或 "atempo=2.000,atempo=1.250"
 */
export function buildAtempoFilter(rate) {
  let r = Number(rate);
  if (!Number.isFinite(r) || r <= 0) r = 1;
  r = Math.min(r, 50); // 安全上限，避免极端倍数把人声压成不可辨
  if (r >= 0.5 && r <= 2.0) return `atempo=${r.toFixed(3)}`;
  const factors = [];
  let cur = r;
  while (cur > 2.0) {
    factors.push('2.000');
    cur /= 2.0;
  }
  while (cur < 0.5) {
    factors.push('0.500');
    cur /= 0.5;
  }
  if (Math.abs(cur - 1) > 0.001) factors.push(cur.toFixed(3));
  return factors.map((f) => `atempo=${f}`).join(',');
}
