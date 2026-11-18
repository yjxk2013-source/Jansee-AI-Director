// IP 归属地只解析为省/市并写入用户资料，不保存原始 IP。
import { IP2Region } from "ip2region/node";

let database: InstanceType<typeof IP2Region> | null = null;
try {
  database = new IP2Region({ families: [4, 6], mappedIPv6: "ipv4" });
} catch {
  database = null;
}

function isPrivateOrLocalIp(ip: string): boolean {
  const value = ip.toLowerCase();
  return value === "::1" || value === "localhost" ||
    value.startsWith("127.") || value.startsWith("10.") ||
    value.startsWith("192.168.") || /^172\.(1[6-9]|2\d|3[01])\./.test(value) ||
    value.startsWith("169.254.") || value.startsWith("fc") ||
    value.startsWith("fd") || value.startsWith("fe80:");
}

export function resolveRegistrationRegion(ip: string): { province: string | null; city: string | null; label: string } {
  const value = String(ip || "").trim();
  if (!value || isPrivateOrLocalIp(value)) {
    return { province: null, city: null, label: "未知地区" };
  }
  try {
    const result = database?.lookup(value);
    const clean = (part: unknown) => typeof part === "string" && part !== "0" && part !== "未知" && part !== "N/A" ? part : null;
    const province = clean(result?.subdivisions?.[0]?.name) ?? null;
    const city = clean(result?.city?.name) ?? null;
    return { province, city, label: [province, city].filter(Boolean).join(" / ") || "未知地区" };
  } catch {
    return { province: null, city: null, label: "未知地区" };
  }
}
