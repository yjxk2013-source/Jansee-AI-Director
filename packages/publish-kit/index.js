// 简兮 · 发布方案共享层 (Publish Kit)
// 定位（2026-10-24 定版）：视频配音 / 图片成片 / 口播 三个版块出片后都要给商家
// 一份「发布方案」（抖音正文、封面大字、置顶评论、发布时机）。字段契约、兜底清洗、
// 广告法红线词表必须三版块一致，故独占成包——符合进 packages 的口径判据。
//
// 消费者（2026-10-24 全版块接入完毕）：
//   apps/web/server/director.mjs        —— 图片成片 + 视频配音（导演 LLM 一次调用顺手出 publish）
//                                          + generatePublishOnly（口播 / 分镜直出 / 分镜 AI 配音
//                                          三条无写词环节链路的独立轻量调用，30s 软上限，永不阻断出片）
//   口播链路（speech-cut 包）           —— startSpeechProduce 经 generatePublish 注入消费
//   分镜直出（storyboard.mjs 编排）     —— 与 ffmpeg 合成并行生成，随成片原子交付
//
// 设计红线：
//   1. 本包只做「文案交付物」的契约与清洗，不碰渲染、不碰 ffmpeg、不碰 TTS。
//   2. caption / cover_title / pinned_comment 是对外公开发布的广告文案，过广告法红线词表；
//      post_time 是内部提示不过词表。
//   3. 图片成片场景 cover_title 恒空——封面大字已由 V4 版面 title 槽位承载，不重复贴。

// ==================== 广告法红线词表 ====================
// 发布文案是公开广告，极限词/医疗断言是平台审核与市监局双雷区。
// prompt 规则已禁（第一道防线），这里是兜底（第二道防线）：LLM 偶发失控时静默清洗。
// 只收高频高危词，不做大词典——误伤面越小越好。
const BANNED_WORDS = [
  '全网最低', '史上最低', '宇宙最低', '最低价', '最便宜', '最好', '最佳', '最强', '最优',
  '第一名', '第一', '冠军', '国家级', '顶级', '极致', '百分百', '100%',
  '无副作用', '治愈', '疗效', '治疗', '根治', '特效', '包治', '立竿见影',
  '神器', '万能', '无敌', '永久', '绝无仅有', '史无前例', '空前绝后',
  '零风险', '完全无风险', '绝对',
];

// 温和替换表：命中后换成通顺安全词，保住句子结构（比直接删除体验好）。
const BANNED_REPLACEMENT = {
  '最便宜': '划算', '最低价': '低价', '全网最低': '这个价', '史上最低': '这个价',
  '最好': '挺合适', '最佳': '合适', '最强': '很能打', '最优': '很划算',
  '第一': '头部', '第一名': '头部', '冠军': '头名', '顶级': '硬核',
  '极致': '拉满', '百分百': '实打实', '100%': '实打实', '绝对': '确实',
  '神器': '利器', '永久': '长期', '无敌': '很扛打',
};

/**
 * 极限词清洗：先长词后短词替换；未映射的命中词直接删除。
 * @returns {{ text: string, hits: string[] }} hits 供日志排查，不写入交付物
 */
export function filterBannedWords(text) {
  let out = String(text || '');
  const hits = [];
  const sorted = [...BANNED_WORDS].sort((a, b) => b.length - a.length);
  for (const w of sorted) {
    if (out.includes(w)) {
      hits.push(w);
      const rep = BANNED_REPLACEMENT[w];
      out = rep ? out.split(w).join(rep) : out.split(w).join('');
    }
  }
  return { text: out, hits };
}

// ==================== 写作规则（单一真相源在 prompt 资产，不在代码） ====================
// 2026-10-24 定版：发布方案创作规则提为独立 prompt 文件
// apps/web/server/prompt/publish-rules.md，由 constitution.md 铁律第 6 条引用，
// 图片成片/视频配音经 director.mjs 注入、口播链路直接读同一份注入。
// 本包不再导出规则文本——代码只做兜底清洗（sanitizePublish/filterBannedWords），
// 规则写在哪、怎么写是 prompt 工程的事，防止代码与 md 双真相源漂移。

// ==================== sanitize 兜底 ====================
// 铁律：LLM 任何异常输出（缺字段/脏词/超长）都必须静默兜底，绝不阻断出片。
function fallbackCaption({ scene, title, subtitle }) {
  const t = title || '这家店';
  const sub = subtitle ? `${subtitle}。` : '';
  if (scene === 'local') return `${t}，同城值得一来。${sub}#同城探店 #本地生活`;
  if (scene === 'personal') return `${t}，分享给懂的你。${sub}`;
  return `${t}，值得一看。${sub}#好物分享`;
}

function fallbackCoverTitle(title, scene) {
  const t = title || '';
  if (scene === 'local') {
    return (t ? `${t}！十年老味道值得一试，同城路过别错过` : '同城宝藏好店推荐，路过千万别错过').slice(0, 32);
  }
  if (scene === 'personal') {
    return (t ? `${t} · 生活里的小确幸记录` : '定格美好瞬间 · 精选生活记录').slice(0, 32);
  }
  return (t ? `${t}！高性价比好物亲测推荐，闭眼冲不踩雷` : '超值好物亲测推荐，闭眼冲不踩雷').slice(0, 32);
}

/**
 * 发布方案兜底清洗。
 * @param {object|null} raw LLM 输出的 publish 字段（缺失传 null，走全兜底）
 * @param {object} ctx
 * @param {string} ctx.scene sell / local / personal（决定兜底语气）
 * @param {string} ctx.title 成片主标题（兜底拼装原料）
 * @param {string} ctx.subtitle 成片副标题（兜底拼装原料）
 * @param {boolean} [ctx.coverTitleRequired=true] 视频标题必填
 * @returns {{ caption: string, cover_title: string, pinned_comment: string, post_time: string, _banned_hits: string[] }}
 */
export function sanitizePublish(raw, { scene = '', title = '', subtitle = '', coverTitleRequired = true } = {}) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const pick = (v) => (typeof v === 'string' ? v.trim() : '');

  let caption = pick(src.caption);
  let coverTitle = pick(src.cover_title);
  let pinned = pick(src.pinned_comment);
  const postTime = pick(src.post_time);

  // 对外广告文案过红线词表；post_time 是内部提示，不清洗
  const c1 = filterBannedWords(caption);
  const c2 = filterBannedWords(coverTitle);
  const c3 = filterBannedWords(pinned);
  // 过滤陈旧年份（如 2024年、2023年等），自动替换为“现在”；清洗未经声明的顺丰特指物流
  const scrubText = (t) => {
    let s = String(t || '').replace(/202[0-4]年?/g, '现在');
    if (scene === 'local') {
      s = s
        .replace(/(顺丰|现货|全国)?包邮/g, '同城到店尝鲜')
        .replace(/现货直发/g, '门店现货供应')
        .replace(/整箱(囤货)?/g, '欢迎进店品尝')
        .replace(/囤货党(直接)?冲/g, '同城老饕直接冲')
        .replace(/顺丰/g, '同城');
    } else {
      s = s.replace(/顺丰包邮/g, '现货包邮');
    }
    return s;
  };

  caption = scrubText(c1.text);
  coverTitle = scrubText(c2.text);
  pinned = scrubText(c3.text);

  if (!caption) caption = fallbackCaption({ scene, title, subtitle });
  if (coverTitleRequired) {
    if (!coverTitle) coverTitle = fallbackCoverTitle(title, scene);
  } else {
    coverTitle = '';
  }

  return {
    caption: caption.slice(0, 300),
    cover_title: coverTitle.slice(0, 36),
    pinned_comment: pinned.slice(0, 60),
    post_time: postTime.slice(0, 40),
    // 命中的红线词（调试排查用，客户端不展示）
    _banned_hits: [...c1.hits, ...c2.hits, ...c3.hits],
  };
}
