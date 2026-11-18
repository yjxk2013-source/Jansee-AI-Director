import { createHash } from "node:crypto";
import type { CreationMode } from "@jansee/contracts";
// @ts-expect-error prompts/index.js is plain JS module
import { decideVariantLocal, SELL_VARIANT_TYPES, LOCAL_VARIANT_TYPES } from "../prompts/index.js";
import { detectCreationScene } from "./prompt-assembly.js";

/** 多版成片（批量赛马）单次上限：对齐 V2 BATCH_VERSION_LIMIT。 */
export const BATCH_VERSION_LIMIT = 10;
/** 关键词命中（如“赛马”）但未指明版数时的默认版数。 */
export const BATCH_DEFAULT_TOTAL = 3;

const BATCH_UNIT_PATTERN = "(?:个版本|个方案|个视频|个不同|版|条|轮)";

const CHINESE_NUMERAL_MAP: Record<string, number> = {
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10,
};

const BATCH_KEYWORD_PATTERN = /赛马|多版|批量|不同版本|几个版本|一版一个风格|多个版本/;

function clampVersionCount(raw: number): number {
  if (!Number.isFinite(raw) || raw < 1) return 1;
  return Math.min(BATCH_VERSION_LIMIT, Math.floor(raw));
}

/**
 * 从用户创作文本（语音转写或手打）解析批量赛马版数。
 * 匹配顺序：阿拉伯数字+单位 → 中文数字+单位 → 关键词默认 3 版 → 未命中 1 版。
 * 场景前缀（"User-selected creation scene: …"）先剥离，避免场景词干扰数字匹配；
 * personal 场景没有变体体系，命中即强制降为单版。
 */
export function parseBatchVersions(text: string, mode: CreationMode = "image-film"): { total: number; matched: boolean } {
  const cleanText = String(text || "")
    .replace(/User-selected creation scene:\s*(online-ecommerce|physical-store|personal-creation)\.?/gi, "")
    .trim();
  if (!cleanText) return { total: 1, matched: false };
  if (detectCreationScene(String(text), mode) === "personal-creation") {
    return { total: 1, matched: false };
  }

  const arabic = cleanText.match(new RegExp(`(\\d{1,3})\\s*${BATCH_UNIT_PATTERN}`));
  if (arabic) {
    return { total: clampVersionCount(Number(arabic[1])), matched: true };
  }

  const chinese = cleanText.match(new RegExp(`([一二两三四五六七八九十])\\s*${BATCH_UNIT_PATTERN}`));
  if (chinese && chinese[1] && chinese[1] in CHINESE_NUMERAL_MAP) {
    return { total: clampVersionCount(CHINESE_NUMERAL_MAP[chinese[1]] ?? 1), matched: true };
  }

  if (BATCH_KEYWORD_PATTERN.test(cleanText)) {
    return { total: BATCH_DEFAULT_TOTAL, matched: true };
  }

  return { total: 1, matched: false };
}

/**
 * 由客户端幂等键确定性派生批量第 index 版的幂等键。
 * generation_jobs.idempotency_key 是 uuid 列（0001_initial.sql），且 UNIQUE(user_id, idempotency_key)；
 * 必须用确定性派生（同 clientKey + index 恒同值），客户端重试批量请求才不会重复创建与重复扣费。
 */
export function deriveBatchIdempotencyKey(clientKey: string, index: number): string {
  const digest = createHash("sha256").update(`${clientKey}#v${index}`).digest("hex").slice(0, 32);
  return [
    digest.slice(0, 8),
    digest.slice(8, 12),
    `5${digest.slice(13, 16)}`,
    ([8, 9, "a", "b"] as const)[parseInt(digest.slice(16, 17), 16) % 4] + digest.slice(17, 20),
    digest.slice(20, 32),
  ].join("-");
}

/**
 * 批量赛马变体分配：逐版排重，保证批内尽量不重复。
 * 三段兜底：强信号命中排重 → 池内未用首位 → 池耗尽轮转复用（local 池 8 个 < 10 版时末版允许复用）。
 * 返回长度为 total 的数组；场景无变体体系时由调用方传空池/自行降级。
 */
export function assignBatchVariants(prompt: string, scene: "sell" | "local", total: number): string[] {
  const pool: string[] = (scene === "local" ? LOCAL_VARIANT_TYPES : SELL_VARIANT_TYPES) as string[];
  const used: string[] = [];
  const assignments: string[] = [];
  for (let index = 0; index < total; index += 1) {
    const signalHit = decideVariantLocal(prompt, scene, used);
    const fallback = pool.find((type) => !used.includes(type));
    const variant = signalHit || fallback || pool[index % pool.length] || "";
    assignments.push(variant);
    if (variant) used.push(variant);
  }
  return assignments;
}
