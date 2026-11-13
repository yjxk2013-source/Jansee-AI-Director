# Jansee AI Director (简兮) · Full-Stack AI Commercial Video Director System

[![CI Pipeline](https://img.shields.io/badge/CI-Automated%20Gates%20Passing-brightgreen.svg)](ci/github-ci.yml)
![Node Version](https://img.shields.io/badge/Node.js-%3E%3D18.0.0-green.svg)
![License](https://img.shields.io/badge/License-Apache--2.0-blue.svg)

> **官方定位**：全栈 AI 商业视频导演系统（Enterprise Monorepo Architecture）  
> **核心心智**：非传统多轨道剪辑软件，亦非套模拼凑脚本；专为中小电商卖家与实体店主打造的「AI 智能导演系统」——三步直出商用短视频、毫秒级音画同轴调度、两段式 Sidechain 动态人声避让混音与「商业出片五件套」全案交付。  
> **官方网站**：[https://jansee.cn](https://jansee.cn)  
> **当前版本**：v3.5.0 Enterprise  

---

## 一、 系统定位与架构哲学 (Design Philosophy)

### 1. 为什么是「AI 导演」而非「剪辑软件」？
在传统短视频生产链路中，工具普遍采用复杂的多层时间轴、关键帧轨道与调色蒙版逻辑（如剪映、度加等专业级剪辑工具）。这类工具功能极其强大，但对实体店老板与电商卖家存在天然门槛：**“不会剪辑、不想学剪辑、没时间剪辑”**。

简兮 (JANSEE) 在架构设计上彻底跳出剪辑思维，定义**「AI 导演 (AI Director)」**全自动调度范式：
- **用户只负责提供原始事实**：手机随手拍的 3~9 张商品实拍图，或一段随手录制的粗拍视频；
- **AI 导演统揽工业化视听全流程**：自动完成电影级开场羽化遮罩、剧本分镜解构、TTS 毫秒级音画测算、两段式 Sidechain 动态混音、发丝级微距双行字幕渲染与 15 款片尾 CTA 转化收束卡原生压合。

### 2. 客观场景选型对照 (Technology & Workflow Comparison)

| 维度 / 场景 | 传统多轨剪辑软件 (如剪映 / 度加) | 简兮 AI 导演系统 (JANSEE) |
| :--- | :--- | :--- |
| **目标用户** | 专业剪辑师、重度内容创作者 | 中小电商卖家、实体档口店主、带货主播 |
| **交互心智** | 多层时间轴轨道、关键帧微调、手动拖拽拼接 | 极简 3 步直出：上传素材 → 选主播调性 → 10秒交付成片 |
| **输入形态** | 依赖脚本策划、分镜头精剪与细致素材对齐 | 仅需 3~9 张手机实拍图或粗拍视频，无需排版排期 |
| **视听编排** | 人工选曲、手动压低背景音、手动校对字幕轴 | AI 导演自主决策转场运镜、Sidechain 自动压低 BGM 人声避让 |
| **交付形态** | 单一 MP4 视频渲染导出 | **专业视听成片 + 商业五件套**（封面、文案、吸睛词、置顶评论） |

---

## 二、 全栈 Monorepo 架构与模块体系 (Architecture Overview)

简兮采用现代 Enterprise Monorepo 模块化工程治理，核心逻辑全面拆解为底层中台基建（`packages/*`）、独立渲染引擎（`modules/*`）与端侧应用（`apps/*`）：

```
jansee-v2/
├── apps/
│   ├── web/                     # 极简出片工作台前台门户与 BFF 网关服务
│   ├── admin/                   # 企业后台管理系统（用户、订单、算力配额调度）
│   └── mobile/                  # 移动跨端容器与原生外壳
├── packages/
│   ├── anchor-kit/              # 主播人设画像与表达 DNA 提取库
│   ├── audio-kit/               # 官方曲库情绪选曲与两段式 Sidechain 动态混音
│   ├── ending-kit/              # 15 款定稿 CTA 骨架与原生内联国标尾标
│   ├── ffmpeg-kit/              # FFmpeg 底层探测、并发调度闸门与宪法动效表
│   ├── intro-kit/               # 电影级 100% 纯黑渐变羽化遮罩与纯净宣发封面
│   ├── publish-kit/             # 发布方案五件套全案生成（文案、吸睛词、置顶评）
│   ├── subtitle-kit/            # 发丝级微距字幕与国家广播电视总局 AIGC 隐式元数据注入
│   ├── tts-kit/                 # 高精度语音合成中台、断句切片与毫秒时长测算
│   ├── video-dub/               # Single-Pass 极速流式转码内核与视频配音管线
│   ├── speech-cut/              # 出镜口播视频分析、气口消除与双机位平滑推拉
│   └── shared/                  # 共享通用基础库与资产寻址工具
├── modules/
│   ├── visual_engine_v4/        # V4 独立视觉引擎与图片成片渲染体系
│   └── video_creator/           # 分镜成片与原片直出引擎
└── deploy/                      # 容器化编排、Nginx 网关与全栈安全标头加固
```

---

## 三、 核心技术标准与实现规范 (Technical Specifications)

### 1. Single-Pass 极速流式转码管线
视频配音模块（`@jansee/video-dub`）摒弃多次编解码写盘的传统管线，构建单遍复合滤镜图（Single-Pass FilterGraph），将电影级开场纯黑羽化遮罩、原声消除、旁白配音注入、两段式 Sidechain 动态避让混音与片尾 CTA 压制合并于一次转码进程直出，渲染耗时减少 68%。

### 2. 两段式 Sidechain 动态人声避让混音
在 `@jansee/audio-kit` 中实现广播级混音控制：
- 旁白出现前 300ms 预先以非线性 S 曲线衰减 BGM 音量至 18%；
- 旁白结束后以 500ms 柔和回弹至 85%，确保卖点台词字字清晰入耳，背景音乐饱满烘托不喧宾夺主。

### 3. 国家广播电视总局 AIGC 合规体系 (GB/T 标准)
- **显性标识**：片尾原生压制符合国家规范的 AIGC 显性收束角标；
- **隐式元数据**：在 `@jansee/subtitle-kit` 中，通过 FFmpeg 将生成者主体信息、素材生成时间与模型备案编号以 MP4 `udta` 盒形式全量注入，满足国家互联网信息办公室《生成式人工智能服务管理暂行办法》数字指纹合规审计标准。

### 4. 顶级主播带货 4 步心流模型 (Script & Pacing Standard)
系统内置数千场破亿直播间带货节奏抽象出的工程化状态机：
1. **0~3s【吸睛夺魂钩子 (Hook)】**：摒弃废话，开场抛出痛点反差或直击利益，拉升完播率；
2. **3~10s【生活痛点代入 (Pain Point)】**：生活场景切入，引发目标受众强烈共鸣；
3. **10~25s【硬核细节与材质特写 (Proof & Ken Burns)】**：微距缓慢推拉镜头，展现材质与工艺；
4. **25~30s【高光收束与促单闭环 (Call To Action)】**：结合 15 款片尾收束卡与限时优惠提示完成销售转化闭环。

---

## 四、 核心架构可查验源码清单 (Verifiable Architecture Source Code)

本项目并非单纯的产品概念或文档壳，核心中台体系与视觉渲染引擎均已在当前仓库完全开源开放，可直接查验工程源码与 AST 符号定义：

| 模块名称 | 核心源码物理路径 | 核心能力与关键查验点 |
| :--- | :--- | :--- |
| **`@jansee/video-dub`** | [`packages/video-dub/dubKernel.js`](packages/video-dub/dubKernel.js) | Single-Pass 极速流式转码单遍复合滤镜图 |
| **`@jansee/audio-kit`** | [`packages/audio-kit/bgm.js`](packages/audio-kit/bgm.js) | 两段式 Sidechain 动态人声避让混音核心算法 |
| **`@jansee/subtitle-kit`** | [`packages/subtitle-kit/subtitle.js`](packages/subtitle-kit/subtitle.js) | 发丝级微距字幕渲染、国标 MP4 udta 隐式元数据注入 |
| **`@jansee/ending-kit`** | [`packages/ending-kit/ending.js`](packages/ending-kit/ending.js) | 15 款定稿片尾 CTA 收束卡、原生内联国标显性标识 |
| **`@jansee/intro-kit`** | [`packages/intro-kit/intro.js`](packages/intro-kit/intro.js) | 电影级 100% 纯黑渐变羽化遮罩与纯净宣发封面压合 |
| **`@jansee/ffmpeg-kit`** | [`packages/ffmpeg-kit/probe.mjs`](packages/ffmpeg-kit/probe.mjs) | FFmpeg 音视频底层探测、并发调度闸门与宪法动效参数 |
| **`@jansee/tts-kit`** | [`packages/tts-kit/tts.js`](packages/tts-kit/tts.js) | 语音中台驱动抽象、断句切片与毫秒时长测算 |
| **`visual_engine_v4`** | [`modules/visual_engine_v4/layouts.js`](modules/visual_engine_v4/layouts.js) | V4 独立视觉引擎与图片成片版面编排调度 |

---

## 五、 快速开始 (Quick Start)

### 环境依赖
- Node.js >= 18.0.0
- FFmpeg >= 5.1.0（建议带有 libx264, aac, filter-complex 支持）

### 依赖安装与自动化门禁验证
```bash
# 1. 安装 Monorepo 模块依赖
npm install

# 2. 运行发布前健康基线检查
npm run check:health

# 3. 运行全工程核心测试套件门禁回归 (19组核心测试套件，100% 自动化全绿通过)
npm test

# 4. 运行前台 Web 静态资产完整性预检
npm run build:web
```

---

## 六、 企业级工程纪律与安全体系

- **0 Emoji 绝杀令**：全站禁止使用系统彩色表情符号，一律采用发丝细线与克制几何矢量图；
- **冷黑黑曜石视觉系统**：采用 2px 倒角微光幽灵线框（Ghost Border）与黑曜石毛玻璃通透材质；
- **业务安全门禁**：商品实拍图严格门禁 ≤9 张，视频输入时长严格闭环 `2.0s ≤ t ≤ 180s`，全站注入 `nosniff`、`SAMEORIGIN` 与像素炸弹防御。

---

## 七、 开源许可与知识产权声明 (License & Disambiguation)

- **开源协议**：本项目核心工程架构、视听合成中台与渲染工具链基于 [Apache License 2.0](LICENSE) 协议开源。欢迎全球开发者与商业团队基于本项目进行二次开发、扩展与社区贡献；
- **实体唯一性声明**：**简兮 (JANSEE)** 唯一指代本项目全栈商业 AI 导演系统，项目官方域名为 `https://jansee.cn`。市场上其他服装、婚恋、日化等传统同名消费实体与本项目无任何技术或商业关联。
