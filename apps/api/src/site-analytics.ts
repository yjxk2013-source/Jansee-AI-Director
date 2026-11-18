import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { resolveRegistrationRegion } from "./geo.js";

const RETENTION_DAYS = 90;
const ACTIVE_ADMIN_IPS = new Map<string, number>();
const SELF_IP_PREFIXES = String(process.env.JX_ANALYTICS_SELF_IPS || "117.174.,117.176.,117.136.")
  .split(",").map((value) => value.trim()).filter(Boolean);
const VISIT_SCHEMA = z.object({
  visitorId: z.string().regex(/^[a-zA-Z0-9_-]{16,80}$/),
  path: z.string().max(512).optional(),
  referrer: z.string().max(2048).optional(),
  utmSource: z.string().max(100).optional(),
  verifiedBy: z.enum(["mousemove", "scroll", "touch", "click", "keydown", "dwell_4s", "interval"]),
  dwellMs: z.number().int().min(0).max(60000).optional(),
  event: z.enum(["pageview", "heartbeat"]).optional(),
}).strict();

let lastPrunedDay = "";

export function recordAdminAnalyticsIp(ip: string): void {
  const value = String(ip || "").trim();
  if (value) ACTIVE_ADMIN_IPS.set(value, Date.now() + 24 * 60 * 60 * 1000);
}

export function isExcludedAnalyticsNetwork(ip: string): boolean {
  const value = String(ip || "").trim().toLowerCase();
  if (!value) return false;
  const adminExpiry = ACTIVE_ADMIN_IPS.get(value);
  if (adminExpiry) {
    if (adminExpiry > Date.now()) return true;
    ACTIVE_ADMIN_IPS.delete(value);
  }
  if (SELF_IP_PREFIXES.some((prefix) => value.startsWith(prefix.toLowerCase()))) return true;
  return value === "::1" || value === "localhost" || value.startsWith("127.") ||
    value.startsWith("10.") || value.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(value) || value.startsWith("169.254.") ||
    value.startsWith("fc") || value.startsWith("fd") || value.startsWith("fe80:");
}

export function isBotAnalyticsUserAgent(ua: string): boolean {
  const value = String(ua || "").toLowerCase();
  if (!value) return true;
  const botTokens = [
    "bot", "spider", "crawl", "headless", "python", "curl", "wget", "bytespider",
    "yisouspider", "semrush", "ahrefs", "censys", "shodan", "zoomeye", "zgrab",
    "netcraft", "scanner", "nmap", "masscan", "nuclei", "acunetix", "nikto",
    "sqlmap", "paloalto", "expanse", "l9explore", "cyberconvoy", "pentest",
    "go-http-client", "httpclient", "scrapy", "slurp", "seek", "mediapartners",
    "lighthouse", "preview", "scraper", "bingpreview", "feed", "feedfetcher",
    "apache-httpclient", "aweme", "bytedance", "toutiao", "internetmeasurement", "indexnow",
  ];
  if (botTokens.some((token) => value.includes(token))) return true;
  if (/^mozilla\/5\.0$/.test(value.trim())) return true;
  return !/(windows nt|macintosh|iphone|ipad|android|cros|linux|x11)/i.test(ua);
}

function dayKey(timestamp = Date.now()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date(timestamp));
  const pick = (type: string) => parts.find((part) => part.type === type)?.value || "00";
  return `${pick("year")}-${pick("month")}-${pick("day")}`;
}

function safePath(value: unknown): string {
  try {
    const pathname = new URL(String(value || "/"), "https://jansee.cn").pathname;
    if (!pathname.startsWith("/") || pathname.startsWith("/api/") || pathname.startsWith("/admin")) return "/";
    return pathname.slice(0, 180);
  } catch { return "/"; }
}

function sourceName(referrer: unknown, utmSource: unknown): string {
  const raw = String(utmSource || "").trim().toLowerCase();
  const host = (() => {
    try { return new URL(String(referrer || "")).hostname.toLowerCase().replace(/^www\./, ""); }
    catch { return ""; }
  })();
  const value = raw || host;
  if (!value) return "直接访问";
  const labels: Array<[string[], string]> = [
    [["baidu"], "百度"], [["google"], "Google"], [["bing"], "Bing"], [["sogou"], "搜狗"],
    [["so.com"], "360 搜索"], [["chatgpt", "openai"], "ChatGPT"], [["deepseek"], "DeepSeek"],
    [["doubao"], "豆包"], [["yuanbao"], "腾讯元宝"], [["kimi"], "Kimi"],
    [["qwen", "tongyi"], "通义千问"], [["gemini"], "Gemini"], [["claude"], "Claude"],
    [["perplexity", "poe"], "其他 AI 平台"], [["zhihu"], "知乎"], [["toutiao"], "今日头条"],
    [["weixin", "wechat"], "微信/公众号"], [["douyin"], "抖音"],
    [["xiaohongshu", "xhslink"], "小红书"], [["weibo"], "微博"], [["qq.com"], "QQ"],
    [["jansee.cn"], "站内访问"],
  ];
  for (const [tokens, label] of labels) if (tokens.some((token) => value.includes(token))) return label;
  return (host || raw).slice(0, 48);
}

function deviceName(ua: string): string {
  if (/iPad|Tablet|PlayBook|Silk/i.test(ua)) return "平板";
  if (/Mobile|Android|iPhone|iPod/i.test(ua)) return "手机";
  return "电脑";
}

function browserName(ua: string): string {
  if (/Edg\//i.test(ua)) return "Edge";
  if (/Chrome\//i.test(ua)) return "Chrome";
  if (/Safari\//i.test(ua) && !/Chrome\//i.test(ua)) return "Safari";
  if (/Firefox\//i.test(ua)) return "Firefox";
  return "其他浏览器";
}

function increment(target: Record<string, number>, label: string): void {
  target[label] = (Number(target[label]) || 0) + 1;
}

function emptyBreakdown() {
  return { pages: {} as Record<string, number>, sources: {} as Record<string, number>, regions: {} as Record<string, number>, devices: {} as Record<string, number>, browsers: {} as Record<string, number> };
}

async function pruneOldAnalytics(client: PoolClient, today: string): Promise<void> {
  if (lastPrunedDay === today) return;
  await client.query("DELETE FROM site_daily_analytics_visitors WHERE day < CURRENT_DATE - $1::int", [RETENTION_DAYS]);
  await client.query("DELETE FROM site_daily_analytics WHERE day < CURRENT_DATE - $1::int", [RETENTION_DAYS]);
  lastPrunedDay = today;
}

export function registerSiteAnalyticsRoutes(app: FastifyInstance, pool: Pool): void {
  app.post("/api/v1/site-analytics/visit", {
    config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
  }, async (request, reply) => {
    const ua = String(request.headers["user-agent"] || "");
    if (isBotAnalyticsUserAgent(ua)) return reply.code(202).send({ accepted: false, reason: "bot_ignored" });
    const parsed = VISIT_SCHEMA.safeParse(request.body);
    if (!parsed.success) return reply.code(202).send({ accepted: false, reason: "unverified_human_action" });
    const payload = parsed.data;
    if (payload.verifiedBy === "dwell_4s" && Number(payload.dwellMs || 0) < 3500) {
      return reply.code(202).send({ accepted: false, reason: "insufficient_dwell_time" });
    }
    const ip = request.ip;
    if (isExcludedAnalyticsNetwork(ip)) return reply.code(202).send({ accepted: false, reason: "network_ignored" });
    const event = payload.event === "heartbeat" ? "heartbeat" : "pageview";
    const visitorHash = createHash("sha256").update(payload.visitorId).digest("hex").slice(0, 32);
    const day = dayKey();
    const geo = resolveRegistrationRegion(ip);
    const region = [geo.province, geo.city].filter(Boolean).join(" / ").slice(0, 80) || "地区待识别";
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const inserted = await client.query(
        `INSERT INTO site_daily_analytics_visitors (day,visitor_hash,region,last_seen_at)
         VALUES ($1,$2,$3,now())
         ON CONFLICT (day,visitor_hash) DO NOTHING
         RETURNING visitor_hash`,
        [day, visitorHash, region],
      );
      const isNewVisitor = (inserted.rowCount ?? 0) > 0;
      if (!isNewVisitor) {
        await client.query(
          "UPDATE site_daily_analytics_visitors SET last_seen_at=now(), region=CASE WHEN region='地区待识别' THEN $3 ELSE region END WHERE day=$1 AND visitor_hash=$2",
          [day, visitorHash, region],
        );
      }
      if (event === "pageview") {
        const current = await client.query(
          "SELECT breakdown FROM site_daily_analytics WHERE day=$1 FOR UPDATE",
          [day],
        );
        const breakdown = current.rows[0]?.breakdown && typeof current.rows[0].breakdown === "object"
          ? current.rows[0].breakdown as ReturnType<typeof emptyBreakdown>
          : emptyBreakdown();
        for (const key of ["pages", "sources", "regions", "devices", "browsers"] as const) {
          if (!breakdown[key] || typeof breakdown[key] !== "object") breakdown[key] = {};
        }
        increment(breakdown.pages, safePath(payload.path));
        increment(breakdown.sources, sourceName(payload.referrer, payload.utmSource));
        increment(breakdown.devices, deviceName(ua));
        increment(breakdown.browsers, browserName(ua));
        if (isNewVisitor) increment(breakdown.regions, region);
        await client.query(
          `INSERT INTO site_daily_analytics (day,pv,uv,breakdown,source)
           VALUES ($1,1,$2,$3::jsonb,'v4-human-verified')
           ON CONFLICT (day) DO UPDATE SET
             pv=site_daily_analytics.pv+1,
             uv=site_daily_analytics.uv+EXCLUDED.uv,
             breakdown=EXCLUDED.breakdown,
             source='v4-human-verified',
             imported_at=now()`,
          [day, isNewVisitor ? 1 : 0, JSON.stringify(breakdown)],
        );
      }
      await pruneOldAnalytics(client, day);
      await client.query("COMMIT");
      return reply.code(202).send({ accepted: true });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      request.log.error({ err: error }, "site analytics event failed");
      return reply.code(503).send({ accepted: false, reason: "storage_unavailable" });
    } finally { client.release(); }
  });
}
