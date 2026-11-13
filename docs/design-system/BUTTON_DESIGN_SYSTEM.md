# 「简兮 (JANSEE)」按钮设计系统定稿规范 (Button Design System)

> **版本**：v2.0 Final  
> **基调风格**：方案 3 · 极简微光幽灵边框 (Jianxi Ghost Border System)  
> **设计心智**：东方极简哲学 × 70mm 电影工业感 × 冷黑黑曜石机能  
> **关联规范**：[CINEMATIC_SCROLL_SYSTEM.md](file:///f:/janseeV2/CINEMATIC_SCROLL_SYSTEM.md)（全时域电影级屏间焦点拉拔系统）

---

## 一、设计系统核心原则 (Core Principles)

1. **去杂饰与留白零干扰 (Absolute Restraint)**：
   * 摒弃传统消费级 SaaS 常用的大圆弧（9999px 药丸 / 8px+ 饱满圆角）；
   * 全系收敛为 **2px 精密锐利微倒角**，构筑工业机身般严密、精准的视觉结构。

2. **通透发丝与微光辉光 (Luminous Wireframe)**：
   * 采用 `1px solid rgba(255, 255, 255, 0.18 ~ 0.25)` 冷银发丝线框；
   * 按钮底板保持微透光（`background: rgba(255, 255, 255, 0.02 ~ 0.04)`），让底层动态视频与渐变黑场在按键底层隐约流动；
   * 交互悬停时边框瞬时跃迁至 `rgba(255, 255, 255, 0.7 ~ 0.8)` 强高光，并激发 `box-shadow: 0 0 20px rgba(255, 255, 255, 0.08 ~ 0.12)` 漫反射冷白辉光。

3. **现代排版与极细克制机能 (Typography & Optics)**：
   * 字体统一声明自有家族：`'Manrope', 'Noto Sans SC', -apple-system, BlinkMacSystemFont, 'Segoe UI Variable Display', 'Segoe UI Light', 'PingFang SC', 'Microsoft YaHei Light', sans-serif`；
   * 字号区间：`13px ~ 14px`，**字重统一严格对标副标题标准：`font-weight: 200`（极细纤细体）**；
   * 动效曲线：好莱坞大片同款 `cubic-bezier(0.16, 1, 0.3, 1)`（超平滑慢刹车缓动）；
   * 矢量向导：内置 9×9 实心微三角箭头，悬停位移 `translateX(3px)`。

---

## 二、按钮规格与层级字典 (Hierarchy & Specs)

| 按钮类型 (Variant) | 应用场景 (Usage) | 高度 (Height) | 内边距 (Padding) | 圆角 (Radius) | 字体与字重 (Font & Weight) | 边框与背景 (Border & Surface) |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Hero Scene Ghost (三大场景)** | 首屏入口 (线上商家 / 实体商家 / 个人创作) | `44px` | `0 22px` | `2px` | 自有字体族 / **`font-weight: 200`** | 边框 `0.18`，底透 `0.02`，带 9px 微三角标 |
| **Nav Action Ghost** | 顶栏行动入口 (登录 / Log in) | `36px` | `0 18px` | `2px` | 自有字体族 / **`font-weight: 200`** | 边框 `0.22`，底透 `0.03`，字号 `14px`，上下与 Logo 等高 |
| **Language Switcher** | 顶栏双态语言切换器 (中 / EN) | `36px` | `0 12px` | `2px` | 自有字体族 / **`font-weight: 200`** | 边框 `0.16`，底透 `0.02`，支持活跃高亮与平滑切换 |
| **Engine Action Ghost** | 即时体验舱 / 抽屉渲染推演 | `44px` | `12px 24px` | `2px` | 自有字体族 / **`font-weight: 200`** | 边框 `0.22`，底透 `0.04`，高光辉光增强 |
| **Utility Square Close** | 工作台与弹窗关闭按钮 | `36px` | `0` (正方) | `2px` | 自有字体族 / **`font-weight: 200`** | 边框 `0.20`，深黑半透背景 |

---

## 三、标准 CSS 样式代码表 (CSS Specifications)

```css
/* ==========================================================================
   1. 首屏三大场景入口按钮 (Hero Scene Ghost)
   ========================================================================== */
.btn-ghost {
  height: 44px;
  padding: 0 22px;
  background: rgba(255, 255, 255, 0.02);
  color: #fafafa;
  font-family: 'Manrope', 'Noto Sans SC', -apple-system, BlinkMacSystemFont, 'Segoe UI Variable Display', 'Segoe UI Light', 'PingFang SC', 'Microsoft YaHei Light', sans-serif;
  font-size: 14px;
  font-weight: 200;
  letter-spacing: 0.08em;
  border: 1px solid rgba(255, 255, 255, 0.18);
  border-radius: 2px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 10px;
  transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
}
.btn-ghost svg {
  width: 9px;
  height: 9px;
  fill: #fafafa;
  transition: transform 0.25s ease;
  display: block;
}
.btn-ghost:hover {
  border-color: rgba(255, 255, 255, 0.7);
  background: rgba(255, 255, 255, 0.06);
  box-shadow: 0 0 20px rgba(255, 255, 255, 0.08);
  color: #ffffff;
  transform: translateY(-1px);
}
.btn-ghost:hover svg {
  transform: translateX(3px);
}

/* ==========================================================================
   2. 顶部导航栏行动入口按钮 (Nav Action Ghost)
   ========================================================================== */
.pill-nav {
  height: 36px;
  padding: 0 18px;
  background: rgba(255, 255, 255, 0.03);
  color: #fafafa;
  border-radius: 2px;
  border: 1px solid rgba(255, 255, 255, 0.22);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  font-family: 'Manrope', 'Noto Sans SC', -apple-system, BlinkMacSystemFont, 'Segoe UI Variable Display', 'Segoe UI Light', 'PingFang SC', 'Microsoft YaHei Light', sans-serif;
  font-size: 14px;
  font-weight: 200;
  letter-spacing: 0.08em;
  cursor: pointer;
  transition: all 0.25s cubic-bezier(0.16, 1, 0.3, 1);
}
.pill-nav:hover {
  background: rgba(255, 255, 255, 0.08);
  border-color: rgba(255, 255, 255, 0.75);
  box-shadow: 0 0 18px rgba(255, 255, 255, 0.1);
  transform: translateY(calc(-50% - 1px));
  color: #ffffff;
}

/* ==========================================================================
   3. 工业级推演 / 渲染主操作按钮 (Engine Action Ghost)
   ========================================================================== */
.pod-btn-fire {
  background: rgba(255, 255, 255, 0.04);
  color: #fafafa;
  font-family: "PP Neue Montreal", "Inter", sans-serif;
  font-weight: 450;
  font-size: 14px;
  letter-spacing: 0.06em;
  padding: 12px 24px;
  border-radius: 2px;
  border: 1px solid rgba(255, 255, 255, 0.22);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  transition: all 0.25s cubic-bezier(0.16, 1, 0.3, 1);
}
.pod-btn-fire:hover {
  background: rgba(255, 255, 255, 0.1);
  border-color: rgba(255, 255, 255, 0.8);
  box-shadow: 0 0 24px rgba(255, 255, 255, 0.14);
  transform: translateY(-1px);
  color: #ffffff;
}

/* ==========================================================================
   4. 参数标签芯片按钮 (Data Chip Button)
   ========================================================================== */
.pod-chip {
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 2px;
  padding: 6px 12px;
  font-family: 'JetBrains Mono', monospace;
  font-size: 12px;
  color: #c4c4cc;
  cursor: pointer;
  transition: all 0.2s ease;
}
.pod-chip:hover {
  background: rgba(255, 255, 255, 0.08);
  border-color: rgba(255, 255, 255, 0.45);
  color: #ffffff;
}

/* ==========================================================================
   5. 极简微倒角关闭按钮 (Utility Square Close)
   ========================================================================== */
.modal-close-btn,
.btn-close-drawer {
  background: rgba(10, 10, 14, 0.85);
  border: 1px solid rgba(255, 255, 255, 0.18);
  color: #fafafa;
  border-radius: 2px;
  cursor: pointer;
  transition: all 0.2s ease;
}
.modal-close-btn:hover,
.btn-close-drawer:hover {
  background: rgba(255, 255, 255, 0.1);
  border-color: rgba(255, 255, 255, 0.7);
  color: #ffffff;
}
```

---

---

## 四、全站与按钮严禁 Emoji 铁律规范 (Zero-Emoji Strict Policy)

### 1. 核心禁令 (Zero-Tolerance)
* **按钮零 Emoji**：所有按钮文本、前缀、后缀中**绝对严禁添加任何 Emoji 图标**（如闪电、火焰、火箭、灯泡、场记牌、星光等图形字符）。
* **全站零 Emoji**：全站所有导航栏、大标题、副标题、标签（Eyebrow）、卡片、参数单元、提示语及系统状态栏中，**一律禁止使用任何操作系统 Emoji 绘文字**。

### 2. 规范 rationale（设计心智）
* **东方极简与 70mm 电影工业感**：简兮 JANSEE 坚持纯黑、冷灰、纯白的三阶克制体系。操作系统原生的彩色 Emoji 会破坏界面的纯粹高级感与严谨的专业工具属性。
* **跨平台视觉一致性**：不同操作系统（Windows, macOS, iOS, Android）对 Emoji 渲染风格、尺寸、基线完全不同，极易导致按钮文字抖动或排版失衡。

### 3. 标准替代指引 (Approved Alternatives)
| 需求场景 | 严禁做法 (FORBIDDEN) | 正确规范做法 (APPROVED) |
| :--- | :--- | :--- |
| **行动按钮方向引导** | `[表情符号] 立即生成`、`[表情符号] 开始制作` | 纯净文字 + 9px 微型矢量 SVG 箭头：`<svg viewBox="0 0 100 100"><polygon points="20,10 90,50 20,90"/></svg>` |
| **系统/录制状态指示** | `[表情符号] 就绪`、`[红点表情] 正在录制` | 纯 CSS 几何微光呼吸点（如 `.rec-dot`，6~7px 纯白，CSS 控制透明度脉冲） |
| **标签与分类引导** | `[符号] 智能工场`、`[表情] 热门推荐` | 纯文字 + 2px 倒角微框胶囊，或等宽英文字标（如 `[PRESET]`） |
| **信息层级分隔** | 复杂装饰符、杂色线条 | 统一使用半角间隔点 `·` 或细线斜杠 `/`，颜色收敛至 `var(--dim)` |

---

## 五、落地实施清单

- [x] 首屏主 CTA 按钮重构（已落地：`.btn-ghost` 微光幽灵框 + 9px 微三角标）
- [x] 顶部导航栏 Action 按钮重构（已由大白药丸转为 2px 倒角微光幽灵线框）
- [x] 即时体验舱推演按钮 `.pod-btn-fire` 重构（由纯白实体钮转为工业幽灵微光高反差框）
- [x] 参数预设标签 `.pod-chip` 重构（收敛为 2px 倒角发丝框）
- [x] 抽屉工作台与弹窗关闭按钮重构（转为 2px 倒角硬朗机能风）
- [x] **全站与全部按钮零 Emoji 彻底肃清**（已清除全部非矢量图形字符，全面转为纯文本与 SVG 规范）
- [x] **第二屏工作台按钮全系镂空重构**（生成大按钮、下载按钮、切换胶囊全部剥离实心白底，升级为幽灵微光边框）

---

## 六、全站按钮全系镂空幽灵边框铁律 (All-Ghost Wireframe Mandatory Policy)

> **用户核心指示**：“按钮全部用镂空的那种，像登录按钮、线上商家、线下商家、个人创作 一样的按钮”。

### 1. 核心约束 (Mandatory Rules)
1. **彻底绝迹实心白块 (No Solid White Fill)**：
   * 全站**严禁**使用任何实心白底（`background: #ffffff; color: #000;`）填充按钮；
   * 实心白块会破坏 70mm 电影级暗场纵深，产生割裂的消费级 SaaS 塑料感。
2. **全系标准统一**：
   * 所有按钮（包括顶栏【登录】、首屏【线上商家/实体商家/个人创作】、第二屏【图片成片】专版、步骤 3【立即生成带货短视频】大按钮、监视器【下载成片】及底栏【立即出片】）一律统一对齐 **Jianxi Ghost Border System**。
3. **视觉标准公式**：
   * **底板**：`background: rgba(255, 255, 255, 0.025 ~ 0.03)`（通透深黑曜石微光）
   * **边框**：`border: 1px solid rgba(255, 255, 255, 0.18 ~ 0.22)`，`border-radius: 2px`
   * **字体字重**：`color: #fafafa`，严格保持 **`font-weight: 200`** 纤细体，`letter-spacing: 0.08em`
   * **矢量向导标**：9×9 统一微三角 `<svg viewBox="0 0 100 100"><polygon points="20,10 90,50 20,90"/></svg>`
   * **悬停动效**：`background: rgba(255, 255, 255, 0.08)`，`border-color: rgba(255, 255, 255, 0.75 ~ 0.8)`，`box-shadow: 0 0 20px rgba(255, 255, 255, 0.1)` 漫反射冷白辉光，向导标位移 `transform: translateX(3px)`。

---

## 七、商品成片实拍图最多 9 张硬锁定交互铁律 (Product Image Max-9 Policy)

> **用户核心指示**：“上传图片锁定最多9张。多了不让传。”

### 1. 硬性拦截链路 (Hardware Interception Chain)
1. **统一受控触发入口 (`triggerProductUpload`)**：
   * 大虚线上传框 `#product-dropzone` 与缩略图托盘 `+ 添加` 按钮统一绑定 `triggerProductUpload()`；
   * 当前图片数已达 9 张时，**严禁触发系统文件选择弹窗**，立即弹出黑曜石微光气泡提示：“最多仅支持上传 9 张商品图片，请先删除不需要的图片”。
2. **多选文件自动精准截断 (`addUploadedFiles`)**：
   * 计算剩余可用配额：`availableSlots = 9 - uploadedImages.length`；
   * 若用户单次多选超出可用名额，仅精确截取前 `availableSlots` 张图片载入，多出图片自动丢弃，并弹出微光提示：“最多仅支持 9 张图片，已添加前 X 张，超出的 Y 张已自动忽略”；
   * 处理完毕后清空 `input.value = ''`，确保同名图片与删除后重选能正常触发 `change` 事件。
3. **拖拽上传硬性阻断 (`handleFileDrop`)**：
   * 拖拽放下时首选校验上限，达到 9 张直接阻断并提示，杜绝拖拽绕过。
4. **9/9 满额状态多维联动**：
   * **添加按钮**：当数量达到 9 张时，托盘内按钮自动转为 `disabled` 置灰状态，文案显示为 `9/9 已满`；
   * **托盘状态标签**：未满时显示 `已载入 X/9 张图片 · AI 已锁定核心外观`，满额时显示 `已载入 9/9 张 (已达上限) · AI 已锁定核心外观`；
   * **步骤 1 徽标**：未满时显示 `支持 1~9 张 · 已载入 X/9 张`，满额时动态高亮微光显示 `已达上限 9/9 张 · 核心外观已锁定`；
   * **大虚线框提示**：满额时文案动态提示 `已达到 9 张上限 · 点击图片右上角 × 可删除换图`。
5. **删除即时恢复配额 (`removeThumb`)**：
   * 用户点击图片右上角 `×` 删除时，实时释放槽位，添加按钮自动恢复可点击状态，徽标和提示同步重置。

