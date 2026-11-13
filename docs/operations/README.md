# 简兮运维与高可用发布规范 (Operations Manual)

> 规范平台服务部署、端口配置、健康巡检、故障回滚与素材同步规约。

## 运维检查项

1. 服务端口健康检查：3000 (BFF Gateway) / 5173 (Web Client)；
2. 环境变量单一可信源检查：确保项目根目录 .env 完备且子目录无冗余 .env；
3. 素材中心链接检查：确保 materials 与底层资产库联结健康；
4. 存储隔离区清理：定期巡检 storage/outputs 与 storage/uploads 过期运行时产物。

------------------------------------------------------------------------

## 积木式引擎验收与压测基线（2026-10-12 定版）

### 硬件地基与压测数据（4核4G / 2并发）

- 2 并发 × 3 批共 6 任务全成无 OOM：ffmpeg 工作集峰值 1406MB、网关 660MB、系统可用内存最低 141MB；
- 最终合成速度 0.526~0.785x，全面不低于积木前基线 0.442~0.525x。注意：测量时若挂内存/CPU 采样器，采样进程会抢占 4 核导致速度与 elapsed 严重虚高（实测 0.424x / 126~200s），禁止作为性能证据；
- 微基准：xfade 四型转场（dissolve/fadeblack/hlslice/radial）与 drawtext 四材质（titanium/hollow/relief/aura）滤镜级开销为零；
- elapsed 波动主要来自非合成阶段（LLM 剧本 / TTS / 背景分析）与系统状态，与积木无关；
- 4 核下 2 并发已近 CPU 饱和，禁止直接升并发 3（需升级硬件或限制单任务线程数）。

### 出片验收基线（scripts/run-six-productions.mjs）

- 用法：`node scripts/run-six-productions.mjs`（需 3000 网关已运行），同组 6 图按 2 并发 × 3 批出 6 片；
- 规格硬指标：1080x1920 / 25fps / libx264 + yuv420p / tv + bt709 色彩标签；任务目录须有 cover.jpg（>10KB）与 ffmpeg.log；
- 结构可辨性：6 片须命中 ≥4 种结构骨架、≥2 种开场积木、≥3 组标题形态×材质组合、≥2 种节奏档；
- 开场积木痕迹核对：slam_black 落盘 reveal_black.png、curtain_v 落盘 reveal_curtain_top/bottom.png、dive_in 无 PNG（仅时间轴缩放），与 script.json 的 design.opening_reveal 一一对应；
- 验收证据留存 scratch/（six-results.json / b6-verify.json / stress-results.json，gitignore 保护）。
