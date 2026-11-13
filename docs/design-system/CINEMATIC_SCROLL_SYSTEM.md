# 「简兮 (JANSEE)」全时域电影级屏间焦点拉拔系统规范 (Cinematic Rack Focus Transition System)

> **版本**：v1.0 Official Final  
> **设计心智**：东方极简哲学 × 70mm 电影镜头焦点拉拔 (Rack Focus) × 黑曜石黑白灰冷冽工业美学  
> **核心铁律**：**“上一屏失焦隐退，下一屏先模糊后清晰、随下滑越来越清楚；以后全站每一屏的衔接都无条件遵循此规则。”**

---

## 一、设计哲学与镜头隐喻 (Cinematic Philosophy)

在专业 70mm 商业电影摄影机中，场景切换绝不采用廉价生硬的生切或普通滚动，而是通过摄影大工的**“跟焦拉拔 (Rack Focus / Focus Pull)”**实现注意力流转：
1. **前景失焦离场 (Defocus Out)**：当观众的注意力需要离开当前视点时，当前主体逐渐脱离焦点平面，画面产生柔和的漫反射光斑模糊并优雅消隐。
2. **后景锐化合焦 (Sharp Focus In)**：下一幕主体在进入视线初期处于深景深虚化状态，随着镜头向其推近，画面由虚入实、逐渐显影凝结，最终在黄金视野中央精准锁焦（Sharp Focus），呈现极度纯净锐利的质感。

---

## 二、屏间流转双向铁律 (The Two-Way Focus Pull Law)

全站自首屏（第一幕）起，后续所有内容屏幕（工作台第二幕、功能解析第三幕、案例矩阵第四幕等）之间的滚动衔接，必须严格执行以下三阶段物理状态机：

```
[ 用户在当前屏 ]  ──────( 向下滑动 )──────►  [ 屏间交接区 (焦点拉拔中) ]  ──────( 滑动就位 )──────►  [ 下一屏精准合焦 ]
 当前屏: 0px 清晰                           当前屏: 0px -> 22px 散焦消散 (opacity 1 -> 0)           当前屏: 彻底消失 (pointer-events: none)
 下一屏: 处于视口下方 (散焦待命)              下一屏: 22px -> 0px 锐化显影 (越来越清楚)               下一屏: 0px 绝对锐化，100% 可交互
```

### 1. 退场屏行为规范 (Exit Screen Defocus)
* **散焦模糊曲线**：随着页面向下滚动，当前屏在视口前 65% 位移区间内，`filter: blur()` 由 `0px` 连续衰减至 **`22px ~ 24px`**。
* **显影透明度**：`opacity` 从 `1.0` 线性递减至 **`0.0`**（在离开视口前提前纯净归零）。
* **视差推移**：伴随轻微负向视差（`-0.26` 速率上浮）与微缩放（`scale: 0.96`），呈现电影镜头焦点推远散焦的舒缓退场感。
* **交互熔断**：当 `opacity < 0.15` 时，强制开启 `pointer-events: none`，严禁遮挡下一屏操作。

### 2. 进场屏行为规范 (Enter Screen Sharp Focus - **用户核心指定**)
* **初始散焦态**：当下一屏刚自视口底部露头时，处于**最大散焦虚化状态**（`blur: 22px`，低底透 `opacity: 0.15`，景深下潜 `translateY(36px)`，`scale: 0.975`）。
* **流转锐化过程**：**“先模糊再清楚，随着下滑越来越清楚”**。随着用户继续向下滑动，第二屏向上进入视口，模糊度自 `22px` 线性收敛至 **`0px`**，不透明度自 `0.15` 平滑饱满至 **`1.0`**，微位移归零，尺寸合焦至原大。
* **合焦驻留态**：当进入视口黄金聚焦区后，**动态滤镜全部解开并清空为 `none`**，确保字体回归 100% 绝对原生亚像素锐度（Subpixel / ClearType），无任何性能残留开销。

### 3. 双向对称回滚 (Bi-Directional Reversibility)
* 当用户向上回滚时，整个过程完全镜像可逆：下方屏幕重新散焦虚化退回视口下方，上方屏幕由虚入实重新合焦凝结。

---

## 三、标准技术规范与数学模型 (Technical Specs)

### 1. 硬件加速声明 (CSS Engine)
所有符合全屏流转规则的 Section 容器必须声明 GPU 独立合成层：
```css
/* 所有全屏 Section 或主内容容器通用类 */
.matrix-section,
.cinematic-screen {
  will-change: transform, opacity, filter;
  transform-origin: center top;
}
```

### 2. 景深计算数学模型 (JavaScript Engine)
由 `window.requestAnimationFrame` 高频驱动，利用视口相对坐标计算通用进场合焦进度：

$$\text{enterProgress} = \text{clamp}\left(0, \frac{V_h - \text{rect.top}}{V_h \times 0.75}, 1\right)$$

- $\text{rect.top}$ 为目标屏距离当前视口顶部的像素距离。
- $V_h$ 为当前视口高度。
- 模糊度计算公式：$\text{Blur} = (1 - \text{enterProgress}) \times 22 \text{ px}$
- 不透明度计算公式：$\text{Opacity} = 0.15 + \text{enterProgress} \times 0.85$
- 景深位移计算公式：$\text{TranslateY} = (1 - \text{enterProgress}) \times 36 \text{ px}$
- 尺度收敛公式：$\text{Scale} = 0.975 + \text{enterProgress} \times 0.025$

---

## 四、全站后续各屏扩展接入指南 (Future Implementation Guide)

未来在简兮 JANSEE 系统中添加第三屏、第四屏或新业务抽屉时，**无须重复编写滚动逻辑**，仅需遵循两步标准即可自动享受电影级焦点拉拔流转：

### 步骤 1：HTML 结构标记
为新建的屏幕添加 `.cinematic-screen` 标识类名：
```html
<!-- 新建的第三屏示例 -->
<section class="cinematic-screen" id="section-analytics">
  <div class="screen-container">
    <!-- 内容要素 -->
  </div>
</section>
```

### 步骤 2：自动接入合焦管线
系统底部的通用查询选择器已自动监听 `.matrix-section, .cinematic-screen`，无需任何额外配置，自动获得：
1. 刚滑入视口底部时：22px 散焦模糊；
2. 随着继续下滑：平滑锐化，越来越清楚；
3. 滑至视口正中：0px 完全合焦，恢复原生文本锐利度。

---

## 五、设计系统落地清单

- [x] 首屏下滑失焦散退与消失系统（已生效：`#hero-content` 随下滑模糊至 22px 并完全消隐）
- [x] 全局背景视频暗场下沉与模糊（已生效：`#ambient-video` 随下滑自 0px 散焦至 24px，背板沉降至 80% 黑场）
- [x] 第二屏电影级焦点拉拔系统（已生效：`#matrix-workbench` 进场自 22px 随下滑逐渐清晰合焦）
- [x] 全局通用类 `.cinematic-screen` 动态合焦适配机制已植入主脚本
- [x] 本规范文档 `CINEMATIC_SCROLL_SYSTEM.md` 已正式归档至工程根目录
