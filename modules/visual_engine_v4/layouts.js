/**
 * 图片成片 · 版面几何与字体配对（Node 侧唯一实现）
 *
 * 与 docs/visual-gallery/v4.html 的 buildLayoutBody 是同一套几何，逐字镜像。
 * v4.html 是浏览器单文件（字体必须以 data URL 内嵌，file:// 下相对路径 404），
 * 所以不能直接 import 本模块；两边的坐标、字号、墨迹系数必须同时改。
 * `tests/layout-mirror.test.mjs` 用同一组输入比对两边 SVG 的关键数值，防止漂移。
 *
 * 三层分工在这里的落点：
 *   版式负责摆放（几何，只有坐标与字号）
 *   配对负责选字（字体家族与字重，零坐标）
 *   文案负责内容（由调用方传入，本模块不自带任何真实文案）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
export const FONTS_ROOT = path.join(REPO_ROOT, 'materials/fonts');

/* ============ 画布与洞位 ============
   1080 × 1920 平台默认竖屏。洞位高由图片比例决定，全片锁定一档，不逐镜跳：
   逐镜换洞位等于每镜重新排版，画面会"跳版"，比图小一点更难看。
   三档的横向口径一致（宽恒 1080，高随比例），条带 bar = (1920 − 洞高) / 2。 */
export const CANVAS = { width: 1080, height: 1920 };
export const SLOT_DEF = {
  A: { h: 1440, name: '竖图洞' },   // 3:4 及更竖（含 9:16 缩进）、2:3
  B: { h: 1080, name: '方图洞' },   // 1:1 附近
  C: { h: 810, name: '横图洞' },    // 4:3 及更横
};

export function slotKeyForRatio(ratio) {
  return ratio <= 0.82 ? 'A' : ratio <= 1.22 ? 'B' : 'C';
}

export function slotForRatio(ratio) {
  const key = slotKeyForRatio(ratio);
  const h = SLOT_DEF[key].h;
  return { key, h, bar: (CANVAS.height - h) / 2, name: SLOT_DEF[key].name };
}

/**
 * 图片在洞位里的实际落点：contain，不裁切、不拉伸、不改色。
 * 图比洞扁时左右留白，比洞竖时上下留白——空白由版面填，这正是版面的职责。
 */
export function imageBoxFor(slot, imageWidth, imageHeight) {
  const scale = Math.min(CANVAS.width / imageWidth, slot.h / imageHeight);
  const w = Math.round(imageWidth * scale);
  const h = Math.round(imageHeight * scale);
  return {
    x: Math.round((CANVAS.width - w) / 2),
    y: slot.bar + Math.round((slot.h - h) / 2),
    width: w,
    height: h,
    scale,
  };
}

/* ============ 字体配对（唯一真源：materials/fonts/index.json） ============ */
let _fontIndex = null;
function fontIndex() {
  if (_fontIndex) return _fontIndex;
  _fontIndex = JSON.parse(fs.readFileSync(path.join(FONTS_ROOT, 'index.json'), 'utf8'));
  return _fontIndex;
}

/* 墨迹系数：字形实际蘸到的高度占 em 的比例。同一字号下黄油体/快乐体的字面比思源宋高近 20%，
   标题基线写死就必然"换一款字就顶到装饰线"。T3 的双线夹标题直接用它反算基线。
   新加显示字体必须同时补这里，否则只有那款字会贴线。 */
export const DISPLAY_INK = {
  'noto-sans-sc': 0.80,
  'noto-serif-sc': 0.82,
  'ma-shan-zheng': 0.95,
  'zcool-xiaowei': 0.86,
  'zcool-qingke-huangyou': 0.95,
  'zcool-kuaile': 1.00,
};

function fontById(id) {
  return fontIndex().fonts.find((f) => f.id === id) || null;
}

/**
 * 配对 → 三个工位的字体家族与字重。
 * 拉丁字重不许硬写 500：Playfair 只有 400/700，写 500 浏览器/渲染器会合成假字重，笔画发胖。
 */
export function resolvePairing(pairingId) {
  const list = fontIndex().pairings || [];
  const pair = list.find((p) => p.id === pairingId) || list[0];
  if (!pair) throw new Error('字体配对表为空：materials/fonts/index.json 缺少 pairings');
  const disp = fontById(pair.display) || fontById('noto-sans-sc');
  const lat = fontById(pair.latin) || fontById('jost');
  const mic = fontById(pair.micro) || fontById('noto-sans-sc');
  const latWeights = (lat.files || []).map((f) => f.weight);
  const latinWeight = latWeights.includes(500) ? 500 : latWeights.includes(400) ? 400 : latWeights[0] || 400;
  return {
    id: pair.id,
    name: pair.name,
    display: disp.family,
    displayWeight: pair.displayWeight || 400,
    latin: lat.family,
    latinWeight,
    micro: mic.family,
    ink: DISPLAY_INK[pair.display] || 0.86,
    /* 渲染器要的是实际字体文件，不是一个家族名 */
    _fontIds: [pair.display, pair.latin, pair.micro],
  };
}

/** 该配对真正会用到的字体文件（绝对路径）——渲染时只加载这几个，不加载全库 */
export function fontFilesFor(pairingId) {
  const pairing = resolvePairing(pairingId);
  const files = [];
  for (const id of new Set(pairing._fontIds)) {
    const f = fontById(id);
    if (!f) continue;
    for (const file of f.files || []) {
      const abs = path.join(FONTS_ROOT, f.id, file.file);
      if (fs.existsSync(abs)) files.push(abs);
    }
  }
  return files;
}

/* ============ SVG 基元 ============ */
const LY_WARM = '#F2EDE4';
const LY_PURE = '#FFFFFF';

function esc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * 一行字。空字符串直接返回空——空文案不能留一个 0 宽度的 text 节点占位，
 * 否则某些渲染器会按 fallback 字体画出方框。
 */
function lyT(str, o) {
  const text = str == null ? '' : String(str);
  if (!text) return '';
  const size = Math.max(4, o.size);
  const track = o.track || 0;
  const fill = o.fill || LY_PURE;
  const op = o.op == null ? 1 : o.op;
  const anchor = o.align === 'center' ? 'middle' : o.align === 'right' ? 'end' : 'start';
  const common = `fill="${fill}" fill-opacity="${op}" font-family="${o.font}" font-weight="${o.weight || 400}" font-size="${size.toFixed(1)}"${track ? ` letter-spacing="${(track * size).toFixed(2)}"` : ''}`;
  if (o.vertical) {
    const chars = [...text];
    const step = size * (1 + track);
    let cy = o.y;
    let out = '';
    for (const ch of chars) {
      out += `<text x="${o.x.toFixed(1)}" y="${cy.toFixed(1)}" text-anchor="middle" ${common}>${esc(ch)}</text>`;
      cy += step;
    }
    return out;
  }
  return `<text x="${o.x.toFixed(1)}" y="${o.y.toFixed(1)}" text-anchor="${anchor}" ${common}>${esc(text)}</text>`;
}

function lyLine(y, op, h, x, w) {
  return `<rect x="${(x || 0).toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" fill="${LY_PURE}" fill-opacity="${op}"/>`;
}

/* ============ 版式几何 ============
   全部纵向坐标写成 k = bar / 240 的倍数：同一套版式在 1440 / 1080 / 810 三种洞位下都成立，
   不必为方图、横图另写一套坐标。 */
export function buildLayoutBody(key, slot, F, c) {
  const bar = slot.bar;
  const bot = CANVAS.height - bar;
  const k = bar / 240;
  const W = CANVAS.width;
  /* 移动端安全区边距：主流手机（20:9 / 19.5:9）全屏铺满 9:16 视频时，
     左右各裁切约 10%~12.5%（≈108~135px）。边距从旧版 66px 扩大到 130px（12%），
     确保标题与装饰元素在手机端 Cover 裁切后依然完整可见。 */
  const L = 130;
  const R = 950;
  const MAXW = R - L;
  const Y = (v) => v * k;                 // 顶部条带：以画面顶为基准等比放大
  const B = (v) => bot + (v - 1680) * k;  // 底部条带：以洞底为基准等比放大
  const S = (v, max) => Math.min(v * k, max || v * 2.4);
  const fit = (str, want, max, maxW, track) =>
    Math.min(max, Math.max(28, Math.floor(maxW / (Math.max(1, [...String(str)].length) * (1 + track)))));
  const hair = Math.max(1, 1.5 * k);
  const thin = Math.max(1, k);

  if (key === 'T1') { /* 时装编辑：左对齐大标题 + 右侧大留白，小标压在标题上方 */
    /* 字号上限不能写死 150：基线固定在 Y(204)，字号越大墨迹顶越高。
       思源黑 150px 时墨迹顶到 Y(84)，离顶部那根 44px 短线只剩 8px，四字标题看着就要顶穿。
       按墨迹系数反算上限，让墨迹顶恒定落在短线下方 24px——三段标题看起来才是同一个起点。
       2026-10-25：上限再收到 96——商家反馈短标题顶格太大，与版面不协调；
       长标题本就被 fit() 宽度约束自动缩，此改动只影响 ≤6 字的短标题。 */
    const tsMax = Math.max(72, Math.min(96, (Y(204) - Y(76) - 24 * k) / (F.ink || 0.86)));
    const ts = fit(c.title, S(88, 96), tsMax, MAXW * 0.66, 0.03);
    return [
      /* 小标和它下面那条短线是一组：小标没有值时整组不画。只删文字留线，顶上就是一根孤线。 */
      ...(c.label ? [
        lyT(c.label, { size: S(15, 26), x: L, y: Y(58), track: 0.3, op: 0.5, font: F.latin }),
        lyLine(Y(76), 0.85, hair, L, 44 * k),
      ] : []),
      lyT(c.title, { size: ts, x: L, y: Y(204), track: 0.03, fill: LY_WARM, font: F.display, weight: F.displayWeight }),
      lyLine(B(1706), 0.18, thin, 0, W),
      lyT(c.site, { size: S(11, 20), x: L, y: B(1744), track: 0.4, op: 0.42, font: F.latin }),
      lyT(c.idx, { size: S(11, 20), x: R, y: B(1744), track: 0.24, op: 0.42, align: 'right', font: F.latin }),
      lyT(c.note, { size: S(20, 34), x: L, y: B(1802), track: 0.14, op: 0.46, font: F.micro }),
    ].join('');
  }

  if (key === 'T2') { /* 瑞士极简：贴顶大标题、绝对网格、零装饰 */
    /* 同 T1：基线在 Y(158)、顶线在 Y(42)，把 150px 写死的结果是墨迹顶 Y(38) 直接穿过那条线。
       按墨迹反算后，标题顶部恒定压在线下 22px。2026-10-25：上限收到 88（同 T1 缩字理由）。 */
    const tsMax = Math.max(72, Math.min(88, (Y(158) - Y(42) - 22 * k) / (F.ink || 0.86)));
    const ts = fit(c.title, S(92, 88), tsMax, MAXW * 0.78, 0.01);
    return [
      lyLine(Y(42), 0.32, thin, 0, W),
      lyT(c.title, { size: ts, x: L, y: Y(158), track: 0.01, op: 0.97, font: F.display, weight: F.displayWeight }),
      lyT(c.en, { size: S(12, 22), x: L, y: Y(196), track: 0.42, op: 0.55, font: F.latin }),
      lyT(c.idx, { size: S(11, 20), x: R, y: Y(158), track: 0.1, op: 0.45, align: 'right', font: F.latin }),
      lyLine(B(1716), 0.18, thin, 0, W),
      lyT(c.note, { size: S(19, 34), x: L, y: B(1766), track: 0.06, op: 0.48, font: F.micro }),
      lyT(c.site, { size: S(11, 20), x: L, y: B(1824), track: 0.35, op: 0.38, font: F.latin }),
    ].join('');
  }

  if (key === 'T3') { /* 画册图录：居中、双线夹标题、小字密集 */
    /* 标题的可用带必须从编号下方起算。NO. 那行基线在 Y(104)，而旧代码从 Y(66) 起算，
       110px 标题的墨迹顶正好落在 Y(103.9)——整行编号被标题吞掉。
       带顶改到 Y(118)，上限收到 100px，编号与标题之间留出 30px。
       2026-10-25：上限再收到 84（同 T1 缩字理由）。 */
    const tTop = Y(118);
    const tBot = Y(232);
    const ts = fit(c.title, S(66, 84), 84, MAXW * 0.62, 0.14);
    /* 标题墨迹在 tTop–tBot 这条带里视觉居中：基线 = 带中线 + 墨迹高/2。 */
    const titleBase = (tTop + tBot) / 2 + ts * (F.ink || 0.86) / 2;
    return [
      lyLine(Y(66), 0.26, thin, 0, W),
      lyT(c.idx ? 'NO. ' + c.idx : '', { size: S(11, 20), x: W / 2, y: Y(104), track: 0.34, op: 0.55, align: 'center', font: F.latin }),
      lyT(c.title, { size: ts, x: W / 2, y: titleBase, track: 0.14, fill: LY_WARM, align: 'center', font: F.display, weight: F.displayWeight }),
      lyLine(tBot, 0.26, thin, 0, W),
      lyLine(B(1722), 0.26, thin, 0, W),
      lyT(c.note, { size: S(20, 34), x: W / 2, y: B(1770), track: 0.18, op: 0.55, align: 'center', font: F.micro }),
      lyT(c.site, { size: S(10, 18), x: W / 2, y: B(1818), track: 0.42, op: 0.34, align: 'center', font: F.latin }),
    ].join('');
  }

  if (key === 'T4') { /* 电影片头：全大写极宽字距，只留字不留装饰 */
    /* 中文标题只有 18–30px，是"配角小字"不是主标题。字重强制不低于 400：300 的细体压到 18px 会发虚。 */
    return [
      lyT(c.en, { size: S(22, 38), x: W / 2, y: Y(128), track: 0.46, op: 0.92, align: 'center', font: F.latin, weight: F.latinWeight }),
      lyT(c.title, { size: S(18, 30), x: W / 2, y: Y(176), track: 0.5, op: 0.52, align: 'center', font: F.display, weight: Math.max(400, F.displayWeight) }),
      lyLine(Y(218), 0.24, hair, W / 2 - 90 * k, 180 * k),
      lyT(c.site, { size: S(10, 18), x: W / 2, y: B(1734), track: 0.5, op: 0.34, align: 'center', font: F.latin }),
      lyT(c.note, { size: S(17, 30), x: W / 2, y: B(1778), track: 0.26, op: 0.52, align: 'center', font: F.micro }),
      lyT(c.idx, { size: S(10, 18), x: W / 2, y: B(1822), track: 0.3, op: 0.18, align: 'center', font: F.latin }),
    ].join('');
  }

  /* T5 东方竖排：右列竖排 + 书脊竖线，左侧大量留白 */
  const vs = Math.min(S(46, 60), Math.max(30, (bar - 96) / Math.max(1, [...c.title].length * (1 + 0.12))));
  const track = 0.12;
  const chars = [...c.title];
  const totalH = chars.length * vs + track * vs * (chars.length - 1);
  const startY = (bar - totalH) / 2 + vs * 0.84;
  const colX = R - 34 * k;
  return [
    `<rect x="${(colX - vs * 0.62).toFixed(1)}" y="${(34 * k).toFixed(1)}" width="${thin}" height="${((240 - 68) * k).toFixed(1)}" fill="${LY_PURE}" fill-opacity="0.22"/>`,
    lyT(c.title, { size: vs, x: colX, y: startY, track, vertical: true, fill: LY_WARM, font: F.display, weight: F.displayWeight }),
    lyLine(Y(178), 0.7, hair, L, 40 * k),
    lyT(c.site, { size: S(10, 18), x: L, y: Y(208), track: 0.34, op: 0.4, font: F.latin }),
    lyLine(B(1712), 0.2, thin, 0, W),
    lyT(c.note, { size: S(18, 32), x: L, y: B(1768), track: 0.2, op: 0.44, font: F.micro }),
    lyT(c.idx, { size: S(10, 18), x: R, y: B(1818), track: 0.3, op: 0.28, align: 'right', font: F.latin }),
  ].join('');
}

/* ============ 版式 × 配对：兼容矩阵，不是全排列 ============
   全排列 5×8=40 里有 22 组是崩的：T5 竖排离开书法/纤细宋会变成菜单排版，
   T2 贴顶网格塞圆胖体会直接散架。所以每套版式只列它撑得住的配对（共 18 组）。 */
export const LAYOUTS = [
  { id: 'layout_t1', key: 'T1', name: 'T1 时装编辑', defaultPairing: 'modern-editorial',
    allowed: ['modern-editorial', 'classic-serif', 'gallery-catalog', 'literary-light', 'playful-round'] },
  { id: 'layout_t2', key: 'T2', name: 'T2 瑞士极简', defaultPairing: 'swiss-grid',
    allowed: ['swiss-grid', 'modern-editorial'] },
  { id: 'layout_t3', key: 'T3', name: 'T3 画册图录', defaultPairing: 'gallery-catalog',
    allowed: ['gallery-catalog', 'classic-serif', 'literary-light', 'retro-signboard'] },
  { id: 'layout_t4', key: 'T4', name: 'T4 电影片头', defaultPairing: 'modern-editorial',
    allowed: ['modern-editorial', 'swiss-grid', 'classic-serif', 'gallery-catalog', 'retro-signboard'] },
  { id: 'layout_t5', key: 'T5', name: 'T5 东方竖排', defaultPairing: 'oriental-vertical',
    allowed: ['oriental-vertical', 'literary-light'] },
];

export function layoutById(layoutId) {
  return LAYOUTS.find((l) => l.id === layoutId) || LAYOUTS[0];
}

/**
 * 版式 + 配对 → 完整 SVG。size 默认 1:1（1080×1920），由渲染器按需放大。
 */
export function buildLayoutSvg({ layout, slot, pairing, copy, width = CANVAS.width, height = CANVAS.height }) {
  const F = typeof pairing === 'string' ? resolvePairing(pairing) : pairing;
  const key = typeof layout === 'string' ? (layoutById(layout).key || layout) : layout.key;
  const body = buildLayoutBody(key, slot, F, copy || {});
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${CANVAS.width} ${CANVAS.height}">${body}</svg>`;
}

/* 结尾卡不在这里：已整体迁到 `packages/ending-kit`（ending.js），以 V4 视觉实验室的 15 款成品资产为唯一来源。
   早前那版包了 cover-kit 的 4 个骨架（旧引擎资产），已被 V4 的「3 场景 × 5 款」取代。 */
