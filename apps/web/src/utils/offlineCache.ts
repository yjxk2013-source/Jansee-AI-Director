/**
 * Jansee SWR & 离线持久化缓存管理器
 * 遵循防巨石原则与纯数据层解耦规范
 * 作用：实现 App / Web 启动 0ms 秒开，优先读旧缓存渲染首屏，后台静默校准拉取
 */

export const CACHE_KEYS = {
  AUTH_USER: "jansee.v4.cache.auth-user",
  WALLET_SNAPSHOT: "jansee.v4.cache.wallet-snapshot",
  WORKS_LIST_PREFIX: "jansee.v4.cache.works:",
  RECENT_WORKS: "jansee.v4.cache.recent-works",
  CREATIVE_DRAFT: "jansee.v4.cache.creative-draft",
} as const;

/**
 * 读取本地缓存（带类型守卫与容错）
 */
export function getLocalCache<T>(key: string): T | null {
  if (typeof window === "undefined" || !window.localStorage) return null;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed as T;
  } catch {
    return null;
  }
}

/**
 * 写入本地缓存（安全捕获 QuotaExceededError）
 */
export function setLocalCache<T>(key: string, data: T): void {
  if (typeof window === "undefined" || !window.localStorage) return;
  try {
    window.localStorage.setItem(key, JSON.stringify(data));
  } catch {
    // 忽略配额超限或无痕浏览模式写入异常
  }
}

/**
 * 移除指定缓存
 */
export function removeLocalCache(key: string): void {
  if (typeof window === "undefined" || !window.localStorage) return;
  try {
    window.localStorage.removeItem(key);
  } catch {
    // ignore
  }
}

/**
 * 获取特定用户的作品列表缓存 Key
 */
export function getWorksCacheKey(userId?: string | null): string {
  return `${CACHE_KEYS.WORKS_LIST_PREFIX}${userId || "guest"}`;
}
