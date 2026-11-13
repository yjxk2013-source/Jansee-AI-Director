# 简兮 (JANSEE) · 视频配音模块 API 契约 (Video Dub API Contract)

> ## ⛔ 已废止（2026-10-24）
>
> 本文描述的 `POST /api/v1/video/produce` 端点已随模块化升级**永久下线（返回 410）**。
> 视频配音现行入口为统一创作任务中心：
>
> * 创建：`POST /api/v1/creation/create`，`type=video_dub` + `materialIds`（素材来自 `POST /api/v1/upload/video` 登记）；
> * 查询：`GET /api/v1/creation/task/:taskId`（响应结构见 `apps/web/server/creation.mjs` 任务态）；
> * 合成模块：`@jansee/video-dub` 的 `produceVideoDub()`（编排层在 `apps/web/server/creation.mjs` 分支二）。
>
> 本文保留作历史基线（上传契约 §2 与产物访问 §5 仍然有效）；端点级行为以
> `docs/architecture/video_dub/MODULE_BOUNDARY.md` 顶部「架构升级公告」与回归测试
> （test-stage-b / test-stage-d，均已重写为 creation/create 契约）为准。

> **契约版本**：video-dub-api v1.0.0（冻结基线）
> **冻结日期**：2026-10-13
> **事实来源**：本文档全部内容逐条对照生产代码核实（apps/web/server/index.mjs / director.mjs），与 [API_SPECIFICATION.md](../api/API_SPECIFICATION.md) v3.0 的图片成片域并存，不修改其内容。
> **阶段定位**：阶段 D（模块封装、API 契约与冻结）交付物。本文档描述现状行为，不以理想化设计改写现状；现有实现暂不满足的行为统一记录于 §6 差距清单。

---

## 一、通用约定

### 1.1 统一响应信封

所有 JSON 接口均遵循统一信封：

```json
{
  "code": 0,
  "msg": "操作成功",
  "data": {},
  "timestamp": 1791905958000
}
```

* `code = 0`：业务成功；
* `code > 0`：业务错误码（见 §5）；
* HTTP 状态码与 code 独立：400/413/404/500 按错误类别返回。

### 1.2 鉴权现状

当前网关为单机 guest 模式（`usr_jianxi_guest`），**所有端点无鉴权、无用户归属校验**，CORS 全开放（`Access-Control-Allow-Origin: *`）。此为 v1.0.0 冻结现状，接入多用户体系时须升级契约主版本（见冻结文档升级规则）。

### 1.3 支持的 HTTP 方法

仅 `GET`、`POST`、`OPTIONS`（CORS 预检）。不支持 `HEAD`/`PUT`/`DELETE`。

---

## 二、视频素材上传

### 2.1 请求

* **路径**：`POST /api/v1/upload/video`
* **Content-Type**：无强制要求（原始二进制直传，`req.pipe(ws)` 流式落盘，不占网关内存）
* **请求头**：
  * `x-file-name`：URL 编码后的原始文件名（服务端仅取扩展名判定格式，`encodeURIComponent(file.name)` 传入）
  * `Content-Length`：必须存在且 `> 0`
* **请求体**：视频文件原始字节流

### 2.2 限制

| 项 | 值 | 拒绝行为 |
| :--- | :--- | :--- |
| 文件格式 | 仅 `.mp4` / `.mov`（按扩展名判定，大小写不敏感） | 400 / code 40004 |
| 文件大小 | ≤ 200MB（Content-Length 预检 + 流式累计双检） | 413 / code 40006，断开连接并清理 |
| 真实时长 | 落盘后服务端探测，必须 `> 0` 且可解析 | 400 / code 40007，清理上传目录 |

### 2.3 成功响应

```json
{
  "code": 0,
  "msg": "上传成功",
  "data": {
    "videoPath": "f:\\janseeV2\\storage\\uploads\\upload_1791905958000\\video.mp4",
    "uploadDir": "f:\\janseeV2\\storage\\uploads\\upload_1791905958000",
    "durationSec": 27.53
  }
}
```

* `videoPath`：服务端绝对路径，后续创建任务时原样回传引用；
* `durationSec`：服务端实测真实媒体时长（秒），来自 `@jansee/video-creator` 的 `videoDurationSec` 探测，绝无伪造值。

### 2.4 错误路径

| 触发条件 | HTTP | code | msg |
| :--- | :--- | :--- | :--- |
| 扩展名非 .mp4/.mov | 400 | 40004 | 视频格式不合法，仅支持 MP4 / MOV |
| 缺少 Content-Length 或 ≤ 0 | 400 | 40005 | 请求缺少视频文件内容 |
| Content-Length 或累计字节 > 200MB | 413 | 40006 | 视频文件超出 200MB 大小上限 |
| 上传目录创建失败 | 500 | 50003 | 上传目录创建失败，请检查 storage 目录权限 |
| 请求流中断 | 500 | 50004 | 视频接收中断，请重试 |
| 磁盘写失败 | 500 | 50005 | 视频落盘失败，请检查磁盘空间 |
| 文件损坏 / 容器无法解析 / 时长为零 | 400 | 40007 | 无法解析视频真实时长：文件可能已损坏或编码格式不受支持 |

**失败即清理铁律**：40006/40007/50004/50005 路径均删除本次 `uploadDir` 整个目录，磁盘上不留无效文件，不返回伪造成功。

### 2.5 文件归属与生命周期

* 落盘位置：`storage/uploads/upload_{毫秒时间戳}/video.{ext}`，目录名取 `Date.now()`，无用户维度隔离（单机 guest 现状）；
* 生命周期：上传成功后**永久保留**，无自动清理任务；仅上传失败路径即时清理；
* `.gitignore` 已保护 `storage/`，不入版本库。

---

## 三、创建视频配音任务

### 3.1 请求

* **路径**：`POST /api/v1/video/produce`（别名 `/api/v1/video/produce/product` 完全等价）
* **Content-Type**：`application/json`
* **分支判定**：`videoPath` 非空即走视频配音分支；为空走图片成片分支（两分支共用同一端点）。

### 3.2 请求体字段（视频配音分支）

| 字段 | 类型 | 必填 | 说明 |
| :--- | :--- | :--- | :--- |
| `scene` | string | 否 | `sell`（默认）/ `local` / `personal` |
| `mode` | string | 否 | 前端传 `dub`；服务端仅透传给 mocker 兜底 |
| `title` | string | 否 | 标题，缺省「精选商品」 |
| `description` | string | 否 | 用户描述/文案（别名 `sellingPoints`），驱动 LLM 旁白创作 |
| `videoPath` | **是（触发视频分支的唯一开关）** | string | §2.3 返回的 `videoPath` 原样回传 |
| `uploadDir` | string | 否 | §2.3 返回的 `uploadDir`（服务端当前未消费，透传字段） |
| `durationSec` | number | 否 | 前端参考值；**服务端以实测为准**（produce 时重新探测，防伪造/防文件变动） |
| `voice` | string | 否 | 仅接受 `male` / `female`（硬约束，LLM 不得改判）；其余任意值视为未指定，由 LLM 按内容基调判定 |
| `imageCount` | number | 否 | 视频分支不消费；`> 9` 时同步拒绝 400/40001 |

### 3.3 服务端真实时长校验

视频分支第一个执行步骤即为服务端权威时长复测（`videoDurationSec(videoFile)`）：探测失败或非正值 → 任务转 `failed`，错误信息「视频真实时长探测失败，文件可能已损坏，请重新上传」。源视频时长作为客观事实传入导演层，LLM 不得自行推测。

### 3.4 同步响应（立即返回）

```json
{
  "code": 0,
  "msg": "出片任务已创建并调度",
  "data": {
    "taskId": "task_1791905958000_x7k2m",
    "status": "processing",
    "remainingCredits": 2650
  }
}
```

* `taskId` 格式：`task_{毫秒时间戳}_{5位随机串}`，全局唯一；
* `remainingCredits`：mock 积分余额（每次任务固定扣 200；**余额不足不拦截请求**，现状行为）。

### 3.5 参数校验、权限与重复请求行为（现状）

| 场景 | 实际行为 |
| :--- | :--- |
| `videoPath` 指向不存在/非文件/目录穿越路径 | 任务**创建成功**（同步响应 200 + taskId），异步阶段校验（必须位于 `storage/uploads` 内且存在且为文件）不通过 → 转 `failed`，error「视频素材无效或不在允许的上传目录内，请重新上传」 |
| 目录穿越（如 `videoPath` 指向 `apps/` 下任意文件） | 同上，路径规范化后不在 `storage/uploads` 内即拒绝 |
| 无鉴权/未授权访问 | 现状无鉴权体系，任何调用方均可创建任务（见 §6 差距 G1） |
| 重复请求 | 每次调用均创建**新任务**并各扣 200 积分，无幂等去重（见 §6 差距 G7） |
| `imageCount > 9` | 同步拒绝 400 / code 40001（图片域规则在共享端点前置） |

### 3.6 异步流水线（阶段序）

`queued(5%) → analyzing(15%, LLM 导演规划旁白，失败回落 mocker 兜底) → BGM 选曲 → rendering(TTS/音画对齐/混流/字幕烧录，进度由合成层回报) → done(100%)`。

* 原音轨排除：混流显式 `-map '[v]' -map '1:a'`，源视频音轨绝不进入成片；
* 时长对齐：画面时长恒等于源视频真实时长，配音超长末尾 0.5s 淡出截断，不足以 BGM/静音补满；
* 产物校验：成片必须存在、非空、时长可解析，否则任务转 `failed`，绝不把损坏文件标为成功。

---

## 四、查询任务状态

### 4.1 请求

* **路径**：`GET /api/v1/video/task/:taskId`

### 4.2 任务状态枚举（全部实际状态）

| status | 含义 | 转出 |
| :--- | :--- | :--- |
| `processing` | 处理中（stage: `queued` → `analyzing` → `rendering` → `done`） | `completed` 或 `failed` |
| `completed` | 成片交付完成 | 终态 |
| `failed` | 失败（附 `error`） | 终态 |

### 4.3 处理中响应结构

```json
{
  "code": 0,
  "msg": "查询成功",
  "data": {
    "taskId": "task_1791905958000_x7k2m",
    "status": "processing",
    "stage": "rendering",
    "stageText": "第 2 步：正在合成配音与背景乐...",
    "progress": 65,
    "scene": "sell",
    "mode": "dub",
    "title": "专业声学配音",
    "createdAt": 1791905958000,
    "updatedAt": 1791905968000
  }
}
```

* `progress`：0~100 整数；
* `stageText`：中文进度文案（面向用户展示）。

### 4.4 成功响应结构（completed）

在处理中字段基础上追加：

| 字段 | 类型 | 说明 |
| :--- | :--- | :--- |
| `status` | string | `completed` |
| `stage` / `stageText` / `progress` | — | `done` / 交付文案 / `100` |
| `videoUrl` | string | `/storage/outputs/{taskId}/final.mp4`（相对根路径 URL） |
| `subtitleUrl` | string | 空串（视频链路字幕已烧录进画面，无独立字幕文件交付） |
| `audioUrl` | string | 空串（无独立音轨交付） |
| `variantType` | string | 变体类型（personal 场景恒空串） |
| `isRealRendered` | boolean | 恒 `true`（产物校验通过才置 completed） |
| `script` | object | 导演剧本（LLM 或 mocker 兜底产物，含 shots 旁白分段） |
| `duration` | number | 成片实测时长（秒） |
| `deliveredAt` | number | 交付时间戳 |

### 4.5 失败响应结构（failed）

```json
{
  "code": 0,
  "msg": "查询成功",
  "data": {
    "taskId": "task_1791905958000_x7k2m",
    "status": "failed",
    "error": "视频素材无效或不在允许的上传目录内，请重新上传",
    "stage": "analyzing",
    "progress": 15
  }
}
```

* 查询接口 HTTP 恒 200，失败以 `status: 'failed'` + `error` 表达；**失败任务绝无 `videoUrl` 字段**；
* 注意：`code` 仍为 0（查询动作本身成功），任务失败状态在 `data.status` 中表达——这是现状行为。

### 4.6 任务不存在 / 服务重启

```json
{ "code": 40400, "msg": "任务不存在或已过期", "data": {}, "timestamp": ... }
```

HTTP 404。任务态存储为网关进程内存 `Map`（inMemoryTasks），**服务重启后全部任务记录丢失**，任何历史 taskId 查询均返回 404 40400。已落盘的历史产物文件仍可通过 `/storage/outputs/` 直接访问（产物不随任务态消失）。

---

## 五、最终视频产物访问

### 5.1 访问方式

* **路径**：`GET /storage/outputs/{taskId}/final.mp4`
* 前端直接以 `<video>` 播放 `videoUrl`；
* 支持 HTTP Range 断点续传（命中 Range 返回 206 + `Content-Range`），保障 1080P 成片秒开；
* MIME：`video/mp4`；响应头 `Cache-Control: public, max-age=86400`。

### 5.2 鉴权

**无需鉴权**（现状）。产物路径对任何访问者公开。

### 5.3 错误行为（现状，含特殊行为披露）

| 场景 | 实际行为 |
| :--- | :--- |
| 文件存在 | 200（或 Range 206）返回视频流 |
| 文件不存在 | **不返回 404**——请求落入 SPA fallback，返回 `index.html`（200, `text/html`）（见 §6 差距 G2） |
| 403 | 无此状态（无权限体系） |
| 非法路径穿越 | 路径经 `path.join` 规范化后仍映射到 `storageOutputsDir` 下拼接；不存在即落 SPA fallback |

### 5.4 产物生命周期

落盘位置 `storage/outputs/{taskId}/final.mp4`，**永久保留、无自动清理**；任务态丢失不影响产物文件存续。`.gitignore` 保护，不入版本库。

---

## 六、差距清单（现状与理想契约的已知差距，本版本不改代码）

> 以下差距为**现状如实记录**，非本次变更引入；修复任何一项均属公共行为变更，须按冻结文档的版本升级规则执行。
> **第三方发布安全门槛**：若本 API 将对外提供给第三方调用，G1（鉴权/调用方归属）、G2（文件访问隔离）、G4（计费控制）三项必须作为公开发布前必须关闭的安全门槛，不得带差距发布。

| # | 差距 | 影响 | 建议方向（仅登记） | 处理阶段 |
| :--- | :--- | :--- | :--- | :--- |
| G1 | 全端点无鉴权、无用户归属校验，CORS 全开 | 公网部署时产物与任务可被任意访问 | 接入多用户时以主版本升级引入鉴权中间件 | **对外发布前必关闭（安全门槛）**；内部冻结期不动 |
| G2 | 产物文件不存在时落入 SPA fallback 返回 200 HTML，而非 404 | 调用方无法以状态码区分「文件不存在」与「正常返回」 | 静态分发层为 `/storage/outputs/` 前缀增加存在性短路 404 | 对外发布前建议关闭（文件访问隔离相关）；内部冻结期不动 |
| G3 | produce 同步阶段不校验 `videoPath` 有效性（异步才 failed） | 调用方需依赖任务轮询发现传参错误 | 同步阶段增加 uploads 目录内存在性预检 | 按需 MINOR 升级（会使此前受理的请求变为同步拒绝，属行为变更） |
| G4 | mock 积分余额不足不拦截请求 | 无真实计费语义 | 接入真实配额体系时处理 | **对外发布前必关闭（计费控制）**；内部冻结期不动 |
| G5 | 任务态纯内存，重启即失 | 长周期任务追踪不可靠 | 需要时引入持久化任务表（新基建，须单独立项） | 单独立项，不在冻结期内实施 |
| G6 | 不支持 `HEAD` 方法 | 部分探测工具不可用 | 按需扩展方法白名单 | 按需 MINOR 升级 |
| G7 | 无重复请求幂等/去重 | 重复提交产生重复任务与重复扣分 | 需要时按内容指纹幂等 | 按需 MINOR 升级 |
| G8 | 上传产物（uploads）无生命周期清理 | 磁盘缓慢增长 | 运维层定期清理或 TTL 策略 | 运维例行事项，不影响 API 行为 |

---

## 七、契约测试锚点

本契约的每一条可验证行为均由 [scratch/test-stage-d.mjs](../../scratch/test-stage-d.mjs) 契约测试锚定（零付费：LLM 走 mocker 兜底、TTS 走本地桩、ffmpeg 本地合成）。测试与文档同版本冻结，修改任一方须同步另一方。
