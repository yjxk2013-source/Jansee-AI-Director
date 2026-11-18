# V4 SEO/GEO 内容资产迁移与发布策略

## 当前执行记录

- V2 工作区：F:/janseeV2
- V4 工作区：F:/Jansee-v4
- 当前开发分支：feat/v4-align-v2-geo-20261118
- 退款流程不在本次修改范围，仍由人工处理。
- V2 原始 GEO 源文件已保存在 docs/seo-geo/source-v2/server/，不覆盖、不删减。
- 从 V2 源码实际读取到 467 条唯一综合 FAQ；需求知识源包含 7 组、38 条问答。
- All 467 original V2 FAQ questions and answers are fully published in geo-knowledge.json and llms-full.txt. The user confirmed the historical measurements, technical specifications, BGM count and licensing information as accurate; none of the 34 entries is withheld or rewritten by keyword rules.
- 当前需求 GEO 共 38 条：前六组 30 条沿用已核验内容；旧版最后 8 条技术宣传问答不直接照搬，改写为 V4 当前代码路径可验证的 8 条问答。
- 15 条精选 FAQ 仍是 faq.html 唯一可见 FAQ，不将全部历史 FAQ 堆到产品前台。
- GEO 完整文本写入 llms-full.txt；机器可读数据写入 /geo-knowledge.json；需求型内容写入 geo-needs.txt。
- 知识中心生成 7 个可抓取专题页，覆盖 38 条当前需求问答。
- V2 的搜索引擎验证文件在构建时同步到 V4 公共目录。
- Sitemap 当前包含首页、产品页、指南页和知识中心专题页；旧 brand-identity.html 由 Nginx 301 合并到 about-jansee.html。
- 首页、品牌介绍、产品能力、适用场景、FAQ 与全部专题页统一检查 title、description、canonical、robots、Open Graph 和有效 JSON-LD；FAQPage 的结构化问答数量必须与页面可见条目一致。

## 对外发布策略

1. 主产品首页和创作工作台保持简洁，不把长篇 FAQ、SEO 文案塞进产品界面。
2. faq.html 只展示人工精选的 15 条 FAQ；JSON-LD 必须与页面可见问答数量一致。
3. 467 条综合 FAQ 通过 llms-full.txt 与 geo-knowledge.json 提供给机器检索，不全部生成独立 HTML 页面。
4. Publish all 467 original V2 FAQ answers as user-confirmed content; local keyword matches are not a basis for withholding or rewriting them.
5. 38 条需求型 GEO 问答面向线上商家、线下商家和个人创作者；不把目标用户缩窄为实体店老板。
6. 旧版最后 8 条专版技术问答不照搬旧宣传话术，替换为 V4 当前接口和工作流能支持的事实说明。
7. V2 营销文章继续留在 source-v2/marketing/articles，暂不原样发布；旧稿中的固定出片时长、爆款/转化暗示、旧版专属规格和未经证明的对比数据需要逐篇事实复核。

## 页面与抓取机制

- 独立静态 HTML，包含唯一 canonical、description、robots、Open Graph 和 JSON-LD。
- 需求专题页正文与 FAQPage JSON-LD 一一对应。
- faq.html 的 15 条可见问答与 FAQPage JSON-LD 一一对应。
- llms.txt 指向产品页、完整知识库和专题页。
- llms-full.txt 提供完整产品说明、467 条历史 FAQ（含明确的复核状态）和 38 条当前需求问答。
- geo-needs.txt 提供完整 D01-D38 需求问答。
- geo-knowledge.json 提供 467 条历史 FAQ 与 38 条需求问答的结构化版本。
- Sitemap 自动纳入知识中心及专题页；构建时检查目标文件存在。
- 不做隐藏关键词、爬虫专属内容或大批量低价值页面。

## 构建方式

npm run build 会先运行 scripts/seo-geo/build-public-content.mjs 生成公开知识页、机器可读 GEO 数据、llms 文档、精选 FAQ 结构化数据和 Sitemap，再执行 Vite 构建。
