import test from "node:test";
import assert from "node:assert/strict";
import type { Pool } from "pg";
import { createPgOutputStore } from "../apps/api/src/output-store.js";

const outputRow = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  job_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  user_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  storage_key: "users/test/outputs/job",
  mime_type: "video/mp4",
  size_bytes: 1234,
  duration_ms: 12000,
  width: 1080,
  height: 1920,
  status: "ready",
  created_at: new Date(),
  expires_at: new Date(Date.now() + 86400000),
};

test("output publication is locked to the worker that still owns a quality-checked job", async () => {
  let queryText = "";
  let queryValues: unknown[] = [];
  const pool = {
    async query(sql: string, values: unknown[]) {
      queryText = sql;
      queryValues = values;
      return { rows: [outputRow], rowCount: 1 };
    },
  } as unknown as Pool;
  const store = createPgOutputStore(pool);

  const output = await store.createOutput({
    jobId: outputRow.job_id,
    userId: outputRow.user_id,
    storageKey: outputRow.storage_key,
    sizeBytes: 1234,
    workerId: "worker-current",
  });

  assert.equal(output.status, "ready");
  assert.match(queryText, /WITH owned_job AS/i);
  assert.match(queryText, /FOR UPDATE/i);
  assert.match(queryText, /worker_id = \$10 AND status = 'quality-check'/i);
  assert.deepEqual(queryValues.slice(0, 3), [outputRow.job_id, outputRow.user_id, outputRow.storage_key]);
  assert.equal(queryValues[9], "worker-current");
});

test("output publication refuses a worker whose lease has already been reclaimed", async () => {
  const pool = {
    async query() {
      return { rows: [], rowCount: 0 };
    },
  } as unknown as Pool;
  const store = createPgOutputStore(pool);

  await assert.rejects(
    () => store.createOutput({
      jobId: outputRow.job_id,
      userId: outputRow.user_id,
      storageKey: outputRow.storage_key,
      sizeBytes: 1234,
      workerId: "worker-stale",
    }),
    /WORKER_LEASE_LOST/,
  );
});
