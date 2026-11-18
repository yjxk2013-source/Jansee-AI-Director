import type { Pool } from "pg";
import type { AssetRecord, AssetStore } from "./assets.js";

export function createPgAssetStore(pool: Pool): AssetStore {
  return {
    async createAssets(userId, assets) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        for (const a of assets) {
          await client.query(
            "INSERT INTO assets (id,user_id,original_name,media_type,mime_type,size_bytes,sha256,storage_key,status,expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'uploaded',$9)",
            [a.id, userId, a.originalName, a.mediaType, a.mimeType, a.sizeBytes, a.sha256, a.storageKey, a.expiresAt ?? new Date(Date.now() + 24 * 60 * 60 * 1000)],
          );
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
    async findUserAssets(userId, assetIds) {
      if (assetIds.length === 0) return [];
      const result = await pool.query<{
        id: string;
        original_name: string;
        media_type: "image" | "video";
        mime_type: string;
        size_bytes: string | number;
        sha256: string;
        storage_key: string;
      }>(
        "SELECT id, original_name, media_type, mime_type, size_bytes, sha256, storage_key FROM assets WHERE user_id = $1 AND id = ANY($2::uuid[]) AND deleted_at IS NULL",
        [userId, assetIds],
      );
      return result.rows.map((r) => ({
        id: r.id,
        originalName: r.original_name,
        mediaType: r.media_type,
        mimeType: r.mime_type,
        sizeBytes: Number(r.size_bytes),
        sha256: r.sha256,
        storageKey: r.storage_key,
      }));
    },
    async listUserAssets(userId) {
      const result = await pool.query<{
        id: string;
        original_name: string;
        media_type: "image" | "video";
        mime_type: string;
        size_bytes: string | number;
        sha256: string;
        storage_key: string;
        status: string;
        created_at: Date;
        expires_at: Date | null;
      }>(
        "SELECT id, original_name, media_type, mime_type, size_bytes, sha256, storage_key, status, created_at, expires_at FROM assets WHERE user_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC",
        [userId],
      );
      return result.rows.map((r) => ({
        id: r.id,
        originalName: r.original_name,
        mediaType: r.media_type,
        mimeType: r.mime_type,
        sizeBytes: Number(r.size_bytes),
        sha256: r.sha256,
        storageKey: r.storage_key,
        status: r.status,
        createdAt: r.created_at,
        expiresAt: r.expires_at,
      }));
    },
    async deleteAsset(userId, assetId) {
      const result = await pool.query<{ storage_key: string }>(
        "UPDATE assets SET status = 'deleted', deleted_at = now() WHERE user_id = $1 AND id = $2 AND deleted_at IS NULL RETURNING storage_key",
        [userId, assetId],
      );
      const row = result.rows[0];
      return row ? { storageKey: row.storage_key } : null;
    },
    async findExpiredAssets(cutoff, limit = 100) {
      const result = await pool.query<{ id: string; user_id: string; storage_key: string }>(
        `SELECT a.id, a.user_id, a.storage_key
         FROM assets a
         WHERE ((a.expires_at IS NOT NULL AND a.expires_at <= $1) OR (a.status = 'deleted' AND a.deleted_at <= $1))
           AND a.status != 'expired'
           AND NOT EXISTS (
             SELECT 1 FROM generation_job_assets ja
             JOIN generation_jobs j ON j.id = ja.job_id
             WHERE ja.asset_id = a.id
               AND j.status IN ('queued', 'inspecting', 'planning', 'rendering', 'quality-check')
           )
         ORDER BY coalesce(a.expires_at, a.deleted_at) ASC
         LIMIT $2`,
        [cutoff, limit],
      );
      return result.rows.map((r) => ({ id: r.id, userId: r.user_id, storageKey: r.storage_key }));
    },
    async markAssetsExpired(ids) {
      if (ids.length === 0) return;
      await pool.query("UPDATE assets SET status = 'expired', deleted_at = coalesce(deleted_at, now()) WHERE id = ANY($1::uuid[])", [ids]);
    },
  };
}
