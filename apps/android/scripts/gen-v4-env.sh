#!/usr/bin/env bash
set -euo pipefail

SRC=/srv/jansee-v2-backup/config/.env
DST=/srv/jansee-v4/.env

# 从 V2 .env 读取某个键的值（兼容大小写两种命名）
get() {
  local key="$1"
  # 精确匹配 key= 开头的第一行，取等号后全部内容，去掉可能的首尾引号
  local val
  val=$(grep -m1 -E "^${key}=" "$SRC" 2>/dev/null | head -1 | cut -d= -f2- || true)
  # 去首尾空白与成对引号
  val=$(printf '%s' "$val" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//")
  printf '%s' "$val"
}

DIRECTOR_KEY=$(get SILICONFLOW_API_KEY)
DIRECTOR_MODEL=$(get SILICONFLOW_DIRECTOR_MODEL)
DIRECTOR_MODEL_SECONDARY=$(get SILICONFLOW_DIRECTOR_SECONDARY_MODEL)
TTS_ID=$(get JX_TTS_TENCENT_SECRET_ID)
TTS_KEY=$(get JX_TTS_TENCENT_SECRET_KEY)
SMS_ID=$(get JX_SMS_SECRET_ID)
SMS_KEY=$(get JX_SMS_SECRET_KEY)
SMS_SIGN=$(get JX_SMS_SIGN_NAME)
SMS_TPL=$(get JX_SMS_TEMPLATE_CODE)
OPCPAY_KEY=$(get opcpay_api_key)

# 校验关键密钥确实取到（非空），否则中止，避免生成一份起不来的配置
for pair in \
  "DIRECTOR_API_KEY:$DIRECTOR_KEY" \
  "JX_TTS_TENCENT_SECRET_ID:$TTS_ID" \
  "JX_TTS_TENCENT_SECRET_KEY:$TTS_KEY" \
  "JX_SMS_SECRET_ID:$SMS_ID" \
  "JX_SMS_SECRET_KEY:$SMS_KEY" \
  "OPCPAY_API_KEY:$OPCPAY_KEY"; do
  name="${pair%%:*}"
  value="${pair#*:}"
  if [ -z "$value" ]; then
    echo "ERROR: 关键配置项 $name 从 V2 配置中未取到值，中止生成 .env" >&2
    exit 1
  fi
done

# 回退模型：优先用 V2 配置的次选，缺省用模板默认
FALLBACK="${DIRECTOR_MODEL_SECONDARY:-deepseek-ai/DeepSeek-V4.1-Flash}"

# 生成 V4 独有的一次性密钥
PG_PASSWORD=$(openssl rand -hex 32)
PAYOUT_KEY=$(openssl rand -hex 32)

cat > "$DST" <<EOF
NODE_ENV=production
API_HOST=0.0.0.0
API_PORT=4100
WORKER_CONCURRENCY=2
LOG_LEVEL=info
WEB_ORIGINS=https://jansee.cn,https://admin.jansee.cn
TRUST_PROXY_IP=172.30.250.2
ADMIN_EMAILS=
ADMIN_PHONES=15208316776

POSTGRES_PASSWORD=${PG_PASSWORD}
DATABASE_SSL=false
DATABASE_PRIVATE_NETWORK=true

DIRECTOR_API_BASE_URL=https://api.siliconflow.cn/v1
DIRECTOR_API_KEY=${DIRECTOR_KEY}
DIRECTOR_MODEL=${DIRECTOR_MODEL:-zai-org/GLM-5.3-Flash}
DIRECTOR_FALLBACK_MODELS=${FALLBACK}
DIRECTOR_TIMEOUT_MS=25000
DIRECTOR_FALLBACK_TIMEOUT_MS=30000
DIRECTOR_MAX_TOKENS=2048

JX_TTS_TENCENT_SECRET_ID=${TTS_ID}
JX_TTS_TENCENT_SECRET_KEY=${TTS_KEY}
JX_TTS_TENCENT_SPEED_BASE=0.79

JX_AUTH_TEST=0
JX_SMS_PROVIDER=aliyun
JX_SMS_SECRET_ID=${SMS_ID}
JX_SMS_SECRET_KEY=${SMS_KEY}
JX_SMS_SIGN_NAME=${SMS_SIGN}
JX_SMS_TEMPLATE_CODE=${SMS_TPL}
JX_SMS_VALID_MIN=10

OPCPAY_API_KEY=${OPCPAY_KEY}
OPCPAY_WEBHOOK_SECRET=
OPCPAY_BASE_URL=
PAY_SIMULATE=0

MEDIA_STORAGE_DRIVER=local
MEDIA_STORAGE_ROOT=/app/storage/media
MEDIA_CACHE_ROOT=/app/storage/cache
MEDIA_MIN_FREE_BYTES=1073741824
JX_WHISPER_CLI=/app/whisper.cpp/bin/whisper-cli
JX_WHISPER_MODEL=/app/whisper.cpp/models/ggml-small.bin
JX_MATERIALS_ROOT=/app/materials

PARTNER_PAYOUT_ENCRYPTION_KEY=${PAYOUT_KEY}
EOF

chmod 600 "$DST"
echo "OK: .env 已生成，权限 600"
echo "行数: $(wc -l < "$DST")"
echo "管理员手机: 15208316776"
echo "导演模型: ${DIRECTOR_MODEL:-zai-org/GLM-5.3-Flash}"
echo "短信签名: ${SMS_SIGN}  模板: ${SMS_TPL}"
echo "POSTGRES_PASSWORD 长度: ${#PG_PASSWORD}  PAYOUT_KEY 长度: ${#PAYOUT_KEY}"
