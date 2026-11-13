/**
 * @jansee/intro-kit —— 纯净宣发封面图合成器 (Pure Cover Composer)
 *
 * 架构定位：全平台四大版块（图片成片 / 视频配音 / 出镜口播 / 切片分镜）统一纯净封面导出中台。
 * 核心铁律：
 *   1. 绝对隔离任何口播台词字幕与 AI 显性角标，确保封面纯净度 100%；
 *   2. 采用电影级 100% 纯黑到透明羽化遮罩，无论复杂/浅白背景文字皆极度清晰锐利；
 *   3. 视音频多模态自适应：视频自动在 1.0s 定点抽取纯净原画，图片直接消费原图。
 */

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import ffmpegStatic from 'ffmpeg-static';
import sharp from 'sharp';
import { renderIntroPng } from './render.js';

const VIDEO_EXTS = new Set(['.mp4', '.mov', '.webm', '.avi', '.mkv', '.m4v', '.flv']);

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    execFile(ffmpegStatic, args, { windowsHide: true }, (err, _stdout, stderr) => {
      if (err) {
        const msg = String(stderr || '').split('\n').slice(-4).join(' ').trim();
        reject(new Error(msg || err.message));
        return;
      }
      resolve();
    });
  });
}

/**
 * 合成纯净封面海报图（无口播台词、无 AI 溯源角标）
 * @param {object} p
 * @param {string} p.bgSource 视频或图片绝对路径
 * @param {string} [p.title] 封面主标题（4~8字）
 * @param {string} [p.brandEn] 装饰大写英文小标
 * @param {string} [p.site] 底部地点/品牌署名
 * @param {string} [p.note] 留白态度短句（8~14字）
 * @param {string} [p.idx='NO. 01 / CINEMATIC DUB'] 场次编号
 * @param {string} p.outPath 输出 cover.jpg 绝对路径
 * @param {number} [p.width] 画幅宽（不传则自适应探测）
 * @param {number} [p.height] 画幅高（不传则自适应探测）
 * @param {number} [p.captureSec=1.0] 若为视频，抽纯净帧的时间戳（秒）
 * @returns {Promise<{coverPath:string, width:number, height:number}>}
 */
export async function composePureCover({
  bgSource,
  title,
  brandEn,
  site,
  note,
  idx = 'NO. 01 / CINEMATIC DUB',
  outPath,
  width,
  height,
  captureSec = 1.0,
}) {
  if (!bgSource || !existsSync(bgSource)) {
    throw new Error(`[composePureCover] 底图素材不存在: ${bgSource}`);
  }
  if (!outPath) {
    throw new Error('[composePureCover] 缺少输出路径 outPath');
  }

  const outDir = path.dirname(outPath);
  mkdirSync(outDir, { recursive: true });

  const ext = path.extname(bgSource).toLowerCase();
  const isVideo = VIDEO_EXTS.has(ext);

  let rawFramePath = bgSource;
  let isTempFrame = false;

  // 1. 若为视频素材，在 captureSec（默认 1.0 秒）抽取一帧纯净原画（无字幕、无角标）
  if (isVideo) {
    rawFramePath = path.join(outDir, `_raw_bg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.jpg`);
    isTempFrame = true;
    const timeStr = Number(captureSec).toFixed(3);
    await runFfmpeg([
      '-nostdin',
      '-y',
      '-ss', timeStr,
      '-i', bgSource,
      '-vframes', '1',
      '-q:v', '2',
      rawFramePath,
    ]);
  }

  try {
    // 2. 探测真实尺寸
    const meta = await sharp(rawFramePath).metadata();
    const finalW = Math.max(320, Math.round(Number(width) || meta.width || 1080));
    const finalH = Math.max(240, Math.round(Number(height) || meta.height || 1920));

    // 3. 渲染透明 intro 贴片（带 100% 纯黑渐变羽化遮罩、大标题、英文字标与留白短句）
    const tempIntroPng = path.join(outDir, `_temp_intro_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.png`);
    renderIntroPng({
      title,
      brandEn,
      site,
      note,
      idx,
      width: finalW,
      height: finalH,
      outPath: tempIntroPng,
    });

    // 4. 使用 Sharp 执行图层压合（Over Blend），输出高质量 JPG 封面
    await sharp(rawFramePath)
      .resize(finalW, finalH, { fit: 'cover' })
      .composite([{ input: tempIntroPng, blend: 'over' }])
      .jpeg({ quality: 92, mozjpeg: true })
      .toFile(outPath);

    // 清理临时贴片
    if (existsSync(tempIntroPng)) {
      try { unlinkSync(tempIntroPng); } catch (_) {}
    }

    return {
      coverPath: outPath,
      width: finalW,
      height: finalH,
    };
  } finally {
    // 清理临时底帧
    if (isTempFrame && existsSync(rawFramePath)) {
      try { unlinkSync(rawFramePath); } catch (_) {}
    }
  }
}
