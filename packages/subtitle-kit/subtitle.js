// 简兮合成引擎 · subtitle.js —— 黑曜石发丝字幕渲染中台 (OBSIDIAN HAIRLINE SUBTITLE SYSTEM)
// 遵循大厂 70mm 电影工业美学与黑曜石设计规范：
// 1. 彻底淘汰粗笨系统黑体 (msyhbd)，采用高奢发丝细体 (msyhl / Deng Light)
// 2. 默认搭载黑曜石微晶通透胶囊底 (0.55 通透度，符合全站 0.5~0.7 黑曜石通透铁律)
// 3. 智能标点断句与中文字符自然排版，消除断行孤字与行末多余标点
// 4. 发丝微光边缘 (1px) 与冷高光钛白 (0xF8FAFC)

import fs from 'node:fs';
import path from 'node:path';
import { AI_BADGE, aiBadgeFontFile } from './aiBadge.js';

/**
 * 智能解析黑曜石发丝字体路径
 * 优先级：项目 OFL 字体真源（materials/fonts 思源黑）> obsidian_hairline.ttc / msyhl.ttc
 *         > obsidian_cinematic.ttf / Dengl.ttf > msyh.ttc
 * OFL 真源排在最前：materials/fonts 里没有系统字体，实际恒命中思源黑；
 * 系统字体候选只作真源缺失时的保底——版权红线（系统字体不进生产）由真源存在性保证。
 * 彻底禁止使用 msyhbd.ttc (粗黑体)
 */
export function resolveObsidianFont(fontfileOrDir) {
  // 0. 项目 OFL 字体唯一真源，绝对优先——杜绝任何调用方传歪到系统字体
  const verifiedFallbacks = [
    path.resolve(process.cwd(), 'materials/fonts/noto-sans-sc/NotoSansSC_400Regular.ttf'),
    path.resolve(process.cwd(), 'materials/fonts/noto-sans-sc/NotoSansSC_300Light.ttf'),
    path.resolve(process.cwd(), 'materials/fonts/noto-serif-sc/NotoSerifSC_400Regular.ttf'),
  ];
  for (const f of verifiedFallbacks) {
    if (fs.existsSync(f)) {
      return f.replace(/\\/g, '/').replace(/:/g, '\\:');
    }
  }

  const candidates = [
    'obsidian_hairline.ttc',
    'msyhl.ttc',
    'obsidian_cinematic.ttf',
    'Dengl.ttf',
    'msyh.ttc',
  ];

  let dir = fontfileOrDir || '';
  // 如果传入的是具体字体文件路径，提取所在目录并尝试纠正
  if (dir.endsWith('.ttc') || dir.endsWith('.ttf') || dir.endsWith('.otf')) {
    if (fs.existsSync(dir)) {
      return dir.replace(/\\/g, '/').replace(/:/g, '\\:');
    }
    const base = path.basename(dir);
    if (base !== 'msyhbd.ttc' && base !== 'simhei.ttf') {
      const relCandidate = path.resolve(process.cwd(), dir);
      if (fs.existsSync(relCandidate)) {
        return relCandidate.replace(/\\/g, '/').replace(/:/g, '\\:');
      }
    }
    dir = path.dirname(dir);
  }

  // 1. 遍历寻找系统或素材库字体
  for (const name of candidates) {
    const joined = path.join(dir, name);
    if (fs.existsSync(joined)) {
      return joined.replace(/\\/g, '/').replace(/:/g, '\\:');
    }
    const relFromCwd = path.resolve(process.cwd(), joined);
    if (fs.existsSync(relFromCwd)) {
      return relFromCwd.replace(/\\/g, '/').replace(/:/g, '\\:');
    }
  }

  // 2.（原第 2 步的 OFL 兜底已上移为第 0 步最高优先级，此步保留注释说明历史）

  // 兜底返回黑曜石发丝字体
  return String(fontfileOrDir || '')
    .replace(/msyhbd\.ttc|msyh\.ttc|msyhl\.ttc|simhei\.ttf/g, 'obsidian_hairline.ttc')
    .replace(/\\/g, '/');
}

/**
 * 智能 CJK 标点自然分行与字数平衡
 * 1. 优先按自然标点断句（避免拆散主谓宾词组）
 * 2. 消除短句行末冗余句号逗号（电影字幕排版规范）
 * 3. 杜绝行尾孤字
 */
export function wrapCJK(text, maxPerLine = 15) {
  if (!text) return [];
  const raw = String(text).trim();
  if (raw.length <= maxPerLine) {
    return [raw.replace(/[，。？！；]$/, '')];
  }

  // 如果有明显断句标点，优先在标点处拆分
  const clauses = raw
    .split(/([，。？！、；：\s]+)/)
    .filter(Boolean);

  const lines = [];
  let current = '';

  for (let i = 0; i < clauses.length; i++) {
    const part = clauses[i];
    if (/^[，。？！、；：\s]+$/.test(part)) {
      if (current) {
        // 如果当前行加上标点没有严重超标，且不是末尾，可暂存
        if (i < clauses.length - 1 && (current + part).length <= maxPerLine) {
          current += part;
        } else {
          lines.push(current.replace(/[，。？！、；：\s]+$/, ''));
          current = '';
        }
      }
      continue;
    }

    if (!current) {
      current = part;
    } else if ((current + part).length <= maxPerLine) {
      current += part;
    } else {
      lines.push(current.replace(/[，。？！、；：\s]+$/, ''));
      current = part;
    }
  }

  if (current) {
    lines.push(current.replace(/[，。？！、；：\s]+$/, ''));
  }

  // 二次防溢出检查：如果某单行因无标点仍超过 maxPerLine，做平分折行
  const result = [];
  for (const l of lines) {
    if (l.length <= maxPerLine) {
      result.push(l);
    } else {
      let rest = l;
      while (rest.length > maxPerLine) {
        const half = Math.ceil(rest.length / 2);
        const cut = half <= maxPerLine ? half : maxPerLine;
        result.push(rest.slice(0, cut));
        rest = rest.slice(cut);
      }
      if (rest) result.push(rest);
    }
  }

  return result.filter(Boolean);
}

function sanitizeSubtitleText(text) {
  return String(text || '')
    .trim()
    .replace(/\\/g, '\\\\')
    .replace(/'/g, '’')
    .replace(/:/g, '：')
    .replace(/;/g, '；')
    .replace(/%/g, '％');
}

/**
 * 黑曜石发丝字幕滤镜生成器
 * @param {Array} ttsResults TTS 对齐句段
 * @param {string} fontfile 字体相对路径
 * @param {Object} options 渲染选项 { theme, style, fontSize, shortEdge }
 */

// ==================== V2 视听积木：5 套字幕样式 × 变体绑定 ====================
// 样式约束（宪法 8.1 条延伸）：单行显示 / 底部安全区不变，只分化字色/描边/阴影观感；
// 全部走 drawtext 原生参数（无新增滤镜），渲染成本与默认样式完全一致（4核4G 硬约束）。
export const SUBTITLE_STYLES = {
  // 默认：冷高光钛白 + 漫反射暗影（黑曜石标准）
  obsidian_hairline: {
    fontcolor: '0xF2F2F2',
    borderw: 0,
    bordercolor: '',
    shadowx: 0,
    shadowy: 2,
    shadowcolor: '0x000000@0.65',
  },
  // 高对比墨影：纯白 + 细黑描边 + 深影（硬朗杂志感）
  ink_wide: {
    fontcolor: '0xFFFFFF',
    borderw: 2,
    bordercolor: '0x0a0a0e@0.85',
    shadowx: 0,
    shadowy: 3,
    shadowcolor: '0x000000@0.75',
  },
  // 暖金辉光：暖白字 + 金色细描边（晨光/烟火气高端）
  warm_glow: {
    fontcolor: '0xFFF6E5',
    borderw: 2,
    bordercolor: '0xD4A853@0.55',
    shadowx: 0,
    shadowy: 2,
    shadowcolor: '0x1a1206@0.7',
  },
  // 冷青科技：冷青白 + 青蓝细描边（科技/数字冲击）
  cold_tech: {
    fontcolor: '0xE8F4FF',
    borderw: 2,
    bordercolor: '0x59B7FF@0.5',
    shadowx: 0,
    shadowy: 2,
    shadowcolor: '0x020a14@0.8',
  },
  // 街头冲击：亮白 + 双重深底（粗黑描边 + 大位移深影）
  bold_shadow: {
    fontcolor: '0xFAFAFA',
    borderw: 3,
    bordercolor: '0x050505@0.9',
    shadowx: 2,
    shadowy: 3,
    shadowcolor: '0x000000@0.85',
  },
};

export function buildDrawtextFilters(ttsResults, fontfile, options = {}) {
  // 自动将粗黑体等旧字体纠正为黑曜石发丝字体
  const effectiveFont = resolveObsidianFont(fontfile);
  const theme = options.theme || 'obsidian_capsule'; // obsidian_capsule (默认) | obsidian_hairline
  const shortEdge = Number(options.shortEdge) || 1080;
  // V2 视听积木：按样式 key 取字幕观感（字色/描边/阴影），未知 key 回落黑曜石标准
  const st = SUBTITLE_STYLES[options.style] || SUBTITLE_STYLES.obsidian_hairline;
  // 动效选择：默认经典缓升或指定动效
  const motionKey = options.motion || 'classic_rise';
  
  // 默认字号 34px，安全区距底 130px（黄金下三点安全区）
  const fontSize = options.fontSize || Math.max(32, Math.round(shortEdge * 0.032));
  const bottomMargin = options.bottomMargin || Math.max(110, Math.round(shortEdge * 0.12));
  const posLayout = options.layout || options.position || 'bottom_capsule';

  const filters = [];

  for (const r of ttsResults) {
    const start = r.audioStart;
    const end = r.audioEnd;
    let text = (r.content || '').trim();
    if (!text || !(end > start)) continue;

    // 宪法 8.1 条 + 单行铁律：整句优先，超出安全区（maxPerLine，默认 18 字）时才平分切段轮播，
    // 画面任意时刻只出现一行字幕，严禁多行重叠堆叠
    const maxPerLine = Number(options.maxPerLine) || 18;
    const lines = wrapCJK(text, maxPerLine);
    const n = lines.length;
    const segDur = (end - start) / n;

    for (let li = 0; li < n; li++) {
      const line = lines[li].trim();
      if (!line) continue;
      const safeText = sanitizeSubtitleText(line);
      const segStart = start + li * segDur;
      const segEnd = start + (li + 1) * segDur;
      const stF = segStart.toFixed(2);
      const enF = segEnd.toFixed(2);

      // 单行字幕基准坐标：支持 4 种排版方式并保障 >= 72% 主体曝光
      let baseX = '(w-tw)/2';
      let baseY = `h-th-${bottomMargin}`;
      let curFontSize = `${fontSize}`;
      let alphaExpr = '';

      if (posLayout === 'top_editorial' || posLayout === 'editorial_top') {
        // 顶部画报排版：固定于顶部约 12% 处，居左带微呼吸安全区
        baseX = `${Math.max(24, Math.round(shortEdge * 0.075))}`;
        baseY = `${Math.max(48, Math.round(shortEdge * 0.12))}`;
      } else if (posLayout === 'center_cinematic') {
        // 黄金中心合焦视窗：居中于中央偏上 42%
        baseX = '(w-tw)/2';
        baseY = `(h-th)*0.42`;
      } else {
        // 默认 bottom_capsule 底部黄金下三点安全区
        baseX = '(w-tw)/2';
        baseY = `h-th-${bottomMargin}`;
      }

      // 零/极低 CPU 负载动效数学插值公式
      switch (motionKey) {
        case 'classic_rise': {
          // 0.25s 内从 baseY + 20 平滑上升到 baseY
          const d = 0.25;
          baseY = `if(lte(t,${stF}+${d}),${baseY}+20*(1-(t-${stF})/${d}),${baseY})`;
          break;
        }
        case 'smooth_fade': {
          // 0.20s 内 alpha 从 0 线性过渡到 1
          const d = 0.20;
          alphaExpr = `:alpha='if(lte(t,${stF}+${d}),(t-${stF})/${d},1)'`;
          break;
        }
        case 'slide_in': {
          // 0.22s 内平滑滑入 baseX
          const d = 0.22;
          baseX = `if(lte(t,${stF}+${d}),${baseX}-35*(1-(t-${stF})/${d}),${baseX})`;
          break;
        }
        case 'micro_pop': {
          // 前 0.16s 字号从 110% 回弹到 100%
          const d = 0.16;
          const popSize = Math.round(fontSize * 1.10);
          curFontSize = `if(lte(t,${stF}+${d}),${popSize}-(${popSize}-${fontSize})*(t-${stF})/${d},${fontSize})`;
          break;
        }
        case 'quick_wipe': {
          // 水平平滑微推 + 极速轻淡入（0.15s），双重弱动效形成推展感，成本与位移恒等
          const d = 0.20;
          baseX = `if(lte(t,${stF}+${d}),${baseX}-20*(1-(t-${stF})/${d}),${baseX})`;
          alphaExpr = `:alpha='if(lte(t,${stF}+0.12),(t-${stF})/0.12,1)'`;
          break;
        }
        case 'none':
        default:
          break;
      }

      // 宪法 8.1 条杂志画册级排版规范：
      // 1. 彻底拿掉半透明底色框 (box=0)
      // 2. 字色/描边/阴影由 V2 字幕样式积木决定（5 套观感 × 变体绑定）
      // 3. 阴影保持极柔和下沉漫反射族（不用硬投影）
      const styleStr =
        `fontsize=${curFontSize}:fontcolor=${st.fontcolor}:` +
        `box=0:borderw=${st.borderw}` +
        (st.borderw > 0 && st.bordercolor ? `:bordercolor=${st.bordercolor}` : '') +
        `:shadowx=${st.shadowx}:shadowy=${st.shadowy}:shadowcolor=${st.shadowcolor}` +
        alphaExpr;

      filters.push(
        `drawtext=fontfile='${effectiveFont}':text='${safeText}':` +
          `${styleStr}:` +
          `x='${baseX}':y='${baseY}':` +
          `enable='between(t,${stF},${enF})'`,
      );
    }
  }

  return filters;
}

/**
 * AI 生成内容显式标识（国标 GB 45438-2025 · 黑曜石发丝冷白版）
 *
 * 两段式（2026-10-25 定版）：
 *   - 开头 2.5s 左上「AI 生成」
 *   - 结尾 2.5s 左上「本视频由 AI 生成 · JANSEE」（结尾带出品方，是宣传位）
 * 常驻右下角小角标已删：30px 只有短边 2.8%，达不到国标「文字高度 ≥ 画面短边 5%」，
 * 与其放一个不合规的小字不如不要——两段式本身已是完整合规面。
 * 国标要素：必须同时含「AI（或人工智能）」+「生成（或合成）」，只写「AI」不合规。
 */
export function buildAiBadgeOverlay(fontfile, videoDuration, shortEdge = 1080, options = {}) {
  const total = Number(videoDuration);
  if (!(total > 0)) return [];

  /* 字体真源在共享层（aiBadgeFontFile），fontfile 参数仅留兼容旧签名——
     传了也不盲信：存在才用，否则一律回落真源，杜绝调用方把系统字体传进来。 */
  const fontSrc = fontfile && fs.existsSync(String(fontfile).replace(/\\:/g, ':')) ? fontfile : aiBadgeFontFile();
  const effectiveFont = String(fontSrc).replace(/\\/g, '/').replace(/:/g, '\\:');
  const esc = (t) => sanitizeSubtitleText(t);

  const LM = 130; // 距左移动端安全区（主流全面屏 Cover 裁切防切保护）
  const BM = 30;  // 距底
  const RM = 130; // 距右安全区
  const TM = 120; // 距顶安全区（防全面屏状态栏/摄像头挖孔遮挡）

  const initialInLabel = typeof options.inLabel === 'string' && options.inLabel ? options.inLabel : 'vtxt';
  const targetOutLabel = typeof options.outLabel === 'string' && options.outLabel ? options.outLabel : 'vout';

  const badge = (text, fs, anchor, st, en, fontOpacity = 1, currentIn, currentOut) => {
    const leftX = anchor.startsWith('left');
    const topY = anchor.endsWith('top');
    const tx = leftX ? `${LM}` : `w-tw-${RM}`;
    const ty = topY ? `${TM}` : `h-th-${BM}`;
    const enbl = `between(t,${st.toFixed(2)},${en.toFixed(2)})`;
    const fc = fontOpacity >= 1 ? '0xF8FAFC' : `0xF8FAFC@${fontOpacity}`;
    return (
      `[${currentIn}]drawtext=fontfile='${effectiveFont}':text='${esc(text)}':fontsize=${fs}:fontcolor=${fc}:` +
      `borderw=1:bordercolor=0x0a0a0e@0.30:x=${tx}:y=${ty}:enable='${enbl}'[${currentOut}]`
    );
  };

  /* 国标：文字高度 ≥ 短边 5%（1080 宽即 54px），持续 ≥ 2s，位于边或角。
     规则常量（文案/时长/字号比例）以 aiBadge.js 的 AI_BADGE 为唯一真源。 */
  const fsStd = Math.max(24, Math.round(Number(shortEdge) * AI_BADGE.fontSizeRatio));
  const HEAD_SEC = AI_BADGE.headSec;
  const TAIL_SEC = AI_BADGE.tailSec;
  const segs = [];
  /* 全平台铁律约束：共享层结尾收束 (@jansee/ending-kit) 已原生内置国标结尾 AI 显性标识。
     全站各业务板块（图片成片、视频配音、出镜口播、切片分镜）统一仅在主视频开头 2.5s 烧录显性角标，
     结尾一律不烧录结尾显性角标，彻底根绝双层文字重叠或重复烧录现象。 */
  if (!options.withTail) {
    segs.push(badge(AI_BADGE.headText, fsStd, 'left-top', 0, Math.min(HEAD_SEC, total), 0.9, initialInLabel, targetOutLabel));
    return segs;
  }
  const tailStart = Math.max(0, total - TAIL_SEC);
  if (total < HEAD_SEC + 2.2) {
    /* 超短视频：只保留开头段，避免头尾窗口重叠叠字 */
    segs.push(badge(AI_BADGE.headText, fsStd, 'left-top', 0, total, 0.9, initialInLabel, targetOutLabel));
    return segs;
  }
  segs.push(badge(AI_BADGE.headText, fsStd, 'left-top', 0, HEAD_SEC, 0.9, initialInLabel, 'aiM0'));
  segs.push(badge(AI_BADGE.tailText, fsStd, 'left-top', tailStart, total, 0.9, 'aiM0', targetOutLabel));

  return segs;
}

// 统一导出国标 AI 显式角标与隐式 udta/MP4 元数据注入方法
export { buildAiMetaTags, aiMetaArgs, AI_BADGE, aiBadgeFontFile } from './aiBadge.js';

