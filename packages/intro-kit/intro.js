/**
 * @jansee/intro-kit —— 简兮经典版式完整开场微光中台（上下分布 + 双向渐变微光遮罩）
 *
 * 1:1 复刻简兮定版事实源（modules/visual_engine_v4/layouts.js tpl_fashion_v1）：
 * 1. 上下双向电影遮罩（Dual-Edge Cinematic Vignette）：
 *    - 顶部 0%~24%：柔和黑曜石微光，托起大标题与发丝短线；
 *    - 中间 24%~74%：100% 绝对纯净全透明，原视频人物与商品主体毫无遮挡；
 *    - 底部 74%~100%：柔和黑曜石微光，托起横贯发丝线、品牌地点与副标金句。
 * 2. 简兮定版经典排版完整呈现（上天下地）：
 *    - 【顶部】：英文微光小标 + 2px 幽灵发丝短线 + 大片中文主标题（左对齐杂志感）；
 *    - 【底部】：横贯发丝细线 + 底部品牌地点（左） + 场次标号（右） + 情感留白金句（左下）。
 * 3. 字体规范：思源黑体（中）+ Jost（英），唯一真源 materials/fonts。
 */

export const INTRO_FONTS = Object.freeze({
  zh: 'Noto Sans SC',
  zhFile: 'NotoSansSC_400Regular.ttf',
  en: 'Jost',
  enFile: 'Jost_400Regular.ttf',
});

/** 开场时间结构常量（全链路统一口径）：t=0.2s 浮现，2.5s 淡出 */
export const INTRO_TIMING = Object.freeze({
  startSec: 0.2,     // 0.2s 时开始浮现
  fadeInSec: 0.45,   // 0.45s 柔和淡入
  durationSec: 2.5,  // 持续总长 2.5s
  fadeOutSec: 0.45,  // 0.45s 优雅淡出
});

/** 字符转义防注入 */
function esc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 构建开场花字包装 SVG（简兮经典 tpl_fashion_v1 完整上下分布版面）
 * @param {object} p
 * @param {string} [p.title] 主标题（中文，大模型导演输出或分镜首句金句）
 * @param {string} [p.brandEn] 顶部装饰英文标签（如 cut.site 或品牌名）
 * @param {string} [p.site] 底部地点/品牌英文
 * @param {string} [p.note] 底部情感留白短句（中文副标）
 * @param {string} [p.idx] 底部右侧场次标号（缺省 NO. 01）
 * @param {number} [p.width=1080] 视频宽度
 * @param {number} [p.height=1920] 视频高度
 * @returns {string} SVG 文本
 */
export function buildIntroSvg({
  title,
  brandEn,
  site,
  note,
  idx,
  width = 1080,
  height = 1920,
}) {
  const W = Math.max(320, Number(width) || 1080);
  const H = Math.max(240, Number(height) || 1920);
  const S = Math.min(W, H); // 基准短边

  const rawTitle = title === undefined ? '精选影像' : (typeof title === 'string' ? title.trim().slice(0, 24) : '');
  const hasTitle = rawTitle.length > 0;
  const mainTitle = esc(rawTitle);
  const topEn = esc(String(brandEn || site || '').trim().toUpperCase() || 'JANSEE CINEMATIC REFRAME');
  const botSite = esc(String(site || brandEn || '').trim().toUpperCase() || 'ORIGINAL ARCHIVE · JANSEE');
  const botIdx = esc(String(idx || '').trim().toUpperCase() || 'NO. 01 / SCENE');
  const botNote = esc(String(note || '').trim().slice(0, 28) || '留一席留白 · 慢下来品味');

  // 1:1 复用简兮 tpl_fashion_v1 坐标体系
  /* 移动端安全区边距：主流手机（20:9 / 19.5:9）全屏铺满 9:16 视频时，
     左右各裁切约 10%~12.5%。边距从旧版 W*0.08（86px）扩大到 W*0.122（≈132px），
     确保开场花字在手机端 Cover 裁切后完整可见。 */
  const L = Math.max(24, Math.round(W * 0.122)); // 左边距（移动端安全区 ≈12.2%）
  const R = W - L;                               // 右对齐边距
  const maxTitleWidth = W - L - Math.max(24, Math.round(W * 0.122)); // 留出右侧安全边界

  // ================= 顶部（上天）坐标 =================
  const topStart = Math.max(28, Math.round(H * 0.085));
  const enFontSize = Math.max(11, Math.round(S * 0.022));
  const lineW = Math.max(36, Math.round(S * 0.075));

  // 字号自适应衰减：防止文字溢出屏幕
  let baseTitleFontSize = Math.max(20, Math.round(S * 0.058));
  if (hasTitle && rawTitle.length > 4) {
    const approxWidth = rawTitle.length * baseTitleFontSize * 1.15;
    if (approxWidth > maxTitleWidth) {
      baseTitleFontSize = Math.max(16, Math.floor(maxTitleWidth / (rawTitle.length * 1.15)));
    }
  }
  const titleFontSize = baseTitleFontSize;

  const enY = topStart + enFontSize;
  const lineY = enY + Math.max(10, Math.round(S * 0.015));
  const titleY = lineY + Math.max(16, Math.round(S * 0.035)) + titleFontSize * 0.85;

  // 顶部黑到透明渐变遮罩高度：有主标题覆盖前 42%，纯装饰收缩至前 22%，通透不遮挡主体
  const topMaskH = hasTitle ? Math.round(H * 0.42) : Math.round(H * 0.22);

  // ================= 底部（下地）坐标 =================
  const botLineY = Math.round(H * 0.88);
  const botSubFontSize = Math.max(10, Math.round(S * 0.018));
  const botNoteFontSize = Math.max(13, Math.round(S * 0.026));

  const botMetaY = botLineY + Math.max(16, Math.round(S * 0.028));
  const botNoteY = botMetaY + Math.max(16, Math.round(S * 0.032));

  // 底部黑到透明渐变遮罩：覆盖后 32% 画面
  const botMaskY = Math.round(H * 0.68);
  const botMaskH = H - botMaskY;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
  <defs>
    <!-- 顶部 100% 纯黑到透明电影遮罩：0% (1.0 纯黑) -> 35% (0.85) -> 65% (0.45) -> 88% (0.15) -> 100% (0% 全透明) -->
    <linearGradient id="topCinematicMask" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#000000" stop-opacity="1.0" />
      <stop offset="35%" stop-color="#000000" stop-opacity="0.85" />
      <stop offset="65%" stop-color="#000000" stop-opacity="0.45" />
      <stop offset="88%" stop-color="#000000" stop-opacity="0.15" />
      <stop offset="100%" stop-color="#000000" stop-opacity="0" />
    </linearGradient>

    <!-- 底部透明到 100% 纯黑电影遮罩：0% (0% 全透明) -> 12% (0.15) -> 35% (0.45) -> 65% (0.85) -> 100% (1.0 纯黑) -->
    <linearGradient id="bottomCinematicMask" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#000000" stop-opacity="0" />
      <stop offset="12%" stop-color="#000000" stop-opacity="0.15" />
      <stop offset="35%" stop-color="#000000" stop-opacity="0.45" />
      <stop offset="65%" stop-color="#000000" stop-opacity="0.85" />
      <stop offset="100%" stop-color="#000000" stop-opacity="1.0" />
    </linearGradient>

    <filter id="editorialGlow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="2" stdDeviation="6" flood-color="#000000" flood-opacity="0.95" />
      <feDropShadow dx="0" dy="0" stdDeviation="2" flood-color="#000000" flood-opacity="0.90" />
    </filter>
  </defs>

  <!-- 1. 顶部 100% 纯黑到透明电影渐变遮罩（确保任何背景下遮罩层次一目了然） -->
  <rect x="0" y="0" width="${W}" height="${topMaskH}" fill="url(#topCinematicMask)" />

  <!-- 2. 底部透明到 100% 纯黑电影渐变遮罩（托起贯穿细线与地点副标） -->
  <rect x="0" y="${botMaskY}" width="${W}" height="${botMaskH}" fill="url(#bottomCinematicMask)" />

  <!-- 3. 【顶部图层】：简兮 tpl_fashion_v1 经典大标题与微光发丝短线 -->
  <g filter="url(#editorialGlow)">
    <!-- 装饰英文小标 -->
    <text
      x="${L}"
      y="${enY.toFixed(1)}"
      text-anchor="start"
      fill="#94A3B8"
      font-family="${INTRO_FONTS.en}, sans-serif"
      font-size="${enFontSize}"
      letter-spacing="${Math.max(2, Math.round(enFontSize * 0.28))}px"
      font-weight="400"
      fill-opacity="0.85"
    >${topEn}</text>

    <!-- 2px 幽灵微光发丝短线 -->
    <rect
      x="${L}"
      y="${lineY.toFixed(1)}"
      width="${lineW}"
      height="1.5"
      fill="#FFFFFF"
      fill-opacity="0.80"
    />

    <!-- 中文大片主标题（暖冷白，左对齐，有标题时渲染，无标题时纯装饰留白） -->
    ${hasTitle ? `
    <text
      x="${L}"
      y="${titleY.toFixed(1)}"
      text-anchor="start"
      fill="#F8FAFC"
      font-family="${INTRO_FONTS.zh}, sans-serif"
      font-size="${titleFontSize}"
      letter-spacing="${Math.max(1, Math.round(titleFontSize * 0.06))}px"
      font-weight="400"
      fill-opacity="0.98"
    >${mainTitle}</text>
    ` : ''}
  </g>

  <!-- 4. 【底部图层】：横贯发丝细线 + 品牌地点 + 场次标号 + 留白短句 -->
  <g filter="url(#editorialGlow)">
    <!-- 横贯发丝细线（1px 全宽微光贯穿线） -->
    <rect
      x="0"
      y="${botLineY}"
      width="${W}"
      height="1"
      fill="#FFFFFF"
      fill-opacity="0.22"
    />

    <!-- 底部左侧：地点 / 品牌副标 -->
    <text
      x="${L}"
      y="${botMetaY.toFixed(1)}"
      text-anchor="start"
      fill="#CBD5E1"
      font-family="${INTRO_FONTS.en}, sans-serif"
      font-size="${botSubFontSize}"
      letter-spacing="${Math.max(1, Math.round(botSubFontSize * 0.3))}px"
      font-weight="400"
      fill-opacity="0.70"
    >${botSite}</text>

    <!-- 底部右侧：场次编号 -->
    <text
      x="${R}"
      y="${botMetaY.toFixed(1)}"
      text-anchor="end"
      fill="#94A3B8"
      font-family="${INTRO_FONTS.en}, sans-serif"
      font-size="${botSubFontSize}"
      letter-spacing="${Math.max(1, Math.round(botSubFontSize * 0.2))}px"
      font-weight="400"
      fill-opacity="0.55"
    >${botIdx}</text>

    <!-- 底部第二行：情感留白意境短句 -->
    <text
      x="${L}"
      y="${botNoteY.toFixed(1)}"
      text-anchor="start"
      fill="#F8FAFC"
      font-family="${INTRO_FONTS.zh}, sans-serif"
      font-size="${botNoteFontSize}"
      letter-spacing="${Math.max(1, Math.round(botNoteFontSize * 0.12))}px"
      font-weight="400"
      fill-opacity="0.80"
    >${botNote}</text>
  </g>
</svg>`;
}
