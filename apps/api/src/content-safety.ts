const SENSITIVE_TERMS = [
  "色情", "裸聊", "约炮", "卖淫", "嫖娼", "援交", "一夜情", "成人影视", "黄色网站", "黄片",
  "三级片", "淫荡", "骚货", "AV视频", "桃色", "情色交易", "催情水", "迷药",
  "暴力", "砍人", "杀人", "血腥", "爆炸", "恐怖袭击", "枪击", "绑架", "殴打", "群殴",
  "枪支弹药", "军用手枪", "管制刀具", "毒品", "大麻", "冰毒", "海洛因", "K粉",
  "颠覆国家", "造反", "暴动", "游行示威", "法轮功", "反动言论", "翻墙梯子", "科学上网", "内幕爆料",
  "赌博平台", "博彩网站", "澳门赌场", "六合彩特码", "网络彩票", "网络诈骗", "洗钱水钱", "传销模式",
  "资金盘", "刷单返利", "高返兼职", "跑分兼职", "裸聊敲诈",
  "国家级", "世界级", "最高级", "顶级工艺", "第一品牌", "全网首创绝无仅有", "包治百病", "药到病除",
  "专治绝症", "百分之百有效", "假一赔万",
] as const;

function collectStrings(value: unknown, output: string[], depth: number): void {
  if (depth > 8 || output.join("").length > 30_000) return;
  if (typeof value === "string") {
    output.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, output, depth + 1);
    return;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) {
      collectStrings(item, output, depth + 1);
    }
  }
}

/** V2 local risk-word screen, migrated as a preflight check; not a complete moderation system. */
export function detectSensitiveTerms(value: unknown): string[] {
  const parts: string[] = [];
  collectStrings(value, parts, 0);
  const normalized = parts.join("\n").normalize("NFKC").replace(/\s+/gu, "");
  return SENSITIVE_TERMS.filter((term) =>
    normalized.includes(term.normalize("NFKC").replace(/\s+/gu, "")),
  );
}