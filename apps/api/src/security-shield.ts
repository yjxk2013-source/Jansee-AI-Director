import { isIP } from "node:net";

export type DetectedMedia = {
  mediaType: "image" | "video" | "audio";
  mimeType: string;
};

/**
 * 校验二进制 Buffer 的魔数（Magic Bytes）特征，精准识别文件真实类型。
 * 杜绝伪装文件、脚本木马或恶意二进制流注入。
 */
export function detectMediaMagicBytes(bytes: Buffer): DetectedMedia | null {
  if (!bytes || bytes.length < 2) return null;

  // 1. GIF 图片 (GIF87a / GIF89a)
  if (bytes.length >= 6 && ["GIF87a", "GIF89a"].includes(bytes.toString("ascii", 0, 6))) {
    return { mediaType: "image", mimeType: "image/gif" };
  }

  // 2. BMP 图片 (BM)
  if (bytes.length >= 2 && bytes.toString("ascii", 0, 2) === "BM") {
    return { mediaType: "image", mimeType: "image/bmp" };
  }

  // 3. TIFF 图片 (Little-endian: II*\0 或 Big-endian: MM\0*)
  if (
    bytes.length >= 4 &&
    ((bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2a && bytes[3] === 0x00) ||
      (bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0x00 && bytes[3] === 0x2a))
  ) {
    return { mediaType: "image", mimeType: "image/tiff" };
  }

  // 4. JPEG / JPG 图片 (\xFF\xD8\xFF)
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { mediaType: "image", mimeType: "image/jpeg" };
  }

  // 5. PNG 图片 (\x89PNG\r\n\x1a\n)
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return { mediaType: "image", mimeType: "image/png" };
  }

  // 6. WebP 图片 (RIFF....WEBP)
  if (
    bytes.length >= 12 &&
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP"
  ) {
    return { mediaType: "image", mimeType: "image/webp" };
  }

  // 7. WAV 音频 (RIFF....WAVE)
  if (
    bytes.length >= 12 &&
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WAVE"
  ) {
    return { mediaType: "audio", mimeType: "audio/wav" };
  }

  // 8. OGG 音频/视频容器 (OggS)
  if (bytes.length >= 4 && bytes.toString("ascii", 0, 4) === "OggS") {
    return { mediaType: "audio", mimeType: "audio/ogg" };
  }

  // 9. WebM 视频 / Matroska MKV (\x1A\x45\xDF\xA3)
  if (bytes.length >= 4 && bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) {
    // 兼容 webm 音频/视频
    return { mediaType: "video", mimeType: "video/webm" };
  }

  // 10. MP4 / MOV / HEIC / AVIF (ftyp box at offset 4..8)
  if (bytes.length >= 12 && bytes.toString("ascii", 4, 8) === "ftyp") {
    const brand = bytes.toString("ascii", 8, 12).toLowerCase();
    if (["heic", "heix", "hevc", "hevx", "mif1", "msf1", "heif", "heim"].includes(brand)) {
      return { mediaType: "image", mimeType: "image/heic" };
    }
    if (["avif", "avis"].includes(brand)) {
      return { mediaType: "image", mimeType: "image/avif" };
    }
    if (brand === "qt  ") {
      return { mediaType: "video", mimeType: "video/quicktime" };
    }
    if (["m4a ", "m4b "].includes(brand)) {
      return { mediaType: "audio", mimeType: "audio/mp4" };
    }
    return { mediaType: "video", mimeType: "video/mp4" };
  }

  // 11. MP3 音频 (ID3v2 标签 \x49\x44\x33 或 MPEG Sync \xFF\xFB, \xFF\xF3, \xFF\xF2)
  if (bytes.length >= 3 && bytes.toString("ascii", 0, 3) === "ID3") {
    return { mediaType: "audio", mimeType: "audio/mpeg" };
  }
  const b0 = bytes[0];
  const b1 = bytes[1];
  if (bytes.length >= 2 && b0 !== undefined && b1 !== undefined && b0 === 0xff && (b1 & 0xe0) === 0xe0 && (b1 & 0x06) !== 0) {
    return { mediaType: "audio", mimeType: "audio/mpeg" };
  }

  // 12. FLAC 音频 (fLaC)
  if (bytes.length >= 4 && bytes.toString("ascii", 0, 4) === "fLaC") {
    return { mediaType: "audio", mimeType: "audio/flac" };
  }

  return null;
}

/**
 * 判断目标 IP 地址是否为内网私有地址、回环地址或云厂商保留元数据地址。
 * 防御 SSRF（服务端请求伪造）攻击。
 */
export function isPrivateOrReservedIp(ip: string): boolean {
  const version = isIP(ip);
  if (version === 0) return true; // 非法 IP 格式直接拒绝

  // IPv4 检查
  if (version === 4) {
    const parts = ip.split(".").map(Number);
    if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) return true;

    const a = parts[0];
    const b = parts[1];
    if (a === undefined || b === undefined) return true;

    // 0.0.0.0/8 (当前网络)
    if (a === 0) return true;
    // 127.0.0.0/8 (回环地址)
    if (a === 127) return true;
    // 10.0.0.0/8 (私有内网)
    if (a === 10) return true;
    // 172.16.0.0/12 (私有内网: 172.16.0.0 - 172.31.255.255)
    if (a === 172 && b >= 16 && b <= 31) return true;
    // 192.168.0.0/16 (私有内网)
    if (a === 192 && b === 168) return true;
    // 169.254.0.0/16 (链路本地 / 云厂商元数据服务 169.254.169.254)
    if (a === 169 && b === 254) return true;
    // 100.64.0.0/10 (运营商级 NAT / 共享地址空间)
    if (a === 100 && b >= 64 && b <= 127) return true;
    // 224.0.0.0/4 (多播地址)
    if (a >= 224 && a <= 239) return true;
    // 240.0.0.0/4 (保留地址)
    if (a >= 240) return true;

    return false;
  }

  // IPv6 检查
  if (version === 6) {
    const normalized = ip.toLowerCase();
    // 回环 ::1
    if (normalized === "::1" || normalized === "0:0:0:0:0:0:0:1") return true;
    // 未指定 ::
    if (normalized === "::" || normalized === "0:0:0:0:0:0:0:0") return true;
    // 唯一本地 fe80::/10 (链路本地)
    if (normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb")) return true;
    // 私有 fc00::/7 (fc00:: ~ fdff::)
    if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
    // IPv4 映射地址 ::ffff:x.x.x.x
    if (normalized.startsWith("::ffff:")) {
      const v4Part = normalized.slice(7);
      return isPrivateOrReservedIp(v4Part);
    }
    return false;
  }

  return true;
}

/**
 * 校验对外请求的 URL 是否合法且不属于 SSRF 高危目标。
 * 必须使用 HTTPS / HTTP 协议，且域名解析的 IP 绝不能指向内网或云厂商元数据。
 */
export function validatePublicUrlSafety(inputUrl: string): { safe: boolean; reason?: string; url?: URL } {
  try {
    const parsed = new URL(inputUrl);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return { safe: false, reason: "UNSUPPORTED_PROTOCOL" };
    }

    const hostname = parsed.hostname.toLowerCase();
    // 阻断 localhost 或常见本地别名
    if (
      hostname === "localhost" ||
      hostname.endsWith(".localhost") ||
      hostname.endsWith(".local") ||
      hostname.endsWith(".internal")
    ) {
      return { safe: false, reason: "LOCAL_HOST_BLOCKED" };
    }

    // 若直接为 IP 地址，做严格网段检查
    if (isIP(hostname)) {
      if (isPrivateOrReservedIp(hostname)) {
        return { safe: false, reason: "PRIVATE_IP_BLOCKED" };
      }
    }

    return { safe: true, url: parsed };
  } catch {
    return { safe: false, reason: "INVALID_URL" };
  }
}
