// 简兮特效目录 (Effects Catalogue) —— 素材盘点的静态清单
//
// 这里只剩"数据"，没有执行逻辑。
// 原来还有 6 个 resolve* 兜底函数（resolveTransition / resolveMotion / resolveEnding …），
// 唯一调用方是 V1 单体合成器 composer.js 的 compose()，那个函数零调用方、已于 2026-10-23 删除，
// 解析函数一并删掉。
//
// 现在唯一消费方：scripts/check-materials-integrity.mjs（生成 docs/materials/assets_inventory.json
// 的只读镜像）。也就是说，**图片成片出片不读这个文件**——引擎用的是
// modules/visual_engine_v4/imageFilm.js 自己的 MOTIONS / TEXT_ANIMS / TRANSITIONS 枚举。

// ==================== 转场（镜与镜之间） ====================
export const TRANSITIONS = {
  dissolve: { label: '万能叠化', scene: '万能平滑叠化过渡，经典交叉淡入淡出，零额外算力', xfade: 'dissolve' },
  fadeblack: { label: '黑场过渡', scene: '纯黑屏段落转折缓冲，情绪收放自如，最轻量级原生转场', xfade: 'fadeblack' },
  fadewhite: { label: '闪白过渡', scene: '产品高光闪白转折，明快惊艳，瞬时白曝光切换', xfade: 'fadewhite' },
  cut: { label: '利落直切', scene: '硬切无过渡，卡点干脆利落，绝对 0 CPU 算力开销', xfade: null },
  slide: { label: '轻快上滑', scene: '简单单轴线性平推入下一场景，轻快流畅', xfade: 'slideup' },
};

// ==================== 开场（作用于第一镜前段） ====================
export const OPENINGS = {
  slam_black: { label: '黑场砸出', scene: '强钩子开场，第一句就有冲击', kind: 'reveal' },
  dive_in: { label: '加速贯入', scene: '快节奏好物推荐，画面扑面而来', kind: 'reveal' },
  curtain_v: { label: '帘幕展开', scene: '电影感叙事、探店氛围铺垫', kind: 'reveal' },
  poster: { label: '大字报', scene: '一句话观点开场，黑底大字炸屏', kind: 'reveal' },
  light_sweep: { label: '扫光入场', scene: '高级感品牌片：45° 高光条 0.7s 扫过画面', kind: 'reveal' },
  fade_reveal: { label: '黑屏渐显', scene: '慢节奏生活感、高级氛围铺垫', kind: 'filter', fade: { color: 'black', dur: 0.8 } },
  flash_in: { label: '闪白入场', scene: '明亮通透的产品，第一眼惊艳', kind: 'filter', fade: { color: 'white', dur: 0.35 } },
};

// ==================== 运镜（逐镜微距） ====================
export const MOTIONS = {
  push_in: { label: '沉静微推', scene: '1.00 -> 1.05 缓慢推近聚焦细节与卖点，极低 CPU 算力', motion: 0 },
  pull_out: { label: '全景微拉', scene: '1.05 -> 1.00 缓慢拉远展现全貌与场景交代，平稳流畅', motion: 1 },
  diagonal: { label: '对角微掠', scene: '微距对角穿梭，动感掠过商品主体与多细节', motion: 2 },
  rise_up: { label: '垂直缓升', scene: 'Y 轴自下而上微抬打量，立体层次丰富', motion: 3 },
  sweep: { label: '水平横掠', scene: 'X 轴平缓横向掠镜，舒展氛围从容质感', motion: 4 },
  breathing: { label: '呼吸律动', scene: '1.00 ↔ 1.035 正弦波往复呼吸，赋予静态商品生命起伏感', motion: 5 },
};

// ==================== 结尾（仅作用于末镜后段） ====================
export const ENDINGS = {
  black_out: { label: '黑场收束', scene: '利落收尾，品牌余韵', kind: 'fade' },
  fade_out: { label: '淡出', scene: '情绪片温柔结束', kind: 'fade' },
  zoom_far: { label: '快速拉远', scene: '从细节拉回全景，意犹未尽', kind: 'zoomout' },
  brand_out: { label: '品牌收尾', scene: '黑场浮现品牌语，记忆点收束', kind: 'brand' },
};
