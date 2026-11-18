import test from "node:test";
import assert from "node:assert/strict";
import { buildJobClaimSql } from "../apps/api/src/worker.js";

test("worker claim query prioritizes active membership tiers with queue aging", () => {
  const sql = buildJobClaimSql(3);
  assert.match(sql, /FROM user_memberships membership/);
  assert.match(sql, /membership\.expires_at > now\(\)/);
  assert.match(sql, /WHEN 'ultra' THEN 0/);
  assert.match(sql, /WHEN 'pro' THEN 1/);
  assert.match(sql, /WHEN 'plus' THEN 2/);
  assert.match(sql, /WHEN 'lite' THEN 3/);
  assert.match(sql, /FLOOR\(EXTRACT\(EPOCH FROM \(now\(\) - queued_at\)\) \/ 21600\)/);
  assert.match(sql, /FOR UPDATE SKIP LOCKED/);
  assert.match(sql, /attempt_count < 3/);
});
