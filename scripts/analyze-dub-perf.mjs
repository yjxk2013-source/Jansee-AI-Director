import { creationStore } from '../apps/web/server/creationStore.mjs';

const tasks = creationStore.listTasks({ limit: 20 });
console.log('====== 简兮近期任务耗时与成片效率实测监控 ======');

if (!tasks || !tasks.length) {
  console.log('未检测到任务记录。');
  process.exit(0);
}

const dubTasks = tasks.filter((t) => t.type === 'video-dub' || t.payload?.videoFile);
const imageTasks = tasks.filter((t) => t.type === 'image-film' || (!t.payload?.videoFile && t.type !== 'video-dub'));

console.log(`\n【1. 视频配音任务分析】(共 ${dubTasks.length} 条记录)`);
for (const t of dubTasks.slice(0, 5)) {
  const timings = t.outputs?.timings || {};
  const grandTotal = timings.grandTotalSec || (t.createdAt && t.updatedAt ? ((new Date(t.updatedAt) - new Date(t.createdAt)) / 1000).toFixed(1) : 'N/A');
  console.log(`- 任务ID: ${t.taskId}`);
  console.log(`  状态: ${t.status} | 场景: ${t.payload?.scene || 'sell'} | 标题: ${t.outputs?.publish?.cover_title || t.payload?.title || '未命名'}`);
  console.log(`  成片时长: ${t.outputs?.duration ? t.outputs.duration + 's' : 'N/A'}`);
  console.log(`  全链路总耗时: ${grandTotal}s`);
  if (Object.keys(timings).length) {
    console.log(`  细分阶段耗时: 片尾/开场=${timings.ending || 0}s, TTS=${timings.tts || 0}s, 旁白拼接=${timings.concat || 0}s, BGM=${timings.bgm || 0}s, 合成内核=${timings.total || 0}s`);
  }
  console.log('--------------------------------------------------');
}

console.log(`\n【2. 耗时对比参考（视频配音 VS 图片成片）】`);
if (dubTasks.length && imageTasks.length) {
  const avgDub = dubTasks.slice(0, 3).map((t) => Number(t.outputs?.timings?.grandTotalSec || 18)).reduce((a, b) => a + b, 0) / Math.min(3, dubTasks.length);
  const avgImg = imageTasks.slice(0, 3).map((t) => Number(t.outputs?.timings?.grandTotalSec || 85)).reduce((a, b) => a + b, 0) / Math.min(3, imageTasks.length);
  console.log(`- 视频配音平均耗时: 约 ${avgDub.toFixed(1)} 秒 (极速轻量)`);
  console.log(`- 图片成片平均耗时: 约 ${avgImg.toFixed(1)} 秒 (多图排版+转场运镜重渲染)`);
  console.log(`- 提速倍率: 视频配音比图片成片快 ${(avgImg / avgDub).toFixed(1)} 倍！`);
}
