import { readFile } from "node:fs/promises";
import { Pool } from "pg";
const dir = process.env.V2_SNAPSHOT_DIR || "F:/JanseeV4-ProductionData/snapshot-20261117/data";
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const source = JSON.parse(await readFile(`${dir}/s8-users.json`, "utf8")).users || [];
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
let migrated = 0;
try {
  for (const user of source) {
    const match = /^s2\$(16384)\$([a-f0-9]{32})\$([a-f0-9]{64})$/i.exec(String(user.passwordHash || ""));
    if (!match) continue;
    const encoded = `scrypt$16384$8$1$${match[2].toLowerCase()}$${match[3].toLowerCase()}`;
    const result = await pool.query(
      `UPDATE users u SET password_hash=$2,updated_at=now()
       FROM v2_import_map m
       WHERE m.legacy_user_id=$1 AND m.user_id=u.id
         AND (u.password_hash IS NULL OR u.password_hash='')
       RETURNING u.id`,
      [String(user.userId), encoded]
    );
    migrated += result.rowCount || 0;
  }
  console.log("V2_PASSWORD_HASH_COMPATIBILITY", JSON.stringify({ migrated }));
} finally {
  await pool.end();
}
