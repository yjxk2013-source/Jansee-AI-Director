import type { Pool } from "pg";
import type { CreationMode, AspectRatio, JobStatus } from "@jansee/contracts";
import { assertJobTransition } from "@jansee/domain";
import type { GenerationJobRecord, JobStore, CreateJobRequest } from "./jobs.js";

interface JobRow {
  id: string;
  user_id: string;
  mode: string;
  status: string;
  prompt: string;
  aspect_ratio: string;
  idempotency_key: string;
  request_payload: unknown;
  director_plan: unknown;
  progress: number;
  error_code: string | null;
  error_message: string | null;
  queued_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

function mapJob(row: JobRow, assetIds: string[]): GenerationJobRecord {
  return {
    id: row.id,
    userId: row.user_id,
    mode: row.mode as CreationMode,
    status: row.status as JobStatus,
    prompt: row.prompt,
    aspectRatio: row.aspect_ratio as AspectRatio,
    idempotencyKey: row.idempotency_key,
    requestPayload: (row.request_payload as Record<string, unknown>) ?? {},
    directorPlan: (row.director_plan as Record<string, unknown>) ?? null,
    progress: Number(row.progress),
    errorCode: row.error_code,
    errorMessage: row.error_message,
    queuedAt: row.queued_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    assetIds,
  };
}

export function createPgJobStore(pool: Pool): JobStore {
  return {
    async createJob(userId, input) {
      // 幂等去重检查
      const existing = await pool.query<JobRow>(
        "SELECT * FROM generation_jobs WHERE user_id = $1 AND idempotency_key = $2 LIMIT 1",
        [userId, input.idempotencyKey],
      );
      if (existing.rows[0]) {
        const assetsRes = await pool.query<{ asset_id: string }>(
          "SELECT asset_id FROM generation_job_assets WHERE job_id = $1 ORDER BY sequence_no ASC",
          [existing.rows[0].id],
        );
        return mapJob(existing.rows[0], assetsRes.rows.map((r) => r.asset_id));
      }

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const jobResult = await client.query<JobRow>(
          `INSERT INTO generation_jobs
            (user_id, mode, prompt, aspect_ratio, idempotency_key, request_payload, director_plan, status, progress)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'queued', 0)
           RETURNING *`,
          [
            userId,
            input.mode,
            input.prompt,
            input.aspectRatio,
            input.idempotencyKey,
            JSON.stringify(input),
            input.directorPlan ? JSON.stringify(input.directorPlan) : null,
          ],
        );
        const row = jobResult.rows[0]!;

        for (let i = 0; i < input.assetIds.length; i += 1) {
          await client.query(
            "INSERT INTO generation_job_assets (job_id, asset_id, user_id, sequence_no) VALUES ($1, $2, $3, $4)",
            [row.id, input.assetIds[i]!, userId, i + 1],
          );
        }

        await client.query("COMMIT");
        return mapJob(row, input.assetIds);
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },

    async findJobById(userId, jobId) {
      const result = await pool.query<JobRow>(
        "SELECT * FROM generation_jobs WHERE user_id = $1 AND id = $2 LIMIT 1",
        [userId, jobId],
      );
      const row = result.rows[0];
      if (!row) return null;

      const assetsRes = await pool.query<{ asset_id: string }>(
        "SELECT asset_id FROM generation_job_assets WHERE job_id = $1 ORDER BY sequence_no ASC",
        [jobId],
      );
      return mapJob(row, assetsRes.rows.map((r) => r.asset_id));
    },

    async findUserActiveJob(userId) {
      const result = await pool.query<JobRow>(
        `SELECT * FROM generation_jobs
         WHERE user_id = $1
           AND status IN ('queued', 'inspecting', 'planning', 'rendering', 'quality-check')
         ORDER BY created_at DESC
         LIMIT 1`,
        [userId],
      );
      const row = result.rows[0];
      if (!row) return null;

      const assetsRes = await pool.query<{ asset_id: string }>(
        "SELECT asset_id FROM generation_job_assets WHERE job_id = $1 ORDER BY sequence_no ASC",
        [row.id],
      );
      return mapJob(row, assetsRes.rows.map((r) => r.asset_id));
    },

    async updateDirectorPlan(userId, jobId, directorPlan, workerId) {
      const result = await pool.query(
        `UPDATE generation_jobs
         SET director_plan = $1::jsonb, updated_at = now()
         WHERE user_id = $2 AND id = $3
           AND ($4::text IS NULL OR worker_id = $4)`,
        [JSON.stringify(directorPlan), userId, jobId, workerId ?? null],
      );
      if (workerId && (result.rowCount ?? 0) !== 1) throw new Error("WORKER_LEASE_LOST");
    },

    async heartbeatJob(userId, jobId, workerId, leaseSeconds = 120) {
      const result = await pool.query(
        `UPDATE generation_jobs
         SET lease_expires_at = now() + make_interval(secs => $4),
             last_heartbeat_at = now(),
             updated_at = now()
         WHERE user_id = $1 AND id = $2 AND worker_id = $3
           AND status IN ('inspecting', 'planning', 'rendering', 'quality-check')`,
        [userId, jobId, workerId, leaseSeconds],
      );
      return (result.rowCount ?? 0) === 1;
    },

    async updateJobStatus(userId, jobId, toStatus, progress, error, workerId) {
      // SELECT ... FOR UPDATE must share a transaction with the UPDATE. A pool-level
      // query runs in its own autocommit transaction and releases the row lock
      // before the state transition is written, allowing concurrent workers to race.
      const client = await pool.connect();
      let updatedRow: JobRow | null = null;
      try {
        await client.query("BEGIN");
        const currentRes = await client.query<{ status: string; worker_id: string | null }>(
          "SELECT status, worker_id FROM generation_jobs WHERE user_id = $1 AND id = $2 FOR UPDATE",
          [userId, jobId],
        );
        const currentRow = currentRes.rows[0];
        if (workerId && currentRow?.worker_id !== workerId) throw new Error("WORKER_LEASE_LOST");
        const current = currentRow?.status as JobStatus | undefined;
        if (!current) {
          await client.query("COMMIT");
          return null;
        }

        assertJobTransition(current, toStatus);

        const updateResult = await client.query<JobRow>(
          `UPDATE generation_jobs
           SET status = $1,
               progress = coalesce($2, progress),
               error_code = CASE WHEN $1 = 'failed' THEN $3 ELSE NULL END,
               error_message = CASE WHEN $1 = 'failed' THEN $4 ELSE NULL END,
               started_at = CASE WHEN $1 = 'inspecting' AND started_at IS NULL THEN now() ELSE started_at END,
               finished_at = CASE WHEN $1 IN ('completed', 'failed', 'cancelled') THEN now() ELSE finished_at END,
               worker_id = CASE WHEN $1 IN ('completed', 'failed', 'cancelled') THEN NULL ELSE worker_id END,
               lease_expires_at = CASE WHEN $1 IN ('completed', 'failed', 'cancelled') THEN NULL ELSE lease_expires_at END,
               updated_at = now()
           WHERE user_id = $5 AND id = $6
           RETURNING *`,
          [toStatus, progress ?? null, error?.code ?? null, error?.message ?? null, userId, jobId],
        );
        updatedRow = updateResult.rows[0] ?? null;
        await client.query("COMMIT");
      } catch (cause) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw cause;
      } finally {
        client.release();
      }

      if (!updatedRow) return null;
      const assetsRes = await pool.query<{ asset_id: string }>(
        "SELECT asset_id FROM generation_job_assets WHERE job_id = $1 ORDER BY sequence_no ASC",
        [jobId],
      );
      return mapJob(updatedRow, assetsRes.rows.map((r) => r.asset_id));
    },
  };
}

