/**
 * 一次性补全：4 款新入库字体的元数据 + 角色池 + 配对表
 *
 * 为什么要有「配对表」而不是直接随机抽单个字体：
 * 字体混搭会崩。马善政楷书配 Playfair 是和谐的，站酷快乐体配 Noto Serif 就是灾难。
 * 「随机」只能在预设好的组合里随机，否则每次出片都要重新赌一次审美。
 *
 * 为什么要有「角色」而不是按字体分类抽：
 * 版式里一个字体要干几件不同的事（大标题 / 小标 / 说明行 / 竖排），
 * 它能不能胜任由字号和字形决定，不由厂商分类决定。
 * 已经踩过的坑：仿宋 88px 会散、仿宋 17px 在深底上会糊——同一个字体在两端都不可用。
 */
import fs from 'node:fs';

const INDEX = 'materials/fonts/index.json';
const idx = JSON.parse(fs.readFileSync(INDEX, 'utf8'));
const byId = new Map(idx.fonts.map((f) => [f.id, f]));

/* ---------- 一、补全 4 款新字体 ---------- */

const meta = {
  'noto-serif-sc': {
    name: '思源宋体 (Noto Serif SC)',
    family: 'Noto Serif SC',
    category: 'luxury_serif',
    license: 'OFL 1.1（免费商用）',
    source: 'npm @expo-google-fonts/noto-serif-sc@0.4.4',
    tags: ['中文衬线', '宋体', '高级典雅', '出版物', '三字重'],
    bestFor: '高客单餐饮、设计品牌、文创、需要"印刷品感"的任何品类',
    files: [
      ['NotoSerifSC_300Light.ttf', 300, 'normal'],
      ['NotoSerifSC_400Regular.ttf', 400, 'normal'],
      ['NotoSerifSC_700Bold.ttf', 700, 'normal'],
    ],
    primary: 'NotoSerifSC_400Regular.ttf',
    note: '中文衬线的唯一正确解。日文明朝体虽然更好看但缺 11 个常用简体字，已在规格里否掉。',
  },
  'noto-sans-sc': {
    name: '思源黑体 (Noto Sans SC)',
    family: 'Noto Sans SC',
    category: 'modern_sans',
    license: 'OFL 1.1（免费商用）',
    source: 'npm @expo-google-fonts/noto-sans-sc@0.4.4',
    tags: ['中文无衬线', '现代极简', '瑞士网格', '两字重'],
    bestFor: '数码、设计、连锁品牌、任何需要"干净现代"的品类',
    files: [
      ['NotoSansSC_300Light.ttf', 300, 'normal'],
      ['NotoSansSC_400Regular.ttf', 400, 'normal'],
    ],
    primary: 'NotoSansSC_300Light.ttf',
    note: '80px 以上大标题的唯一安全解。300 字重的笔画在 1080 画幅上刚好，400 会显粗。',
  },
  jost: {
    name: 'Jost（Futura 开源复刻）',
    family: 'Jost',
    category: 'modern_sans',
    license: 'OFL 1.1（免费商用）',
    source: 'npm @expo-google-fonts/jost@0.4.2',
    tags: ['几何无衬线', '包豪斯', '宽字距全大写', '仅拉丁'],
    bestFor: '英文小标、编号、品牌名（JANSEE.CN），不能用于中文',
    files: [
      ['Jost_400Regular.ttf', 400, 'normal'],
      ['Jost_500Medium.ttf', 500, 'normal'],
    ],
    primary: 'Jost_400Regular.ttf',
    note: '替代系统 Futura。Futura 是 Windows 自带字体、不可商用，Jost 是它的开源克隆，观感几乎一致。',
  },
  'playfair-display': {
    name: 'Playfair Display',
    family: 'Playfair Display',
    category: 'luxury_serif',
    license: 'OFL 1.1（免费商用）',
    source: 'npm @expo-google-fonts/playfair-display@0.4.2',
    tags: ['高对比衬线', '时装杂志', '仅拉丁'],
    bestFor: '英文小标、时装/美妆/珠宝的高对比副标，不能用于中文',
    files: [
      ['PlayfairDisplay_400Regular.ttf', 400, 'normal'],
      ['PlayfairDisplay_700Bold.ttf', 700, 'normal'],
    ],
    primary: 'PlayfairDisplay_400Regular.ttf',
    note: '替代系统 Bodoni。Bodoni Bk BT 是 Windows 自带字体、不可商用。',
  },
};

for (const [id, m] of Object.entries(meta)) {
  const e = byId.get(id);
  if (!e) throw new Error(`索引里没有 ${id}`);
  e.name = m.name;
  e.family = m.family;
  e.category = m.category;
  e.license = m.license;
  e.source = m.source;
  e.tags = m.tags;
  e.bestFor = m.bestFor;
  e.files = m.files.map(([file, weight, style]) => ({ file, weight, style }));
  e.primaryFile = m.primary;
  e.primaryRelPath = `materials/fonts/${id}/${m.primary}`;
  e.totalFiles = m.files.length;
  e.note = m.note;
  delete e._needsReview;
}

// 已有 4 款补 source 字段（当时的下载来源不明，标注为素材库内置）
for (const id of ['ma-shan-zheng', 'zcool-kuaile', 'zcool-qingke-huangyou', 'zcool-xiaowei']) {
  const e = byId.get(id);
  if (e && !e.source) e.source = '素材库内置（OFL）';
  if (e && !Array.isArray(e.files[0])) {
    e.files = e.files.map((f) => (typeof f === 'string' ? { file: f, weight: 400, style: 'normal' } : f));
  }
}

/* ---------- 二、角色池 ----------
 * 角色 = 版式里的一个具体工位。判定依据是实测结论，不是厂商分类：
 *   80px 以上必须无衬线（衬线在这个尺寸笔画散开）
 *   55-75px 衬线可用（Noto Serif 300 在这里最好看）
 *   20px 以下必须无衬线（衬线在深底 + 低透明度下糊成一片）
 */
idx.roles = {
  _note: '每个角色声明 minPx/maxPx，抽取时按实际字号过滤；latinOnly 的角色只接受拉丁字体。',
  display_cn: {
    label: '中文大标题 80px+',
    minPx: 80,
    maxPx: 150,
    pool: ['noto-sans-sc', 'zcool-xiaowei', 'zcool-qingke-huangyou', 'zcool-kuaile'],
  },
  title_cn: {
    label: '中文中标题 55-75px',
    minPx: 55,
    maxPx: 75,
    pool: ['noto-serif-sc', 'zcool-xiaowei', 'noto-sans-sc', 'zcool-qingke-huangyou'],
  },
  micro_cn: {
    label: '中文说明行 20px 以下',
    minPx: 14,
    maxPx: 22,
    pool: ['noto-sans-sc', 'noto-serif-sc', 'zcool-xiaowei'],
  },
  vertical_cn: {
    label: '中文竖排',
    minPx: 30,
    maxPx: 60,
    pool: ['ma-shan-zheng', 'zcool-xiaowei', 'noto-serif-sc'],
  },
  label_latin: {
    label: '拉丁小标（全大写字距）',
    minPx: 9,
    maxPx: 24,
    latinOnly: true,
    pool: ['jost', 'playfair-display'],
  },
  num_latin: {
    label: '拉丁编号 / 数字',
    minPx: 9,
    maxPx: 120,
    latinOnly: true,
    pool: ['jost', 'playfair-display', 'noto-serif-sc'],
  },
};

/* ---------- 三、配对表 ----------
 * 一套配对 = 版式里所有字体工位的一次完整指派。
 * 随机抽配对，而不是随机抽单个字体——这是「每次不一样」和「不会翻车」的唯一交集。
 */
idx.pairings = [
  {
    id: 'modern-editorial',
    name: '现代编辑',
    display: 'noto-sans-sc',
    displayWeight: 300,
    latin: 'playfair-display',
    micro: 'noto-sans-sc',
    fit: ['咖啡', '烘焙', '服装', '美妆', '买手店'],
    mood: '克制、留白大、高级',
  },
  {
    id: 'classic-serif',
    name: '经典衬线',
    display: 'noto-serif-sc',
    displayWeight: 400,
    latin: 'jost',
    micro: 'noto-sans-sc',
    fit: ['茶室', '中餐厅', '文创', '书店'],
    mood: '温润、印刷品感',
  },
  {
    id: 'swiss-grid',
    name: '瑞士网格',
    display: 'noto-sans-sc',
    displayWeight: 300,
    latin: 'jost',
    micro: 'noto-sans-sc',
    fit: ['数码', '设计工作室', '健身', '连锁'],
    mood: '绝对秩序、零装饰',
  },
  {
    id: 'gallery-catalog',
    name: '画册图录',
    display: 'noto-serif-sc',
    displayWeight: 300,
    latin: 'playfair-display',
    micro: 'noto-sans-sc',
    fit: ['艺术展', '香氛', '花艺', '高端餐饮'],
    mood: '典雅、编号感、细密',
  },
  {
    id: 'oriental-vertical',
    name: '东方竖排',
    display: 'ma-shan-zheng',
    displayWeight: 400,
    latin: 'playfair-display',
    micro: 'noto-sans-sc',
    fit: ['茶', '中式餐饮', '国潮', '中医'],
    mood: '毛笔、书脊、大留白',
  },
  {
    id: 'retro-signboard',
    name: '复古招牌',
    display: 'zcool-qingke-huangyou',
    displayWeight: 400,
    latin: 'jost',
    micro: 'noto-sans-sc',
    fit: ['甜品', '炸物', '烧烤', '集市摊'],
    mood: '厚重、手绘招牌、吸睛',
  },
  {
    id: 'literary-light',
    name: '文艺清秀',
    display: 'zcool-xiaowei',
    displayWeight: 400,
    latin: 'playfair-display',
    micro: 'noto-sans-sc',
    fit: ['独立书店', '设计师品牌', '花店', '手作'],
    mood: '纤细、静谧、格调',
  },
  {
    id: 'playful-round',
    name: '亲和圆润',
    display: 'zcool-kuaile',
    displayWeight: 400,
    latin: 'jost',
    micro: 'noto-sans-sc',
    fit: ['母婴', '宠物', '零食', '少儿'],
    mood: '圆润、活泼、亲和',
  },
];

/* ---------- 四、系统字体黑名单 ----------
 * 打样时用过 simfang / simkai / Dengl / Bodoni / Futura，全是 Windows 自带字体。
 * 版权属微软与各字库厂商，不得随产品分发，更不能用于给付费用户出片。
 * 这里显式记录，防止以后有人图方便又接回系统字体。
 */
idx.bannedSystemFonts = {
  _note: '仅可用于本地打样，禁止进入生产随机池。五套版式需全部迁移到本索引内的 OFL 字体。',
  list: [
    { file: 'simfang.ttf', name: '仿宋', reason: 'Windows 自带，宋体族版权' },
    { file: 'simkai.ttf', name: '楷体', reason: 'Windows 自带，中易字库版权' },
    { file: 'Dengl.ttf', name: '等线 Light', reason: 'Windows 自带，微软版权' },
    { file: 'Bodoni Bk BT Book.ttf', name: 'Bodoni', reason: '商业字库，随 Windows 授权不含商用分发' },
    { file: 'Futura Bk BT Book.ttf', name: 'Futura', reason: '商业字库，同上' },
  ],
  replacements: {
    'simfang.ttf': 'noto-serif-sc',
    'simkai.ttf': 'ma-shan-zheng 或 noto-serif-sc',
    'Dengl.ttf': 'noto-sans-sc（300）',
    'Bodoni Bk BT Book.ttf': 'playfair-display',
    'Futura Bk BT Book.ttf': 'jost',
  },
};

idx.licensePolicy =
  '仅收录 SIL OFL 1.1 / Apache 2.0 可商用字体。系统字体（Windows/Office 自带）不得进入生产池，见 bannedSystemFonts。';
idx.totalCount = idx.fonts.length;
idx.roleCount = Object.keys(idx.roles).filter((k) => k !== '_note').length;
idx.pairingCount = idx.pairings.length;
idx.version = '4.0.0';
idx.updatedAt = new Date().toISOString().slice(0, 10);

fs.writeFileSync(INDEX, JSON.stringify(idx, null, 2) + '\n');
console.log('已补全：', idx.totalCount, '款字体 /', idx.roleCount, '个角色 /', idx.pairingCount, '套配对');
