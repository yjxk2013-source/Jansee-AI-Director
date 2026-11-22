import assert from "node:assert/strict";
import test from "node:test";
import { buildApp } from "../apps/api/src/app.js";
import type { AuthStore, AuthUser } from "../apps/api/src/auth.js";

const user: AuthUser = {
  id: "88888888-8888-4888-8888-888888888888",
  email: "voice@jansee.com",
  phone: "13800008888",
  displayName: "Voice User",
  createdAt: new Date(),
};
const token = "v".repeat(43);

function mockAuthStore(): AuthStore {
  return {
    async createUser() { throw new Error("not implemented"); },
    async findUserByEmail() { return null; },
    async findUserById(id) { return id === user.id ? user : null; },
    async verifyPassword() { return null; },
    async createSession() {},
    async findSession() {
      return { user, expiresAt: new Date(Date.now() + 3600_000) };
    },
    async deleteSession() {},
    async deleteUserSessions() {},
  };
}

test("voice transcribe endpoint enforces authentication and origin security", async (t) => {
  const app = buildApp({
    allowedOrigins: ["https://jansee.cn"],
    authStore: mockAuthStore(),
    logLevel: "silent",
  });
  t.after(async () => app.close());

  // 1. 未授权请求被拦截 (401)
  const unauth = await app.inject({
    method: "POST",
    url: "/api/v1/voice/transcribe",
    headers: { origin: "https://jansee.cn" },
  });
  assert.equal(unauth.statusCode, 401);
  assert.equal(unauth.json().error?.code, "AUTH_REQUIRED");

  // 2. 非法来源请求被拦截 (403)
  const forbiddenOrigin = await app.inject({
    method: "POST",
    url: "/api/v1/voice/transcribe",
    headers: {
      origin: "https://malicious-site.com",
      cookie: `jansee_session=${token}`,
    },
  });
  assert.equal(forbiddenOrigin.statusCode, 403);
  assert.equal(forbiddenOrigin.json().error?.code, "ORIGIN_NOT_ALLOWED");

  // 3. 上传空 boundary 时返回 400 NO_AUDIO_FILE
  const emptyBoundary = "----jansee-test-empty-boundary";
  const emptyPayload = `--${emptyBoundary}--\r\n`;
  const noAudio = await app.inject({
    method: "POST",
    url: "/api/v1/voice/transcribe",
    headers: {
      origin: "https://jansee.cn",
      cookie: `jansee_session=${token}`,
      "content-type": `multipart/form-data; boundary=${emptyBoundary}`,
    },
    payload: emptyPayload,
  });
  assert.equal(noAudio.statusCode, 400);
  assert.equal(noAudio.json().error?.code, "NO_AUDIO_FILE");

  // 4. 正常上传音频并完成 Whisper 语音转写 (200)
  const mockTranscribeApp = buildApp({
    allowedOrigins: ["https://jansee.cn"],
    authStore: mockAuthStore(),
    logLevel: "silent",
    voiceTranscribeAudio: async (_path) => ({
      text: "生成一段具有电影质感的黄金首饰带货短视频",
      duration: 3.5,
    }),
  });
  t.after(async () => mockTranscribeApp.close());

  const validBoundary = "----jansee-test-valid-boundary";
  const head = Buffer.from(`--${validBoundary}\r\nContent-Disposition: form-data; name="audio"; filename="recording.webm"\r\nContent-Type: audio/webm\r\n\r\n`);
  // 标准 WebM EBML 魔数开头 (\x1A\x45\xDF\xA3)
  const fileBytes = Buffer.concat([
    Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81]),
    Buffer.from("mock-audio-data-stream"),
  ]);
  const tail = Buffer.from(`\r\n--${validBoundary}--\r\n`);
  const validPayload = Buffer.concat([head, fileBytes, tail]);

  const validRes = await mockTranscribeApp.inject({
    method: "POST",
    url: "/api/v1/voice/transcribe",
    headers: {
      origin: "https://jansee.cn",
      cookie: `jansee_session=${token}`,
      "content-type": `multipart/form-data; boundary=${validBoundary}`,
    },
    payload: validPayload,
  });
  assert.equal(validRes.statusCode, 200);
  const data = validRes.json() as { text: string; durationSec: number };
  assert.equal(data.text, "生成一段具有电影质感的黄金首饰带货短视频");
  assert.equal(data.durationSec, 3.5);
});
