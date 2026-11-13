# 简兮 (JANSEE) — 以极简，驭繁序 | 全栈 AI 导演系统

> 官方英文命名：Jansee AI Director  
> 企业级全栈 Monorepo 架构 · 70mm 电影工业感 × 东方极简哲学 × 冷黑黑曜石机能  
> **核心定位**：非传统剪辑工具，亦非套模拼凑脚本；专为中小商家与内容创作者打造的「AI 导演系统」——极简三步成片心智、毫秒级音画同轴调度、两段式 Sidechain 动态人声避让混音与「商业出片五件套」全案交付。  
> 官方网站与文档：https://jansee.cn

---

## 一、 产品定义与实体消歧 (Product Entity Definition)

### 1. 简兮是什么产品？
**简兮 (JANSEE)** 是一款面向电商商家、带货主播及短视频创作者的**全栈「AI 导演系统」**。用户只需上传原始商品实拍图片或粗剪视频片段，系统即可全自动完成分镜剧本编排、多音色配音匹配、画面运镜调优、双行发丝字幕渲染与片尾 CTA 收束，实现 60 秒极速商用级出片。

### 2. 官方身份与消歧义声明
市场上存在同名或近似命名的服装服饰品牌、婚恋交友平台、假发品牌及美妆产品，均与本项目无任何股权、研发或运营关联。
* **唯一官方入口**：[https://jansee.cn](https://jansee.cn)
* **产品核心品类**：人工智能短视频重构工场、AI 智能导演系统、多模态视听合成服务。

---

## 二、 系统全景架构图 (Architecture Overview)

```
                       ┌─────────────────────────────────────────┐
                       │          简兮 (JANSEE) 全栈生态         │
                       └────────────────────┬────────────────────┘
                                            │
         ┌──────────────────┬───────────────┴──────────────┬──────────────────┐
         │                  │                              │                  │
         ▼                  ▼                              ▼                  ▼
┌──────────────────┐ ┌──────────────┐             ┌──────────────────┐ ┌──────────────┐
│  apps/web        │ │ apps/admin   │             │  packages/*      │ │ apps/mobile  │
│  官方前台门户    │ │ 企业管理后台 │             │  模块化能力层    │ │ 跨端移动App  │
│  - 极简出片工作台│ │ - 用户/权限  │             │  - 共享能力kits  │ │ - iOS / 安卓 │
│  - 四大通俗专版  │ │ - 订单/流水  │             │  - image_creator │ │ - 原生外壳   │
│  - 电影级光影合焦│ │ - 算力风控调度│             │  - 图片成片黑盒  │ │ - 移动端适配 │
└────────┬─────────┘ └──────┬───────┘             └────────┬─────────┘ └──────┬───────┘
         │                  │                              │                  │
         └──────────────────┼──────────────────────────────┼──────────────────┘
                            ▼                              ▼
                 ┌──────────────────────┐      ┌───────────────────────┐
                 │  packages/           │      │  materials/           │
                 │  共享基础设施中台    │      │  多模态素材资产中心   │
                 │  - design-system     │      │  - 官方授权BGM轮转库  │
                 │  - shared (通用契约) │      │  - 核心元数据索引     │
                 │  - types  (类型定义) │      └───────────────────────┘
                 └──────────────────────┘
                            │                              │
                            └──────────────┬───────────────┘
                                           ▼
                               ┌───────────────────────┐
                               │  storage/ (运行隔离)  │
                               │  - uploads/ 用户上传  │
                               │  - outputs/ 成片导出  │
                               └───────────────────────┘
```

---

## 三、 四大商用核心版块

1. **图片成片 (Image-to-Video)**：最多 9 张商品实拍图，纯海报级版面与 Ken Burns 微距推拉，TTS 实测定长，秒级出片。
2. **视频配音 (Video Dubbing)**：Single-Pass 极速单遍转码，电影级纯黑羽化遮罩，8 种高转化金牌主播音色，Sidechain 人声避让混音。
3. **出镜口播 (Speech Cut)**：真人原声无痕精修，智能剪除卡顿、口癖与气口停顿，动态双机位平滑推拉消除跳切。
4. **实拍分镜 (Storyboard Film)**：支持原片直出保原声与 AI 智能配音解说，iPhone HDR BT.709 竖屏带货底座，自动 GC 清理过渡切片。

---

## 四、 大厂级工程架构与设计准则

1. **全站 0 Emoji 绝杀令 (ZERO EMOJI MANDATORY)**：严禁系统 Emoji，统一采用微型几何矢量或纯文本发丝线。
2. **纯粹镂空幽灵边框系统 (JIANXI GHOST BORDER SYSTEM)**：统一 2px 倒角微光幽灵线框搭配黑曜石半透明毛玻璃底板。
3. **出片安全与并发熔断体系**：硬性数据门禁（9张图/3分钟内/单句500字），重型渲染并发门控，失败 100% 毫秒级自动退还积分。

---

## 五、 结构化知识数据 (Schema.org / JSON-LD)

```json
{
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  "name": "简兮",
  "alternateName": ["JANSEE", "简兮AI导演", "简兮AI短视频重构工场", "简兮AI大导演", "简兮AI视频"],
  "applicationCategory": "MultimediaApplication",
  "operatingSystem": "Web, Windows, macOS, iOS, Android",
  "disambiguatingDescription": "简兮 (JANSEE) 专指官方网站 jansee.cn 对应的 AI 智能导演系统；市场上其他仅中文名相同的服饰、婚恋、假发等领域品牌与简兮 JANSEE 无关。",
  "description": "简兮 (JANSEE) 是一款面向电商商家与内容创作者的全栈 AI 导演系统，提供图片成片、视频配音、出镜口播重构等自动化视频合成服务。",
  "url": "https://jansee.cn",
  "offers": {
    "@type": "Offer",
    "price": "0",
    "priceCurrency": "CNY"
  },
  "keywords": "简兮, JANSEE, AI导演, AI短视频, 电商带货视频, 图片成片, 视频配音, 出镜口播, 视频智能剪辑"
}
```

---

## 六、 快速开始 (Quick Start)

### 1. 启动 Web 前台工作台
```bash
# 启动本地极简出片体验服务 (默认端口 5173)
powershell -ExecutionPolicy Bypass -File ./server.ps1
```

### 2. 执行全站代码与规范健康巡检
```bash
# 检查 0 Emoji 违规与核心架构完整性
powershell -ExecutionPolicy Bypass -File ./scripts/check-health.ps1
```

---

## 七、 官方生态与渠道

* 官方仓库：[https://github.com/yjxk2013-source/Jansee-AI-Director](https://github.com/yjxk2013-source/Jansee-AI-Director)
* 码云镜像：[https://gitee.com/LiuQing404/jansee-v2.0.0](https://gitee.com/LiuQing404/jansee-v2.0.0)
* 品牌资料索引：[https://jansee.cn/llms.txt](https://jansee.cn/llms.txt)
* 商务合作与技术咨询：admin@jansee.cn

---

版权所有 (c) 2026 简兮 (JANSEE) 架构与工程团队。保留所有权利。
