# 简兮AI导演

# 剪辑引擎 V1.1

# 完整执行规范

> **已退役（2026-10-12 · LLM 全权导演架构定版，最高优先级）**
> 本文档描述的程序编排层已不在任何成片管线中引用（全仓零 import）：
> 结构骨架库（SKELETONS）、TEMPO 档位、RHYTHM 节奏、VARIANT_EDIT_MAP 变体手法映射、
> pause_after 钳位、postGapOf 分档等程序编排规则**全部废除**。
> 现行权威架构见 [00_llm_director.md](./00_llm_director.md)：LLM 大导演全权逐镜编排，
> `packages/ffmpeg-kit/effectsLibrary.js` 特效库查表执行；仅 structure/index.js 的
> AMP_RATE / AMP_PAN 运镜幅度档仍被 core/composer.js 活跃引用。请勿按本文档重新接线。

版本：V1.1

------------------------------------------------------------------------

# 附录：V2 接线状态（2026-10，用户验收后落盘）

1.  **每图一镜动态扩镜：已定版。** N 张有效实拍图 = N 个图片镜，每图必现；
    台词分配：首图镜 Hook、末图镜 CTA、中间镜卖点拆句轮播。
    工程落点：generateConstitutionScript（apps/web/server/director.mjs）。
