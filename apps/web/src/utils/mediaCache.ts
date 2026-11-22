/**
 * Jansee 媒体资源与封面图离线持久缓存管理器
 * 遵循防巨石与纯底层解耦铁律，不碰任何视觉样式与 DOM 布局
 * 
 * 核心机制：
 * 1. 采用 CacheStorage（现代浏览器与移动端 WebView 原生标准）存储封面二进制 Blob，支持大容量与离线秒读
 * 2. 内存维护 ObjectURL 池与完成状态映射，实现组件重入与再进入 0ms 同步出图
 * 3. 智能并发控制与预加载队列，杜绝数十张封面同时请求打爆网络与渲染管道
 */

import { useEffect, useState } from "react";

const MEDIA_CACHE_NAME = "jansee-media-cache-v1";
const memoryUrlCache = new Map<string, string>();
const inflightRequests = new Map<string, Promise<string | null>>();

/**
 * 检查当前环境是否支持 CacheStorage
 */
function isCacheStorageAvailable(): boolean {
  return typeof window !== "undefined" && "caches" in window && typeof window.caches?.open === "function";
}

/**
 * 获取或缓存媒体资源（封面图片等）
 * 返回可直接赋给 img.src 的持久化 ObjectURL 或原始 URL
 */
export async function getOrCacheMediaUrl(rawUrl: string): Promise<string> {
  if (!rawUrl || typeof window === "undefined") return rawUrl;

  // 1. 命中内存映射，直接 0ms 返回
  const memoryHit = memoryUrlCache.get(rawUrl);
  if (memoryHit) return memoryHit;

  // 2. 命中并发去重队列，避免同一张封面多次发起 fetch
  const inflight = inflightRequests.get(rawUrl);
  if (inflight) {
    const res = await inflight;
    return res || rawUrl;
  }

  const fetchPromise = (async (): Promise<string | null> => {
    try {
      // 3. 检查 CacheStorage 离线持久化缓存
      if (isCacheStorageAvailable()) {
        const cache = await window.caches.open(MEDIA_CACHE_NAME);
        const match = await cache.match(rawUrl);
        if (match) {
          const blob = await match.blob();
          if (blob && blob.size > 0) {
            const objectUrl = URL.createObjectURL(blob);
            memoryUrlCache.set(rawUrl, objectUrl);
            return objectUrl;
          }
        }

        // 4. 发起网络请求获取图片 Blob 并写回 CacheStorage
        const res = await fetch(rawUrl, { credentials: "include" });
        if (res.ok) {
          const clone = res.clone();
          void cache.put(rawUrl, clone).catch(() => undefined);
          const blob = await res.blob();
          if (blob && blob.size > 0) {
            const objectUrl = URL.createObjectURL(blob);
            memoryUrlCache.set(rawUrl, objectUrl);
            return objectUrl;
          }
        }
      } else {
        // 不支持 CacheStorage 的极端宿主环境降级走常规 fetch Blob
        const res = await fetch(rawUrl, { credentials: "include" });
        if (res.ok) {
          const blob = await res.blob();
          if (blob && blob.size > 0) {
            const objectUrl = URL.createObjectURL(blob);
            memoryUrlCache.set(rawUrl, objectUrl);
            return objectUrl;
          }
        }
      }
    } catch {
      // 网络错误降级返回原始 rawUrl
    }
    return null;
  })();

  inflightRequests.set(rawUrl, fetchPromise);
  try {
    const finalUrl = await fetchPromise;
    return finalUrl || rawUrl;
  } finally {
    inflightRequests.delete(rawUrl);
  }
}

/**
 * 同步检查内存是否已有缓存好的 ObjectURL（用于 React 初始渲染 0ms 秒出）
 */
export function getSyncMediaCache(rawUrl?: string | null): string | null {
  if (!rawUrl) return null;
  return memoryUrlCache.get(rawUrl) ?? null;
}

/**
 * 批量预热封面缓存列表（空闲时段静默执行）
 */
export function preloadMediaUrls(urls: (string | null | undefined)[]): void {
  if (typeof window === "undefined") return;
  const validUrls = Array.from(new Set(urls.filter((u): u is string => typeof u === "string" && u.trim().length > 0)));
  if (validUrls.length === 0) return;

  const runner = async () => {
    // 每次并发最多 3 个，避免占用视频推流或接口带宽
    for (let i = 0; i < validUrls.length; i += 3) {
      const chunk = validUrls.slice(i, i + 3);
      await Promise.allSettled(chunk.map((u) => getOrCacheMediaUrl(u)));
    }
  };

  if ("requestIdleCallback" in window) {
    (window as unknown as { requestIdleCallback: (cb: () => void) => void }).requestIdleCallback(() => {
      void runner();
    });
  } else {
    setTimeout(() => {
      void runner();
    }, 120);
  }
}

/**
 * React Hook：加载并消费本地持久化缓存的图片 URL
 * 特性：
 * - 如果内存已有，首次渲染直接出图，0 白屏、0 转圈
 * - 否则后台拉取 CacheStorage 并写入，完成后更新状态
 */
export function useCachedMediaUrl(rawUrl?: string | null): string | undefined {
  const [resolvedUrl, setResolvedUrl] = useState<string | undefined>(() => {
    if (!rawUrl) return undefined;
    return memoryUrlCache.get(rawUrl) || rawUrl;
  });

  useEffect(() => {
    if (!rawUrl) {
      setResolvedUrl(undefined);
      return;
    }

    // 内存已命中
    const hit = memoryUrlCache.get(rawUrl);
    if (hit) {
      setResolvedUrl(hit);
      return;
    }

    let active = true;
    getOrCacheMediaUrl(rawUrl).then((url) => {
      if (active && url) {
        setResolvedUrl(url);
      }
    }).catch(() => {
      if (active) setResolvedUrl(rawUrl);
    });

    return () => {
      active = false;
    };
  }, [rawUrl]);

  return resolvedUrl;
}

