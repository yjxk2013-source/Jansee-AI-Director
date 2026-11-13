// 简兮 · 端到端出片回归脚本（真实 LLM + 真实 TTS + 真实合成，产生真实费用）
// 【人工授权门槛】默认拒绝执行：需同时满足 1) 生产网关 3000 已按真实配置启动；2) 显式设置
// 环境变量 E2E_REAL_APPROVED=1（由负责人逐次批准），防止任何自动化流程静默产生付费调用。
// 用法：node apps/web/server/tests/video-dub/e2e-image-produce.mjs <图片绝对路径> [图片数量1-9]
// 流程：读图转 dataURL → 上传 → 提交出片 → 轮询真实进度 → 输出成片与封面路径
if (process.env.E2E_REAL_APPROVED !== '1') {
  console.error('[AUTH GATE] 本脚本触发真实 LLM/TTS 付费调用。需负责人逐次授权：设置环境变量 E2E_REAL_APPROVED=1 后重跑。');
  process.exit(2);
}
import fs from 'node:fs';
import path from 'node:path';

const GATEWAY = 'http://localhost:3000';
const imgPath = process.argv[2];
if (!imgPath || !fs.existsSync(imgPath)) {
  console.error('[AUTH GATE] 用法：node apps/web/server/tests/video-dub/e2e-image-produce.mjs <图片绝对路径> [数量1-9]（不提供默认素材，避免误触真实出片）');
  process.exit(2);
}
const count = Math.max(1, Math.min(9, parseInt(process.argv[3] || '1', 10)));

function toDataUrl(p) {
  const ext = path.extname(p).slice(1).toLowerCase().replace('jpeg', 'jpg');
  const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
  return `data:${mime};base64,${fs.readFileSync(p).toString('base64')}`;
}

async function post(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function main() {
  const health = await (await fetch(`${GATEWAY}/api/v1/health`)).json();
  console.log('[E2E] 网关健康:', health.msg);

  const image = toDataUrl(imgPath);
  const up = await post(`${GATEWAY}/api/v1/upload/images`, { images: Array(count).fill(image) });
  if (up.code !== 0) throw new Error(`上传失败: ${up.msg}`);
  console.log(`[E2E] 上传成功 ${count} 张`);

  const produce = await post(`${GATEWAY}/api/v1/video/produce`, {
    imageCount: count,
    imagePaths: up.data.imagePaths,
    description: '手工烘焙可颂，每天现烤，酥脆掉渣，全家人都爱吃',
    title: '现烤可颂',
    scene: 'sell',
    mode: 'product',
  });
  if (produce.code !== 0) throw new Error(`出片提交失败: ${produce.msg}`);
  const taskId = produce.data.taskId;
  console.log(`[E2E] 任务已创建: ${taskId}`);

  const t0 = Date.now();
  let last = '';
  for (;;) {
    await new Promise((r) => setTimeout(r, 3000));
    const st = await (await fetch(`${GATEWAY}/api/v1/video/task/${taskId}`)).json();
    const d = st.data || {};
    const cur = `${d.progress}% ${d.stageText || ''}`;
    if (cur !== last) { console.log(`[E2E] ${cur} (${Math.round((Date.now() - t0) / 1000)}s)`); last = cur; }
    if (d.status === 'completed') {
      const outDir = path.join('storage/outputs', taskId);
      const okVideo = fs.existsSync(path.join(outDir, 'final.mp4'));
      const okCover = fs.existsSync(path.join(outDir, 'cover.jpg'));
      console.log(`[E2E] 完成 video=${okVideo} cover=${okCover} 耗时=${Math.round((Date.now() - t0) / 1000)}s`);
      console.log(`[E2E] 产物目录: ${outDir}`);
      process.exit(okVideo && okCover ? 0 : 2);
    }
    if (d.status === 'failed') { console.error(`[E2E] 任务失败: ${d.error || d.stageText}`); process.exit(1); }
    if (Date.now() - t0 > 600000) { console.error('[E2E] 轮询超时(10min)'); process.exit(3); }
  }
}

main().catch((e) => { console.error('[E2E] 异常:', e.message); process.exit(1); });
