// E1 stub：asr.js 替身（仅导出消费方使用的 runASR；slicer.js/dub.js 在本测试中不被触发）
// 返回与 runKeepOriginalAsr 消费结构一致的伪识别结果：words 由真实 keepOriginal 层叠加强集填充词标记
export async function runASR(audioPath, workDir) {
  const { mkdir } = await import('node:fs/promises');
  await mkdir(workDir, { recursive: true });
  return {
    text: '大家好 今天 呃 给大家 介绍 一个 特别好的 产品',
    words: [
      { word: '大家好', start: 0.20, end: 0.80 },
      { word: '今天', start: 0.85, end: 1.10 },
      { word: '呃', start: 1.15, end: 1.35 },
      { word: '给大家', start: 1.40, end: 1.70 },
      { word: '介绍', start: 1.75, end: 2.00 },
      { word: '一个', start: 2.05, end: 2.25 },
      { word: '特别好的', start: 2.30, end: 2.60 },
      { word: '产品', start: 2.65, end: 2.95 },
    ],
    segments: [{ start: 0.2, end: 2.95, text: '大家好 今天 呃 给大家 介绍 一个 特别好的 产品' }],
    duration: 2.95,
    model: 'e2e-stub',
  };
}
