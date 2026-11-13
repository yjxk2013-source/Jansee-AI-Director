# 简兮多模态素材资产中心 (Materials Vault)

> **定位**：官方高品质视听商业资产中心，为大模型自动挑镜头、智能匹配 BGM、商品风格贴合与合成引擎提供素材供给。

---

## 资产目录规约与结构映射

* **`materials/video/`**：
  - **电影级运镜空镜头库**：共收录 **112 个商业与生活实拍场景**，878 段真实高清 MP4 实拍运镜短片；
  - 覆盖烘焙（bakery）、咖啡（cafe/coffee）、火锅（hot_pot）、数码科技（tech/laptop）、城市街景（cityscape/commute）、自然日落（sunset/golden_hour）等全行业类目；
  - 元数据索引：`materials/metadata/_global_index.json`。

* **`materials/audio/`**：
  - **商业授权情绪 BGM 曲库**：共收录 **31 种情绪曲风**，526 首正版背景音乐（MP3 / 无损 WAV 母带）；
  - 覆盖高奢（luxury）、激昂（passionate）、欢快（cheerful）、温暖（warm）、治愈（healing）、科技未来（tech_future）等情绪；
  - 倒排元数据：`materials/metadata/manifest.json`。

* **`materials/images/`**：
  - **`images/premium/` 单反级精选大图库**：包含 135 个场景精选、321 张超清实拍摄影大图（单张约 9MB，专用于图文分镜与推拉运镜）；
  - **`images/standard/` 全场景商用实拍图库**：包含 238 个细分场景、2587 张商品展示与环境打光实拍图。

* **`materials/fonts/`**：
  - **正版商用精选字库**：共收录 **8 大设计风格场景**，56 款超高品质、免费且可商用的中英文精选字体（共 313 个字重文件，77MB）；
  - 覆盖国风书法、中文趣味招牌、顶级高奢衬线、极简现代无衬线、电影紧凑海报、手写艺术签名、赛博机甲科技与潮玩拟声；
  - 全量遵循 SIL Open Font License (OFL 1.1) 或 Apache 2.0 开源商业许可，企业与个人商用终身零版权风险；
  - 索引与说明：`materials/fonts/index.json`、`materials/fonts/README.md`。

* **`materials/metadata/`**：
  - 倒排索引与标签库：`_global_index.json`、`image_tags.json`、`manifest.json`、`available_tags.json`。

---

## 架构演进与兼容性保障

1. **职责分离**：根据大厂 Monorepo 规约，`materials/` 独立承担多模态素材库管理职责，`apps/engine` 保持纯无状态计算引擎定位；
2. **底层映射**：在文件系统层，`materials/` 与 `apps/engine/assets` 保持无损透明联结，支持通过环境变量 `JX_MATERIALS_ROOT` 或 `JX_ASSETS_ROOT` 重定向至独立数据盘或对象存储挂载点。
