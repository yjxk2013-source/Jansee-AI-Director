// 简兮 (JANSEE) · 用户成片作品库持久化存储 (apps/web/server/userWorkStore.mjs)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataFile, readJson, writeJsonAtomic } from './dataStore.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const OUTPUTS_DIR = path.resolve(REPO_ROOT, 'storage', 'outputs');
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
 * 物理成片目录扫描兜底：当用户成片库缺失但 outputs 物理目录有已生成视频时，自动兜底恢复
 */
function scanAndBackfillOutputs(userId) {
  if (!userId || !fs.existsSync(OUTPUTS_DIR)) return;
  const store = loadStore();
  const existingUrls = new Set(store.works.map(w => w.videoUrl || w.url).filter(Boolean));

  try {
    const entries = fs.readdirSync(OUTPUTS_DIR, { withFileTypes: true });
    let updated = false;

    entries.forEach(ent => {
      if (!ent.isDirectory()) return;
      const subDir = path.join(OUTPUTS_DIR, ent.name);
      const finalMp4 = path.join(subDir, 'final.mp4');
      if (!fs.existsSync(finalMp4)) return;

      const stat = fs.statSync(finalMp4);
      // 仅关联 24 小时内的有效成片
      if (Date.now() - stat.mtimeMs > 24 * 3600 * 1000) return;

      const webUrl = `/storage/outputs/${ent.name}/final.mp4`;
      if (existingUrls.has(webUrl)) return;

      const coverJpg = path.join(subDir, 'cover.jpg');
      const coverUrl = fs.existsSync(coverJpg) ? `/storage/outputs/${ent.name}/cover.jpg` : '';

      let title = '商业成片';
      let duration = 15;
      if (ent.name.startsWith('spk_')) title = '出镜口播精修成片';
      else if (ent.name.startsWith('sb_')) title = '实拍分镜精修成片';
      else if (ent.name.startsWith('crt_')) title = '图片成片 · 商业带货';

      store.works.push({
        id: `work_${ent.name}`,
        userId: String(userId).trim(),
        title,
        url: webUrl,
        videoUrl: webUrl,
        coverUrl,
        duration,
        meta: '1080P · 高清商业交付',
        publish: {
          caption: `${title}，AI 智能导演高清重构！`,
          cover_title: '商业高光 · 精致呈现',
          comment: '正品现货，欢迎咨询选购！',
          coverUrl
        },
        versions: null,
        createdAt: stat.mtimeMs || Date.now()
      });
      existingUrls.add(webUrl);
      updated = true;
    });

    if (updated) {
      store.works.sort((a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0));
      saveStore(store);
    }
  } catch (err) {
    console.warn('[userWorkStore] 扫描 outputs 自动归集异常:', err.message);
  }
}

/**
 * 查询指定用户的历史成片列表（按创建时间倒序）
 */
export function listUserWorks(userId, limit = 50) {
  if (!userId) return [];
  scanAndBackfillOutputs(userId);
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
