// 简兮 (JANSEE) · 短信验证码通道 (apps/web/server/smsProvider.mjs)
// ---------------------------------------------------------------------------
// 供应商：阿里云「号码认证服务」Dypnsapi（SendSmsVerifyCode / CheckSmsVerifyCode）
// 为什么用号码认证而不是经典短信 Dysmsapi：
//   号码认证自带「赠送签名 + 赠送模板」，个人账号可用，验证码由阿里云生成与校验，
//   不必自己拼模板变量、也不必把明文验证码存在本服务里。
//
// 三条铁律：
//   1. 验证码的生成与校验都在阿里云侧，本服务只转发结果，**不存在明文码**（mock 模式除外）。
//   2. 密钥缺失时**绝不假装发送**：直接抛错，避免上线后用户收不到码、页面却提示"已发送"。
//   3. 任何日志都不打印 AccessKey / SecretKey / 完整手机号。
import crypto from 'node:crypto';

const ALIYUN_ENDPOINT = 'https://dypnsapi.aliyuncs.com/';
const ALIYUN_VERSION = '2017-05-25';
const ALIYUN_REGION = 'cn-hangzhou';
const REQUEST_TIMEOUT_MS = 10000;

/** 当前供应商（aliyun | tencent | mock） */
export function smsProviderName() {
  return String(process.env.JX_SMS_PROVIDER || 'aliyun').trim().toLowerCase() || 'aliyun';
}

/** 是否开发 mock（JX_AUTH_TEST=1 或 provider=mock） */
export function isMockMode() {
  if (String(process.env.JX_AUTH_TEST || '0').trim() === '1') return true;
  return smsProviderName() === 'mock';
}

/** 手机号脱敏，仅用于日志 */
function maskPhone(phone) {
  const p = String(phone || '');
  return p.length === 11 ? `${p.slice(0, 3)}****${p.slice(-4)}` : '***';
}

/**
 * RFC3986 编码（阿里云 RPC 签名要求）：
 * encodeURIComponent 之后 + → %20、* → %2A、%7E → ~
 */
function percentEncode(str) {
  return encodeURIComponent(String(str))
    .replace(/\+/g, '%20')
    .replace(/\*/g, '%2A')
    .replace(/%7E/g, '~');
}

/**
 * 阿里云 RPC 风格 V1 签名（HMAC-SHA1）
 * @param {Record<string,string>} params 含全部公共参数与业务参数
 * @param {string} secret AccessKeySecret
 * @returns {{canonicalQuery: string, signature: string}}
 */
function signRpc(params, secret) {
  const sortedKeys = Object.keys(params).sort();
  const canonicalQuery = sortedKeys
    .map((k) => `${percentEncode(k)}=${percentEncode(params[k])}`)
    .join('&');
  const stringToSign = `GET&${percentEncode('/')}&${percentEncode(canonicalQuery)}`;
  const signature = crypto
    .createHmac('sha1', `${secret}&`)
    .update(stringToSign)
    .digest('base64');
  return { canonicalQuery, signature };
}

function aliyunCredential() {
  const id = String(process.env.JX_SMS_SECRET_ID || '').trim();
  const secret = String(process.env.JX_SMS_SECRET_KEY || '').trim();
  if (!id || !secret) {
    throw new Error('短信通道未配置：缺少 JX_SMS_SECRET_ID / JX_SMS_SECRET_KEY');
  }
  return { id, secret };
}

/**
 * 阿里云错误码 → 用户可读文案
 * 只挑登录场景常见的几种，其余原样透出（便于排查，但不含密钥）
 */
function friendlySmsError(code, message) {
  const map = {
    'biz.FREQUENCY': '发送过于频繁，请稍后再试',
    'isv.BUSINESS_LIMIT_CONTROL': '发送过于频繁，请稍后再试',
    'biz.LIMIT_CONTROL': '发送过于频繁，请稍后再试',
    'isv.MOBILE_NUMBER_ILLEGAL': '手机号格式不正确',
    'biz.MOBILE_NUMBER_ILLEGAL': '手机号格式不正确',
    'isv.TEMPLATE_MISSING_PARAMETERS': '短信模板参数不完整，请联系管理员',
    'isv.SMS_TEMPLATE_ILLEGAL': '短信模板不可用，请联系管理员',
    'isv.SMS_SIGNATURE_ILLEGAL': '短信签名不可用，请联系管理员',
    'isv.AMOUNT_NOT_ENOUGH': '短信余额不足，请联系管理员',
    'isv.RAM_PERMISSION_DENY': '短信服务权限不足，请联系管理员',
  };
  return map[code] || message || '短信下发失败，请稍后重试';
}

/**
 * 调用阿里云 RPC 接口
 * @param {string} action 如 SendSmsVerifyCode
 * @param {Record<string,string>} bizParams 业务参数（值必须是字符串）
 */
async function callAliyun(action, bizParams) {
  const { id, secret } = aliyunCredential();
  const params = {
    AccessKeyId: id,
    Action: action,
    Format: 'JSON',
    RegionId: ALIYUN_REGION,
    SignatureMethod: 'HMAC-SHA1',
    SignatureNonce: crypto.randomUUID(),
    SignatureVersion: '1.0',
    // ISO8601 UTC，去掉毫秒（阿里云要求 yyyy-MM-ddTHH:mm:ssZ）
    Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    Version: ALIYUN_VERSION,
    ...bizParams,
  };
  const { canonicalQuery, signature } = signRpc(params, secret);
  const url = `${ALIYUN_ENDPOINT}?${canonicalQuery}&Signature=${percentEncode(signature)}`;

  let resp;
  try {
    resp = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
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

/**
 * 通道可用性（给启动自检/健康检查用，不做外部请求）
 * @returns {{ready: boolean, provider: string, mock: boolean, reason?: string}}
 */
export function smsStatus() {
  const provider = smsProviderName();
  if (isMockMode()) return { ready: true, provider: 'mock', mock: true };
  if (provider === 'aliyun') {
    const missing = ['JX_SMS_SECRET_ID', 'JX_SMS_SECRET_KEY', 'JX_SMS_SIGN_NAME', 'JX_SMS_TEMPLATE_CODE']
      .filter((k) => !String(process.env[k] || '').trim());
    if (missing.length) {
      return { ready: false, provider, mock: false, reason: `缺少配置 ${missing.join(' / ')}` };
    }
    return { ready: true, provider, mock: false };
  }
  if (provider === 'tencent') {
    return { ready: false, provider, mock: false, reason: '腾讯云短信通道尚未实现，请改用 aliyun' };
  }
  return { ready: false, provider, mock: false, reason: `未知短信供应商 ${provider}` };
}

/**
 * 下发登录验证码
 * @param {string} phone 11 位手机号
 * @returns {Promise<{ok: boolean, provider: string, requestId?: string, message?: string}>}
 */
export async function sendVerifyCode(phone) {
  const cleanPhone = String(phone || '').replace(/\D/g, '');
  if (!/^1\d{10}$/.test(cleanPhone)) {
    return { ok: false, provider: smsProviderName(), message: '手机号格式不正确' };
  }

  const status = smsStatus();
  if (!status.ready) {
    console.error('[SMS] 通道不可用：' + (status.reason || '未知原因'));
    return { ok: false, provider: status.provider, message: status.reason || '短信通道不可用' };
  }
  if (status.mock) {
    // mock 由调用方生成本地码，此处不参与
    return { ok: false, provider: 'mock', message: 'mock 模式下不应调用真实发送' };
  }

  const validMin = Math.max(1, Number(process.env.JX_SMS_VALID_MIN) || 10);
  const signName = String(process.env.JX_SMS_SIGN_NAME || '').trim();
  const templateCode = String(process.env.JX_SMS_TEMPLATE_CODE || '').trim();

  const json = await callAliyun('SendSmsVerifyCode', {
    PhoneNumber: cleanPhone,
    SignName: signName,
    TemplateCode: templateCode,
    // 模板 100001：变量为 ${code}（由阿里云生成）与 ${min}（有效期分钟）
    TemplateParam: JSON.stringify({ code: '##code##', min: String(validMin) }),
    CodeLength: '6',
    ValidTime: String(validMin * 60),
    Interval: '60',
    ReturnVerifyCode: 'false',
  });

  if (json.Code !== 'OK') {
    const raw = String(json.Message || json.Code || '短信下发失败');
    const msg = friendlySmsError(String(json.Code || ''), raw);
    console.error(`[SMS] 下发失败 ${maskPhone(cleanPhone)} Code=${json.Code} Message=${raw}`);
    return { ok: false, provider: 'aliyun', requestId: json.RequestId, message: msg };
  }

  console.log(`[SMS] 已下发 ${maskPhone(cleanPhone)} 请求号=${json.RequestId || (json.Model && json.Model.RequestId) || '-'}`);
  return { ok: true, provider: 'aliyun', requestId: json.RequestId || (json.Model && json.Model.RequestId) || '' };
}

/**
 * 校验验证码（由阿里云判定，本服务不持有明文码）
 * @param {string} phone
 * @param {string} code 6 位数字
 * @returns {Promise<{ok: boolean, passed: boolean, provider: string, message?: string}>}
 */
export async function checkVerifyCode(phone, code) {
  const cleanPhone = String(phone || '').replace(/\D/g, '');
  const cleanCode = String(code || '').replace(/\D/g, '');

  const status = smsStatus();
  if (!status.ready) {
    console.error('[SMS] 通道不可用：' + (status.reason || '未知原因'));
    return { ok: false, passed: false, provider: status.provider, message: status.reason || '短信通道不可用' };
  }
  if (status.mock) {
    return { ok: false, passed: false, provider: 'mock', message: 'mock 模式下不应调用真实校验' };
  }

  const json = await callAliyun('CheckSmsVerifyCode', {
    PhoneNumber: cleanPhone,
    VerifyCode: cleanCode,
    CodeLength: '6',
  });

  if (json.Code !== 'OK') {
    // isv.ValidateFail = 验证码不匹配（正常业务结果，不是通道故障），必须与"服务异常"区分，
    // 否则用户输错一次会看到"短信服务不可用"，且服务端无法累计错误次数。
    if (String(json.Code) === 'isv.ValidateFail') {
      return { ok: true, passed: false, provider: 'aliyun' };
    }
    const msg = String(json.Message || json.Code || '验证码校验失败');
    console.error(`[SMS] 校验异常 ${maskPhone(cleanPhone)} Code=${json.Code} Message=${msg}`);
    return { ok: false, passed: false, provider: 'aliyun', message: msg };
  }

  const passed = json.Model && (json.Model.Pass === true || json.Model.VerifyResult === 'PASS');
  return { ok: true, passed: Boolean(passed), provider: 'aliyun' };
}
