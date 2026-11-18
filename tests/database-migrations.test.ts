import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrations } from "../apps/api/src/migrate.ts";
import type { Pool } from "pg";

test("migration runner applies ordered SQL files once and releases its connection", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jansee-migrations-"));
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "0002_second.sql"), "SELECT 'second';", "utf8");
  await writeFile(join(directory, "0001_first.sql"), "SELECT 'first';", "utf8");
  await writeFile(join(directory, "notes.txt"), "ignored", "utf8");

  const appliedVersions = new Set<string>();
  const executedSql: string[] = [];
  let released = false;
  const client = {
    async query(sql: string, values?: unknown[]) {
      if (sql.includes("to_regclass")) return { rows: [{ exists: true }], rowCount: 1 };
      if (sql.includes("SELECT 1 FROM schema_migrations")) {
        return { rows: appliedVersions.has(String(values?.[0])) ? [{}] : [], rowCount: appliedVersions.has(String(values?.[0])) ? 1 : 0 };
      }
      if (sql.startsWith("SELECT pg_advisory")) return { rows: [], rowCount: 1 };
      executedSql.push(sql);
      const match = sql.match(/SELECT '([^']+)'/);
      if (match) appliedVersions.add(match[1] === "first" ? "0001_first" : "0002_second");
      return { rows: [], rowCount: 1 };
    },
    release() { released = true; },
  };
  const pool = { connect: async () => client } as unknown as Pool;

  try {
    assert.deepEqual(await runMigrations(pool, directory), ["0001_first", "0002_second"]);
    assert.deepEqual(await runMigrations(pool, directory), []);
    assert.equal(executedSql.length, 2);
    assert.equal(released, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("user analytics migration adds structured province and city registration fields with lookup indexes", async () => {
  const sql = await readFile(new URL("../apps/api/migrations/0012_user_analytics.sql", import.meta.url), "utf8");
  assert.match(sql, /ADD COLUMN IF NOT EXISTS register_province/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS register_city/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS register_region/);
  assert.match(sql, /users_created_at_idx/);
  assert.match(sql, /users_register_province_city_idx/);
});
