// 简兮 V2 · 6 组不同变体案例出片验收（同一组六张图，2 并发 × 3 批节奏）
// 用法：node scripts/run-six-productions.mjs （需 3000 网关已启动）
// 输出：scratch/six-results.json（每个任务的变体、时长、状态、时间线）
import fs from 'node:fs';

const BASE = 'http://localhost:3000';
const IMAGES = [
  'f:\\janseeV2\\storage\\uploads\\bakery_1.jpg',
  'f:\\janseeV2\\storage\\uploads\\breakfast_1.jpg',
  'f:\\janseeV2\\storage\\uploads\\cafe_1.jpg',
  'f:\\janseeV2\\storage\\uploads\\cake_1.jpg',
  'f:\\janseeV2\\storage\\uploads\\coffee_1.jpg',
  'f:\\janseeV2\\storage\\uploads\\dessert_1.jpg',
];

// 6 组案例：文案各自携带明确的变体信号，用于检验变体导演路由是否命中不同类型
const CASES = [
  { key: 'c1-trust',  title: '二手单反相机 95新 质检保障', desc: '这台相机九成新，官方质检报告齐全，90天质保，专业卖家可信，高客单放心入手。' },
  { key: 'c2-flash',  title: '纸巾整箱 9块9 限量秒杀',     desc: '9块9一整箱抽纸，今天限时秒杀，抢完就没，赶紧囤货。' },
  { key: 'c3-number', title: '39元3件 收纳盒超值',         desc: '39元带走3件收纳盒，一件才13块，比超市便宜一半，立省50%。' },
  { key: 'c4-tutor',  title: '三步搞定元气早餐三明治',     desc: '三步教你做早餐三明治：一抹酱、二叠料、三压热压，3分钟开吃。' },
  { key: 'c5-gift',   title: '咖啡礼盒 送长辈超有面子',     desc: '这款咖啡礼盒送长辈特别有面子，礼盒包装高级，节日心意满分。' },
  { key: 'c6-avoid',  title: '买蛋糕别再踩坑了',           desc: '买蛋糕千万别乱买，90%的人都踩过坑，教你三招避雷不花冤枉钱。' },
];

async function produce(c, batch) {
  const submittedAt = new Date().toISOString();
  try {
    const res = await fetch(BASE + '/api/v1/video/produce', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        description: c.desc,
        title: c.title,
        scene: 'sell',
        mode: 'product',
        imagePaths: IMAGES,
        imageCount: IMAGES.length,
      }),
    });
    const j = await res.json();
    return { key: c.key, title: c.title, batch, taskId: j?.data?.taskId || null, submittedAt, raw: j };
  } catch (e) {
    return { key: c.key, title: c.title, batch, taskId: null, submittedAt, error: e.message };
  }
}

async function pollOne(rec) {
  const started = Date.now();
  for (let i = 0; i < 240; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    try {
      const r = await fetch(`${BASE}/api/v1/video/task/${rec.taskId}`);
      const j = await r.json();
      const t = j?.data || {};
      const status = String(t.status || '').toLowerCase();
      if (['completed', 'done', 'success', 'failed', 'error'].includes(status)) {
        return {
          elapsedSec: Math.round((Date.now() - started) / 1000),
          status,
          variantType: t.variantType ?? t.variant_type ?? null,
          duration: t.duration ?? null,
          videoUrl: t.videoUrl ?? null,
          emotion: t.emotion ?? null,
          stageText: t.stageText ?? null,
        };
      }
    } catch {}
  }
  return { elapsedSec: Math.round((Date.now() - started) / 1000), status: 'timeout' };
}

const results = [];
for (let b = 0; b < 3; b++) {
  const batchCases = CASES.slice(b * 2, b * 2 + 2);
  const batchStart = new Date().toISOString();
  console.log(`[BATCH ${b + 1}] 并发提交 2 个任务: ${batchCases.map((c) => c.key).join(' + ')} @ ${batchStart}`);
  const submitted = await Promise.all(batchCases.map((c) => produce(c, b + 1)));
  results.push(...submitted);
  const done = await Promise.all(submitted.map((s) => pollOne(s)));
  submitted.forEach((s, i) => { s.result = done[i]; });
  console.log(`[BATCH ${b + 1}] 结果: ${JSON.stringify(done.map((d, i) => ({ key: submitted[i].key, status: d.status, variant: d.variantType, dur: d.duration, sec: d.elapsedSec })))}`);
}

fs.writeFileSync(new URL('../scratch/six-results.json', import.meta.url), JSON.stringify(results, null, 2));
console.log('ALL-DONE');
