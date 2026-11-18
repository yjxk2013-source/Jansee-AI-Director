// 简兮 (JANSEE) · 短信服务套件 (@jansee/sms-kit)
// ---------------------------------------------------------------------------
// 供应商：阿里云「号码认证服务」Dypnsapi（SendSmsVerifyCode / CheckSmsVerifyCode）
// 原生 Node.js crypto + fetch 实现，无冗余三方依赖
import crypto from "node:crypto";

const ALIYUN_ENDPOINT = "https://dypnsapi.aliyuncs.com/";
const ALIYUN_VERSION = "2017-05-25";
const ALIYUN_REGION = "cn-hangzhou";
const REQUEST_TIMEOUT_MS = 10000;

// 本地开发/单测 Mock 码存储（内存暂存）
const mockCodeStore = new Map();

/** 当前供应商（aliyun | mock） */
export function smsProviderName() {
  return String(process.env.JX_SMS_PROVIDER || "aliyun").trim().toLowerCase() || "aliyun";
}

/** 是否处于显式 Mock 模式（仅 JX_AUTH_TEST=1 或 JX_SMS_PROVIDER=mock） */
export function isMockMode() {
  // Never infer mock mode from missing credentials: an unconfigured real provider
  // must report unavailable instead of silently accepting fixed test codes.
  if (String(process.env.NODE_ENV || "").trim().toLowerCase() === "production") return false;
  if (String(process.env.JX_AUTH_TEST || "0").trim() === "1") return true;
  return smsProviderName() === "mock";
}

/** 手机号脱敏 */
export function maskPhone(phone) {
  const p = String(phone || "");
  return p.length === 11 ? `${p.slice(0, 3)}****${p.slice(-4)}` : "***";
}

/** RFC3986 编码 */
function percentEncode(str) {
  return encodeURIComponent(String(str))
    .replace(/\+/g, "%20")
    .replace(/\*/g, "%2A")
    .replace(/%7E/g, "~");
}

/** 阿里云 RPC 风格 V1 签名（HMAC-SHA1） */
function signRpc(params, secret) {
  const sortedKeys = Object.keys(params).sort();
  const canonicalQuery = sortedKeys
    .map((k) => `${percentEncode(k)}=${percentEncode(params[k])}`)
    .join("&");
  const stringToSign = `GET&${percentEncode("/")}&${percentEncode(canonicalQuery)}`;
  const signature = crypto
    .createHmac("sha1", `${secret}&`)
    .update(stringToSign)
    .digest("base64");
  return { canonicalQuery, signature };
}

function aliyunCredential() {
  const id = String(process.env.JX_SMS_SECRET_ID || "").trim();
  const secret = String(process.env.JX_SMS_SECRET_KEY || "").trim();
  if (!id || !secret) {
    throw new Error("短信通道未配置：缺少 JX_SMS_SECRET_ID / JX_SMS_SECRET_KEY");
  }
  return { id, secret };
}

function friendlySmsError(code, message) {
  const map = {
    "biz.FREQUENCY": "发送过于频繁，请稍后再试",
    "isv.BUSINESS_LIMIT_CONTROL": "发送过于频繁，请稍后再试",
    "biz.LIMIT_CONTROL": "发送过于频繁，请稍后再试",
    "isv.MOBILE_NUMBER_ILLEGAL": "手机号格式不正确",
    "biz.MOBILE_NUMBER_ILLEGAL": "手机号格式不正确",
    "isv.TEMPLATE_MISSING_PARAMETERS": "短信模板参数不完整，请联系管理员",
    "isv.SMS_TEMPLATE_ILLEGAL": "短信模板不可用，请联系管理员",
    "isv.SMS_SIGNATURE_ILLEGAL": "短信签名不可用，请联系管理员",
    "isv.AMOUNT_NOT_ENOUGH": "短信余额不足，请联系管理员",
    "isv.RAM_PERMISSION_DENY": "短信服务权限不足，请联系管理员",
  };
  return map[code] || message || "短信下发失败，请稍后重试";
}

async function callAliyun(action, bizParams) {
  const { id, secret } = aliyunCredential();
  const params = {
    AccessKeyId: id,
    Action: action,
    Format: "JSON",
    RegionId: ALIYUN_REGION,
    SignatureMethod: "HMAC-SHA1",
    SignatureNonce: crypto.randomUUID(),
    SignatureVersion: "1.0",
    Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    Version: ALIYUN_VERSION,
    ...bizParams,
  };
  const { canonicalQuery, signature } = signRpc(params, secret);
  const url = `${ALIYUN_ENDPOINT}?${canonicalQuery}&Signature=${percentEncode(signature)}`;

  let resp;
  try {
    resp = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (e) {
    throw new Error(`短信服务网络异常：${e.message || e.name}`);
  }

  const text = await resp.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch (_) {
    throw new Error(`短信服务返回非 JSON（HTTP ${resp.status}）`);
  }
  return json;
}

/** 通道可用性 */
export function smsStatus() {
  const provider = smsProviderName();
  if (isMockMode()) return { ready: true, provider: "mock", mock: true };
  if (provider === "aliyun") {
    const missing = ["JX_SMS_SECRET_ID", "JX_SMS_SECRET_KEY", "JX_SMS_SIGN_NAME", "JX_SMS_TEMPLATE_CODE"]
      .filter((k) => !String(process.env[k] || "").trim());
    if (missing.length) {
      return { ready: false, provider, mock: false, reason: `缺少配置 ${missing.join(" / ")}` };
    }
    return { ready: true, provider, mock: false };
  }
  return { ready: false, provider, mock: false, reason: `未知短信供应商 ${provider}` };
}

/**
 * 下发登录短信验证码
 * @param {string} phone 11 位中国大陆手机号
 * @returns {Promise<{ ok: boolean, message?: string, requestId?: string, mockCode?: string }>}
 */
export async function sendVerifyCode(phone) {
  const cleanPhone = String(phone || "").replace(/\D/g, "");
  if (!/^1\d{10}$/.test(cleanPhone)) {
    return { ok: false, message: "手机号格式不正确，请输入 11 位大陆手机号" };
  }

  // 1. Mock 模式：生成 6 位测试码并暂存
  if (isMockMode()) {
    const code = "123456"; // 测试环境固定码或随机码
    const validMin = Math.max(1, Number(process.env.JX_SMS_VALID_MIN) || 10);
    mockCodeStore.set(cleanPhone, {
      code,
      expiresAt: Date.now() + validMin * 60 * 1000,
    });
    console.log(`[SMS-Mock] 已为手机号 ${maskPhone(cleanPhone)} 生成测试验证码: ${code}`);
    return { ok: true, message: "验证码已发送", requestId: "mock-req-" + Date.now(), mockCode: code };
  }

  // 2. 生产模式：调用阿里云 Dypnsapi 真实下发
  const validMin = Math.max(1, Number(process.env.JX_SMS_VALID_MIN) || 10);
  const signName = String(process.env.JX_SMS_SIGN_NAME || "").trim();
  const templateCode = String(process.env.JX_SMS_TEMPLATE_CODE || "").trim();

  try {
    const json = await callAliyun("SendSmsVerifyCode", {
      PhoneNumber: cleanPhone,
      SignName: signName,
      TemplateCode: templateCode,
      TemplateParam: JSON.stringify({ code: "##code##", min: String(validMin) }),
      CodeLength: "6",
      ValidTime: String(validMin * 60),
      Interval: "60",
      ReturnVerifyCode: "false",
    });

    if (json.Code !== "OK") {
      const raw = String(json.Message || json.Code || "短信下发失败");
      const msg = friendlySmsError(String(json.Code || ""), raw);
      console.error(`[SMS] 下发失败 ${maskPhone(cleanPhone)} Code=${json.Code} Message=${raw}`);
      return { ok: false, requestId: json.RequestId, message: msg };
    }

    console.log(`[SMS] 阿里云已下发 ${maskPhone(cleanPhone)} 请求号=${json.RequestId || "-"}`);
    return { ok: true, message: "验证码已发送", requestId: json.RequestId || "" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[SMS] 下发异常 ${maskPhone(cleanPhone)}: ${msg}`);
    return { ok: false, message: msg };
  }
}

/**
 * 校验短信验证码
 * @param {string} phone 11 位手机号
 * @param {string} code 6 位验证码
 * @returns {Promise<{ ok: boolean, passed: boolean, message?: string }>}
 */
export async function checkVerifyCode(phone, code) {
  const cleanPhone = String(phone || "").replace(/\D/g, "");
  const cleanCode = String(code || "").replace(/\D/g, "");

  if (!/^1\d{10}$/.test(cleanPhone)) {
    return { ok: false, passed: false, message: "手机号格式不正确" };
  }
  if (!/^\d{6}$/.test(cleanCode)) {
    return { ok: false, passed: false, message: "请输入 6 位数字验证码" };
  }

  // 1. Mock 模式校验
  if (isMockMode()) {
    // 支持固定万能测试码 123456 或内存中的码
    if (cleanCode === "123456") {
      return { ok: true, passed: true };
    }
    const item = mockCodeStore.get(cleanPhone);
    if (!item) {
      return { ok: false, passed: false, message: "验证码已失效，请重新获取" };
    }
    if (Date.now() > item.expiresAt) {
      mockCodeStore.delete(cleanPhone);
      return { ok: false, passed: false, message: "验证码已过期，请重新获取" };
    }
    if (item.code !== cleanCode) {
      return { ok: true, passed: false, message: "验证码不正确" };
    }
    mockCodeStore.delete(cleanPhone);
    return { ok: true, passed: true };
  }

  // 2. 生产模式：调用阿里云校验
  try {
    const json = await callAliyun("CheckSmsVerifyCode", {
      PhoneNumber: cleanPhone,
      VerifyCode: cleanCode,
      CodeLength: "6",
    });

    if (json.Code !== "OK") {
      if (String(json.Code) === "isv.ValidateFail") {
        return { ok: true, passed: false, message: "验证码不正确或已过期" };
      }
      const msg = String(json.Message || json.Code || "验证码校验失败");
      return { ok: false, passed: false, message: msg };
    }

    const passed = json.Model && (json.Model.Pass === true || json.Model.VerifyResult === "PASS");
    return { ok: true, passed: Boolean(passed) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, passed: false, message: msg };
  }
}
