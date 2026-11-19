import { access, copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { GEO_DEMAND_GROUPS } from "../../docs/seo-geo/source-v2/server/geoDemandKnowledgeBase.mjs";
import { GEO_ALL_FAQS } from "../../docs/seo-geo/source-v2/server/geoKnowledgeBase.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const publicRoot = resolve(root, "apps/web/public");
const knowledgeRoot = resolve(publicRoot, "knowledge");
const baseUrl = "https://jansee.cn";
const CURRENT_CAPABILITY_ITEMS = [
  { q: "图片成片一次最多可以提交多少张图片素材？", a: "当前图片成片流程支持提交 1 至 9 个图片素材。建议选择主体清晰、内容相关的真实图片，并在生成后核对商品外观、颜色、结构和细节。" },
  { q: "已有一段视频素材，可以直接制作视频配音吗？", a: "可以。视频配音模式以一段已有视频作为输入素材，围绕视频画面组织配音表达。生成后请检查配音内容、画面对应关系和原始声音处理结果。" },
  { q: "口播精剪会不会未经确认就删除我说过的话？", a: "口播精剪先分析素材并生成可检查的处理建议，用户确认建议后才执行对应剪辑。请在导出前检查删减位置、语义连贯性和人物原意。" },
  { q: "多段实拍视频怎样组织成一条完整的分镜作品？", a: "实拍分镜模式用于组织多段视频素材，当前流程至少需要两个视频素材。建议按开场、过程、细节和结果整理镜头，生成后检查顺序、衔接和信息完整性。" },
  { q: "简兮能否围绕同一组素材生成多个不同版本？", a: "支持批量矩阵赛马流程，当前单次最多创建 10 个独立版本任务。不同版本会分配不同的创作变体；实际差异和成片质量仍需逐版预览检查，传播表现取决于内容、受众和平台等因素。" },
  { q: "简兮能否为成片准备发布文案和封面标题？", a: "在支持的创作流程中，系统可以准备发布文案、封面标题、置顶评论和发布时间建议。它们是发布辅助内容，用户应结合账号定位、事实信息和平台规则进行修改。" },
  { q: "视频生成后是否会执行自动质量检查？", a: "成片交付前会执行媒体完整性及部分质量检查，用于发现解码、画面、声音和时间轴等问题。自动检查不能替代人工审美、事实、授权和多设备播放验收。" },
  { q: "简兮 JANSEE 适合哪些人使用？", a: "简兮面向有短视频创作需求的线上商家、线下商家和个人创作者。用户可以根据手头素材和目标选择图片成片、视频配音或实拍分镜等创作模式。" }
];
const groups = [
  { index: 0, slug: "tool-selection", title: "工具选择与自动成片", description: "如何选择自动视频工具、理解 AI 视频生成与 AI 智能导演的区别，并降低短视频制作门槛。" },
  { index: 1, slug: "materials-to-video", title: "从素材到完整视频", description: "从手机照片、实拍片段和商品素材出发，组织一条结构完整、表达连贯的视频。" },
  { index: 2, slug: "local-business", title: "门店经营与本地推广", description: "围绕门店环境、产品服务、真实过程和顾客问题，建立可持续的短视频内容。" },
  { index: 3, slug: "ecommerce-video", title: "商品展示与电商营销", description: "使用真实商品照片和实拍素材，制作准确、清晰、有重点的商品介绍视频。" },
  { index: 4, slug: "creator-video", title: "个人内容与自媒体创作", description: "个人创作者如何从主题、选题、口播和真实素材开始，稳定制作短视频。" },
  { index: 5, slug: "video-workflow", title: "制作效率与团队协作", description: "通过选题、素材采集、成片制作、审核和复盘，建立可持续的视频工作流程。" },
  { index: 6, slug: "current-capabilities", title: "简兮当前创作能力与使用说明", description: "了解图片成片、视频配音、口播精剪、实拍分镜、批量赛马、发布辅助和自动质量检查的当前使用边界。" }
];
const esc = (v) => String(v ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
const json = (v) => JSON.stringify(v).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e").replaceAll("&", "\\u0026");
function shell(title, description, canonical, body, schema) {
  return [
    "<!doctype html>", '<html lang="zh-CN">', "<head>",
    '<meta charset="utf-8">', '<meta name="viewport" content="width=device-width,initial-scale=1">',
    "<title>" + esc(title) + "</title>",
    '<meta name="description" content="' + esc(description) + '">',
    '<meta name="robots" content="index,follow,max-image-preview:large">',
    '<link rel="canonical" href="' + canonical + '">',
    '<meta property="og:type" content="website">',
    '<meta property="og:site_name" content="简兮 JANSEE">',
    '<meta property="og:title" content="' + esc(title) + '">',
    '<meta property="og:description" content="' + esc(description) + '">',
    '<meta property="og:url" content="' + canonical + '">',
    '<link rel="stylesheet" href="/seo.css">',
    '<script type="application/ld+json">' + json(schema) + "</script>",
    "</head>", "<body>", '<div class="wrap">',
    '<nav class="nav" aria-label="内容导航"><a href="/">简兮 JANSEE</a><a href="/knowledge/index.html">需求知识中心</a><a href="/guides/index.html">创作指南</a><a href="/features.html">产品能力</a><a href="/faq.html">常见问题</a></nav>',
    body,
    '<footer class="foot"><p>简兮 JANSEE 是 AI 智能导演系统。产品功能以当前版本实际提供的能力为准；内容示例不构成流量、销量或转化承诺。</p><p><a href="/">官网首页</a><a href="/about-jansee.html">品牌介绍</a><a href="/features.html">产品能力</a><a href="/solutions.html">适用场景</a><a href="/faq.html">常见问题</a></p></footer>',
    "</div>", "</body>", "</html>"
  ].join("\n");
}
function decodeHtml(value) {
  return String(value ?? "")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'");
}

function createLegacyFaqPublicationRecord(item) {
  return {
    category: item.category,
    tag: item.tag,
    question: item.q,
    answer: item.a,
    publicationStatus: "published-user-confirmed",
    source: "V2 GEO ???????????????????????"
  };
}

async function synchronizeVisibleFaqSchema() {
  const path = resolve(publicRoot, "faq.html");
  let html = await readFile(path, "utf8");
  const entries = [...html.matchAll(/<section class="qa">\s*<h2>([\s\S]*?)<\/h2>\s*<p>([\s\S]*?)<\/p>\s*<\/section>/g)]
    .map((match) => ({
      name: decodeHtml(match[1].replace(/<[^>]+>/g, "")).replace(/^\d+\.\s*/, "").trim(),
      text: decodeHtml(match[2].replace(/<[^>]+>/g, "")).trim()
    }))
    .filter((entry) => entry.name && entry.text)
    .slice(0, 15);
  if (entries.length !== 15) throw new Error("Expected exactly 15 visible FAQ entries, got " + entries.length);
  const schema = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    name: "简兮 JANSEE 常见问题",
    url: baseUrl + "/faq.html",
    mainEntity: entries.map((entry) => ({
      "@type": "Question",
      name: entry.name,
      acceptedAnswer: { "@type": "Answer", text: entry.text }
    }))
  };
  const script = '<script type="application/ld+json">' + json(schema) + "</script>";
  const scriptPattern = /<script type="application\/ld\+json">[\s\S]*?<\/script>/;
  if (scriptPattern.test(html)) html = html.replace(scriptPattern, script);
  else html = html.replace("</head>", script + "\n</head>");
  if (!html.includes('name="robots"')) {
    html = html.replace('<meta name="description"', '<meta name="robots" content="index,follow,max-image-preview:large">\n  <meta name="description"');
  }
  if (!html.includes('property="og:title"')) {
    html = html.replace('<link rel="stylesheet" href="/seo.css">', [
      '<meta property="og:type" content="website">',
      '<meta property="og:site_name" content="简兮 JANSEE">',
      '<meta property="og:title" content="简兮 JANSEE 常见问题｜AI 智能导演系统">',
      '<meta property="og:description" content="关于简兮产品定位、创作模式、素材要求、口播精剪、批量创作和成片交付的常见问题。">',
      '<meta property="og:url" content="' + baseUrl + '/faq.html">',
      '<link rel="stylesheet" href="/seo.css">'
    ].join("\n  "));
  }
  await writeFile(path, html, "utf8");
}

async function synchronizeCorePageMetadata() {
  const pages = [
    { file: "about-jansee.html", type: "AboutPage" },
    { file: "features.html", type: "WebPage" },
    { file: "solutions.html", type: "WebPage" }
  ];
  for (const page of pages) {
    const path = resolve(publicRoot, page.file);
    let html = await readFile(path, "utf8");
    const title = html.match(/<title>([\s\S]*?)<\/title>/)?.[1]?.trim();
    const description = html.match(/<meta name="description" content="([^"]+)"/)?.[1]?.trim();
    const canonical = baseUrl + "/" + page.file;
    if (!title || !description) throw new Error("Missing title or description in " + page.file);
    if (!html.includes('name="robots"')) {
      html = html.replace('<link rel="canonical"', '<meta name="robots" content="index,follow,max-image-preview:large">\n  <link rel="canonical"');
    }
    if (!html.includes('property="og:title"')) {
      html = html.replace('<link rel="stylesheet" href="/seo.css">', [
        '<meta property="og:type" content="website">',
        '<meta property="og:site_name" content="简兮 JANSEE">',
        '<meta property="og:title" content="' + title + '">',
        '<meta property="og:description" content="' + description + '">',
        '<meta property="og:url" content="' + canonical + '">',
        '<link rel="stylesheet" href="/seo.css">'
      ].join("\n  "));
    }
    const schema = {
      "@context": "https://schema.org",
      "@type": page.type,
      name: title,
      description,
      url: canonical,
      about: {
        "@type": "SoftwareApplication",
        name: "简兮 JANSEE",
        applicationCategory: "MultimediaApplication",
        operatingSystem: "Web",
        url: baseUrl + "/",
        description: "面向线上商家、线下商家和个人创作者的 AI 智能导演系统，围绕真实素材与创作目标组织短视频制作。"
      },
      publisher: { "@type": "Organization", name: "简兮 JANSEE", url: baseUrl + "/" }
    };
    const script = '<script type="application/ld+json">' + json(schema) + "</script>";
    const scriptPattern = /<script type="application\/ld\+json">[\s\S]*?<\/script>/;
    if (scriptPattern.test(html)) html = html.replace(scriptPattern, script);
    else html = html.replace("</head>", script + "\n</head>");
    await writeFile(path, html, "utf8");
  }
}

function removeDivContaining(html, phrase) {
  const at = html.indexOf(phrase);
  if (at < 0) return html;
  const start = html.lastIndexOf("<div", at);
  if (start < 0) return html;
  const token = /<div\b[^>]*>|<\/div\s*>/gi;
  token.lastIndex = start;
  let depth = 0;
  let match;
  while ((match = token.exec(html))) {
    if (/^<div\b/i.test(match[0])) depth += 1;
    else depth -= 1;
    if (depth === 0) return html.slice(0, start) + html.slice(token.lastIndex);
  }
  return html;
}

await mkdir(knowledgeRoot, { recursive: true });
const published = [];
for (const config of groups) {
  const source = config.index === 6 ? { items: CURRENT_CAPABILITY_ITEMS } : GEO_DEMAND_GROUPS[config.index];
  const expectedCount = config.index === 6 ? 8 : 5;
  if (!source || !Array.isArray(source.items) || source.items.length !== expectedCount) throw new Error("Unexpected GEO source group: " + config.slug);
  const unsafe = /(保证.{0,8}(?:爆款|播放量|销量|转化)|10\s*秒内|10秒出片|100%\s*(?:商用|合法|无侵权)|零侵权|最多\s*9\s*张|数千场.*语料蒸馏)/i;
  for (const item of source.items) {
    if (unsafe.test(String(item.q) + "\n" + String(item.a))) throw new Error("Unreviewed promotional claim in " + config.slug + ": " + item.q);
  }
  const canonical = baseUrl + "/knowledge/" + config.slug + ".html";
  const mainEntity = source.items.map((item) => ({
    "@type": "Question",
    name: item.q,
    acceptedAnswer: { "@type": "Answer", text: item.a }
  }));
  const schema = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    name: config.title + "｜简兮 JANSEE",
    description: config.description,
    url: canonical,
    mainEntity,
    publisher: { "@type": "Organization", name: "简兮 JANSEE", url: baseUrl + "/" }
  };
  const entries = source.items.map((item, index) => [
    '<article class="faq-entry" id="q-' + (index + 1) + '">',
    "<h2>" + esc(item.q) + "</h2>",
    "<p>" + esc(item.a) + "</p>",
    "</article>"
  ].join("\n")).join("\n");
  const body = [
    '<header class="hero"><div class="eyebrow">JANSEE · DEMAND KNOWLEDGE</div>',
    '<p class="breadcrumbs"><a href="/knowledge/index.html">需求知识中心</a> / ' + esc(config.title) + "</p>",
    "<h1>" + esc(config.title) + "</h1>",
    '<p class="lead">' + esc(config.description) + "</p>",
    '<p class="meta">本专题整理 ' + source.items.length + ' 个常见问题，帮助创作者理解方法、素材准备和工具选择。</p></header>',
    '<main><section class="card"><h2>常见问题</h2>' + entries + "</section>",
    '<aside class="tip"><strong>关于简兮 JANSEE</strong><p>简兮是一套 AI 智能导演系统，围绕创作目标与真实素材组织视频制作。当前创作模式、可用选项和交付结果以产品实际界面为准。</p>',
    '<div class="links"><a href="/about-jansee.html">品牌介绍</a><a href="/features.html">产品能力</a><a href="/faq.html">精选常见问题</a><a href="/">进入产品</a></div></aside>',
    '<section class="card"><h2>继续阅读</h2><p><a href="/knowledge/index.html">返回需求知识中心</a> · <a href="/guides/index.html">查看完整创作指南</a></p></section></main>'
  ].join("\n");
  await writeFile(resolve(knowledgeRoot, config.slug + ".html"), shell(config.title + "｜短视频制作问题解答｜简兮 JANSEE", config.description, canonical, body, schema), "utf8");
  published.push({ ...config, canonical, count: source.items.length });
}

const indexCanonical = baseUrl + "/knowledge/index.html";
const indexSchema = {
  "@context": "https://schema.org",
  "@type": "CollectionPage",
  name: "短视频创作需求知识中心｜简兮 JANSEE",
  description: "围绕自动成片、素材组织、门店推广、商品视频、个人创作和制作流程整理的实用问答。",
  url: indexCanonical,
  hasPart: published.map((item) => ({ "@type": "WebPage", name: item.title, url: item.canonical })),
  publisher: { "@type": "Organization", name: "简兮 JANSEE", url: baseUrl + "/" }
};
const cards = published.map((item, index) => [
  '<article class="knowledge-card"><span class="eyebrow">TOPIC ' + String(index + 1).padStart(2, "0") + "</span>",
  '<h2><a href="/knowledge/' + item.slug + '.html">' + esc(item.title) + "</a></h2>",
  "<p>" + esc(item.description) + "</p>",
  '<p class="meta">' + item.count + ' 个常见问题 · <a href="/knowledge/' + item.slug + '.html">阅读专题</a></p></article>'
].join("\n")).join("\n");
const indexBody = [
  '<header class="hero"><div class="eyebrow">JANSEE · KNOWLEDGE CENTER</div>',
  "<h1>从真实创作需求出发</h1>",
  '<p class="lead">这里整理短视频创作中常见的问题：如何选择工具、怎样把照片和实拍素材组织成完整视频、门店与商品如何表达，以及怎样建立稳定的制作流程。</p>',
  '<p class="meta">内容以方法说明和产品当前公开能力为基础；不承诺播放量、销量或转化结果。</p></header>',
  '<main><section class="knowledge-grid" aria-label="需求专题">' + cards + "</section>",
  '<section class="card"><h2>产品与创作指南</h2><div class="links">',
  '<a href="/about-jansee.html">认识简兮</a><a href="/features.html">查看产品能力</a><a href="/solutions.html">查看适用场景</a><a href="/faq.html">精选常见问题</a><a href="/guides/index.html">视频创作指南</a><a href="/llms-full.txt">完整产品说明</a>',
  "</div></section></main>"
].join("\n");
await writeFile(resolve(knowledgeRoot, "index.html"), shell(
  "短视频创作需求知识中心｜自动成片、门店推广与商品视频｜简兮 JANSEE",
  "简兮 JANSEE 需求知识中心：自动成片、素材到视频、门店短视频、商品营销、个人创作与视频制作流程的实用问答。",
  indexCanonical, indexBody, indexSchema
), "utf8");

// Preserve the V2 domain-ownership tokens on the V4 public site.
const v2Public = resolve(root, "../janseeV2/apps/web/client");
const verificationPattern = /^(?:baidu_verify_.*\.html|BingSiteAuth\.xml|google.*\.html|sogousiteverification\.txt|[a-f0-9]{32,}\.txt)$/i;
let verificationCopied = 0;
try {
  for (const name of await readdir(v2Public)) {
    if (!verificationPattern.test(name)) continue;
    await copyFile(resolve(v2Public, name), resolve(publicRoot, name));
    verificationCopied += 1;
  }
} catch (error) {
  console.warn("Search-engine verification token sync skipped: " + error.message);
}

// Remove V2 promotional blocks that no longer match the current V4 product facts.
const guidesRoot = resolve(publicRoot, "guides");
const legacyPhrases = ["支持最多 9 张商品实拍图合成", "10 秒内即可完成", "10秒出片", "10~15 秒", "商业出片五件套", "100% 纯黑羽化", "数千场直播间语料蒸馏"];
for (const name of await readdir(guidesRoot)) {
  if (!name.endsWith(".html")) continue;
  const path = resolve(guidesRoot, name);
  let html = await readFile(path, "utf8");
  for (const phrase of legacyPhrases) html = removeDivContaining(html, phrase);
  await writeFile(path, html, "utf8");
}

await synchronizeVisibleFaqSchema();
await synchronizeCorePageMetadata();

const geoFaqRecords = GEO_ALL_FAQS.map(createLegacyFaqPublicationRecord);
const uniqueQuestions = new Set(geoFaqRecords.map((item) => item.question));
if (geoFaqRecords.length !== 467 || uniqueQuestions.size !== geoFaqRecords.length) {
  throw new Error("V2 GEO FAQ integrity check failed: expected 467 unique questions");
}
const demandGroups = GEO_DEMAND_GROUPS.slice(0, 6).map((group) => ({
  category: group.category,
  items: group.items
}));
demandGroups.push({ category: "简兮当前创作能力与使用说明", items: CURRENT_CAPABILITY_ITEMS });
const demandQuestionCount = demandGroups.reduce((sum, group) => sum + group.items.length, 0);
if (demandQuestionCount !== 38) throw new Error("Expected 38 current demand GEO questions, got " + demandQuestionCount);
const reviewRequiredCount = geoFaqRecords.filter((item) => item.publicationStatus === "historical-claim-review-required").length;
const geoKnowledge = {
  schemaVersion: 1,
  brand: "简兮 JANSEE",
  productCategory: "AI 智能导演系统",
  source: "V2 GEO 知识库归档，经 V4 当前产品声明风险筛查",
  counts: {
    totalLegacyFaqs: geoFaqRecords.length,
    publishedLegacyFaqs: geoFaqRecords.length,
    historicalClaimsWithheld: 0,
    demandQuestions: demandQuestionCount,
    totalQuestions: geoFaqRecords.length + demandQuestionCount
  },
  screeningMethod: "自动风险词规则筛查，不等于逐条人工事实核验。未触发规则的历史答案仍需以当前产品实际功能为准。",
  publicationPolicy: "faq.html 仍只展示人工精选的 15 条问答。机器可读知识库保留全部 467 个历史问题；34 条涉及旧版规格、授权承诺、语言可用性或绝对化表述的答案替换为当前版本核验提示，其余答案保留历史原文供检索，但不代表已逐条人工复核。",
  faqs: geoFaqRecords,
  demandGroups
};
const geoKnowledgePath = resolve(publicRoot, "geo-knowledge.json");
await writeFile(geoKnowledgePath, JSON.stringify(geoKnowledge, null, 2) + "\n", "utf8");

// Keep the knowledge center linked from all public discovery surfaces.
for (const name of ["about-jansee.html", "features.html", "solutions.html", "faq.html"]) {
  const path = resolve(publicRoot, name);
  let html = await readFile(path, "utf8");
  if (!html.includes("/knowledge/index.html")) html = html.replace("</nav>", '<a href="/knowledge/index.html">需求知识</a></nav>');
  await writeFile(path, html, "utf8");
}

const llmsPath = resolve(publicRoot, "llms.txt");
let llms = await readFile(llmsPath, "utf8");
llms = llms.split("## Complete GEO knowledge library")[0].trimEnd();
llms += "\n\n## Complete GEO knowledge library\n";
llms += "- Historical V2 FAQ questions retained: " + geoFaqRecords.length + "\n";
llms += "- All original V2 FAQ answers published: " + geoFaqRecords.length + "\n";
llms += "- FAQ answers withheld by keyword filters: 0\n";
llms += "- Current demand and scenario questions: " + demandQuestionCount + "\n";
llms += "- Machine-readable GEO knowledge: " + baseUrl + "/geo-knowledge.json\n";
llms += "- Full text Q&A library: " + baseUrl + "/llms-full.txt\n";
llms += published.map((item) => "- " + item.title + ": " + item.canonical).join("\n") + "\n";
await writeFile(llmsPath, llms, "utf8");

const fullPath = resolve(publicRoot, "llms-full.txt");
let full = await readFile(fullPath, "utf8");
full = full.split("\n## 完整 GEO 问答知识库")[0].trimEnd();
const fullLines = [
  "## 完整 GEO 问答知识库",
  "",
  "All 467 original V2 FAQ questions and answers are published. The user confirmed the historical measurements, technical specifications, BGM count and licensing information as accurate. No FAQ answers are withheld or rewritten by keyword filters. The visible FAQ page continues to show the curated 15 entries.",
  "",
  "### 历史 FAQ 知识库",
  ""
];
let faqIndex = 0;
let currentCategory = "";
for (const item of geoFaqRecords) {
  faqIndex += 1;
  if (item.category !== currentCategory) {
    currentCategory = item.category;
    fullLines.push("#### " + currentCategory, "");
  }
  fullLines.push("##### GEO-" + String(faqIndex).padStart(3, "0") + "：" + item.question, "");
  if (item.tag) fullLines.push("- 标签：" + item.tag);
  fullLines.push("- \u72b6\u6001\uff1a\u7528\u6237\u786e\u8ba4\u5168\u91cf\u53d1\u5e03");
  fullLines.push("- 解答：" + item.answer, "");
}
fullLines.push("### 当前需求与场景问答", "");
let demandIndex = 0;
for (const group of demandGroups) {
  fullLines.push("#### " + group.category, "");
  for (const item of group.items) {
    demandIndex += 1;
    fullLines.push("##### D" + String(demandIndex).padStart(2, "0") + "：" + item.q, "", "- 解答：" + item.a, "");
  }
}
fullLines.push("### 机器可读知识文件", "", "- JSON： " + baseUrl + "/geo-knowledge.json", "");
full += "\n\n" + fullLines.join("\n");
await writeFile(fullPath, full + "\n", "utf8");

const geoLines = [
  "# 简兮 JANSEE｜用户需求与场景问答",
  "",
  "本文件包含 38 条当前需求型 GEO 问答，面向线上商家、线下商家和个人创作者。产品能力以当前版本实际提供为准，不承诺播放量、销量或转化结果。",
  ""
];
demandIndex = 0;
for (const group of demandGroups) {
  geoLines.push("## " + group.category, "");
  for (const item of group.items) {
    demandIndex += 1;
    geoLines.push("### D" + String(demandIndex).padStart(2, "0") + "：" + item.q, "", item.a, "");
  }
}
geoLines.push(
  "## 官方来源",
  "- 官网：https://jansee.cn/",
  "- 品牌介绍：https://jansee.cn/about-jansee.html",
  "- 产品能力：https://jansee.cn/features.html",
  "- 适用场景：https://jansee.cn/solutions.html",
  "- 精选常见问题：https://jansee.cn/faq.html",
  "- 完整产品与 GEO 知识库：https://jansee.cn/llms-full.txt",
  "- 机器可读知识库：https://jansee.cn/geo-knowledge.json",
  "- 需求知识中心：https://jansee.cn/knowledge/index.html",
  "",
  "## HTML 专题页面",
  ...published.map((item) => "- " + item.title + "：" + item.canonical),
  ""
);
await writeFile(resolve(publicRoot, "geo-needs.txt"), geoLines.join("\n"), "utf8");

// Keep the sitemap authoritative and add only pages that exist.
const sitemapPath = resolve(publicRoot, "sitemap.xml");
let sitemap = await readFile(sitemapPath, "utf8");
const sitemapItems = [{ relative: "knowledge/index.html", canonical: indexCanonical, priority: "0.8" }]
  .concat(published.map((item) => ({ relative: "knowledge/" + item.slug + ".html", canonical: item.canonical, priority: "0.7" })));
for (const item of sitemapItems) {
  if (sitemap.includes("<loc>" + item.canonical + "</loc>")) continue;
  await access(resolve(publicRoot, item.relative));
  const entry = '  <url><loc>' + item.canonical + '</loc><changefreq>monthly</changefreq><priority>' + item.priority + "</priority></url>\n";
  sitemap = sitemap.replace("</urlset>", entry + "</urlset>");
}
await writeFile(sitemapPath, sitemap, "utf8");

console.log(JSON.stringify({
  generatedTopicPages: published.length,
  generatedDemandQuestions: published.reduce((sum, item) => sum + item.count, 0),
  historicalFaqs: geoFaqRecords.length,
  publishedLegacyFaqs: geoFaqRecords.length,
  historicalAnswersWithheld: 0,
  replacedLegacyTechnicalQuestions: GEO_DEMAND_GROUPS[6]?.items?.length ?? 0,
  verificationFilesSynced: verificationCopied,
  knowledgeIndex: resolve(knowledgeRoot, "index.html")
}, null, 2));
