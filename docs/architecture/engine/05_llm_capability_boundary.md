# 05 · AI 导演能力边界表（阶段四审计定版）

> **依据**：阶段二/三全字段契约审计 + 阶段四能力边界审计与三项补证（2026-10-13，用户批准）。
> **口径四分法**：①程序读取＝存在代码读取位；②影响产物＝改变最终成片；③LLM 可控＝契约声明且 LLM 输出；④意图/预留＝仅创作意图表达或未来预留。
> **能力分类**：已接通 / 部分接通 / 默认行为 / 冻结预留 / 文档漂移 / 待确认。
> **红线**：「字段被读取」≠「LLM 可以控制」≠「最终视频产生可见影响」；本文档为设计说明，运行时唯一真相源是 `apps/web/server/prompt/` 与代码本身。
> **阶段收尾更新（2026-10-13）**：personal.variant_type 两处修复已实施并通过单元级 9 断言 + 行为级 6 断言验证；ENGINE_SPECIFICATION.md sfx.intensity 与 sfx.js L60 注释漂移已修正；timeline.js 两处漂移维持挂账随 image_creator_v2。各域状态以当前表述为准。

## 域 1：LLM 输入与 JSON 输出契约

| 能力 | 分类 | LLM 可控 | 程序消费 | 影响产物 | 关键证据 |
|---|---|---|---|---|---|
| 26 个契约字段（顶层 12 + visual_design 8 + shots 6） | 已接通 | 是 | 是 | 是 | apps/web/server/prompt/constitution.md L68-109 |
| sales_intensity | 已接通（④创作意图） | 是（输出） | 仅人设导演 prompt 逻辑 | 否（渲染管线零读取位） | director.mjs L271；00_llm_director.md §8.1 |
| voice_id | 冻结预留 | 否 | timeline.js L112 读取位恒 undefined（五路写入全零） | 否 | 03_audio_constitution.md §11.2 |
| script.sfx（intensity/三类细分开关） | 冻结预留 | 否 | timeline.js L347 消费位恒收缺省（全开 + 0.8） | 否（恒默认） | 03_audio_constitution.md §11.3 |
| 前端创作入参（voice/scene/title/sellingPoints/imageCount + 图片文件） | 已接通 | —（用户输入） | 是 | 是 | index.mjs L294-329 |

## 域 2：三入口导演路由（sell / local / personal）

| 能力 | 分类 | 结论 | 关键证据 |
|---|---|---|---|
| scene 分流 | 已接通 | personal 跳过 decideVariantLocal 强信号判定，decidedVariant 恒空串 | index.mjs L294-304 |
| decideVariantLocal 强信号锁定（sell/local 各自规则表，LLM 不得改判） | 已接通 | 命中锁定；未命中交 LLM 按类型表兜底；占用时本地排重/轮询 | prompt/index.js L105-132 |
| personal 的 variant_type | 已接通（修复后定版） | **修复验证结论（2026-10-13 阶段收尾）**：两处修复已实施并验证——①mocker 源头归一（director.mjs L268 personal 输出空串，「宪法纯生活叙事」仅保留为 decideVariant L219-223 内部判定语义不落盘）；②主流程最终防线（index.mjs L323-324，位于 try/catch 之后 icCreateTask 之前，LLM 违规输出统一归零）；行为级桩测试证实 sell/local 路径不受防线影响；该字段仅进入 creativeLedger 落盘，不影响渲染产物 | index.mjs L300-302、L323-324；director.mjs L166、L243、L268；creativeLedger.mjs L33 |
| 三入口能力越界 | 通过 | personal 人设注入为空（personal 无 director-personal.md）、跳过变体判定、mocker 按 scene 分流；未发现越界或意外共用 | director.mjs L60-94、L214-232、L239-281 |

## 域 3：人设导演 vs 宪法导演职责边界

| 能力 | 分类 | 结论 | 关键证据 |
|---|---|---|---|
| constitution.md 全局宪法（契约 + 铁律） | 已接通 | 三入口共用，唯一运行时真相源 | constitution.md 全文 |
| director-sell.md / director-local.md 场景人设 | 已接通 | 仅对应场景注入；personal 无注入 | director.mjs L60-94（buildDirectorPrompt 组装序） |
| 创作防重账本注入（最近 3 条） | 已接通 | 只提示不强制；账本条目含 variant_type/opening/ending/bgm_emotion/visual_design 五维 | creativeLedger.mjs L28-55；director.mjs L60-94 |

## 域 4：分镜结构 / 素材引用 / 运镜 / 转场

| 能力 | 分类 | LLM 可控 | 影响产物 | 关键证据 |
|---|---|---|---|---|
| N图=N镜、asset 装配、去重补位 | 已接通 | 是（编号表达） | 是 | director.mjs L131-181；api/index.js L49-59 |
| duration | 部分接通（导演值仅参考） | 意图表达 | 是 | 最终取「导演意图 vs TTS 实测+0.6s 尾隙」最大值（timeline.js L259-280） |
| pause_after | 部分接通 | 意图表达 | 是 | 钳位 0.15~1.5s 缺省 0.5（timeline.js L259-280） |
| motion（5 档）/ transition（15 种 + 5 旧剧本兼容别名） | 已接通 | 是 | 是 | ffmpeg-kit/effectsLibrary.js L7-31、L53-60；timeline.js L100-103 |
| opening（14 种）/ ending（5 种） | 已接通 | 是 | 是 | effectsLibrary.js；非法 key 静默回退（ending 默认 black_out） |

## 域 5：封面视觉设计与标题渲染

| 能力 | 分类 | LLM 可控 | 影响产物 | 关键证据 |
|---|---|---|---|---|
| visual_design 8 子字段（layout/font/graphic/color/title_form/title_material/animation_in/out） | 已接通 | 是 | 是 | cover-kit/rules.js L11-19、L119-135（组合矩阵校验）；api/visual.js L40-66（降级清洗）；cover-kit/index.js L157、L183-184、L271-340 |
| 非法组合自动降级 LAYOUT_DEFAULT_COMBOS | 默认行为 | 否 | 是 | api/visual.js L40-66 |
| 封面抽帧 2.6s、主标题=LLM title、副标题=cover_line | 已接通 | 是（文案） | 是 | cover.js L17-43；index.mjs L306-315 |

## 域 6：BGM / TTS 音色 / 情绪 / 音效

| 能力 | 分类 | LLM 可控 | 影响产物 | 关键证据 |
|---|---|---|---|---|
| bgm_emotion + bgm_on | 已接通 | 是 | 是 | bgm.js L167-190（白名单回退 generic）；timeline.js L358-365 |
| BGM 选曲机制 | 已接通（随机） | — | 是 | **补证结论**：`pickBgmByPriorityChain` 目录内随机不重复轮转（bgm.js L177-178 注释明示）；无任务 ID/seed；无可用曲目返回 null 跳过背景乐（L179-182） |
| sfx_on（整体开关） | 已接通 | 是 | 是 | timeline.js L332-345 |
| 音效选型机制 | 已接通（随机） | — | 是 | **补证结论**：pickOne `Math.random()` + used 本片防重（sfx.js L33-40）；三类共用同一 pickOne，逻辑一致 |
| intro/transition 音效 | 默认行为（静默跳过） | — | 否 | **补证结论**：intro_sfx / transition_sfx 目录已移除、映射保留、缺目录静默跳过（sfx.js L2、L16-30），池空恒返回空串；实际仅 outro_sfx 生效 |
| 音效强度/三类细分开关 | 冻结预留 | 否 | 否（恒默认全开 + 0.8） | timeline.js L347；sfx.js L65-71 |
| 音色（性别跟随用户 + 失败降级晓晓） | 已接通（性别）/ 冻结预留（细选） | 性别跟随用户 | 是 | timeline.js L112、L155-158；03_audio_constitution.md §11.1 |

## 域 7：程序默认值、兜底、随机、兼容

| 能力 | 分类 | 结论 | 关键证据 |
|---|---|---|---|
| sanitizeDirectorCut 钳位/默认全集 | 默认行为 | duration≤8（0=按 TTS 自适应）、pause_after 钳位缺省 0.5、motion 默认 push_in、transition 默认 dissolve、opening 默认 dive_in、ending 默认 black_out、title 截 24 字、asset 去重补位；**无 scene 参数，无按 scene 分流逻辑** | director.mjs L131-181、L199 |
| mocker 兜底剧本（LLM 失败回落） | 默认行为 | **补证结论**：opening/ending/motion/transition 全部按 scene 与镜位**条件固定选择**（local=curtain_v/personal=fade_reveal/sell=dive_in；personal=fade_out/其余 black_out；末镜 pull_out+fadeblack、其余 push_in+dissolve），零随机零轮询；sfx 细分字段不写入，由下游缺省补齐 | index.mjs L317-320；director.mjs L246-262、L274 |
| TTS 失败降级 | 默认行为 | 晓晓整批重试 | timeline.js L155-158 |
| BGM/音效选型随机 | 已接通 | 见域 6 补证结论 | bgm.js L177-178；sfx.js L33-40 |

## 域 8：历史任务 / 存储 / 前端传值

| 能力 | 分类 | 结论 | 关键证据 |
|---|---|---|---|
| storage 任务剧本归档（script.json） | 已接通（只写） | 仅归档与取证，不回读参与执行 | api/index.js L116-152 |
| 创作防重账本（唯一回读路径） | 已接通 | 影响创作倾向不强制；variant_type 为纯字符串记录（personal 空串口径已修复；历史账本条目中「宪法纯生活叙事」随最近 20 条滚动自然淘汰，见域 2） | creativeLedger.mjs L28-64 |
| 前端传剧本字段 | 不存在 | 前端仅传创作入参，剧本全由 LLM/mocker 产出 | apps/web/client（阶段三核实） |

## 域 9：image_creator_v1 冻结边界

| 能力 | 分类 | 结论 |
|---|---|---|
| core/ 内部实现（timeline.js 读取位与注释） | 冻结预留 / 文档漂移挂账 | 预留位 L75（voiceId 入参）/ L112（script.voice_id）/ L347（script.sfx）不得依赖；L62（asset_id/audio_design）与 L347 注释漂移随 v2 协议修正 |
| 对外 API（createTask/getTask/preanalyzeAssets） | 已接通 | 协议变更须升主版本号 |

## 域 10：文档漂移与挂账汇总

| 项 | 分类 | 处置现状 |
|---|---|---|
| timeline.js L62（asset_id/audio_design）、L347（「mocker 与真实 LLM 同结构」） | 文档漂移 | 挂账（03_audio_constitution.md §11.3、image_creator README、00_llm_director.md §8.2），黑盒内不修 |
| docs/architecture/engine/03_audio_constitution.md 三处旧 sfx 契约表述 | 文档漂移（已勘误） | 就地勘误注记完成（2026-10-13） |
| ENGINE_SPECIFICATION.md L47 sfx.intensity 遗留 | 文档漂移（已修正） | 2026-10-13 阶段收尾就地修正为 sfx_on 真实口径（勘误：原文实测位于 L46，05 文档原引用 L47 为旧行号） |
| sfx.js L60「mocker 与真实 LLM 同结构」注释漂移 | 文档漂移（已修正） | 2026-10-13 阶段收尾修正（packages/audio-kit 共享层非冻结，纯注释零行为变更；登记见 00_llm_director.md §8.2） |
| personal mocker variant_type=「宪法纯生活叙事」与契约空串口径不一致 | 已修复（2026-10-13） | director.mjs L268 源头归零；单元级 9 断言 + 行为级 6 断言通过 |
| personal LLM 路径清洗层无 variant_type 强制归零 | 已修复（2026-10-13） | index.mjs L323-324 最终防线（icCreateTask 之前）；行为级桩测试证实 LLM 违规输出归零且 sell/local 不误伤 |

## 待确认项闭合表（阶段四补证后）

| 项 | 状态 | 依据 |
|---|---|---|
| personal variant_type 终值及对齐 | 已证实 | index.mjs L300-302；director.mjs L166、L219-223、L243 |
| BGM 选曲随机性 | 已证实（目录内随机不重复） | bgm.js L167-190 |
| 音效选型随机性 | 已证实（Math.random 本片防重；intro/transition 池空静默跳过） | sfx.js L16-40 |
| mocker 特效默认值 | 已证实（全条件固定值） | director.mjs L246-262 |

## 影响未来需求的已知限制

1. 导演无法控制音色细选与音效强度/分开关——解冻须走 image_creator_v1 协议变更。
2. sales_intensity 无渲染消费位——「按销售强度驱动节奏/配乐」类需求需新增字段与消费链。
3. duration 受 TTS 实测+0.6s 取大约束、pause_after 下限 0.15s——精准卡点需求受物理制约。
4. 特效/视觉均为固定白名单菜单——新增特效须改 packages/ffmpeg-kit（共享层，需跨包评估）。
5. 4核4G 2并发硬件地基约束有效（项目级硬约束）。
6. personal.variant_type 两个口径问题已修复并验证（2026-10-13 阶段收尾，见域 2/域 10）。
