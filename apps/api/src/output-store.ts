import type { Pool } from "pg";
import type { OutputRecord, OutputStore, NewOutput } from "./outputs.js";

interface OutputRow {
  id: string;
  job_id: string;
  user_id: string;
  storage_key: string;
  cover_storage_key: string | null;
  mime_type: string;
  size_bytes: string | number;
  duration_ms: number | null;
  width: number | null;
  height: number | null;
  status: string;
  created_at: Date;
  expires_at: Date | null;
  director_plan?: Record<string, unknown> | null;
  assets?: Array<{ assetId: string; name?: string; kind?: "image" | "video"; size?: number }> | null;
}

function mapOutput(row: OutputRow): OutputRecord {
  const plan = row.director_plan && typeof row.director_plan === "object" ? row.director_plan as Record<string, unknown> : null;
  const publish = plan?.publish && typeof plan.publish === "object" ? plan.publish as Record<string, string | undefined> : undefined;
  const title = typeof plan?.title === "string" ? plan.title.trim() : undefined;
  const assets = Array.isArray(row.assets) ? row.assets : undefined;
  return {
    id: row.id,
    jobId: row.job_id,
    userId: row.user_id,
    storageKey: row.storage_key,
    ...(row.cover_storage_key ? { coverStorageKey: row.cover_storage_key } : {}),
    mimeType: row.mime_type,
    sizeBytes: Number(row.size_bytes),
    durationMs: row.duration_ms ? Number(row.duration_ms) : null,
    width: row.width ? Number(row.width) : null,
    height: row.height ? Number(row.height) : null,
    status: row.status,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    ...(title ? { title } : {}),
    ...(publish ? { publish } : {}),
    ...(plan ? { directorPlan: plan } : {}),
    ...(assets ? { assets } : {}),
  };
}

export function createPgOutputStore(pool: Pool): OutputStore {
  return {
    async createOutput(output: NewOutput) {
      const expiresAt = output.expiresAt ?? new Date(Date.now() + 24 * 60 * 60 * 1000);
      const result = await pool.query<OutputRow>(
        `WITH owned_job AS (
           SELECT id FROM generation_jobs
           WHERE id = $1 AND user_id = $2 AND worker_id = $10 AND status = 'quality-check'
           FOR UPDATE
         )
         INSERT INTO generated_outputs
          (job_id, user_id, storage_key, cover_storage_key, mime_type, size_bytes, duration_ms, width, height, status, expires_at)
         SELECT $1, $2, $3, $11, $4, $5, $6, $7, $8, 'ready', $9
         WHERE $10::text IS NULL OR EXISTS (SELECT 1 FROM owned_job)
         ON CONFLICT (storage_key) DO UPDATE SET
           job_id = EXCLUDED.job_id,
           user_id = EXCLUDED.user_id,
           cover_storage_key = EXCLUDED.cover_storage_key,
           mime_type = EXCLUDED.mime_type,
           size_bytes = EXCLUDED.size_bytes,
           duration_ms = EXCLUDED.duration_ms,
           width = EXCLUDED.width,
           height = EXCLUDED.height,
           status = 'ready',
           expires_at = EXCLUDED.expires_at,
           deleted_at = NULL
         RETURNING *`,
        [
          output.jobId,
          output.userId,
          output.storageKey,
          output.mimeType ?? "video/mp4",
          output.sizeBytes,
          output.durationMs ?? null,
          output.width ?? null,
          output.height ?? null,
          expiresAt,
          output.workerId ?? null,
          output.coverStorageKey ?? null,
        ],
      );
      if (!result.rows[0]) throw new Error(output.workerId ? "WORKER_LEASE_LOST" : "OUTPUT_INSERT_FAILED");
      return mapOutput(result.rows[0]);
    },

    async listUserOutputs(userId: string) {
      const result = await pool.query<OutputRow>(
        `SELECT o.*, j.director_plan,
           coalesce((
             SELECT json_agg(
               json_build_object(
                 'assetId', a.id,
                 'name', a.original_name,
                 'kind', a.media_type,
                 'size', a.size_bytes
               ) ORDER BY ja.sequence_no ASC
             )
             FROM generation_job_assets ja
             JOIN assets a ON a.id = ja.asset_id
             WHERE ja.job_id = o.job_id
           ), '[]'::json) AS assets
         FROM generated_outputs o
         LEFT JOIN generation_jobs j ON j.id = o.job_id
         WHERE o.user_id = $1 AND o.status = 'ready' AND o.deleted_at IS NULL AND (o.expires_at IS NULL OR o.expires_at > now())
         ORDER BY o.created_at DESC`,
        [userId],
      );
      return result.rows.map(mapOutput);
    },

    async findOutputById(userId: string, outputId: string) {
      const result = await pool.query<OutputRow>(
        `SELECT o.*, j.director_plan,
           coalesce((
             SELECT json_agg(
               json_build_object(
                 'assetId', a.id,
                 'name', a.original_name,
                 'kind', a.media_type,
                 'size', a.size_bytes
               ) ORDER BY ja.sequence_no ASC
             )
             FROM generation_job_assets ja
             JOIN assets a ON a.id = ja.asset_id
             WHERE ja.job_id = o.job_id
           ), '[]'::json) AS assets
         FROM generated_outputs o
         LEFT JOIN generation_jobs j ON j.id = o.job_id
         WHERE o.user_id = $1 AND o.id = $2 AND o.status = 'ready' AND o.deleted_at IS NULL AND (o.expires_at IS NULL OR o.expires_at > now())
         LIMIT 1`,
        [userId, outputId],
      );
      const row = result.rows[0];
      return row ? mapOutput(row) : null;
    },

    async findOutputCoverById(userId: string, outputId: string) {
      // 允许在成片过期（24h后）但会话保留期内（7天内，created_at >= now() - 7 days）仍然访问纯净封面缩略图
      const result = await pool.query<{ cover_storage_key: string | null }>(
        "SELECT cover_storage_key FROM generated_outputs WHERE user_id = $1 AND id = $2 AND cover_storage_key IS NOT NULL AND created_at >= (now() - interval '7 days') LIMIT 1",
        [userId, outputId],
      );
      const row = result.rows[0];
      return row?.cover_storage_key ? { coverStorageKey: row.cover_storage_key } : null;
    },

    async incrementDownloadCount(userId: string, outputId: string) {
      await pool.query(
        "UPDATE generated_outputs SET download_count = download_count + 1 WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL",
        [outputId, userId],
      );
    },

    async findExpiredOutputs(now: Date, limit = 100) {
      const result = await pool.query<{ id: string; storage_key: string }>(
        "SELECT id, storage_key FROM generated_outputs WHERE status = 'ready' AND deleted_at IS NULL AND expires_at IS NOT NULL AND expires_at <= $1 ORDER BY expires_at ASC LIMIT $2",
        [now, Math.max(1, Math.min(500, Math.trunc(limit)))],
      );
      return result.rows.map((row) => ({ id: row.id, storageKey: row.storage_key }));
    },

    async markOutputExpired(outputId: string, now: Date) {
      await pool.query(
        "UPDATE generated_outputs SET status = 'expired', deleted_at = $2 WHERE id = $1 AND status = 'ready' AND deleted_at IS NULL AND expires_at IS NOT NULL AND expires_at <= $2",
        [outputId, now],
      );
    },
  };
}

