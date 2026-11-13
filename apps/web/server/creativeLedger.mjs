// 简兮后端 · creativeLedger.mjs —— 创作防重账本（LLM 导演跨任务差异化上下文）
// 背景（2026-10-12 定版）：视觉/听觉资源此前无跨任务轮流机制，连续出片易观感趋同。
// 本账本记录最近成片的变体与 BGM 情绪（V2 时代的 opening/ending/visual_design 已随
// 死字段清理移除——V7 宪法起视觉全由系统装配，LLM 不再输出这些字段），由 director.mjs
// 注入 LLM prompt 作为「刻意差异化」上下文——只提示不强制，不约束导演创作自由。
// 账本落盘 DATA_DIR/creative_ledger.json，保留最近 20 条防无限膨胀；任何异常静默吞掉，
// 账本读写失败绝不影响出片主流程。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './paths.mjs';

const LEDGER_FILE = path.join(DATA_DIR, 'creative_ledger.json');
const MAX_ENTRIES = 20;

/** 任务完成时记录本片全局创意决策（creation 完成点调用，静默吞错） */
export function recordCreative(script = {}) {
  try {
    const entries = readAll();
    entries.push({
      ts: new Date().toISOString(),
      variant_type: String(script.variant_type || '').trim(),
      bgm_emotion: String(script.bgm_emotion || '').trim(),
    });
    while (entries.length > MAX_ENTRIES) entries.shift();
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(LEDGER_FILE, JSON.stringify(entries, null, 2), 'utf8');
  } catch (e) {
    console.warn(`[CREATIVE LEDGER] 记录失败（不影响出片）: ${e.message}`);
  }
}

/** 最近 n 条创意决策（最近在前），供导演 prompt 注入差异化上下文 */
export function recentCreative(n = 3) {
  try {
    const entries = readAll();
    return entries.slice(-Math.max(1, n)).reverse();
  } catch {
    return [];
  }
}

function readAll() {
  try {
    const arr = JSON.parse(fs.readFileSync(LEDGER_FILE, 'utf8'));
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}
