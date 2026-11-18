import test from "node:test";
import assert from "node:assert/strict";
import type { OutputStore } from "../apps/api/src/outputs.js";
import type { LocalObjectStorage } from "../apps/api/src/storage-local.js";
import { cleanupExpiredOutputs } from "../apps/api/src/outputs.js";

test("expired outputs are removed from object storage before their rows are marked expired", async () => {
  const deleted: string[] = [];
  const marked: string[] = [];
  const store = {
    async findExpiredOutputs() {
      return [
        { id: "output-a", storageKey: "users/a/output-a" },
        { id: "output-b", storageKey: "users/b/output-b" },
      ];
    },
    async markOutputExpired(id: string) {
      marked.push(id);
    },
  } as unknown as OutputStore;
  const storage = {
    async deleteObject(key: string) {
      deleted.push(key);
      if (key.endsWith("output-b")) throw new Error("COS temporarily unavailable");
    },
  } as unknown as LocalObjectStorage;

  const removed = await cleanupExpiredOutputs(store, storage, new Date("2026-11-16T00:00:00.000Z"));

  assert.equal(removed, 1);
  assert.deepEqual(deleted, ["users/a/output-a", "users/b/output-b"]);
  assert.deepEqual(marked, ["output-a"]);
});

test("output cleanup safely does nothing when a store does not expose expiry operations", async () => {
  const store = {} as OutputStore;
  const storage = {} as LocalObjectStorage;
  assert.equal(await cleanupExpiredOutputs(store, storage), 0);
});
