# 交给生视频 AI 的提示词（方式三 · 背景素材）

配套首帧参考图：`screen-template-first-frame.png`（1080 × 1920，屏 = 820 × 900 @(130, 414)，零文字）。

---

## 怎么用（三步，顺序不能换）

1. **先传图。** 把 `screen-template-first-frame.png` 作为首帧图 / 参考图上传。平台若同时支持「首帧」和「参考图」，选**首帧**。
2. **再贴提示词。** 整段复制下面的中文版（或英文版）粘进去，不要删改，也不要自己加尺寸数字。
3. **生成后先验收。** 拿到文件立刻跑 `npm run check:material -- <视频路径>`，退出码 0 才算能用。

> 如果平台只支持纯文生视频、传不了图——这套办法不成立，换平台。前四版素材全废，根因就是让模型「按文字描述画一块屏」。

---

## 中文提示词（可灵 / 即梦 / 豆包 / 通义 等）

```
以下构图以所附首帧图为准。请照抄它的构图：画面的长宽比、屏在画面里的位置、屏的大小、屏的长宽比、屏占画面的比例，全部与首帧图完全一致。你只负责把首帧图里那面灰色的墙，替换成一个真实可信的场景。

场景：一个真实的城市商业街转角，店铺立面朝向镜头。傍晚，天刚暗下来但还没全黑。立面由水泥和深色石材拼成，有使用痕迹、有质感、不是全新的。画面上方露出建筑上层和一小段天空，下方是铺装地面。空气里有一点雨后的湿气和薄雾。

镜头：一个镜头到底，机位完全固定。不推进、不拉远、不摇镜、不横移、不俯仰。整段素材里屏的位置一帧都不能变。

屏：它是一块真实安装在外墙上的大型广告屏，不是贴在画面上的图层，也不是后期合成的。必须能看出：边框有真实厚度和转折，屏体略微凸出墙面，屏在身后墙面上有方向一致的落影，屏的光把周围墙面和地面微微染亮，前景有树影或线缆从屏前掠过，只压到屏的边缘和四角，不遮挡屏的中间区域。

屏内的画面：非常暗，整体亮度很低。只有缓慢漂移的暗色色块和模糊渐变，看不清任何具体的东西。不允许出现街道、楼体、人物剪影、灯光光斑、高光热点。

绝对禁止：画面里不许出现任何文字、字母、数字、符号、标点、水印、标志、招牌、路牌、店名、域名、二维码。屏上、边框上、墙上、玻璃上、地面上、天空里，一律不许有。一个字母都不许有。

声音：不需要声音。
```

## 英文提示词（Runway / Veo / Sora / Pika 等）

```
Composition is defined by the attached first frame. Copy it exactly: the frame's aspect ratio, and the panel's position, size, proportions and screen-to-frame ratio must match the first frame precisely. Your only job is to replace the flat grey wall in that frame with a believable real-world scene.

Scene: a real corner of a city commercial street at dusk, storefront facade facing the camera. The facade is a mix of concrete and dark stone, weathered and used, not brand new. Above the panel you see the upper floors and a sliver of sky; below it, paved ground. Slight post-rain humidity and thin haze in the air.

Camera: one continuous take, camera completely locked off. No push in, no pull out, no pan, no tilt, no truck. The panel must not move a single pixel for the entire clip.

The panel: a large advertising screen genuinely mounted on the exterior wall, not a flat sticker and not a composited layer. It must read as a physical object: a bezel with real thickness and a visible edge turn, the panel body slightly protruding from the wall, a consistent cast shadow on the wall behind it, its light softly spilling onto the nearby wall and ground, and foreground elements such as tree shadows or cables sweeping across only the edges and corners of the panel, never across its centre.

Panel content: very dark, low overall brightness. Only slow-drifting dark colour fields and soft gradients, nothing recognisable. No streets, no buildings, no people, no light blooms, no hot spots.

Absolutely no text: no letters, numbers, symbols, punctuation, watermarks, logos, signage, street signs, store names, domains or QR codes anywhere, on the panel, on the bezel, on the wall, on glass, on the ground or in the sky. Not a single letter.

No audio.
```

## 负面提示词（平台支持就填，不支持就跳过）

```
文字, 字母, 数字, 标点, 水印, logo, 招牌, 路牌, 店名, 域名, 二维码,
剪辑, 切镜, 转场, 叠化, 闪白, 场景变化,
推镜, 拉镜, 摇镜, 移镜, 变焦, 手持晃动,
分屏, 画中画, 镜像, 边框装饰,
卡通, 插画, 3D 渲染感, 塑料质感, 过度锐化, 高饱和
```

## 参数

| 项 | 值 |
|---|---|
| 比例 | 9:16 |
| 分辨率 | 1080 × 1920 |
| 时长 | 10 秒 |
| 帧率 | 30 fps（平台只给 24 fps 也可以） |
| 音轨 | 不要 |

---

## 为什么这么写（三条，别自作聪明改动）

**1. 一个数字都没有。**
之前两次翻车，都是提示词里写了「40px」「14px」这类带单位的数字，模型把尺寸**当标注画进了画面**——墙上出现一条 40px 的尺寸线，屏框上出现了「14px」字样。所以这一版里没有任何尺寸、坐标、百分比。几何全部由首帧图承担，文字只负责说「照抄」。

**2. 一个品牌名都没有。**
提到 JANSEE 它就会把字母刻进画面（上一版把 JANSEE.CN 烧了四处）。屏框下方那块金属铭牌，**后期合成时贴**，不让模型画。

**3. 禁令写在最后、写成清单。**
模型对末尾的约束最敏感。而且「不许有文字」这一条要具体到「屏上、边框上、墙上、玻璃上、地面上、天空里」，只写一句「不要有文字」它一定会漏。

---

## 拿到素材后的验收

```bash
npm run check:material -- <视频路径>
```

会自动查：分辨率、帧率、音轨、剪辑点、面板亮度，并把 820 × 900 的槽位框叠到抽帧上。重点是四件事：

- 屏显示区与青虚线框重合（宽高误差不超过 2%，即 820×900 上下浮动 16px 内）
- 全片一个镜头，没有切点
- 屏的位置一帧没动
- 画面里一个字都没有

退回重出时，**不要改提示词去描述屏多大**——那只会让它把数字画进画面。要么重抽，要么换平台。
