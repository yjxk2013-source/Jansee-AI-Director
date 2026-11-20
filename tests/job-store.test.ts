import test from "node:test";
import assert from "node:assert/strict";
import type { Pool } from "pg";
import { createPgJobStore } from "../apps/api/src/job-store.ts";

const jobRow = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  user_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  mode: "video-dub",
  status: "rendering",
  prompt: "测试任务",
  aspect_ratio: "9:16",
  idempotency_key: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  request_payload: {},
  director_plan: {},
  progress: 70,
  error_code: null,
  error_message: null,
  queued_at: new Date(),
  started_at: new Date(),
  finished_at: null,
  created_at: new Date(),
  updated_at: new Date(),
};

function makePool(currentStatus = "rendering", currentWorkerId: string | null = null) {
  const events: string[] = [];
  const client = {
    async query(sql: string) {
      const normalized = sql.trim();
      events.push(normalized === "BEGIN" || normalized === "COMMIT" || normalized === "ROLLBACK"
        ? normalized
        : normalized.startsWith("SELECT status") ? "SELECT status"
        : normalized.startsWith("UPDATE generation_jobs") ? "UPDATE generation_jobs"
        : normalized);
      if (sql.includes("SELECT status")) return { rows: [{ status: currentStatus, worker_id: currentWorkerId }], rowCount: 1 };
      if (sql.includes("UPDATE generation_jobs")) return { rows: [{ ...jobRow, status: "quality-check", progress: 90 }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
    release() { events.push("RELEASE"); },
  };
  const pool = {
    async connect() { events.push("CONNECT"); return client; },
    async query(sql: string) {
      events.push("POOL_QUERY");
      if (sql.includes("generation_job_assets")) return { rows: [{ asset_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  };
  return { pool: pool as unknown as Pool, events };
}

test("job status transition keeps SELECT FOR UPDATE and UPDATE in one transaction", async () => {
  const { pool, events } = makePool();
  const store = createPgJobStore(pool);
  const result = await store.updateJobStatus!("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", jobRow.id, "quality-check", 90);

  assert.equal(result?.status, "quality-check");
  assert.deepEqual(events.slice(0, 6), [
    "CONNECT",
    "BEGIN",
    "SELECT status",
    "UPDATE generation_jobs",
    "COMMIT",
    "RELEASE",
  ]);
  assert.equal(events[6], "POOL_QUERY");
});

test("invalid job transition rolls back and releases the locked connection", async () => {
  const { pool, events } = makePool("completed");
  const store = createPgJobStore(pool);

  await assert.rejects(
    () => store.updateJobStatus!("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", jobRow.id, "queued", 0),
    /Invalid job state transition/,
  );
  assert.ok(events.includes("ROLLBACK"));
  assert.equal(events.at(-1), "RELEASE");
  assert.equal(events.includes("POOL_QUERY"), false);
});


test("a stale worker cannot change a job after another worker has reclaimed its lease", async () => {
  const { pool, events } = makePool("rendering", "worker-new");
  const store = createPgJobStore(pool);

  await assert.rejects(
    () => store.updateJobStatus!(
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      jobRow.id,
      "quality-check",
      90,
      undefined,
      "worker-old",
    ),
    /WORKER_LEASE_LOST/,
  );
  assert.ok(events.includes("ROLLBACK"));
  assert.equal(events.includes("UPDATE generation_jobs"), false);
  assert.equal(events.at(-1), "RELEASE");
});

test("worker heartbeat renews only the lease owned by the same worker", async () => {
  let queryText = "";
  let queryValues: unknown[] = [];
  const pool = {
    async query(sql: string, values: unknown[]) {
      queryText = sql;
      queryValues = values;
      return { rows: [], rowCount: 1 };
    },
  } as unknown as Pool;
  const store = createPgJobStore(pool);
  const renewed = await store.heartbeatJob!("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", jobRow.id, "worker-a", 120);

  assert.equal(renewed, true);
  assert.match(queryText, /lease_expires_at = now\(\) \+ make_interval/);
  assert.match(queryText, /worker_id = \$3/);
  assert.deepEqual(queryValues, ["bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", jobRow.id, "worker-a", 120]);
});
