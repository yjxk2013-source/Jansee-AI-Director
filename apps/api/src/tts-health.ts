import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { TENCENT_VOICE_CANDIDATES, applyTencentVoiceHealthSnapshot, probeTencentVoiceType, registerTencentVoiceUnavailableHandler } from "@jansee/tts-kit";

const VOICE_HEALTH_LOCK_ID = 741_202_612;

type ProbeStatus = "healthy" | "unavailable" | "unknown";

interface VoiceProbeResult {
  voiceType: number;
  gender: "male" | "female";
  language: string;
  label: string;
  status: ProbeStatus;
  latencyMs: number | null;
  errorCode: string | null;
  reason: string | null;
}

function isDefinitiveVoiceUnavailable(errorCode: string, reason: string): boolean {
  return /InvalidParameterValue\.VoiceType|VoiceTypeNotFound|NoSuchVoice|VoiceNotFound|VoiceUnavailable|VoiceNotSupported|UnsupportedVoiceType/i.test(
    `${errorCode} ${reason}`,
  );
}

function probeLanguages(language: string): string[] {
  if (language === "zh-en") return ["zh", "en"];
  return [language];
}

export async function loadTencentVoiceHealth(pool: Pool): Promise<number> {
  registerTencentVoiceUnavailableHandler(async ({ voiceType, reason }: { voiceType: number; reason: string }) => {
    const candidate = TENCENT_VOICE_CANDIDATES.find((item) => item.voiceType === voiceType);
    if (!candidate) return;
    await pool.query(
      `INSERT INTO tts_voice_health
        (voice_type, gender, language, label, status, last_probe_status, error_code, reason, checked_at, updated_at)
       VALUES ($1, $2, $3, $4, 'unavailable', 'unavailable', 'LIVE_SYNTHESIS_VOICE_FAILURE', $5, now(), now())
       ON CONFLICT (voice_type) DO UPDATE SET
        status = 'unavailable', last_probe_status = 'unavailable',
        error_code = 'LIVE_SYNTHESIS_VOICE_FAILURE', reason = EXCLUDED.reason,
        checked_at = now(), updated_at = now()`,
      [voiceType, candidate.gender, candidate.language, candidate.label, reason],
    );
    const current = await pool.query<{ voice_type: number; status: ProbeStatus }>(
      "SELECT voice_type, status FROM tts_voice_health",
    );
    applyTencentVoiceHealthSnapshot(current.rows.map((row) => ({ voiceType: Number(row.voice_type), status: row.status })));
  });
  const result = await pool.query<{ voice_type: number; status: ProbeStatus }>(
    "SELECT voice_type, status FROM tts_voice_health",
  );
  applyTencentVoiceHealthSnapshot(result.rows.map((row) => ({
    voiceType: Number(row.voice_type),
    status: row.status,
  })));
  return result.rows.length;
}

/** 每次对腾讯真实合成接口发起短文本探测；只有明确的 VoiceType 无效错误才会下架音色。 */
export async function runTencentVoiceHealthCheck(
  pool: Pool,
  trigger: "startup" | "schedule" | "manual",
): Promise<{
  skipped: boolean;
  status?: "healthy" | "degraded" | "failed";
  totalCount?: number;
  healthyCount?: number;
  unavailableCount?: number;
  unknownCount?: number;
  replacementMap?: Record<string, number>;
}> {
  const client = await pool.connect();
  let lockAcquired = false;
  try {
    const lock = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock($1) AS locked",
      [VOICE_HEALTH_LOCK_ID],
    );
    lockAcquired = Boolean(lock.rows[0]?.locked);
    if (!lockAcquired) return { skipped: true };

    const startedAt = new Date();
    const grouped = new Map<number, {
      voiceType: number;
      gender: "male" | "female";
      languages: Set<string>;
      labels: Set<string>;
    }>();
    for (const candidate of TENCENT_VOICE_CANDIDATES) {
      const existing = grouped.get(candidate.voiceType) || {
        voiceType: candidate.voiceType,
        gender: candidate.gender,
        languages: new Set<string>(),
        labels: new Set<string>(),
      };
      existing.languages.add(candidate.language);
      existing.labels.add(candidate.label);
      grouped.set(candidate.voiceType, existing);
    }

    const results: VoiceProbeResult[] = [];
    for (const candidate of grouped.values()) {
      const languages = [...candidate.languages].flatMap(probeLanguages);
      let latencyMs = 0;
      let status: ProbeStatus = "healthy";
      let errorCode: string | null = null;
      let reason: string | null = null;

      for (const language of [...new Set(languages)]) {
        const probe = await probeTencentVoiceType(candidate.voiceType, language);
        latencyMs += Number(probe.latencyMs || 0);
        if (probe.ok) continue;

        errorCode = String(probe.errorCode || "TTS_PROBE_FAILED");
        reason = String(probe.reason || "腾讯云未返回有效语音").slice(0, 500);
        status = isDefinitiveVoiceUnavailable(errorCode, reason) ? "unavailable" : "unknown";
        break;
      }

      results.push({
        voiceType: candidate.voiceType,
        gender: candidate.gender,
        language: [...candidate.languages].sort().join(","),
        label: [...candidate.labels].join(" / ").slice(0, 180),
        status,
        latencyMs: status === "unknown" && latencyMs === 0 ? null : latencyMs,
        errorCode,
        reason,
      });
    }

    for (const result of results) {
      await client.query(
        `INSERT INTO tts_voice_health
          (voice_type, gender, language, label, status, last_probe_status, latency_ms, error_code, reason, checked_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $5, $6, $7, $8, now(), now())
         ON CONFLICT (voice_type) DO UPDATE SET
          gender = EXCLUDED.gender,
          language = EXCLUDED.language,
          label = EXCLUDED.label,
          status = EXCLUDED.status,
          last_probe_status = EXCLUDED.last_probe_status,
          latency_ms = EXCLUDED.latency_ms,
          error_code = EXCLUDED.error_code,
          reason = EXCLUDED.reason,
          checked_at = now(),
          updated_at = now()`,
        [
          result.voiceType,
          result.gender,
          result.language,
          result.label,
          result.status,
          result.latencyMs,
          result.errorCode,
          result.reason,
        ],
      );
    }

    const stored = await client.query<{ voice_type: number; status: ProbeStatus }>(
      "SELECT voice_type, status FROM tts_voice_health",
    );
    const replacementMap = applyTencentVoiceHealthSnapshot(stored.rows.map((row) => ({
      voiceType: Number(row.voice_type),
      status: row.status,
    })));

    const healthyCount = results.filter((item) => item.status === "healthy").length;
    const unavailableCount = results.filter((item) => item.status === "unavailable").length;
    const unknownCount = results.filter((item) => item.status === "unknown").length;
    const status = healthyCount === 0 && unavailableCount === 0
      ? "failed"
      : unavailableCount > 0 || unknownCount > 0
        ? "degraded"
        : "healthy";

    await client.query(
      `INSERT INTO tts_voice_probe_runs
        (id, trigger, status, total_count, healthy_count, unavailable_count, unknown_count, details, started_at, completed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, now())`,
      [
        randomUUID(),
        trigger,
        status,
        results.length,
        healthyCount,
        unavailableCount,
        unknownCount,
        JSON.stringify(results),
        startedAt,
      ],
    );

    return {
      skipped: false,
      status,
      totalCount: results.length,
      healthyCount,
      unavailableCount,
      unknownCount,
      replacementMap,
    };
  } finally {
    if (lockAcquired) {
      try {
        await client.query("SELECT pg_advisory_unlock($1)", [VOICE_HEALTH_LOCK_ID]);
      } catch {
        // Releasing the client also releases a session-scoped advisory lock.
      }
    }
    client.release();
  }
}
