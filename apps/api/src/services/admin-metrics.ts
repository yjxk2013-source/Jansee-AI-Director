import * as os from "node:os";
import { readFile, statfs } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import type { Pool } from "pg";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const bundledFfmpeg = require("ffmpeg-static") as string | null;

let previousCpuSample: { usageMicros: number; sampledAt: bigint } | undefined;
let previousHostCpuSample: { idle: number; total: number } | undefined;

export async function readCpuUsage(): Promise<number | null> {
  try {
    const [cpuMax, cpuStat] = await Promise.all([
      readFile("/sys/fs/cgroup/cpu.max", "utf8"),
      readFile("/sys/fs/cgroup/cpu.stat", "utf8"),
    ]);
    const [quota = Number.NaN, period = Number.NaN] = cpuMax.trim().split(/\s+/).map(Number);
    const usageLine = cpuStat.split(/\r?\n/).find((line) => line.startsWith("usage_usec "));
    const usageMicros = Number(usageLine?.split(/\s+/)[1]);
    if (quota > 0 && period > 0 && Number.isFinite(usageMicros)) {
      const sampledAt = process.hrtime.bigint();
      const previous = previousCpuSample;
      previousCpuSample = { usageMicros, sampledAt };
      if (!previous || usageMicros < previous.usageMicros) return null;
      const elapsedMicros = Number(sampledAt - previous.sampledAt) / 1000;
      const allocatedCores = quota / period;
      if (elapsedMicros <= 0 || allocatedCores <= 0) return null;
      return Math.max(0, Math.min(100, Math.round((usageMicros - previous.usageMicros) / elapsedMicros / allocatedCores * 1000) / 10));
    }
  } catch {
    // Fall back to host CPU accounting when cgroup v2 metrics are unavailable.
  }
  const cpus = os.cpus();
  let idle = 0;
  let total = 0;
  for (const cpu of cpus) {
    idle += cpu.times.idle;
    total += Object.values(cpu.times).reduce((sum, value) => sum + value, 0);
  }
  const previous = previousHostCpuSample;
  previousHostCpuSample = { idle, total };
  if (!previous || total <= previous.total) return null;
  return Math.max(0, Math.min(100, Math.round((1 - (idle - previous.idle) / (total - previous.total)) * 1000) / 10));
}

export async function readMemoryUsage(): Promise<{ totalBytes: number; freeBytes: number; usedBytes: number; usedPercent: number }> {
  try {
    const [limitText, currentText] = await Promise.all([
      readFile("/sys/fs/cgroup/memory.max", "utf8"),
      readFile("/sys/fs/cgroup/memory.current", "utf8"),
    ]);
    const totalBytes = Number(limitText.trim());
    const usedBytes = Number(currentText.trim());
    if (Number.isFinite(totalBytes) && totalBytes > 0 && Number.isFinite(usedBytes)) {
      const boundedUsed = Math.min(usedBytes, totalBytes);
      return { totalBytes, usedBytes: boundedUsed, freeBytes: totalBytes - boundedUsed, usedPercent: Math.round(boundedUsed / totalBytes * 1000) / 10 };
    }
  } catch {
    // Fall back to host memory accounting when cgroup v2 metrics are unavailable.
  }
  const totalBytes = os.totalmem();
  const freeBytes = os.freemem();
  const usedBytes = totalBytes - freeBytes;
  return { totalBytes, freeBytes, usedBytes, usedPercent: Math.round(usedBytes / totalBytes * 1000) / 10 };
}

export interface DiskUsageStats {
  totalBytes: number;
  freeBytes: number;
  usedBytes: number;
  usedPercent: number | null;
}

export interface MediaStorageStats {
  driver: string;
  bucket: string | null;
  region: string | null;
  activeOutputsCount: number;
  activeOutputsBytes: number;
  activeAssetsCount: number;
  activeAssetsBytes: number;
  totalBytes: number;
}

export async function inspectDiskUsage(): Promise<DiskUsageStats | null> {
  try {
    const value = await statfs(process.env.MEDIA_STORAGE_ROOT || process.cwd());
    const totalBytes = Number(value.blocks) * Number(value.bsize);
    const freeBytes = Number(value.bavail) * Number(value.bsize);
    return {
      totalBytes,
      freeBytes,
      usedBytes: Math.max(0, totalBytes - freeBytes),
      usedPercent: totalBytes > 0 ? Math.round((totalBytes - freeBytes) / totalBytes * 1000) / 10 : null,
    };
  } catch {
    return null;
  }
}

export async function testFfmpegExecutable(): Promise<boolean> {
  return execFileAsync(bundledFfmpeg ?? "ffmpeg", ["-version"], { timeout: 2500, windowsHide: true })
    .then(() => true)
    .catch(() => false);
}

export async function queryMediaStorageStats(pool?: Pool): Promise<MediaStorageStats | null> {
  if (!pool) return null;
  try {
    const res = await pool.query<{ outputs_count: string; outputs_bytes: string; assets_count: string; assets_bytes: string }>(
      `SELECT
         (SELECT count(*) FROM generated_outputs WHERE deleted_at IS NULL AND (expires_at IS NULL OR expires_at > now())) as outputs_count,
         (SELECT coalesce(sum(size_bytes), 0) FROM generated_outputs WHERE deleted_at IS NULL AND (expires_at IS NULL OR expires_at > now())) as outputs_bytes,
         (SELECT count(*) FROM assets WHERE deleted_at IS NULL AND (expires_at IS NULL OR expires_at > now())) as assets_count,
         (SELECT coalesce(sum(size_bytes), 0) FROM assets WHERE deleted_at IS NULL AND (expires_at IS NULL OR expires_at > now())) as assets_bytes`
    );
    const row = res.rows[0];
    if (!row) return null;
    const outputsBytes = Number(row.outputs_bytes) || 0;
    const assetsBytes = Number(row.assets_bytes) || 0;
    return {
      driver: process.env.MEDIA_STORAGE_DRIVER ?? "local",
      bucket: process.env.COS_BUCKET ?? null,
      region: process.env.COS_REGION ?? null,
      activeOutputsCount: Number(row.outputs_count) || 0,
      activeOutputsBytes: outputsBytes,
      activeAssetsCount: Number(row.assets_count) || 0,
      activeAssetsBytes: assetsBytes,
      totalBytes: outputsBytes + assetsBytes,
    };
  } catch {
    return null;
  }
}
