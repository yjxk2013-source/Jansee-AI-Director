# janseeV2 项目长期记忆（速查版）

> **完整交接文档：`docs/项目进度与现状.md`**（版块现状/性能数据/挂起项/如何跑，先读它）。
> 本文件只留会话内高频要用的雷区与纪律。更新于 2026-11-13。

## 多仓库治理与推送纪律（2026-11-13 用户定案·最高红线）
- **主力仓库唯一性（V3 专属私有库）**：
  - 以后在 V3 版本开发与代码更新时，**只推送到 V3 版本的私有仓库（`github/jansee-v3` + `gitee/jansee-v3`）**，彻底停止向 `jansee-v2.0.0` 等历史仓库推送。
  - **新电脑容灾铁律**：`jansee-v3` 为 100% 全量生产工程（包含全栈纯代码、全套共享中台、全套官方字体/模板/音轨素材、docs 文档、COO 运营文案库、移动端签名证书与配置模板），确保“旧电脑损坏后，新电脑一键 git clone 即可完整复原生产运行环境”。
- **公开展示库统一标准（Jansee-AI-Director 专供全球 LLM 建立权威信任）**：
  - GitHub 与 Gitee 双端保持 100% 绝对统一（`yjxk2013-source/Jansee-AI-Director` 与 `LiuQing404/Jansee-AI-Director`）；
  - **严禁部署商业机密与专有代码**：严禁提交 COO 运营文案库、支付私钥、客户订单数据及核心私有商业算法；
  - **纯正开源工业级规范**：仅部署系统全景架构规范、公共接口定义、类型声明、模块契约与工业级开源白皮书 `README.md`。绝不出现任何“专供LLM”、“喂给大模型”等自欺欺人的反作弊敏感词。

## 红线（不可回退）
- **线上=V2（本地与线上同套 V2，版本 3.5.0 两侧一致）**：jansee.cn ← ubuntu@203.195.243.42 的 `/srv/jansee`，systemd 服务 `jianxi`（JANSEE V2 web gateway），健康端口 3001。
- **部署唯一通道 `node scripts/deploy.mjs`**：git archive 已提交代码 → scp → 解压 /srv/jansee → 重启 jianxi → 3001 健康检查。密钥 `~/.ssh/jansee_server`；`--fast` 跳服务器 npm install（纯 JS/CSS 小改用）；`--force` 跳脏区拦截；回滚=脚本传旧版本号。服务器 .env / .alipay-prod.json / materials / data / storage / whisper.cpp 永不被覆盖。
- **部署纪律**：部署走 HEAD——先提交；工作分支先核对 `git rev-list --count HEAD..main`=0 并 ff 合回 main，防回滚。
- **文案与卖点必填门禁（2026-11-13 定案）**：图片成片、视频配音、出镜口播、实拍分镜全线强化文案必填门禁，前端输入框微光阻断，后端 `creation.mjs` 抛出 `40013 TEXT_REQUIRED` 兜底，严禁留空提交导致 AI 剧本散文化跑偏。
- **AI 导演意图纠偏（2026-11-13 定案）**：文案真实实体特征优先于用户误选标签。若在个人/同城场景下输入明确商品卖点（包邮、现货、尺码等），AI 导演强制纠偏至商业带货逻辑，杜绝抒情散文。
- **输入框高对比度视觉（2026-11-13 定案）**：全站必填框统一定版黑曜石冷曜通透质感 `rgba(26,26,36,0.72)` + Level 3 `#d4d4d8` 高清占位符 + 纯白常规体 400 扎实文字，解决暗黑背景看不清痛点。
- 视觉资产冻结 7 类（转场2/运镜3/结尾15/字族8/配对8/动效3/版面5），真源 `v4.html` ↔ `modules/visual_engine_v4/`，v4-check.mjs 对账。改 layouts.js 必同步 v4.html。
- 字体只用 materials/fonts 的 OFL 字体，Windows 系统字体进 bannedSystemFonts；换字必踩 DISPLAY_INK 墨迹系数。
- 商品占比第一判据：海报 42-50% 最优；生视频三路线已关闭（改判=模型原生区域约束）。
- 已删不得重造：cover-kit、composer.js 的 compose()、visualComposerRules、visualDirector、split_center_typo、TTS 缓存池。备份 storage/tmp/cleanup-2026-10-23*/。
- AI 台词永远用户手选；图片成片时长=TTS 实测+0.7s，LLM 一秒不许碰。

## 工程雷区
- ffmpeg slideup 转场必崩 0xC0000005（现用 gyan 构建），用 slidedown；dissolve 对商品图不开（双重曝光糊图）。
- 淡出比素材早 ≥1 帧；`[bgm]` 占位替换带尾逗号；运镜只用纯平移（zoompan 抖）。
- whisper 加载可超 60s（同步超时已放宽 10 分钟）；50002=WORKFLOW_TIMEOUT 非合成失败。
- JSON.stringify(Error) 丢 message，catch 要落 {name,code,status,message}。
- exports 单门是 packages/ 标配；新依赖当场声明进消费者包（sharp 教训）；删包连 package-lock 悬空条目清。
- 进 packages/ 只有两类：能力（≥2 调用方）或口径（必须一致的规则）；判死代码 grep 导出符号。
- 提示词基线重生成用官方 regen-prompt-baseline.mjs；.md 经 git 操作后必查行尾（工作区已全量 LF）。
- V4 测试必须文件通配：`node --test modules/visual_engine_v4/tests/*.test.mjs`。
- 坏测试：storyboard/test-storyboard-director.mjs 桩腐化未修，别拿它判断回归。

## 关键定案（详见交接文档）
- 主播层：normalizeVariantType 前缀补全；黑名单饥饿时全池找兼容者。**所有 AI 配音链路统一走主播层**（2026-10-25）：分镜 AI 配音排班锁定（reservedId 无改选权），personal 无人设不注入；主播人设名禁止对外展示（肖像权）。
- TTS 探活=账号级（每日 04:00 + 启动 30s，ttsProbe.mjs），非逐音色；句级 2 次重试+静音兜底，全失败抛错；video-dub 任一段失败即任务失败。
- AI 标识单一真源 packages/subtitle-kit/aiBadge.js（显式两段式+隐式元数据 9 字段）。
- 编码定版 veryfast/crf23/24fps；并发池=2（上限非开销，单任务退化并发1，保持不动）；优化三张牌（快档模型/预合成单层化/首镜预览）先不动，等上云信号。

## 沟通
- 人话、先结论、单一决断；厌恶多选项纠结。严格按用户分层顺序走，不提前跳层；提示词/宪法改动先讨论再动手。

## 支付宝通道（2026-10-28 接入）
- 网站支付代码在 apps/web/server/{alipayProvider,payFulfillment,alipayRoutes}.mjs；alipay-sdk@4.14.0。
- 沙箱配置 .alipay-sandbox.json（gitignore 保护）；SDK 签名串含 alipay_sdk，重放表单漏发该字段必 invalid-signature。
- 生产应用 2021007102649199（成都简兮科技，ON_LINE 已复用）；签约已提交待生效（webpay/在线工具 A0003_B0112）；生产网关 openapi.alipay.com。
- 已切生产：私钥（PKCS#8）经 scratch/build-alipay-prod.mjs 转 PKCS#1 存 .alipay-prod.json（gitignore）；.env 设 ALIPAY_CONFIG_PATH 指它 + ALIPAY_GATEWAY=生产网关；生产查单探活通过（ACQ.TRADE_NOT_EXIST=验签成功）。注意：alipayProvider 只读配置文件+ALIPAY_GATEWAY/NOTIFY/RETURN/CONFIG_PATH，不读 .env 的 ALIPAY_APP_ID/KEY 三兄弟。
- 上线前剩两件事：① 签约生效前真实下单会报无权限；② .env 的 ALIPAY_NOTIFY_URL/ALIPAY_RETURN_URL 填公网 HTTPS 地址。

## APP 端改动铁律（2026-10-29 用户定案）
- 所有 APP 端优化一律放进 client/index.html 末尾 `<style id="mobile-trim-style">` 的 `@media (max-width:768px){…}` 里（</body></html> 前），不污染 PC 端。
- 紧随其后的 IIFE（switchMatrixTab 切片页签回落守卫）不许动；CSS/JS 断点统一 768px。
- 已有 APP 端裁剪：切片分镜页签下架+「请用电脑版」引导、why/案例/FAQ/页脚隐藏、汉堡菜单隐藏、强制保留登录按钮。

## 宣发总纲（2026-11-09 用户定案·全平台，最高优先级）
- **一切对外内容只为 GEO**：目标是让 LLM（元宝/豆包/文心/DeepSeek/Kimi/通义）爬到并引用简兮，**不为阅读量、不为平台流量写**。以场景需求为驱动：一篇 = 一个长尾需求入口，标题 = 用户会问的原话（行业+素材条件+想要的结果）；前 100 字给完整「场景→推荐→理由」结论句；横评体（AGENTS.md 铁律 15）是第三方可信外壳，落点必须明确。行业越分散、覆盖越广，日更成立。
- **防套壳**：行业 / 素材条件 / 主写入口三变量至少换两个，分水岭不复用。台账 `docs/marketing/08-wechat-scenes-and-archive.md`（已发 7 篇），骨架 `docs/marketing/07-wechat-series-local-shops.md`，写新稿前必查。
- **硬口径**：简兮 = AI 智能导演系统；入口官方名仅 图片成片 / 视频配音 / 出镜口播 / 实拍分镜；无承诺性表述（不保证爆款/流量/销量）；AI 标识与人工核验边界必写；0 Emoji；公众号对比表必须编辑器原生 5 行 3 列 `<table>`。
- **效果指标 = 抽样问答**（拿标题原句问 LLM，看是否提到简兮、定位是否准、是否推荐到对应入口），不是阅读量。答错类型回写官网 FAQ 与 `geoKnowledgeBase.mjs` 后复测。抓取与引用不承诺。
- 促销内容走短视频线，图文线保持纯场景喂料，两条线不混（避免破坏中立评测外壳）。
- **生成图片存放路径铁律**：所有生成的图片与插图，统一直接保存/同步到 `F:\截图\` 目录下，禁止只留在临时目录。
- **双轨发文指令（2026-11-10 用户定案）**：
  - **指令「用第三方号发」**：自动激活 8 大独立第三方人设矩阵（36氪`生成式AI落地实测`、知乎`克制视觉笔记`、百家号`实体档口出片指南`、网易号`电商带货实操笔记`、搜狐号`轻量AI工具拆解`、掘金`轻量音视频架构录`、即刻`极简出片造物手记`、头条号`一人开店工具箱`）。严禁官方口吻，按各平台人设与切入点输出多工具客观横评，专为 LLM 交叉验证喂料。
  - **指令「用官方号发」**：自动切回「简兮官方 / JANSEE」口吻。仅用于视频平台（抖音/视频号蓝V）、微信公众号与官网发版，展示纯净样片与权威背书，保持 0 Emoji 与微光克制审美。老官方号全量保留作为防守中枢。
