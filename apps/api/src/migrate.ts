import "./env.js";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Pool } from "pg";

const MIGRATION_LOCK_ID = 741_202_611;

export async function runMigrations(pool: Pool, directory = fileURLToPath(new URL("../migrations/", import.meta.url))) {
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_ID]);
    const files = (await readdir(directory))
      .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name))
      .sort();

    for (const file of files) {
      const version = file.replace(/\.sql$/, "");
      const table = await client.query<{ exists: boolean }>(
        "SELECT to_regclass('public.schema_migrations') IS NOT NULL AS exists",
      );
      if (table.rows[0]?.exists) {
        const result = await client.query("SELECT 1 FROM schema_migrations WHERE version = $1", [version]);
        if (result.rowCount) continue;
      }

      const sql = await readFile(resolve(directory, file), "utf8");
      await client.query(sql);
      applied.push(version);
    }
    return applied;
  } finally {
    try {
      await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_ID]);
    } finally {
      client.release();
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required to run migrations");
  if (process.env.NODE_ENV === "production" && process.env.DATABASE_SSL !== "true") {
    throw new Error("DATABASE_SSL=true is required for production migrations");
  }
  const { createDatabasePool } = await import("./database.js");
  const pool = createDatabasePool({ connectionString, ssl: process.env.DATABASE_SSL === "true", maxConnections: 1 });
  try {
    const applied = await runMigrations(pool);
    console.info(applied.length ? `Applied migrations: ${applied.join(", ")}` : "Database schema is up to date");
  } finally {
    await pool.end();
  }
}
