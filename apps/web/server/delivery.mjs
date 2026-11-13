// 简兮 (JANSEE) · 统一成片产物 Delivery 层 (apps/web/server/delivery.mjs)
// 职责：
//   1. 统一归一化各类创作链路的输出产物 (outputs)；
//   2. 严格安全清洗物理绝对路径 (如 C:\..., f:\..., /storage/...)，绝不泄露服务器内部路径；
//   3. 输出规范对象格式: { video, cover, subtitle, audio, duration, ... }

import path from 'node:path';

/**
 * 将任意本地物理路径清洗转换为安全的静态托管 URL
 * @param {string} rawPath
 * @param {string} [taskId]
 * @returns {string}
 */
export function sanitizeToSafeUrl(rawPath, taskId = '') {
  if (!rawPath || typeof rawPath !== 'string') return '';
  const trimmed = rawPath.trim();
  if (!trimmed) return '';

  // 若已经是合法的网络相对路径或标准 HTTP(S) 地址，直接规范化斜杠
  if (trimmed.startsWith('/storage/') || trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    return trimmed.replace(/\\/g, '/');
  }

  // 针对包含 storage/outputs 的物理绝对路径（Windows 盘符或 Linux 根路径）
  const normalized = trimmed.replace(/\\/g, '/');
  const storageMarker = '/storage/outputs/';
  const idx = normalized.indexOf(storageMarker);
  if (idx !== -1) {
    return normalized.substring(idx);
  }

  // 若含有 slices 相对路径，如 'slices/part_001.mp4'
  if (taskId && (normalized.startsWith('slices/') || normalized.startsWith('/slices/'))) {
    const cleanRel = normalized.replace(/^\/+/, '');
    return `/storage/outputs/${taskId}/${cleanRel}`;
  }

  // 若仅有文件名，且提供了 taskId
  if (taskId && !normalized.includes('/') && !normalized.includes('\\')) {
    return `/storage/outputs/${taskId}/${normalized}`;
  }

  // 若属于不可识别的未知物理路径，绝对禁止原样透传，安全屏蔽
  if (normalized.includes(':') || normalized.startsWith('/') || normalized.startsWith('\\')) {
    return '';
  }

  return normalized;
}

/**
 * 统一产物归一化处理 (normalizeOutput)
 *
 * @param {object} rawOutputs 原始输出对象
 * @param {string} [taskId] 任务 ID
 * @returns {object} 标准化产物对象
 */
export function normalizeOutput(rawOutputs = {}, taskId = '') {
  if (!rawOutputs || typeof rawOutputs !== 'object') {
    return {
      video: '',
      cover: '',
      subtitle: '',
      audio: '',
      duration: 0,
    };
  }

  // 1. 核心四大视听产物安全清洗
  const rawVideo = rawOutputs.video || rawOutputs.videoUrl || '';
  const rawCover = rawOutputs.cover || rawOutputs.coverUrl || '';
  const rawSubtitle = rawOutputs.subtitle || rawOutputs.subtitleUrl || '';
  const rawAudio = rawOutputs.audio || rawOutputs.audioUrl || '';

  const durationSec = Number(rawOutputs.duration || rawOutputs.durationSec || 0);

  const delivery = {
    video: sanitizeToSafeUrl(rawVideo, taskId),
    cover: sanitizeToSafeUrl(rawCover, taskId),
    subtitle: sanitizeToSafeUrl(rawSubtitle, taskId),
    audio: sanitizeToSafeUrl(rawAudio, taskId),
    duration: Number.isFinite(durationSec) && durationSec >= 0 ? Number(durationSec.toFixed(2)) : 0,
  };

  // 2. 兼容映射旧版 URL 与时长字段（保持向后兼容性）
  delivery.videoUrl = delivery.video;
  delivery.coverUrl = delivery.cover;
  delivery.subtitleUrl = delivery.subtitle;
  delivery.audioUrl = delivery.audio;
  delivery.durationSec = delivery.duration;

  // 3. 专业链路子字段脱敏透传
  if (rawOutputs.variantType) {
    delivery.variantType = String(rawOutputs.variantType);
  }

  // 切片列表安全脱敏
  if (Array.isArray(rawOutputs.slices)) {
    delivery.slices = rawOutputs.slices.map((s) => ({
      videoUrl: sanitizeToSafeUrl(s.videoUrl || s.file || s.name, taskId),
      durationSec: Number(s.durationSec || 0),
      text: String(s.text || s.final_text || ''),
      materialId: String(s.materialId || ''),
    }));
  }

  // 口播词级表脱敏透传
  if (Array.isArray(rawOutputs.words)) {
    delivery.words = rawOutputs.words;
  }
  if (Array.isArray(rawOutputs.suggestions)) {
    delivery.suggestions = rawOutputs.suggestions;
  }

  // 发布方案（增值交付物）：出片后随视频一起给用户的「直接复制就能发」四件套。
  // 纯文本，已由 @jansee/publish-kit 的 sanitizePublish 过广告法红线词表并钳制长度，
  // 这里只做字段白名单透传——绝不上路径清洗逻辑（文案里没有路径），
  // 也绝不透传 _banned_hits（调试字段，不进客户端交付物）。
  if (rawOutputs.publish && typeof rawOutputs.publish === 'object') {
    delivery.publish = pickPublishFields(rawOutputs.publish, taskId);
  }

  // 主播风格标签（纯文本，如「逼单冲锋型」）：单版路径透传，让商家看得到本片表达人格
  if (rawOutputs.anchorDna) {
    delivery.anchorDna = String(rawOutputs.anchorDna).trim();
  }

  // 多版成片（批量赛马）：每条版本的交付物白名单透传（videoUrl/coverUrl/duration/publish 逐项清洗）
  if (Array.isArray(rawOutputs.versions)) {
    delivery.versions = rawOutputs.versions.map((v) => {
      const itemCover = sanitizeToSafeUrl(v?.coverUrl || v?.cover || '', taskId);
      const item = {
        videoUrl: sanitizeToSafeUrl(v?.videoUrl || v?.video || '', taskId),
        coverUrl: itemCover,
        duration: Number(v?.duration) || 0,
        // 主播风格标签（纯文本，如「逼单冲锋型」）：让商家看得到每条的差异维度
        anchorDna: String(v?.anchorDna || '').trim(),
      };
      if (v?.publish && typeof v.publish === 'object') {
        item.publish = pickPublishFields({
          ...v.publish,
          cover_url: v.publish.cover_url || itemCover,
        }, taskId);
      }
      return item;
    });
  }

  return delivery;
}

/**
 * 发布方案四件套字段白名单（单一出口：normalizeOutput 与编排层直写 outputs 共用，
 * 保证 _banned_hits 等调试字段无论从哪条路写入都不会外泄）。
 * @param {object} p sanitizePublish 产物
 * @returns {object}
 */
export function pickPublishFields(p, taskId = '') {
  const src = p && typeof p === 'object' ? p : {};
  return {
    caption: String(src.caption || '').slice(0, 300),
    cover_title: String(src.cover_title || '').slice(0, 36),
    cover_url: sanitizeToSafeUrl(src.cover_url || src.coverUrl || '', taskId),
    pinned_comment: String(src.pinned_comment || '').slice(0, 60),
    post_time: String(src.post_time || '').slice(0, 40),
  };
}
