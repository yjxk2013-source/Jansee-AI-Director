/**
 * Jansee 成片视频 · 设备端持久缓存管理器
 * 遵循防巨石与纯底层解耦铁律，不碰任何视觉样式与 DOM 布局。
 *
 * 目标：用户反复回看同一条成片时，直接走本机缓存播放 ——
 *      0 服务器带宽、0 CDN 流量、0 卡顿。
 *
 * 策略：
 * 1. 只有用户"真正看过"（播放到一定时长或播完）才落盘，绝不预热式批量下载，
 *    避免无人观看的成片白白占用服务器带宽；
 * 2. 上限 10 条 + 30 天自动清理（按最先存入的顺序淘汰）；
 * 3. 存储介质为 CacheStorage（与封面缓存同源机制），读取时经 ObjectURL 秒出，
 *    播放过程不再发起任何网络请求。
 *
 * 注意：缓存名不以 "jansee-v4-shell-" 开头，避免被 Service Worker 的版本清理误删。
 */

import { useCallback, useEffect, useRef, useState } from "react";

const VIDEO_CACHE_NAME = "jansee-media-video-cache-v1";
const VIDEO_INDEX_KEY = "jansee-video-cache-index-v1";
const MAX_VIDEO_ENTRIES = 10;
const MAX_VIDEO_AGE_MS = 30 * 24 * 60 * 60 * 1000;

type VideoCacheIndex = Record<string, { size: number; storedAt: number }>;

function isCacheStorageAvailable(): boolean {
  return typeof window !== "undefined" && "caches" in window && typeof window.caches?.open === "function";
}

function readIndex(): VideoCacheIndex {
  try {
    const raw = window.localStorage.getItem(VIDEO_INDEX_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object") return parsed as VideoCacheIndex;
  } catch {
    // 隐私模式或存储异常时退回空索引
  }
  return {};
}

function writeIndex(index: VideoCacheIndex): void {
  try {
    window.localStorage.setItem(VIDEO_INDEX_KEY, JSON.stringify(index));
  } catch {
    // 写失败不影响播放（仅影响淘汰顺序）
  }
}

/** 清理：过期（>30 天）优先删除，其次按存入顺序淘汰至 10 条以内。 */
async function evictVideoCache(cache: Cache, index: VideoCacheIndex): Promise<void> {
  const now = Date.now();
  const entries = Object.entries(index).sort((a, b) => a[1].storedAt - b[1].storedAt);
  const survivors = entries.filter(([, meta]) => now - meta.storedAt <= MAX_VIDEO_AGE_MS);
  const expired = entries.filter(([, meta]) => now - meta.storedAt > MAX_VIDEO_AGE_MS);
  const overflow = survivors.length > MAX_VIDEO_ENTRIES
    ? survivors.slice(0, survivors.length - MAX_VIDEO_ENTRIES)
    : [];

  for (const [url] of [...expired, ...overflow]) {
    await cache.delete(url).catch(() => undefined);
    delete index[url];
  }
  writeIndex(index);
}

let maintenanceScheduled = false;

/** 应用启动时静默执行一次过期/超量清理（不下载任何内容）。 */
export function scheduleVideoCacheMaintenance(): void {
  if (maintenanceScheduled || !isCacheStorageAvailable()) return;
  maintenanceScheduled = true;
  void (async () => {
    try {
      const cache = await window.caches.open(VIDEO_CACHE_NAME);
      await evictVideoCache(cache, readIndex());
    } catch {
      // 清理失败不阻断应用
    }
  })();
}

/**
 * 读取本机已缓存的成片，命中则返回可直接赋给 video.src 的 ObjectURL，否则 null。
 * 调用方负责在用完后 revokeObjectURL。
 */
export async function getCachedVideoUrl(streamUrl: string): Promise<string | null> {
  if (!streamUrl || !isCacheStorageAvailable()) return null;
  try {
    const cache = await window.caches.open(VIDEO_CACHE_NAME);
    const match = await cache.match(streamUrl);
    if (!match) return null;
    const blob = await match.blob();
    if (!blob || blob.size === 0) return null;
    return URL.createObjectURL(blob);
  } catch {
    return null;
  }
}

/**
 * 后台把整段成片落盘到本机缓存。已有缓存则仅刷新时间戳，不重复下载。
 * 返回是否已就绪（可作为本地播放源）。
 */
export async function cacheVideoInBackground(streamUrl: string): Promise<boolean> {
  if (!streamUrl || !isCacheStorageAvailable()) return false;
  try {
    const cache = await window.caches.open(VIDEO_CACHE_NAME);
    const index = readIndex();

    const existing = await cache.match(streamUrl);
    if (existing) {
      index[streamUrl] = { size: index[streamUrl]?.size ?? 0, storedAt: Date.now() };
      writeIndex(index);
      return true;
    }

    const res = await fetch(streamUrl, { credentials: "include" });
    if (!res.ok || res.status !== 200 || !res.body) return false;
    const size = Number(res.headers.get("content-length") || 0);
    await cache.put(streamUrl, res);

    index[streamUrl] = { size, storedAt: Date.now() };
    writeIndex(index);
    await evictVideoCache(cache, index);
    return true;
  } catch {
    return false;
  }
}

/**
 * React Hook：让播放器优先使用本机缓存成片。
 * - 挂载 / 切换成片：命中缓存即刻以本地地址播放（秒开、无网络）；
 * - persist()：由播放器在"确实看过"后调用，后台落盘；落盘完成且当前未在播放时，
 *   自动把播放源切到本地缓存，保证下一次回看零流量。
 */
export function useCachedVideoSrc(
  streamUrl: string,
  isActivelyPlaying: boolean,
): { videoSrc: string; persist: () => void } {
  const [cachedUrl, setCachedUrl] = useState<string | null>(null);
  const [downloadedUrl, setDownloadedUrl] = useState<string | null>(null);
  const persistStartedRef = useRef(false);
  const objectUrlsRef = useRef<string[]>([]);

  useEffect(() => {
    scheduleVideoCacheMaintenance();
    return () => {
      objectUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
      objectUrlsRef.current = [];
    };
  }, []);

  useEffect(() => {
    let active = true;
    void getCachedVideoUrl(streamUrl).then((url) => {
      if (!url) return;
      if (!active) {
        URL.revokeObjectURL(url);
        return;
      }
      objectUrlsRef.current.push(url);
      setCachedUrl(url);
    });
    return () => {
      active = false;
    };
  }, [streamUrl]);

  // 落盘完成后，等当前播放停下来再把画面切到本地缓存，避免打断正在观看的成片。
  useEffect(() => {
    if (isActivelyPlaying || !downloadedUrl) return;
    setCachedUrl(downloadedUrl);
  }, [isActivelyPlaying, downloadedUrl]);

  const persist = useCallback(() => {
    if (persistStartedRef.current) return;
    persistStartedRef.current = true;
    void cacheVideoInBackground(streamUrl).then(async (ok) => {
      if (!ok) {
        persistStartedRef.current = false;
        return;
      }
      const url = await getCachedVideoUrl(streamUrl);
      if (!url) return;
      objectUrlsRef.current.push(url);
      setDownloadedUrl(url);
    });
  }, [streamUrl]);

  return { videoSrc: cachedUrl ?? streamUrl, persist };
}
