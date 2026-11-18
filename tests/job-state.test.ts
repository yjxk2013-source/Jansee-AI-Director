import test from "node:test";
import assert from "node:assert/strict";
import { canTransitionJob, assertJobTransition } from "../packages/domain/src/job-state.ts";

test("job lifecycle permits only forward transitions", () => {
  assert.equal(canTransitionJob("queued", "inspecting"), true);
  assert.equal(canTransitionJob("planning", "rendering"), true);
  assert.equal(canTransitionJob("quality-check", "completed"), true);
  assert.equal(canTransitionJob("completed", "rendering"), false);
});

test("terminal job states cannot be reopened", () => {
  for (const terminal of ["completed", "failed", "cancelled"] as const) {
    assert.equal(canTransitionJob(terminal, "queued"), false);
  }
});

test("invalid transition is rejected with an explicit error", () => {
  assert.throws(
    () => assertJobTransition("queued", "completed"),
    /Invalid job state transition/,
  );
});
