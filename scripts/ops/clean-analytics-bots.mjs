#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

// 已知在 Nginx 日志中证实为 Googlebot / Bingbot / 自动化机房探针的海外数据中心标识
const BOT_REGION_KEYWORDS = [
  'Austria',
  'Netherlands',
  'United States / Virginia',
  'United States / Oregon',
  'United States / New Jersey',
];

export function cleanAnalyticsDb(rawDb) {
  const db = JSON.parse(JSON.stringify(rawDb));
  let removedVisitorsCount = 0;
  let removedPvCount = 0;

  for (const [dayKey, bucket] of Object.entries(db.days || {})) {
    const originalVisitors = bucket.visitors || [];
    const visitorRegions = bucket.visitorRegions || {};
    
    // 找出匹配机房关键词的机器访客哈希
    const botVisitorHashes = new Set();
    for (const [hash, region] of Object.entries(visitorRegions)) {
      if (BOT_REGION_KEYWORDS.some((kw) => region.includes(kw))) {
        botVisitorHashes.add(hash);
      }
    }

    if (botVisitorHashes.size === 0) continue;

    // 过滤访客列表
    const cleanedVisitors = originalVisitors.filter((h) => !botVisitorHashes.has(h));
    const deltaVisitors = originalVisitors.length - cleanedVisitors.length;
    removedVisitorsCount += deltaVisitors;
    bucket.visitors = cleanedVisitors;

    // 清理 visitorRegions
    for (const botHash of botVisitorHashes) {
      delete bucket.visitorRegions[botHash];
    }

    // 对应扣减 PV（每个机器人访客通常产生 1~2 次 PV）
    const pvDeduction = Math.min(bucket.pv, deltaVisitors);
    bucket.pv = Math.max(0, bucket.pv - pvDeduction);
    removedPvCount += pvDeduction;

    // 清理 active 缓存
    for (const botHash of botVisitorHashes) {
      if (db.active && db.active[botHash]) {
        delete db.active[botHash];
      }
    }
  }

  return {
    cleanedDb: db,
    removedVisitorsCount,
    removedPvCount,
  };
}

// CLI 执行逻辑
if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const targetFile = process.argv[2];
  if (!targetFile) {
    console.error('用法: node clean-analytics-bots.mjs <site-analytics.json路径>');
    process.exit(1);
  }

  if (!fs.existsSync(targetFile)) {
    console.error(`文件不存在: ${targetFile}`);
    process.exit(1);
  }

  const raw = JSON.parse(fs.readFileSync(targetFile, 'utf8'));
  const bakFile = `${targetFile}.bak-${Date.now()}`;
  fs.copyFileSync(targetFile, bakFile);
  console.log(`[数据备份] 已备份至: ${bakFile}`);

  const { cleanedDb, removedVisitorsCount, removedPvCount } = cleanAnalyticsDb(raw);
  fs.writeFileSync(targetFile, JSON.stringify(cleanedDb), 'utf8');

  console.log(`[清洗完成] 成功剔除搜索引擎与自动化机房爬虫访客 ${removedVisitorsCount} 个，剔除虚高 PV ${removedPvCount} 次。`);
}
