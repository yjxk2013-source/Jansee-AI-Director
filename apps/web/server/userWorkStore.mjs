// 简兮 (JANSEE) · 用户成片作品库持久化存储 (apps/web/server/userWorkStore.mjs)
import { dataFile, readJson, writeJsonAtomic } from './dataStore.mjs';

const WORKS_FILE = dataFile('user_works.json');

function loadStore() {
  const data = readJson(WORKS_FILE, { works: [] });
  if (!data || !Array.isArray(data.works)) {
    return { works: [] };
  }
  return data;
}

function saveStore(data) {
  writeJsonAtomic(WORKS_FILE, data);
}

/**
 * 查询指定用户的历史成片列表（按创建时间倒序）
 */
export function listUserWorks(userId, limit = 50) {
  if (!userId) return [];
  const store = loadStore();
  const uidStr = String(userId).trim();
  const userWorks = store.works.filter((w) => String(w.userId).trim() === uidStr);
  userWorks.sort((a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0));
  return userWorks.slice(0, limit);
}

/**
 * 保存或更新用户作品（支持去重与跨端同步）
 */
export function saveUserWork(userId, work) {
  if (!userId || !work) return null;
  const store = loadStore();
  const uidStr = String(userId).trim();
  const videoUrl = work.videoUrl || work.url || '';
  if (!videoUrl) return null;

  const id = work.id || `work_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const now = Number(work.createdAt) || Date.now();

  const existingIdx = store.works.findIndex(
    (w) =>
      String(w.userId).trim() === uidStr &&
      (w.id === id || (w.videoUrl && w.videoUrl === videoUrl))
  );

  const record = {
    id,
    userId: uidStr,
    title: (work.title || '商业成片').trim(),
    url: videoUrl,
    videoUrl: videoUrl,
    coverUrl: work.coverUrl || work.cover || work.thumbnail || '',
    duration: Number(work.duration) || 0,
    meta: work.meta || '',
    publish: work.publish || null,
    versions: Array.isArray(work.versions) ? work.versions : null,
    createdAt: now,
  };

  if (existingIdx !== -1) {
    store.works[existingIdx] = { ...store.works[existingIdx], ...record };
  } else {
    store.works.unshift(record);
  }

  // 保持单用户最多保留 100 条成片
  const userItems = store.works.filter((w) => String(w.userId).trim() === uidStr);
  if (userItems.length > 100) {
    const toRemove = new Set(userItems.slice(100).map((w) => w.id));
    store.works = store.works.filter((w) => !toRemove.has(w.id));
  }

  saveStore(store);
  return record;
}
