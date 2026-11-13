/**
 * 结尾收束 · 15 款 CTA 资产 + 抽样（全平台唯一真源）
 *
 * 原 modules/visual_engine_v4/ending.js，2026-10-24 原样提升为独立包：
 * 消费者从 1 条链路（图片成片引擎）变成 2 条（+ 视频配音），
 * 按项目宪法「能力有 ≥2 个互不统属调用方即独立成包」提升。
 * 本文件与引擎版逐字一致（cp 搬迁，未手抄），SVG 几何一处都没动。
 *
 * 严格镜像 `docs/visual-gallery/v4.html` 的 `V4_ASSETS.ending`（15 款）
 * 与 `buildEndingCtaSvg()` 的四个骨架分支。
 *
 * 为什么不再用 `packages/cover-kit/endingCta.js`：
 * 那是旧引擎资产（4 款基础 + 文案池随机拼骨架），V4 已经把结尾收束定成
 * 「15 款成品 = 3 场景 × 5 款，每款是骨架 + 文案的固定搭配」。
 * 两套并存会导致同一单出两种结尾风格，所以全平台只认这一份。
 *
 * 一致性由 modules/visual_engine_v4/tests/ending-assets.test.mjs
 * 逐条比对 v4.html，漂了就红。
 */

/* ============ 15 款资产（顺序与 v4.html 一致） ============ */
export const ENDING_ASSETS = Object.freeze([
  { id: 'cta_p1_hairline', name: 'CTA · 个人 · 发丝双翼线', scene: 'personal', copyId: 'p_continue', skelId: 'horizontal_hairline', kind: 'cta', desc: '「未 完 · 待 续 / TO BE CONTINUED」— 发丝水平双翼线骨架' },
  { id: 'cta_p2_ghost', name: 'CTA · 个人 · 幽灵微框', scene: 'personal', copyId: 'p_resonance', skelId: 'ghost_box', kind: 'cta', desc: '「静 候 灵 感 回 响 / RESONANCE OF INSPIRATION」— 幽灵微框骨架' },
  { id: 'cta_p3_pillar', name: 'CTA · 个人 · 中心竖柱', scene: 'personal', copyId: 'p_next_encounter', skelId: 'vertical_pillar', kind: 'cta', desc: '「下 一 站 · 再 会 / UNTIL THE NEXT ENCOUNTER」— 东方竖直隔离柱骨架' },
  { id: 'cta_p4_typo', name: 'CTA · 个人 · 无框微距', scene: 'personal', copyId: 'p_stories_motion', skelId: 'pure_typo', kind: 'cta', desc: '「步 履 不 停 · 所 见 皆 景 / STORIES IN CONTINUOUS MOTION」— 纯排版骨架' },
  { id: 'cta_p5_hairline', name: 'CTA · 个人 · 光影余韵', scene: 'personal', copyId: 'p_silent_echo', skelId: 'horizontal_hairline', kind: 'cta', desc: '「光 影 停 歇 · 意 犹 未 尽 / WHERE SHADOWS REST, MEMORIES ECHO」— 发丝双翼线骨架' },
  { id: 'cta_s1_ghost', name: 'CTA · 电商 · 幽灵微框', scene: 'sell', copyId: 's_curated', skelId: 'ghost_box', kind: 'cta', desc: '「甄 选 呈 现 · 即 刻 拥 有 / CURATED FOR YOU · AVAILABLE NOW」— 幽灵微框骨架' },
  { id: 'cta_s2_hairline', name: 'CTA · 电商 · 发丝双翼线', scene: 'sell', copyId: 's_worth', skelId: 'horizontal_hairline', kind: 'cta', desc: '「物 有 所 值 · 恭 候 鉴 赏 / WORTH EVERY MOMENT · ORDER NOW」— 发丝双翼线骨架' },
  { id: 'cta_s3_typo', name: 'CTA · 电商 · 无框微距', scene: 'sell', copyId: 's_in_stock', skelId: 'pure_typo', kind: 'cta', desc: '「匠 心 之 作 · 现 货 呈 现 / CRAFTED WITH SOUL · READY TO SHIP」— 纯排版骨架' },
  { id: 'cta_s4_pillar', name: 'CTA · 电商 · 中心竖柱', scene: 'sell', copyId: 's_exclusive', skelId: 'vertical_pillar', kind: 'cta', desc: '「私 享 典 藏 · 欢 迎 选 购 / EXCLUSIVE SELECTION · LIMITED PIECES」— 东方竖柱骨架' },
  { id: 'cta_s5_ghost', name: 'CTA · 电商 · 品质启程', scene: 'sell', copyId: 's_signature', skelId: 'ghost_box', kind: 'cta', desc: '「品 质 见 证 · 心 动 启 程 / AUTHENTIC QUALITY · SHOP THE COLLECTION」— 幽灵微框骨架' },
  { id: 'cta_l1_pillar', name: 'CTA · 实体 · 中心竖柱', scene: 'local', copyId: 'l_reserved', skelId: 'vertical_pillar', kind: 'cta', desc: '「虚 位 以 待 · 恭 候 光 临 / A SEAT RESERVED · WELCOME TO VISIT」— 东方竖柱骨架' },
  { id: 'cta_l2_hairline', name: 'CTA · 实体 · 发丝双翼线', scene: 'local', copyId: 'l_presence', skelId: 'horizontal_hairline', kind: 'cta', desc: '「一 席 留 白 · 静 待 亲 临 / WAITING IN SILENCE FOR YOUR PRESENCE」— 发丝双翼线骨架' },
  { id: 'cta_l3_ghost', name: 'CTA · 实体 · 幽灵微框', scene: 'local', copyId: 'l_taste_moment', skelId: 'ghost_box', kind: 'cta', desc: '「此 处 相 逢 · 欢 迎 品 鉴 / MEET HERE · TASTE THE AUTHENTIC MOMENT」— 幽灵微框骨架' },
  { id: 'cta_l4_typo', name: 'CTA · 实体 · 无框微距', scene: 'local', copyId: 'l_space_encounter', skelId: 'pure_typo', kind: 'cta', desc: '「同 城 所 见 · 恭 候 打 卡 / IN OUR SPACE · SEE YOU HERE SOON」— 纯排版骨架' },
  { id: 'cta_l5_hairline', name: 'CTA · 实体 · 暖意恭候', scene: 'local', copyId: 'l_door_open', skelId: 'horizontal_hairline', kind: 'cta', desc: '「暖 意 充 盈 · 敬 候 佳 期 / DOORS OPEN WIDE · AWAITING YOUR ARRIVAL」— 发丝双翼线骨架' },
]);

export const ENDING_SCENES = Object.freeze(['personal', 'sell', 'local']);

/** 入口 → 场景。线上商家线上卖货 = sell，线下门店 = local，个人创作者 = personal。 */
export const ENTRY_TO_SCENE = Object.freeze({
  online: 'sell',
  offline: 'local',
  personal: 'personal',
  sell: 'sell',
  local: 'local',
});

/* 结尾卡固定用这两款字（V4 实验室口径），不跟随正文配对。
   理由：结尾是全片唯一「纯字卡」，跟商品图的调性无关，跟随配对会每单变风格。 */
export const ENDING_FONTS = Object.freeze({
  zh: 'Noto Sans SC',
  en: 'Jost',
  zhFile: 'NotoSansSC_400Regular.ttf',
  enFile: 'Jost_400Regular.ttf',
});

/** 竖柱骨架左右两侧的副字（V4 原值，可被调用方覆盖） */
const DEFAULT_BRAND = Object.freeze({ zh: '原 创 呈 现', en: 'JANSEE AI STUDIO' });

/* ============ 文案解析 ============
   desc 形状：「未 完 · 待 续 / TO BE CONTINUED」— 发丝双翼线骨架
   「」内按 " / " 切两段，前中文后英文。 */
export function endingCopyParts(item) {
  const match = String((item && item.desc) || '').match(/「([^」]+)」/);
  const parts = match ? match[1].split(' / ') : [];
  return { zh: (parts[0] || '').trim(), en: (parts[1] || '').trim() };
}

/** 中文里的「·」是分行符，不是标点 */
function endingZhLines(zh) {
  const parts = String(zh || '').split(/\s*·\s*/).map((p) => p.trim()).filter(Boolean);
  return parts.length > 1 ? parts : [String(zh || '').trim()];
}

function wrapWords(text, maxWidth, charWidth) {
  const lines = [];
  let cur = '';
  for (const word of String(text || '').split(/\s+/).filter(Boolean)) {
    const trial = cur ? `${cur} ${word}` : word;
    if (trial.length * charWidth <= maxWidth || !cur) cur = trial;
    else { lines.push(cur); cur = word; }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [''];
}

function escapeXml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/** 按场景取该场景的 5 款；未知名回落到 sell（线上是主场景） */
export function endingsForScene(scene) {
  const key = ENTRY_TO_SCENE[scene] || scene;
  const list = ENDING_ASSETS.filter((e) => e.scene === key);
  return list.length ? list : ENDING_ASSETS.filter((e) => e.scene === 'sell');
}

/**
 * 入口场景（online/offline/personal/sell/local）归一成引擎三态
 * （sell/local/personal），越界回落 sell。两条链路的入口词表不同
 * （前端可能传 online，创作任务传 sell），归一逻辑只许有一份。
 */
export function sceneForEngine(scene) {
  const key = ENTRY_TO_SCENE[String(scene || '').trim()] || String(scene || '').trim();
  return ['sell', 'local', 'personal'].includes(key) ? key : 'sell';
}

/**
 * 抽一款。吃外部传入的 rand，保证同一颗 seed 出同一条结尾——
 * 用户改个错字重出一次，尾句整个换掉是灾难级体验。
 */
export function pickEnding(rand, { scene = 'sell', endingId = null } = {}) {
  if (endingId) {
    const hit = ENDING_ASSETS.find((e) => e.id === endingId);
    if (hit) return hit;
  }
  const pool = endingsForScene(scene);
  return pool[Math.floor(rand() * pool.length)];
}

/* ============ 渲染（逐字镜像 v4.html 的 buildEndingCtaSvg） ============ */
export function buildEndingSvg(item, { brandZh, brandEn, withAiBadge = true } = {}) {
  const W = 1080;
  const H = 1920;
  const cx = W / 2;
  const cy = H / 2;
  const { zh, en } = endingCopyParts(item);
  const skel = String((item && item.skelId) || 'horizontal_hairline');

  const open = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">`;
  /* 结尾 CTA 也走真实字库。原来这里是 PingFang/Inter 系统栈，
     Windows 上 PingFang 根本不存在，实际一直回退到微软雅黑，等于没指定。 */
  const zhFont = `font-family="${ENDING_FONTS.zh},sans-serif"`;
  const enFont = `font-family="${ENDING_FONTS.en},sans-serif"`;
  const brand = {
    zh: brandZh != null ? brandZh : DEFAULT_BRAND.zh,
    en: brandEn != null ? brandEn : DEFAULT_BRAND.en,
  };
  // 国标 GB 45438-2025 · 结尾显性标识统一固化在片尾收束卡左上角安全区（全平台四大版块统一样式与位置）
  // 字号严格遵循国标下限：高度 ≥ 短边 5%（1080 宽即 54px）
  // 移动端安全区：x 从旧版 26px 扩大到 130px（12%），防止 20:9 手机 Cover 裁切时首字被切掉
  const aiBadge = withAiBadge !== false
    ? `<text x="130" y="82" fill="#F8FAFC" fill-opacity="0.90" ${zhFont} font-size="54" font-weight="400" letter-spacing="1.2">本视频由 AI 生成 · JANSEE</text>`
    : '';
  const backdrop = `<rect x="0" y="0" width="${W}" height="${H}" fill="#0a0a0e" fill-opacity="0.68"/>${aiBadge}`;

  if (skel === 'ghost_box') {
    const ZH_FS = 52, EN_FS = 32, PAD_X = 88, PAD_Y = 48, GAP = 24, EN_LH = EN_FS * 1.5;
    const maxLineW = W * 0.86 - PAD_X * 2;
    const zhW = Array.from(zh.replace(/\s+/g, '')).length * ZH_FS * 1.22;
    const enLines = wrapWords(en, maxLineW, EN_FS * 0.88);
    const enMaxW = Math.max(...enLines.map((line) => line.length * EN_FS * 0.88));
    const boxW = Math.round(Math.min(Math.max(zhW, enMaxW) + PAD_X * 2, W * 0.86));
    const boxH = Math.round(ZH_FS * 1.2 + GAP + 3 + GAP + enLines.length * EN_LH + PAD_Y * 2);
    const boxX = Math.round(cx - boxW / 2);
    const boxY = Math.round(cy - boxH / 2);
    const zhY = boxY + PAD_Y + ZH_FS * 0.8;
    const ruleY = boxY + PAD_Y + ZH_FS * 1.2 + GAP + 1.5;
    const enTop = boxY + PAD_Y + ZH_FS * 1.2 + GAP + 3 + GAP;
    const enTexts = enLines.map((line, index) => `<text x="${cx}" y="${(enTop + EN_LH * index + EN_FS * 0.8).toFixed(1)}" text-anchor="middle" fill="#ffffff" ${enFont} font-size="${EN_FS}" font-weight="300" letter-spacing="${(EN_FS * 0.28).toFixed(1)}" fill-opacity="0.60">${escapeXml(line)}</text>`).join('');
    const ruleW = Math.round(boxW * 0.72), dot = 8, inset = 20;
    return open + `<defs><filter id="v4BoxGlow" x="-10%" y="-10%" width="120%" height="120%"><feDropShadow dx="0" dy="32" stdDeviation="96" flood-color="#000000" flood-opacity="0.6"/></filter></defs>${backdrop}<g filter="url(#v4BoxGlow)"><rect x="${boxX}" y="${boxY}" width="${boxW}" height="${boxH}" rx="12" ry="12" fill="#0a0a0e" fill-opacity="0.50" stroke="#ffffff" stroke-opacity="0.22" stroke-width="4"/><circle cx="${boxX + inset}" cy="${boxY + inset}" r="${dot}" fill="#ffffff" fill-opacity="0.5"/><circle cx="${boxX + boxW - inset}" cy="${boxY + inset}" r="${dot}" fill="#ffffff" fill-opacity="0.5"/><circle cx="${boxX + inset}" cy="${boxY + boxH - inset}" r="${dot}" fill="#ffffff" fill-opacity="0.5"/><circle cx="${boxX + boxW - inset}" cy="${boxY + boxH - inset}" r="${dot}" fill="#ffffff" fill-opacity="0.5"/><text x="${cx}" y="${zhY.toFixed(1)}" text-anchor="middle" fill="#ffffff" ${zhFont} font-size="${ZH_FS}" font-weight="400" letter-spacing="${(ZH_FS * 0.22).toFixed(1)}" fill-opacity="0.95">${escapeXml(zh)}</text><line x1="${cx - ruleW / 2}" y1="${ruleY.toFixed(1)}" x2="${cx + ruleW / 2}" y2="${ruleY.toFixed(1)}" stroke="#ffffff" stroke-opacity="0.12" stroke-width="3"/>${enTexts}</g></svg>`;
  }

  if (skel === 'vertical_pillar') {
    const ZH_FS = 48, EN_FS = 30, SUB_FS = 28, GAP_COL = 56, GAP_IN = 16, ZH_GAP = 16, VL_W = 3, VL_H = 320;
    const colEdge = (GAP_COL + VL_W) / 2;
    const lx = cx - colEdge;
    const rx = cx + colEdge;
    const maxEnPx = W - rx - W * 0.04;
    const enLines = [];
    let cur = '';
    for (const word of String(en || '').split(/\s+/).filter(Boolean)) {
      const trial = cur ? `${cur} ${word}` : word;
      if (trial.length * EN_FS * 0.88 <= maxEnPx || !cur) cur = trial;
      else { enLines.push(cur); cur = word; }
    }
    if (cur) enLines.push(cur);
    const EN_LH = EN_FS * 1.5, zhLine = ZH_FS * 1.2, subLine = SUB_FS * 1.2;
    const zhLines = endingZhLines(zh);
    const zhBlock = zhLines.length * zhLine + (zhLines.length - 1) * ZH_GAP;
    const leftTop = cy - (zhBlock + GAP_IN + subLine) / 2;
    const rightTop = cy - (enLines.length * EN_LH + GAP_IN + subLine) / 2;
    const zhTexts = zhLines.map((ln, i) => `<text x="${lx.toFixed(1)}" y="${(leftTop + i * (zhLine + ZH_GAP) + zhLine * 0.8).toFixed(1)}" text-anchor="end" fill="#ffffff" ${zhFont} font-size="${ZH_FS}" font-weight="400" letter-spacing="${(ZH_FS * 0.18).toFixed(1)}" fill-opacity="0.95">${escapeXml(ln)}</text>`).join('');
    const lSubY = leftTop + zhBlock + GAP_IN + subLine * 0.8;
    const rSubY = rightTop + enLines.length * EN_LH + GAP_IN + subLine * 0.8;
    const enTexts = enLines.map((ln, i) => `<text x="${rx.toFixed(1)}" y="${(rightTop + EN_LH * i + EN_FS * 0.8).toFixed(1)}" text-anchor="start" fill="#ffffff" ${enFont} font-size="${EN_FS}" font-weight="300" letter-spacing="${(EN_FS * 0.22).toFixed(1)}" fill-opacity="0.60">${escapeXml(ln)}</text>`).join('');
    return open + `<defs><linearGradient id="v4VpGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#ffffff" stop-opacity="0"/><stop offset="30%" stop-color="#ffffff" stop-opacity="0.55"/><stop offset="70%" stop-color="#ffffff" stop-opacity="0.55"/><stop offset="100%" stop-color="#ffffff" stop-opacity="0"/></linearGradient></defs>${backdrop}<g><rect x="${(cx - VL_W / 2).toFixed(1)}" y="${cy - VL_H / 2}" width="${VL_W}" height="${VL_H}" fill="url(#v4VpGrad)"/>${zhTexts}<text x="${lx.toFixed(1)}" y="${lSubY.toFixed(1)}" text-anchor="end" fill="#ffffff" ${zhFont} font-size="${SUB_FS}" font-weight="300" letter-spacing="${(SUB_FS * 0.18).toFixed(1)}" fill-opacity="0.40">${escapeXml(brand.zh)}</text>${enTexts}<text x="${rx.toFixed(1)}" y="${rSubY.toFixed(1)}" text-anchor="start" fill="#ffffff" ${enFont} font-size="${SUB_FS}" font-weight="300" letter-spacing="${(SUB_FS * 0.18).toFixed(1)}" fill-opacity="0.40">${escapeXml(brand.en)}</text></g></svg>`;
  }

  if (skel === 'pure_typo') {
    const ZH_FS = 56, EN_FS = 34, GAP = 40, ZH_GAP = 20, zhLine = ZH_FS * 1.2, enLine = EN_FS * 1.2;
    const zhLines = endingZhLines(zh);
    const zhBlock = zhLines.length * zhLine + (zhLines.length - 1) * ZH_GAP;
    const top = cy - (zhBlock + GAP + enLine) / 2;
    const enY = top + zhBlock + GAP + enLine * 0.8;
    const zhTexts = zhLines.map((ln, i) => `<text x="${cx}" y="${(top + i * (zhLine + ZH_GAP) + zhLine * 0.8).toFixed(1)}" text-anchor="middle" fill="#ffffff" ${zhFont} font-size="${ZH_FS}" font-weight="400" letter-spacing="${(ZH_FS * 0.28).toFixed(1)}" fill-opacity="0.95">${escapeXml(ln)}</text>`).join('');
    return open + `${backdrop}<g>${zhTexts}<text x="${cx}" y="${enY.toFixed(1)}" text-anchor="middle" fill="#ffffff" ${enFont} font-size="${EN_FS}" font-weight="300" letter-spacing="${(EN_FS * 0.36).toFixed(1)}" fill-opacity="0.60">${escapeXml(en)}</text></g></svg>`;
  }

  /* 默认：horizontal_hairline（发丝双翼线 + 中央菱形） */
  const ZH_FS = 52, EN_FS = 32, GAP = 32, DIA = 20, DIA_PAD = 32;
  const zhW = Array.from(zh.replace(/\s+/g, '')).length * ZH_FS * 1.22;
  const enW = en.length * EN_FS * 0.88;
  const blockW = Math.min(Math.max(zhW, enW), W * 0.88), zhLine = ZH_FS * 1.2, enLine = EN_FS * 1.2;
  const top = cy - (zhLine + GAP + DIA + GAP + enLine) / 2;
  const zhY = top + zhLine * 0.8;
  const ruleY = top + zhLine + GAP + DIA / 2;
  const enY = top + zhLine + GAP + DIA + GAP + enLine * 0.8;
  const wing = blockW / 2 - DIA_PAD;
  return open + `<defs><linearGradient id="v4HlL" x1="1" y1="0" x2="0" y2="0"><stop offset="0%" stop-color="#ffffff" stop-opacity="0.45"/><stop offset="100%" stop-color="#ffffff" stop-opacity="0"/></linearGradient><linearGradient id="v4HlR" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#ffffff" stop-opacity="0.45"/><stop offset="100%" stop-color="#ffffff" stop-opacity="0"/></linearGradient></defs>${backdrop}<g><text x="${cx}" y="${zhY.toFixed(1)}" text-anchor="middle" fill="#ffffff" ${zhFont} font-size="${ZH_FS}" font-weight="400" letter-spacing="${(ZH_FS * 0.22).toFixed(1)}" fill-opacity="0.95">${escapeXml(zh)}</text><line x1="${(cx - DIA_PAD).toFixed(1)}" y1="${ruleY.toFixed(1)}" x2="${(cx - wing).toFixed(1)}" y2="${ruleY.toFixed(1)}" stroke="url(#v4HlL)" stroke-width="3"/><polygon points="${cx},${(ruleY - DIA / 2).toFixed(1)} ${(cx + DIA / 2).toFixed(1)},${ruleY.toFixed(1)} ${cx},${(ruleY + DIA / 2).toFixed(1)} ${(cx - DIA / 2).toFixed(1)},${ruleY.toFixed(1)}" fill="#ffffff" fill-opacity="0.85"/><line x1="${(cx + DIA_PAD).toFixed(1)}" y1="${ruleY.toFixed(1)}" x2="${(cx + wing).toFixed(1)}" y2="${ruleY.toFixed(1)}" stroke="url(#v4HlR)" stroke-width="3"/><text x="${cx}" y="${enY.toFixed(1)}" text-anchor="middle" fill="#ffffff" ${enFont} font-size="${EN_FS}" font-weight="300" letter-spacing="${(EN_FS * 0.28).toFixed(1)}" fill-opacity="0.60">${escapeXml(en)}</text></g></svg>`;
}
