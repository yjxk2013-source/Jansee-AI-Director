# 简兮 JANSEE · 品牌视觉徽标重构设计规范 (LOGO DESIGN SYSTEM)

> **版本**：v2.1 Cinematic Obsidian & Monoline System  
> **设计定调**：纯粹黑白灰极致系统 (Monochrome Obsidian) / 70mm 电影工业先锋感 / 极简精密机能美学  
> **主站首页**：[index.html](file:///f:/janseeV2/index.html)

---

## 1. 原设计资产诊断与痛点推导

### 1.1 原稿特征分析
用户原稿为红色缎带飘带风格的「J + X」字母连体组合，中间嵌套常规三角形播放键（▶）。

### 1.2 核心脱节原因与重构必然性
1. **色相严重冲突**：原稿采用高饱和度鲜红渐变（#b91c1c ~ #dc2626），与全站彻底去饱和的黑曜石深邃底色（#050505）、冷银发丝钛金与高光纯白产生了极强的视觉噪点与违和感。
2. **形态肌理软绵拟物**：原稿带有十年前消费级流媒体 App 的高光圆角塑料质感，缺乏「AI 商业短视频重构工场」所要求的发丝级锐利切角与工业数控机床精工感。
3. **视听隐喻过于常规**：直接在字母间嵌圆角播放三角，缺乏高级留白与正负形互动的深层概念。

---

## 2. 品牌核心基因提炼与设计法则

- **字母心智**：**J**（简）+ **X**（兮）连续翻折缎带拓扑体。
- **产业心智**：**商业视听重构工场** —— 毫秒级重构脚本分镜、70mm 电影镜头质感。
- **原版造型 100% 传承**：
  左侧 J 垂直立柱自然回勾，顶部连续翻折贯穿至 X 主斜肢，中间悬浮咬合的三角形播放键（▶）完全保持原有几何位置。
- **色彩与材质彻底脱胎换骨**：
  剥离原稿的红色塑料质感，全面拥抱纯粹黑曜石（#050505）、冷银钛金拉丝（Titanium Silver）与高光冷白聚光核。

---

## 3. 原造型官方终极定稿方案 (ORIGINAL MONOGRAM · OBSIDIAN GLOW)

> **官方定稿**：**`orig_metal_obsidian`（黑曜石暗黑陶瓷 + 冷白激光轮廓与微光播放核）**  
> **核心原则**：造型 100% 保持用户原稿，彻底移除多余文字干扰，全站顶栏与页脚已全量实装 `orig_metal_obsidian` 官方资产。

| 方案代号 | 视觉命名 | 核心设计语言 | 资产预览 | 状态 |
| :--- | :--- | :--- | :--- | :--- |
| **orig_metal_obsidian (官方定稿)** | **黑曜石陶瓷 + 冷白激光轮廓 (Obsidian Glow)** | 本体哑光黑曜石深沉碳素材质，外边缘 1.6px 纯白激光发光轮廓，中心三角形播放核爆发纯白高亮辉光 | `./assets/orig_metal_obsidian.jpg` | **[APPROVED] 全站唯一指定官方实装资产** |

---

## 4. 主站纯矢量 SVG 官方工程级实现代码 (方案 B 黑曜石冷白微光版)

```xml
<svg viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg" class="brand-logo-svg">
  <defs>
    <!-- 黑曜石深沉碳素底色渐变 -->
    <linearGradient id="obsidianBody" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#1e1e24"/>
      <stop offset="50%" stop-color="#121216"/>
      <stop offset="100%" stop-color="#08080a"/>
    </linearGradient>
    <!-- 折叠内侧深渊渐变 -->
    <linearGradient id="obsidianInner" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#000000"/>
      <stop offset="100%" stop-color="#16161a"/>
    </linearGradient>
    <!-- 冷白激光辉光滤镜 -->
    <filter id="neonWhiteGlow" x="-30%" y="-30%" width="160%" height="160%">
      <feGaussianBlur stdDeviation="2.5" result="blur"/>
      <feMerge>
        <feMergeNode in="blur"/>
        <feMergeNode in="SourceGraphic"/>
      </feMerge>
    </filter>
  </defs>
  <!-- 1. 背面折叠暗部 (黑曜石深渊) -->
  <path d="M 40 22 C 48 22 56 30 62 40 L 52 56 C 46 48 42 38 38 28 Z" fill="url(#obsidianInner)" stroke="rgba(255,255,255,0.25)" stroke-width="1.2"/>
  <!-- 2. X 副对角线 (深邃黑曜石 + 纯白冷光轮廓) -->
  <path d="M 72 20 L 92 20 L 54 80 L 36 80 Z" fill="url(#obsidianBody)" stroke="#ffffff" stroke-width="1.6" stroke-linejoin="round"/>
  <!-- 3. J 主体与顶部翻折主斜肢 (原版一气呵成连续缎带 + 纯白发丝光芒) -->
  <path d="M 10 58 C 10 70 18 80 30 80 C 40 80 46 72 46 58 L 46 30 C 46 22 40 20 32 20 C 20 20 18 28 18 36 L 28 36 C 28 30 30 28 32 28 C 34 28 36 30 36 34 L 36 58 C 36 68 32 72 28 72 C 22 72 18 66 18 58 Z" fill="url(#obsidianBody)" stroke="#ffffff" stroke-width="1.6" stroke-linejoin="round"/>
  <path d="M 36 28 C 40 20 48 20 54 20 L 90 80 L 74 80 L 46 34 Z" fill="url(#obsidianBody)" stroke="#ffffff" stroke-width="1.6" stroke-linejoin="round"/>
  <!-- 4. 中心高亮纯白播放三角 ▶ (冷白激光发光核) -->
  <polygon class="logo-play-core" points="46,38 64,50 46,62" fill="#ffffff" filter="url(#neonWhiteGlow)"/>
</svg>
```

---

## 5. 导航栏排版与字体粗细规范 (用户明确制定基准)

### 5.1 视觉比例准则：Logo 放大与登录字体上下等高
- **基准对齐**：Logo 发光 JX 图形本体的高度，与右侧幽灵边框内的「登录」二字汉字字高（`14px ~ 15px`）在垂直上下维度上**绝对等高**。
- **物理尺寸**：
  - 容器尺寸：`width: 28px; height: 28px;`（弥补原图边缘安全黑边留白，使内部图形实心高度达到 15px）；
  - 倒角微倒：`border-radius: 4px;`；
  - 悬停动效：`transform: scale(1.06); filter: drop-shadow(0 0 10px rgba(255, 255, 255, 0.85));`。

### 5.2 品牌字标水平单行排列规范
- **排列方式**：严禁上下双行堆叠，坚决采用单行水平连续排版：**`简兮·JANSEE`**。
- **字标参数**：
  - 内容：`简兮·JANSEE`（中英文以间隔点优雅衔接）；
  - 字号：`14px`；
  - 字重：`font-weight: 200`（极细纤细体）；
  - 字距：`letter-spacing: 0.1em`；
  - 色彩：`#ffffff`。

### 5.3 导航栏全员字体族与粗细标准 (对标副标题基准)
- **字体族规范 (Font Family)**：
  严禁使用系统默认宋体或沉重回退无衬线字体，全员统一采用项目自有私有化字体家族：
  ```css
  font-family: 'Manrope', 'Noto Sans SC', -apple-system, BlinkMacSystemFont, 'Segoe UI Variable Display', 'Segoe UI Light', 'PingFang SC', 'Microsoft YaHei Light', sans-serif;
  ```
- **粗细程序标准 (Font Weight Standard)**：
  完全严格对标首屏副标题基准：
  > *“贯通全域电商、实体门店与独立创作者的内容工场。无需庞大摄制团队，毫秒级重构脚本分镜，让商业镜头回归纯粹质感”*
  - **标准字重**：全员统一执行 **`font-weight: 200`**；
  - **设计心理学意图**：去除非专业网站的 400/500/600 粗笨臃肿感，以 200 极细高精度线条呼应 70mm 电影镜头的冷冽、深邃与克制留白；
  - **覆盖元素清单**：
    1. **品牌字标**（`.brand-text`）：`font-size: 14px; font-weight: 200;`；
    2. **导航主链接**（`.links a`）：`font-size: 14px; font-weight: 200; letter-spacing: 0.08em;`；
    3. **中英文切换器**（`.lang-switch-btn` / `.lang-opt`）：`font-size: 13px; font-weight: 200;`；
    4. **登录操作按钮**（`.pill-nav`）：`font-size: 14px; font-weight: 200; letter-spacing: 0.08em;`；
    5. **首屏三大场景按钮**（`.btn-ghost`）：`font-size: 14px; font-weight: 200; letter-spacing: 0.08em;`。
