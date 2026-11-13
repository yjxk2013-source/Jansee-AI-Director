# 06 · AI 导演与视频生成引擎阶段关闭记录

> **关闭日期**：2026-10-13（阶段最终收尾，用户指令执行）
> **关闭范围**：阶段三契约全字段普查、阶段四能力边界审计、personal.variant_type 两处修复及双层验证、全部已知文档漂移收口。
> **红线声明**：本阶段零生产逻辑改动（唯一生产文件改动为 sfx.js 纯 JSDoc 注释）；image_creator_v1 冻结核心与协议零触碰。

## 1. 本阶段目标与范围

关闭 AI 导演与视频生成引擎阶段全部已知欠账，形成可审计的阶段关闭记录。不做新功能开发、不扩展能力、不重构执行链；以当前实际代码、正式文档、可复现测试结果为唯一依据，禁止以历史报告替代实测。

## 2. 已完成工作及证据

| 工作 | 证据 |
|---|---|
| 阶段二：voice_id / bgm_on / sfx_on 契约审计，voice_id 定版冻结兼容方案 | 03_audio_constitution.md §11.2（冻结清单 7 项符号 + 解冻条件） |
| 阶段三：剧本契约全字段普查（26 字段五路证据 + A-E 分类） | 00_llm_director.md §8（口径登记）+ 03 §11（登记）+ image_creator README §9 |
| 阶段四：AI 导演能力边界审计（十域）+ 三项补证闭合 | 05_llm_capability_boundary.md（十域全表 + 待确认项闭合表） |
| personal.variant_type 两处修复 | director.mjs L268（mocker 源头归零）+ index.mjs L323-324（最终防线，位于 try/catch 之后 icCreateTask 之前） |
| personal.variant_type 双层验证 | 单元级 9 断言（test-personal-variant.mjs verify）+ 行为级 6 断言（test-personal-variant-e2e-stub.mjs，ESM loader 无侵入桩）——2026-10-13 收尾当日重跑 ALL PASS |
| 文档漂移收口 | 本次收尾修正 2 处、维持挂账 2 处（详见第 6 节） |

## 3. 修复清单与测试结果

### 3.1 生产代码修复（本阶段批准范围，收尾当日重测）

| 修复 | 位置 | 内容 | 测试 |
|---|---|---|---|
| 修复 A：mocker 源头归一 | apps/web/server/director.mjs L268 | personal 兜底剧本 variant_type 输出空串；「宪法纯生活叙事」仅保留为 decideVariant 内部判定语义不落盘 | 单元 T1/T2；行为级 B 组 3 断言 |
| 修复 B：主流程最终防线 | apps/web/server/index.mjs L323-324 | personal 场景 directorPlan.variant_type 强制归零，覆盖 LLM 违规输出；位于 icCreateTask 之前，LLM 与 mocker 两路径均受控 | 单元 T3（源码位置断言）+ 行为级 A 组 3 断言（真实 produce 主流程） |

### 3.2 收尾当日实测结果（全部真实执行，退出码 0）

| 测试 | 命令 | 结果 |
|---|---|---|
| 单元级 9 断言 | `node scratch/test-personal-variant.mjs verify` | ALL PASS（T1 mocker 归零 / T2 sell/local 对基线逐字段回归 / T3 防线存在且位于 icCreateTask 前 / T4 账本隔离与四维差异化） |
| 行为级 6 断言 | `node scratch/test-personal-variant-e2e-stub.mjs` | ALL PASS（A 组：LLM 违规输出经真实 sanitizeDirectorCut + 装配后防线归零，sell/local 不误伤；B 组：LLM 失败走真实 mocker，personal 空串、sell=A-痛点直击型、local=A-宝藏发现型） |
| 项目健康检查 | `npm run check:health` | PASSED（18 项目录结构 OK、100% 零 Emoji、5173 静态页 200） |
| 网关健康探活 | GET http://localhost:3000/api/v1/health | healthy（uptime 2048.8s，运行进程为含修复代码的已重启实例，未做中断性重启） |

行为级测试方法说明：ESM loader（scratch/stub-ic-loader.mjs）拦截面仅两处——icCreateTask 换落盘桩（不进真实合成流水线）、generateDirectorCut 换可控桩（违规模板先过真实 sanitizeDirectorCut 清洗层）；spawn 真实网关子进程以隔离端口与 JX_DATA_DIR 触发真实 produce 主流程。不调用真实 LLM/TTS/外部付费服务，不触发真实视频生成。测试资产全部位于 scratch/，运行时产物已清理（账本测试经 JX_DATA_DIR 隔离，不污染真实 creative_ledger.json）。

## 4. 正式契约字段审计结论（26 字段）

宪法契约 constitution.md §4 共 26 字段：顶层 12（title/variant_type/emotion/voice_gender/sales_intensity/bgm_emotion/bgm_on/sfx_on/opening/ending/cover_line/visual_design）+ visual_design 8 子字段（layout/font/graphic/color/title_form/title_material/animation_in/animation_out）+ shots 6 子字段（asset/line/duration/pause_after/motion/transition）。收尾当日逐项点数核实，数量与分类准确。

| 已知事项 | 收尾核实结论 | 证据 |
|---|---|---|
| sales_intensity | 创作意图字段（④口径），渲染管线零读取位，未误报为直接渲染控制；mocker 兜底 sell='medium'（L271） | 00_llm_director.md §8.1；constitution.md L73 |
| bgm_on / sfx_on | 已接通开关（③LLM 可控 ②影响产物） | director.mjs L170-171 → timeline.js L343（sfx_on）/ L361（bgm_on） |
| script.sfx 细分控制 | 未接通，未误报为 LLM 可控；timeline.js L347 消费位恒收缺省（三类全开 + intensity 0.8，sfx.js 缺省逻辑实测 L69-72） | 03_audio_constitution.md §11.3 |
| voice_id | 冻结预留，非当前正式 LLM 契约；timeline.js L112 读取位、L75 voiceId 入参恒空 | 03_audio_constitution.md §11.2 |
| shots.asset_id / audio_design 注释漂移 | 确认存在（timeline.js L62 注释 vs L98-105 实际消费 s.asset）；维持挂账随 image_creator_v2 | 00_llm_director.md §8.2 |

## 5. 能力边界与当前实际可控能力

权威结论以 05_llm_capability_boundary.md 十域边界表为准（收尾当日逐域复核：域 1-10 完整，引用行号抽查 director.mjs / index.mjs / prompt/index.js / creativeLedger.mjs / timeline.js / bgm.js / sfx.js / effectsLibrary.js / visual.js 全部准确）。

当前 LLM 实际可控：26 契约字段输出（其中 sales_intensity 仅意图表达）、duration/pause_after 受物理约束取大钳位、BGM 情绪选曲（目录内随机不重复 + 人声闪避）、sfx_on 整体开关、voice_gender 跟随用户红线、visual_design 整套组合（非法组合自动降级）。

## 6. 文档漂移处理决定

| 项 | 原口径 | 实际口径 | 处理决定 | 证据 |
|---|---|---|---|---|
| ENGINE_SPECIFICATION.md 索引表（05 文档曾引用 L47，实测 L46） | 「强度契约 sfx.intensity 0.3~1.2」 | LLM 可控仅 sfx_on 整体开关；intensity 与分向开关冻结预留 | 已修正（安全文档修正，不改运行时） | 03 §11.3 |
| packages/audio-kit/sfx.js L60 JSDoc | 「LLM 导演氛围意图（mocker 与真实 LLM 同结构）」 | 写入链未接通，prefs 恒收缺省（全开 + 0.8）——清洗层与 mocker 均不写 sfx | 已修正（共享层非冻结黑盒，纯注释零行为变更）+ 登记 00 §8.2 | timeline.js L347 实测 |
| modules/image_creator/core/timeline.js L62 | 注释 shots:[{line, asset_id, audio_design}] | 实际契约 asset（数字）且无 audio_design，全仓库零代码读取 | 维持挂账，随 image_creator_v1 → v2 协议升级修正（冻结黑盒内不修） | 00 §8.2 |
| modules/image_creator/core/timeline.js L347 | 注释「mocker 与真实 LLM 同结构」 | 清洗层与 mocker 均不写 sfx | 同上维持挂账 | 00 §8.2 |
| 05 文档 personal.variant_type 相关 4 处「待批准/未处理」状态 | 修复前状态 | 修复已实施并验证 | 已更新为「已修复（2026-10-13）」定版状态 | 本次收尾 Edit 记录 |

## 7. 冻结项清单（全部保留，不删除死代码）

| 冻结项 | 理由 | 边界 | 解冻条件 |
|---|---|---|---|
| script.voice_id（timeline.js L112） | V2 声音积木预留 | 读取位保留、写入链五路全零、禁止提示词声明 | LLM 契约未来声明音色字段 / video_creator 接线 / 用户主动解冻（03 §11.2） |
| composeProductVideoInner.voiceId 入参（timeline.js L75） | 预留接入口 | 调用链恒空串 | 同上 |
| tts-kit 方言白名单体系（VOICE_WHITELIST / ALL_VOICE_IDS / DEFAULT_DIALECT / normalizeDialect / resolveVoice）、VOICE_CHAR / VARIANT_VOICE_MAP / resolveVariantVoiceKey | 历史实现冻结保留 | 零外部引用，一律不删不改 | 同上 |
| tts.js MOOD_TO_VOICE 分支、TEMPERAMENT 三表 + mapVoiceFor 气质分支 | 函数级兜底 / 方案 A 预留翻译层 | 主链路恒不命中 | 同上 |
| script.sfx（intensity + 三类分向开关） | 音效细粒度控制预留 | timeline.js L347 消费位保留，恒收缺省 | LLM 契约声明 sfx 字段并接通写入链（须评估 image_creator_v1 协议影响，03 §11.3） |
| image_creator_v1 协议与 core/ 内部实现 | 模块黑盒冻结（protocol v1） | 仅经 api/index.js（createTask/getTask/preanalyzeAssets）消费 | 协议变更须升级主版本号（image_creator_v2） |

## 8. 未执行但已正式决定延期的事项及触发条件

| 事项 | 正式决定 | 触发条件 |
|---|---|---|
| timeline.js L62 / L347 注释修正 | 随 image_creator_v1 → v2 协议升级统一处理（冻结黑盒内不做任何改动，含注释） | v2 协议升级立项 |
| 视频配音功能开发 | 本阶段关闭并通过用户审查批准后启动（用户明令：批准前不得开始） | 用户明确批准 |
| voice_id / script.sfx 能力接通 | 冻结，非欠账（见第 7 节解冻条件） | 见第 7 节 |
| BGM/SFX 随机策略调整 | 无调整需求，维持现状（随机不重复为本阶段证实行为，非缺陷） | 产品决策变更 |

## 9. 已知未覆盖测试与剩余风险

**已知未覆盖（如实声明，不伪称已验证）**：
1. 真实 LLM 网络调用的行为（行为级测试以违规模板替代模拟，未消耗真实 LLM 验证其输出合规率——prompt 软约束的实际违规率无统计数据）。
2. 真实 icCreateTask 之后的合成链路（冻结黑盒内，与本阶段 variant_type 验证目标无关；其功能正确性由模块化封装阶段的全量验收覆盖）。
3. variants 判定对长尾开放文案（零强信号命中）的行为依赖 LLM 兜底，未做 LLM 实测。
4. git 不在本机 PATH，无法输出机器级 diff 快照——以文件级修改清单 + 行为级测试为替代证据。

**剩余风险（低）**：
1. 真实账本 creative_ledger.json 历史条目中残留「宪法纯生活叙事」值，随最近 20 条滚动自然淘汰，期间仅影响 antiRepeatBlock 提示文案的一个字段展示，不影响产物。
2. 运行中网关（PID 见探活）为重启后实例，已加载修复代码；若后续部署，重启即生效（磁盘代码已含全部修复）。

## 10. 最终修改文件清单

**收尾阶段（2026-10-13 本次）修改**：

| 文件 | 性质 | 内容 |
|---|---|---|
| docs/architecture/ENGINE_SPECIFICATION.md | 文档 | L46 索引描述 sfx.intensity 旧口径 → sfx_on 真实口径（1 行） |
| packages/audio-kit/sfx.js | 生产代码（纯注释） | buildSfxTimeline JSDoc prefs 段漂移修正（2 行注释，零行为变更） |
| docs/architecture/engine/00_llm_director.md | 文档 | §8.2 补记 sfx.js L60 漂移及处置（1 行） |
| docs/architecture/engine/05_llm_capability_boundary.md | 文档 | 头部收尾标注 + 域 2/域 8/域 10/已知限制第 6 条共 6 处状态更新为修复后定版 |
| docs/architecture/engine/06_engine_phase_closure.md | 文档（新建） | 本关闭记录 |

**上一批准阶段遗留修改（本阶段零触碰，行为级测试再次证实）**：apps/web/server/director.mjs（L268）、apps/web/server/index.mjs（L323-324）。

**测试资产（scratch/，按项目约定存放）**：test-personal-variant.mjs、test-personal-variant-e2e-stub.mjs、stub-ic-loader.mjs、personal-variant-baseline.json（另有此前阶段的既有 scratch 资产未动）。

**明确未改动**：modules/image_creator/**（冻结核心与协议零触碰）、packages/{tts-kit,cover-kit,ffmpeg-kit,subtitle-kit}、apps/web/client、director 提示词 md、BGM/SFX 选曲策略。

## 11. 阶段关闭判定

| 关闭条件 | 判定 | 证据 |
|---|---|---|
| 所有已知欠账均已修复、验证，或有正式冻结/延期决定 | 满足 | 第 3/6/7/8 节；挂账项均有正式决定与触发条件 |
| 正式文档与实际运行行为一致 | 满足 | 收尾只读盘点：05/00/03/ENGINE_SPECIFICATION/README 逐项与代码证据核对一致，过时状态已更新 |
| 必要测试与健康检查通过，结果真实可复现 | 满足 | 第 3.2 节：15 断言 ALL PASS + check:health PASSED + 网关探活 healthy，命令可重复执行 |
| sell/local 行为未发生非预期变化 | 满足 | 单元 T2 对基线逐字段回归 + 行为级 A/B 组 sell/local 断言通过 |
| image_creator_v1 冻结边界未被破坏 | 满足 | 本阶段零触碰 core/ 与协议；唯一生产改动在 packages/audio-kit 注释层 |
| 最终 diff 与文件清单明确 | 满足（附限制） | 第 10 节清单完整；git 缺失已如实声明，以清单+实测替代 |
| 06_engine_phase_closure.md 已完成且证据充分 | 满足 | 本文档 |
| 不存在尚未处理的已知高风险问题 | 满足 | 第 9 节剩余风险均为低风险且已有归宿 |

**判定结论：本阶段关闭通过（附第 9 节已知未覆盖边界声明）。**

下一步前置条件：视频配音功能开发须待用户审查本报告并明确批准后方可启动。
