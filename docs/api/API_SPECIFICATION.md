# 简兮 (JANSEE) · 统一 API 接口与数据契约规范 (API Specification)

> **版本**：v3.0  
> **基准协议**：HTTP/2 RESTful + Server-Sent Events (SSE) / WebSocket  
> **通用编码**：UTF-8 · JSON  

---

## 一、通用响应信封结构 (Response Envelope)

所有 API 接口均遵循统一信封规范：

```json
{
  "code": 0,
  "msg": "操作成功",
  "data": {},
  "timestamp": 1791448800000
}
```

* `code = 0`：代表业务逻辑完全成功；
* `code > 0`：通用业务错误码（如 `10001` 参数校验失败，`10002` 算力配额不足，`10003` 达到上传数量上限）；
* `code < 0`：系统级或未捕获异常。

---

## 二、商品成片核心接口清单

### 1. 提交商品成片任务
* **请求路径**：`POST /api/v1/video/produce/product`
* **请求内容**：`multipart/form-data`
* **参数规范**：
  - `images`: File[]（**硬性锁定：最多 9 张图片，超过直接拦截**）
  - `description`: String（商品核心卖点，必填）
  - `submode`: String (`"product"` | `"text"`)
* **响应示例**：
```json
{
  "code": 0,
  "msg": "任务创建成功",
  "data": {
    "taskId": "task_20261008_a8f9c1e",
    "status": "processing",
    "estimatedSeconds": 45
  }
}
```

### 2. 查询异步任务生成进度
* **请求路径**：`GET /api/v1/video/task/:taskId`
* **响应示例**：
```json
{
  "code": 0,
  "msg": "查询成功",
  "data": {
    "taskId": "task_20261008_a8f9c1e",
    "status": "processing",
    "stage": "composing_camera",
    "stageText": "正在像电影摄影师一样构思运镜与构图...",
    "progress": 65,
    "videoUrl": null
  }
}
```

---

## 三、错误码速查表 (Error Codes)

| 错误码 | 错误标识 (Error Identifier) | 释义 |
| :--- | :--- | :--- |
| `0` | `SUCCESS` | 成功 |
| `40001` | `IMAGE_LIMIT_EXCEEDED` | 上传图片超过 9 张上限 |
| `40002` | `DESCRIPTION_REQUIRED` | 商品卖点必填项缺失 |
| `40201` | `INSUFFICIENT_CREDITS` | 账号算力点数不足 |
| `50001` | `SYNTHESIS_FAILED` | 音视频合成引擎异常 |
