// 简兮后端 · ttsProbe.mjs —— 腾讯云 TTS 账号级探活（每日 04:00 错峰自检）
// 依据（2026-10-12 定版）：腾讯 TTS 所有音色共用同一账号接口，失效为账号级，
// 单次极短合成探活即可判定账号健康，无需逐音色检查。
// 结果落盘 DATA_DIR/tts_probe.json 供运维查看；探活失败仅告警，不触碰任何出片链路。
import fsp from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DATA_DIR } from './paths.mjs';
import { resolveTTSProvider } from '@jansee/tts-kit/ttsProvider.js';

const PROBE_HOUR = 4; // 每日 04:00 错峰探活（业务低谷）
const RESULT_FILE = path.join(DATA_DIR, 'tts_probe.json');
const PROBE_VOICE_ID = 101027; // 温柔女声（全链未命中兜底同款，代表账号级可用性）
let started = false;

export async function probeOnce(trigger = 'schedule') {
  const t0 = Date.now();
  const tmp = path.join(os.tmpdir(), `jx_tts_probe_${Date.now()}.mp3`);
  let result;
  try {
    const { provider } = resolveTTSProvider();
    const r = await provider.synthesize({ text: '探活', voiceId: PROBE_VOICE_ID, outPath: tmp, speed: 1 });
    result = { ok: !!r?.ok, reason: r?.ok ? '' : String(r?.reason || '未知原因').slice(0, 200) };
  } catch (e) {
    result = { ok: false, reason: String(e?.message || e).slice(0, 200) };
  } finally {
    fsp.unlink(tmp).catch(() => {});
  }
  result.latencyMs = Date.now() - t0;
  result.probedAt = new Date().toISOString();
  result.trigger = trigger;
  try {
    fsSync.mkdirSync(DATA_DIR, { recursive: true });
    fsSync.writeFileSync(RESULT_FILE, JSON.stringify(result, null, 2), 'utf8');
  } catch (_) {
    /* 结果落盘失败不影响告警 */
  }
  if (result.ok) {
    console.log(`[TTS PROBE] 探活成功（${result.latencyMs}ms, ${trigger}）`);
  } else {
    console.error(`[TTS PROBE] 探活失败（${trigger}）：${result.reason}`);
  }
  return result;
}

function scheduleDailyProbe() {
  const now = new Date();
  const next = new Date(now);
  next.setHours(PROBE_HOUR, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  setTimeout(async () => {
    await probeOnce('schedule').catch(() => {});
    scheduleDailyProbe(); // 链式续约：进程常驻期间每日 04:00 各一次
  }, next.getTime() - now.getTime()).unref?.();
}

// 网关入口挂载：启动 30s 后先探一次（进程重启后尽快暴露账号级失效），此后每日 04:00 错峰自检
export function startTtsProbe() {
  if (started) return;
  started = true;
  setTimeout(() => {
    probeOnce('startup').catch(() => {});
  }, 30 * 1000).unref?.();
  scheduleDailyProbe();
}
