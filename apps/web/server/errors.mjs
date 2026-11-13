// 简兮 · 对外安全错误边界
// 原则：业务预期内的提示（积分不足/请登录等）可直显；系统内部错误（LLM 超时、上游 5xx、
// 代码异常、JSON 解析失败等）一律映射为「预置友好文案」，绝不让 err.message / 堆栈到达客户端。
// 服务端始终用 requestId 记录完整错误+堆栈，便于排查。
import { randomUUID } from 'node:crypto';

// ===== 错误码 → 客户端文案（对外只有这些字，且不含任何技术细节）=====
// retryable=true 时前端可展示「重试」按钮
export const CLIENT_MESSAGES = {
  LLM_TIMEOUT:    { text: '大导演正在赶工，生成稍慢，请稍候再试', retryable: true },
  UPSTREAM_ERROR: { text: '服务暂时开小差，请稍后再试', retryable: true },
  SCRIPT_PARSE:   { text: '大导演这回发挥有点失常，请重试一次', retryable: true },
  INTERNAL:       { text: '出了点小状况，已记录，请稍后重试', retryable: false },
};

// ===== 错误类：带 code，expose=true 表示 message 本身已是安全可展示的业务文案 =====
export class ApiError extends Error {
  constructor(code, message, { status = 500, expose = false, retryable = false } = {}) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.expose = expose;     // true → 客户端直显 message（业务文案）；false → 用 CLIENT_MESSAGES[code]
    this.retryable = retryable;
  }
}

// ===== 纯函数：错误 → 客户端可见 payload（绝不携带内部 message）=====
export function toClientPayload(err, fallback) {
  if (err instanceof ApiError) {
    if (err.expose) {
      return { code: err.code, message: err.message, status: err.status, retryable: err.retryable };
    }
    const m = CLIENT_MESSAGES[err.code] || CLIENT_MESSAGES.INTERNAL;
    return { code: err.code, message: m.text, status: err.status, retryable: m.retryable };
  }
  // 未知错误：用调用方给的安全降级文案（fallback），否则 INTERNAL 默认文案
  const m = CLIENT_MESSAGES.INTERNAL;
  return { code: 'INTERNAL', message: fallback || m.text, status: 500, retryable: m.retryable };
}

// ===== 统一出口：记录完整内部错误，只回安全 payload 给客户端 =====
export function safeReply(res, err, requestId, fallback) {
  const payload = toClientPayload(err, fallback);
  // 服务端日志：完整内部信息 + requestId（排查用），即使 err 不是 ApiError 也记 message/stack
  console.error('[safeReply]', {
    code: payload.code,
    requestId,
    clientMessage: payload.message,
    internalMessage: err && err.message,
    stack: err && err.stack,
  });
  return res.status(payload.status).json({
    ok: false,
    code: payload.code,
    message: payload.message,
    retryable: payload.retryable,
  });
}

// ===== requestId：每个请求一个，串起日志与客户端排查 =====
export function newRequestId() {
  try { return randomUUID(); } catch { return 'req-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
}

export function requestIdMiddleware(req, _res, next) {
  req.requestId = newRequestId();
  next();
}

// =========================================================================
// S7 统一错误码体系 (Standardized Application Error Codes)
// 遵循分层错误码规范：400xx 参数 / 403xx 安全 / 404xx 资源 / 409xx 状态 / 500xx 服务
// =========================================================================

export const ERROR_CODES = {
  // 400xx 参数错误
  PARAM_INVALID: 40001,             // 请求体无效或参数结构错误
  MISSING_TYPE: 40002,              // 缺少创作类型 type
  TYPE_UNSUPPORTED: 40003,          // 不支持的创作类型
  MISSING_MATERIAL: 40010,          // 缺少素材 ID (materialIds 为空)
  MATERIAL_LIMIT_EXCEEDED: 40011,   // 素材数量超限 (>9)
  MATERIAL_ID_INVALID: 40012,       // 素材 ID 格式非法
  TEXT_REQUIRED: 40013,             // 必填文本内容缺失

  // 403xx 安全错误
  SECURITY_PATH_FORBIDDEN: 40301,   // 禁止提交物理文件路径或试图目录穿越
  CONTENT_SENSITIVE: 40302,         // 文本包含高危敏感词或广告法绝对违禁词

  // 404xx 资源错误
  RESOURCE_NOT_FOUND: 40400,        // 资源或任务不存在
  MATERIAL_NOT_FOUND: 40401,        // 指定素材未登记或已过期

  // 409xx 状态冲突
  TASK_DUPLICATED: 40901,           // 任务重复提交
  TASK_STATE_INVALID: 40902,        // 任务前置状态不满足当前操作

  // 500xx 服务错误
  SYNTHESIS_FAILED: 50001,          // 底层引擎合成或编排失败
  WORKFLOW_TIMEOUT: 50002,          // 编排任务等待超时
};

/**
 * 创建符合统一信封契约的结构化应用错误
 * @param {number} code 业务错误码
 * @param {string} message 业务提示信息
 * @param {object} [options]
 * @param {number} [options.status] HTTP 状态码（默认根据 code 首三位推导）
 * @param {any} [options.details] 额外错误详情
 * @returns {Error & { code: number, status: number, details: any }}
 */
export function createAppError(code, message, { status, details } = {}) {
  const codeNum = Number(code) || 50001;
  const inferredStatus = status || (codeNum >= 40000 && codeNum < 60000 ? Math.floor(codeNum / 100) : 500);

  const err = new Error(String(message || '操作失败'));
  err.name = 'AppError';
  err.code = codeNum;
  err.status = inferredStatus;
  if (details !== undefined) {
    err.details = details;
  }

  // 保持与 includes / string 检查的向下兼容
  err.includes = function (substr) {
    return this.message.includes(substr);
  };

  return err;
}

