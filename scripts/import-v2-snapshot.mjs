import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { Pool } from "pg";

const snapshotDir = process.env.V2_SNAPSHOT_DIR || "F:/JanseeV4-ProductionData/snapshot-20261117/data";
const importKey = "v2-production-snapshot-20261117";
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 5000 });
const readJson = async (name) => JSON.parse(await readFile(path.join(snapshotDir, name), "utf8"));
const dateValue = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  const d = Number.isFinite(n) && n > 100000000000 ? new Date(n) : new Date(value);
  if (!Number.isFinite(d.getTime())) throw new Error("Invalid legacy timestamp");
  return d;
};
const number = (value) => Number.isFinite(Number(value)) ? Math.max(0, Math.trunc(Number(value))) : 0;
const passwordHashForV4 = (value) => {
  const match = /^s2\$(\d+)\$([a-f0-9]{32})\$([a-f0-9]{64})$/i.exec(String(value || ""));
  return match && Number(match[1]) === 16384 ? `scrypt$16384$8$1$${match[2].toLowerCase()}$${match[3].toLowerCase()}` : null;
};
const splitRegion = (value) => {
  const parts = String(value || "").split(/[\/／]/).map((part) => part.trim()).filter(Boolean);
  return { province: parts.length >= 2 ? parts[1].slice(0, 80) : null, city: parts.length >= 3 ? parts[2].slice(0, 80) : null };
};
const parseSplit = (reason, key) => {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(escaped + "\\s*[:：]\\s*(\\d+)", "i").exec(String(reason || ""));
  return match ? number(match[1]) : null;
};

try {
  const files = (await readdir(snapshotDir)).filter((name) => name.endsWith(".json") || /\.json\.bak/.test(name)).sort();
  const hash = createHash("sha256");
  for (const name of files) {
    hash.update(name);
    hash.update(await readFile(path.join(snapshotDir, name)));
  }
  const snapshotHash = hash.digest("hex");

  const existingRun = await pool.query("SELECT snapshot_sha256, summary FROM v2_import_runs WHERE import_key = $1", [importKey]);
  if (existingRun.rows[0]) {
    console.log("V2_IMPORT_ALREADY_APPLIED", JSON.stringify(existingRun.rows[0].summary));
    process.exitCode = 0;
  } else {
    const usersData = await readJson("s8-users.json");
    const creditsData = await readJson("credit-accounts.json");
    const ordersData = await readJson("pay-orders.json");
    const analyticsData = await readJson("site-analytics.json");
    const legacyUsers = Array.isArray(usersData.users) ? usersData.users : [];
    const client = await pool.connect();
    const summary = { users: 0, wallets: 0, ledger: 0, expiredOrders: 0, analyticsDays: 0, archives: 0, skippedSessions: 1 };
    try {
      await client.query("BEGIN");
      const userMap = new Map();
      for (const legacy of legacyUsers) {
        const legacyId = String(legacy.userId || "");
        const phone = String(legacy.phone || "");
        if (!legacyId || !phone) throw new Error("Legacy user is missing its stable ID or phone");
        let mapped = await client.query("SELECT user_id FROM v2_import_map WHERE legacy_user_id = $1", [legacyId]);
        let userId = mapped.rows[0]?.user_id;
        if (!userId) {
          const samePhone = await client.query("SELECT id FROM users WHERE phone = $1 AND deleted_at IS NULL LIMIT 1", [phone]);
          userId = samePhone.rows[0]?.id || randomUUID();
          const region = splitRegion(legacy.registerRegion);
          const status = String(legacy.status || "active") === "active" ? "active" : "suspended";
          const passwordHash = passwordHashForV4(legacy.passwordHash);
          await client.query(
            `INSERT INTO users
              (id,email,phone,password_hash,display_name,status,created_at,updated_at,register_province,register_city,register_region,registration_channel,invite_code)
             VALUES ($1,NULL,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
             ON CONFLICT (id) DO NOTHING`,
            [userId, phone, passwordHash, String(legacy.nickname || "简兮用户").slice(0,80), status,
              dateValue(legacy.createdAt) || new Date(), dateValue(legacy.updatedAt) || dateValue(legacy.createdAt) || new Date(),
              region.province, region.city, String(legacy.registerRegion || "").slice(0,180) || null,
              String(legacy.channel || "").slice(0,80) || null, randomUUID().replace(/-/g,"").slice(0,10).toUpperCase()]
          );
          await client.query(
            "INSERT INTO v2_import_map (legacy_user_id,user_id) VALUES ($1,$2) ON CONFLICT (legacy_user_id) DO NOTHING",
            [legacyId, userId]
          );
          summary.users++;
        }
        userMap.set(legacyId, userId);
      }

      for (const legacy of legacyUsers) {
        const inviter = legacyUsers.find((candidate) => candidate.phone && candidate.phone === legacy.inviterPhone);
        if (inviter && userMap.has(inviter.userId)) {
          await client.query("UPDATE users SET inviter_user_id=$2 WHERE id=$1 AND inviter_user_id IS NULL", [userMap.get(legacy.userId), userMap.get(inviter.userId)]);
        }
      }

      const txByUser = new Map();
      for (const tx of creditsData.transactions || []) {
        const list = txByUser.get(tx.userId) || [];
        list.push(tx);
        txByUser.set(tx.userId, list);
        const amount = number(tx.amount);
        if (!amount) continue;
        let type = "compensation";
        let paidAmount = 0;
        let freeAmount = 0;
        if (tx.type === "grant_free") { type = "grant"; freeAmount = amount; }
        else if (tx.type === "recharge") { type = "recharge"; paidAmount = amount; }
        else if (tx.type === "consume") {
          type = "settle";
          freeAmount = parseSplit(tx.reason, "扣除赠送");
          paidAmount = parseSplit(tx.reason, "扣除充值");
          if (freeAmount === null || paidAmount === null || freeAmount + paidAmount !== amount) { freeAmount = amount; paidAmount = 0; }
        } else if (tx.type === "refund") {
          type = "refund";
          freeAmount = parseSplit(tx.reason, "退回赠送");
          paidAmount = parseSplit(tx.reason, "退回充值");
          if (freeAmount === null || paidAmount === null || freeAmount + paidAmount !== amount) { freeAmount = amount; paidAmount = 0; }
        } else { freeAmount = amount; }
        const userId = userMap.get(tx.userId);
        if (!userId) throw new Error("Ledger references an unknown legacy user");
        await client.query(
          "INSERT INTO billing_ledger (user_id,type,amount,description,created_at,paid_amount,free_amount) VALUES ($1,$2,$3,$4,$5,$6,$7)",
          [userId,type,amount,(`[V2 ${tx.type}] ${String(tx.reason || "历史积分流水").slice(0,500)}`),dateValue(tx.createdAt)||new Date(),paidAmount,freeAmount]
        );
        summary.ledger++;
      }

      for (const [legacyId, account] of Object.entries(creditsData.accounts || {})) {
        const userId = userMap.get(legacyId);
        if (!userId) throw new Error("Wallet references an unknown legacy user");
        const paid = number(account.paid);
        const free = number(account.free);
        const txs = txByUser.get(legacyId) || [];
        const spent = Math.max(0, txs.filter((x) => x.type === "consume").reduce((n,x)=>n+number(x.amount),0) - txs.filter((x) => x.type === "refund").reduce((n,x)=>n+number(x.amount),0));
        await client.query(
          `INSERT INTO wallets (user_id,available_credits,frozen_credits,total_spent_credits,paid_available_credits,free_available_credits)
           VALUES ($1,$2,0,$3,$4,$5)
           ON CONFLICT (user_id) DO UPDATE SET available_credits=EXCLUDED.available_credits,frozen_credits=0,total_spent_credits=EXCLUDED.total_spent_credits,paid_available_credits=EXCLUDED.paid_available_credits,free_available_credits=EXCLUDED.free_available_credits,updated_at=now()`,
          [userId,paid+free,spent,paid,free]
        );
        summary.wallets++;
      }

      for (const order of ordersData) {
        const userId = userMap.get(order.userId) || null;
        await client.query(
          `INSERT INTO v2_legacy_orders (legacy_order_id,user_id,original_status,created_at,paid_at,payload)
           VALUES ($1,$2,$3,$4,$5,$6::jsonb)
           ON CONFLICT (legacy_order_id) DO UPDATE SET user_id=EXCLUDED.user_id,original_status=EXCLUDED.original_status,created_at=EXCLUDED.created_at,paid_at=EXCLUDED.paid_at,payload=EXCLUDED.payload`,
          [String(order.id),userId,String(order.status || "unknown"),dateValue(order.createdAt),dateValue(order.paidAt),JSON.stringify(order)]
        );
        if (order.status === "expired") summary.expiredOrders++;
      }

      for (const [day, row] of Object.entries(analyticsData.days || {})) {
        const breakdown = { pages: row.pages || {}, sources: row.sources || {}, regions: row.regions || {}, devices: row.devices || {}, browsers: row.browsers || {} };
        await client.query(
          `INSERT INTO site_daily_analytics (day,pv,uv,breakdown,source)
           VALUES ($1,$2,$3,$4::jsonb,'v2-real-visitor-aggregate')
           ON CONFLICT (day) DO UPDATE SET pv=EXCLUDED.pv,uv=EXCLUDED.uv,breakdown=EXCLUDED.breakdown,source=EXCLUDED.source,imported_at=now()`,
          [day,number(row.pv),Array.isArray(row.visitors)?row.visitors.length:0,JSON.stringify(breakdown)]
        );
        summary.analyticsDays++;
      }
      for (const name of files.filter((item) => /^site-analytics\.json\.bak/.test(item))) {
        const backup = await readJson(name);
        for (const [day, row] of Object.entries(backup.days || {})) {
          const breakdown = { pages: row.pages || {}, sources: row.sources || {}, regions: row.regions || {}, devices: row.devices || {}, browsers: row.browsers || {} };
          const backupInsert = await client.query(
            `INSERT INTO site_daily_analytics (day,pv,uv,breakdown,source)
             VALUES ($1,$2,$3,$4::jsonb,'v2-real-visitor-aggregate-backup')
             ON CONFLICT (day) DO NOTHING RETURNING day`,
            [day,number(row.pv),Array.isArray(row.visitors)?row.visitors.length:0,JSON.stringify(breakdown)]
          );
          if (backupInsert.rowCount) summary.analyticsDays++;
        }
      }

      const pricing = await readJson("pricing.json");
      const mapPricing = (rows) => (rows || []).map((item) => ({ id: String(item.id), priceYuan: Number(item.price), strikeYuan: String(item.strike || "") }));
      await client.query(
        `INSERT INTO pricing_config (id,config,updated_at)
         VALUES ('default',$1::jsonb,now())
         ON CONFLICT (id) DO UPDATE SET config=EXCLUDED.config,updated_at=now()`,
        [JSON.stringify({ members: mapPricing(pricing.members), boostPacks: mapPricing(pricing.boostPacks) })]
      );

      for (const name of files) {
        if (name === "s8-sessions.json" || name.startsWith("s8-sessions.json.")) continue;
        if (["s8-users.json","credit-accounts.json","pay-orders.json","site-analytics.json"].includes(name)) continue;
        const payload = await readJson(name);
        const digest = createHash("sha256").update(await readFile(path.join(snapshotDir,name))).digest("hex");
        await client.query(
          `INSERT INTO v2_legacy_archives (source_file,sha256,payload)
           VALUES ($1,$2,$3::jsonb)
           ON CONFLICT (source_file) DO UPDATE SET sha256=EXCLUDED.sha256,payload=EXCLUDED.payload,imported_at=now()`,
          [name,digest,JSON.stringify(payload)]
        );
        summary.archives++;
      }

      await client.query(
        "INSERT INTO v2_import_runs (import_key,snapshot_sha256,summary) VALUES ($1,$2,$3::jsonb)",
        [importKey,snapshotHash,JSON.stringify(summary)]
      );
      await client.query("COMMIT");
      const totals = await client.query(`SELECT
        (SELECT count(*)::int FROM users WHERE deleted_at IS NULL) AS users,
        (SELECT count(*)::int FROM wallets) AS wallets,
        (SELECT count(*)::int FROM billing_ledger) AS ledger,
        (SELECT count(*)::int FROM v2_legacy_orders) AS legacy_orders,
        (SELECT count(*)::int FROM site_daily_analytics) AS analytics_days,
        (SELECT coalesce(sum(pv),0)::int FROM site_daily_analytics) AS human_pv,
        (SELECT coalesce(sum(uv),0)::int FROM site_daily_analytics) AS human_uv`);
      console.log("V2_IMPORT_SUCCESS",JSON.stringify({snapshotSha256:snapshotHash,summary,totals:totals.rows[0]}));
    } catch (error) {
      await client.query("ROLLBACK").catch(()=>undefined);
      throw error;
    } finally {
      client.release();
    }
  }
} finally {
  await pool.end();
}
