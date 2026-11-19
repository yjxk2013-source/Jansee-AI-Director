// 简兮 · 本地强信号变体判定引擎 (V4 纯 TypeScript 原生重构)

export const SELL_VARIANT_TYPES = [
  'A-痛点直击型',
  'B-反差对比型',
  'C-福利低价型',
  'D-场景代入型',
  'E-证言型',
  'F-紧迫逼单型',
  'G-结果先行型',
  'H-情感共鸣型',
  'I-权威专业型',
  'J-反转型/避坑型',
  'K-教程演示型',
  'L-信任测评型',
  'M-数字冲击型',
  'N-保障安心型',
] as const;

export const LOCAL_VARIANT_TYPES = [
  'A-宝藏发现型',
  'B-性价比种草型',
  'C-环境氛围型',
  'D-硬核测评型',
  'E-避坑提醒型',
  'F-限时活动型',
  'G-信任背书型',
  'H-高客单沉稳型',
] as const;

export type SellVariantType = typeof SELL_VARIANT_TYPES[number];
export type LocalVariantType = typeof LOCAL_VARIANT_TYPES[number];

const SELL_SIGNAL_RULES: Array<{ type: SellVariantType; re: RegExp }> = [
  { type: 'K-教程演示型', re: /教程|教学|步骤|食谱|做法|怎么做|怎么用|DIY|教你|学会|攻略|入门/ },
  {
    type: 'H-情感共鸣型',
    re: /礼盒|伴手礼|送长辈|送客户|送朋友|送爸妈|送人|送礼|有面子|有排面|礼物|悦己|女神|女友|闺蜜|妈妈|女生|春茶|新茶|明前|头采|高山茶|时鲜|当季|季节限定|尝鲜|回甘|茶香|生香|春意|春色|初春|山野/,
  },
  { type: 'J-反转型/避坑型', re: /避坑|避雷|干货|别买|不能买|千万别|当心|小心|防坑|智商税|踩坑|后悔/ },
  { type: 'B-反差对比型', re: /肉眼可见|立竿见影|马上见效|前后对比|效果明显|焕然一新|一用就|瞬间/ },
  { type: 'G-结果先行型', re: /坚持|28天|7天|一段时间后|过程慢|慢慢.*效果|养成|蜕变/ },
  {
    type: 'F-紧迫逼单型',
    re: /限时|秒杀|抢|手慢无|库存不多|马上截止|最后.*天|抓紧|库存告急|手慢|手快|快抢|还剩|截止|倒计时|今天下单/,
  },
  {
    type: 'I-权威专业型',
    re: /专业|背书|临床|实验室|认证|配方|研发|证书|专利|专家|检测报告|成分党|科班|医研|母婴级|食品级|质检/,
  },
  {
    type: 'N-保障安心型',
    re: /保修|售后|安心|放心|正品保障|假一赔|运费险|终身|质保|包退|无理由|不满意包退|闪赔|承诺/,
  },
  {
    type: 'M-数字冲击型',
    re: /出货量|\d+w\+|\d+万\+|\d+支|\d+瓶|\d+单|\d+位|累计销售|断货\d+次|\d+条好评|\d+个点|回头客\d+|数字不会骗人/,
  },
  {
    type: 'L-信任测评型',
    re: /实测|开箱|自用|体验|亲测|用了一个月|盲测|红黑榜|真实感受|测评|空瓶|真实记录|实打实/,
  },
  {
    type: 'E-证言型',
    re: /老粉|回购|复购|无数次|一直在用|第三瓶|第五次回购|无限回购|身边的朋友|同事都在|全网都在|都在用/,
  },
  {
    type: 'A-痛点直击型',
    re: /痛点|头疼|烦恼|救命|救星|尴尬|难受|谁懂啊|崩溃|踩雷|绝望|受够了|苦恼|困扰|毛孔粗大|脱发|油头|起皮|暗沉|卡粉|异味|发黄|油腻|油污|难清洗|结垢|堵塞|乱糟糟|放不下|挤不下|收纳不下|凌乱|占空间|衣服褶|起球|褪色|缩水|磨脚|累脚|卡顿|发热|慢|耗电快|续航差|容易坏|摔坏|噪音大|吵|异响|难受|失眠|睡不好|落枕|腰酸|背痛|疲劳|酸痛/,
  },
  { type: 'D-场景代入型', re: /场景|下班|周末|早上|睡前|通勤|约会|出差|旅行|聚会|独处|办公室|回家|户外|客厅|卧室|穿搭|衣橱/ },
  { type: 'C-福利低价型', re: /低价|让利|优惠|团购|划算|半价|满减|特价|买一送一|包邮|券|便宜|促销|折扣/ },
];

const LOCAL_SIGNAL_RULES: Array<{ type: LocalVariantType; re: RegExp }> = [
  { type: 'H-高客单沉稳型', re: /二手车|二手房|医美|婚庆|珠宝|高端餐饮|牙科|种植牙|分期|月子|豪车|高端/ },
  {
    type: 'E-避坑提醒型',
    re: /哪些别点|哪些必点|避雷|避坑|真实吐槽|别买|不能买|千万别|当心|小心|怎么挑|挑.*技巧|死蟹|踩雷/,
  },
  {
    type: 'F-限时活动型',
    re: /新店开业|开业|节日特惠|周末活动|进店送|赠品|半价|第二杯半价|买一送一|充值送|活动|特惠|折扣|优惠/,
  },
  {
    type: 'C-环境氛围型',
    re: /拍照|打卡|约会|环境好|环境出片|超出片|出片|氛围感|网红店|落地窗|绝美|姐妹|落地灯|吊灯|壁灯|灯饰|氛围灯|暖光|灯光|家居氛围|家装|室内设计/,
  },
  { type: 'G-信任背书型', re: /老店|老字号|口碑|熟客|街坊|邻居|回头客|开了.{0,3}年|多年|几十年/ },
  { type: 'B-性价比种草型', re: /平价|实惠|好吃|好用|团购套餐|划算|性价比|人均|便宜|吃到撑|量大/ },
  { type: 'D-硬核测评型', re: /食材品质|服务体验|设施|检验|专业|品质|用料|新鲜|测评|手艺|细节/ },
  { type: 'A-宝藏发现型', re: /小众|新开|隐藏|宝藏|巷子|藏在|不起眼/ },
];

export function decideVariantLocal(
  inputText: string,
  mode: 'sell' | 'local' = 'sell',
  usedTypes: string[] = []
): string {
  if (mode !== 'sell' && mode !== 'local') return '';
  const txt = String(inputText || '').trim();
  if (!txt) return '';
  const used = new Set((Array.isArray(usedTypes) ? usedTypes : []).map((s) => String(s).trim()).filter(Boolean));
  const rules = mode === 'local' ? LOCAL_SIGNAL_RULES : SELL_SIGNAL_RULES;
  const typeNames = mode === 'local' ? LOCAL_VARIANT_TYPES : SELL_VARIANT_TYPES;
  for (const r of rules) {
    if (r.re.test(txt)) {
      if (!used.has(r.type)) return r.type;
      const rest = (typeNames as readonly string[]).filter((t) => !used.has(t));
      if (rest.length) return rest[0]!;
      return r.type;
    }
  }
  return '';
}
