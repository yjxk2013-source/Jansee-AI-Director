import test from "node:test";
import assert from "node:assert/strict";
import type { Pool } from "pg";
import { createPgAssetStore } from "../apps/api/src/asset-store.js";

test("asset persistence always stores an explicit 24-hour retention deadline", async () => {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const client = {
    async query(sql: string, values: unknown[] = []) { calls.push({ sql, values }); return { rows: [], rowCount: 1 }; },
    release() {},
  };
  const pool = { async connect() { return client; } } as unknown as Pool;
  const store = createPgAssetStore(pool);
  const uploadedAt = Date.now();
  await store.createAssets("user-a", [{
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    originalName: "clip.mp4",
    mediaType: "video",
    mimeType: "video/mp4",
    sizeBytes: 10,
    sha256: "a".repeat(64),
    storageKey: "users/user-a/clip",
  }]);
  const insert = calls.find((call) => call.sql.includes("INSERT INTO assets"));
  assert.ok(insert);
  assert.match(insert.sql, /expires_at/);
  const expiry = insert.values[8] as Date;
  assert.ok(expiry instanceof Date);
  assert.ok(expiry.getTime() >= uploadedAt + 23 * 60 * 60 * 1000);
  assert.ok(expiry.getTime() <= uploadedAt + 25 * 60 * 60 * 1000);
});

test("asset expiry sweep never deletes assets still used by active generation jobs", async () => {
  let sql = "";
  let values: unknown[] = [];
  const pool = {
    async query(query: string, params: unknown[]) { sql = query; values = params; return { rows: [], rowCount: 0 }; },
  } as unknown as Pool;
  const store = createPgAssetStore(pool);
  await store.findExpiredAssets!(new Date("2026-11-16T00:00:00.000Z"), 25);
  assert.match(sql, /NOT EXISTS/i);
  assert.match(sql, /generation_job_assets/i);
  assert.match(sql, /generation_jobs/i);
  assert.match(sql, /'queued'.*'inspecting'.*'planning'.*'rendering'.*'quality-check'/s);
  assert.deepEqual(values, [new Date("2026-11-16T00:00:00.000Z"), 25]);
});

test("multiple upload batches are persisted without a daily count gate", async () => {
  const calls: string[] = [];
  const client = {
    async query(sql: string) { calls.push(sql); return { rows: [], rowCount: 1 }; },
    release() {},
  };
  const pool = { async connect() { return client; } } as unknown as Pool;
  const store = createPgAssetStore(pool);
  for (let batch = 0; batch < 4; batch++) {
    const assets = Array.from({ length: batch === 3 ? 4 : 9 }, (_, index) => ({
      id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(batch * 9 + index + 1).padStart(12, "0")}`,
      originalName: "clip.mp4",
      mediaType: "video" as const,
      mimeType: "video/mp4",
      sizeBytes: 10,
      sha256: "a".repeat(64),
      storageKey: `users/user-a/${batch}-${index}`,
    }));
    await store.createAssets("user-a", assets);
  }
  assert.equal(calls.filter((sql) => sql.includes("INSERT INTO assets")).length, 31);
  assert.equal(calls.some((sql) => /count\(\*\)|upload-quota|pg_advisory_xact_lock/i.test(sql)), false);
  assert.equal(calls.filter((sql) => sql === "COMMIT").length, 4);
});
