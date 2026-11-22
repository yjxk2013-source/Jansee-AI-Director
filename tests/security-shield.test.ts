import test from "node:test";
import assert from "node:assert/strict";
import { detectMediaMagicBytes, isPrivateOrReservedIp, validatePublicUrlSafety } from "../apps/api/src/security-shield.js";
import { detectFile } from "../apps/api/src/assets.js";

test("detectMediaMagicBytes correctly identifies various image types", () => {
  // 1. PNG
  const pngHeader = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13]);
  const pngResult = detectMediaMagicBytes(pngHeader);
  assert.equal(pngResult?.mediaType, "image");
  assert.equal(pngResult?.mimeType, "image/png");

  // 2. JPEG
  const jpegHeader = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
  const jpegResult = detectMediaMagicBytes(jpegHeader);
  assert.equal(jpegResult?.mediaType, "image");
  assert.equal(jpegResult?.mimeType, "image/jpeg");

  // 3. GIF
  const gifHeader = Buffer.from("GIF89a\x01\x00\x01\x00", "ascii");
  const gifResult = detectMediaMagicBytes(gifHeader);
  assert.equal(gifResult?.mediaType, "image");
  assert.equal(gifResult?.mimeType, "image/gif");

  // 4. WebP
  const webpHeader = Buffer.concat([
    Buffer.from("RIFF", "ascii"),
    Buffer.alloc(4),
    Buffer.from("WEBP", "ascii"),
  ]);
  const webpResult = detectMediaMagicBytes(webpHeader);
  assert.equal(webpResult?.mediaType, "image");
  assert.equal(webpResult?.mimeType, "image/webp");
});

test("detectMediaMagicBytes correctly identifies video formats", () => {
  // MP4 (ftypisom)
  const mp4Header = Buffer.concat([
    Buffer.alloc(4),
    Buffer.from("ftypisom", "ascii"),
  ]);
  const mp4Result = detectMediaMagicBytes(mp4Header);
  assert.equal(mp4Result?.mediaType, "video");
  assert.equal(mp4Result?.mimeType, "video/mp4");

  // WebM
  const webmHeader = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81]);
  const webmResult = detectMediaMagicBytes(webmHeader);
  assert.equal(webmResult?.mediaType, "video");
  assert.equal(webmResult?.mimeType, "video/webm");
});

test("detectMediaMagicBytes correctly identifies audio formats", () => {
  // WAV
  const wavHeader = Buffer.concat([
    Buffer.from("RIFF", "ascii"),
    Buffer.alloc(4),
    Buffer.from("WAVE", "ascii"),
  ]);
  const wavResult = detectMediaMagicBytes(wavHeader);
  assert.equal(wavResult?.mediaType, "audio");
  assert.equal(wavResult?.mimeType, "audio/wav");

  // MP3 with ID3 tag
  const mp3Id3Header = Buffer.concat([Buffer.from("ID3", "ascii"), Buffer.alloc(5)]);
  const mp3Result = detectMediaMagicBytes(mp3Id3Header);
  assert.equal(mp3Result?.mediaType, "audio");
  assert.equal(mp3Result?.mimeType, "audio/mpeg");

  // OGG (OggS)
  const oggHeader = Buffer.from("OggS\x00\x02\x00\x00", "ascii");
  const oggResult = detectMediaMagicBytes(oggHeader);
  assert.equal(oggResult?.mediaType, "audio");
  assert.equal(oggResult?.mimeType, "audio/ogg");
});

test("detectMediaMagicBytes rejects shell scripts, text, and unknown binaries", () => {
  assert.equal(detectMediaMagicBytes(Buffer.from("#!/bin/bash\necho hack")), null);
  assert.equal(detectMediaMagicBytes(Buffer.from("<?php phpinfo(); ?>")), null);
  assert.equal(detectMediaMagicBytes(Buffer.from("console.log('test')")), null);
  assert.equal(detectMediaMagicBytes(Buffer.alloc(0)), null);
  assert.equal(detectMediaMagicBytes(Buffer.from([0x00, 0x01, 0x02])), null);
});

test("assets.ts detectFile wraps detectMediaMagicBytes and filters image/video", () => {
  const pngHeader = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(detectFile(pngHeader)?.mediaType, "image");

  const wavHeader = Buffer.concat([
    Buffer.from("RIFF", "ascii"),
    Buffer.alloc(4),
    Buffer.from("WAVE", "ascii"),
  ]);
  // 资产上传只支持 image/video，audio 会被拒绝
  assert.equal(detectFile(wavHeader), null);
});

test("isPrivateOrReservedIp accurately classifies private, loopback, and metadata IPs", () => {
  // 回环地址
  assert.equal(isPrivateOrReservedIp("127.0.0.1"), true);
  assert.equal(isPrivateOrReservedIp("127.0.0.254"), true);

  // 内网 A/B/C 类
  assert.equal(isPrivateOrReservedIp("10.0.0.1"), true);
  assert.equal(isPrivateOrReservedIp("10.255.255.255"), true);
  assert.equal(isPrivateOrReservedIp("172.16.0.1"), true);
  assert.equal(isPrivateOrReservedIp("172.31.255.255"), true);
  assert.equal(isPrivateOrReservedIp("192.168.1.1"), true);
  assert.equal(isPrivateOrReservedIp("192.168.0.100"), true);

  // 云厂商元数据地址 (169.254.169.254)
  assert.equal(isPrivateOrReservedIp("169.254.169.254"), true);

  // 公网正常 IP
  assert.equal(isPrivateOrReservedIp("203.195.243.42"), false);
  assert.equal(isPrivateOrReservedIp("8.8.8.8"), false);
  assert.equal(isPrivateOrReservedIp("1.1.1.1"), false);
  assert.equal(isPrivateOrReservedIp("114.114.114.114"), false);

  // IPv6 测试
  assert.equal(isPrivateOrReservedIp("::1"), true);
  assert.equal(isPrivateOrReservedIp("fe80::1"), true);
  assert.equal(isPrivateOrReservedIp("fc00::1"), true);
  assert.equal(isPrivateOrReservedIp("::ffff:127.0.0.1"), true);
  assert.equal(isPrivateOrReservedIp("2400:3200::1"), false);
});

test("validatePublicUrlSafety blocks dangerous and SSRF URLs", () => {
  // 本地主机名拦截
  assert.equal(validatePublicUrlSafety("http://localhost:8080").safe, false);
  assert.equal(validatePublicUrlSafety("http://my.internal/api").safe, false);
  assert.equal(validatePublicUrlSafety("https://test.local").safe, false);

  // 内网 IP 拦截
  assert.equal(validatePublicUrlSafety("http://127.0.0.1:3000/").safe, false);
  assert.equal(validatePublicUrlSafety("http://10.10.10.10/").safe, false);
  assert.equal(validatePublicUrlSafety("http://169.254.169.254/latest/meta-data").safe, false);
  assert.equal(validatePublicUrlSafety("http://192.168.1.1/secret").safe, false);

  // 非 HTTP(S) 协议拦截
  assert.equal(validatePublicUrlSafety("file:///etc/passwd").safe, false);
  assert.equal(validatePublicUrlSafety("ftp://example.com/data").safe, false);

  // 正常公网 HTTPS URL 通过
  const valid = validatePublicUrlSafety("https://api.openai.com/v1");
  assert.equal(valid.safe, true);
  assert.equal(valid.url?.hostname, "api.openai.com");

  const validIp = validatePublicUrlSafety("https://203.195.243.42/api");
  assert.equal(validIp.safe, true);
});
