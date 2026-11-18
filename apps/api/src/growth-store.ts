import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { Pool, PoolClient } from "pg";

export interface GrowthStore {
  getOverview(userId: string, timeZone: string): Promise<Record<string, unknown>>;
  checkin(userId: string, timeZone: string, rewardCredits: number): Promise<Record<string, unknown>>;
  activatePartner(userId: string, province: string, city: string, target: number): Promise<Record<string, unknown>>;
  listInvitees(userId: string): Promise<Array<Record<string, unknown>>>;
  listCommissions(userId: string): Promise<Array<Record<string, unknown>>>;
  getPayoutProfile(userId: string): Promise<Record<string, unknown> | null>;
  savePayoutProfile(userId: string, accountName: string, account: string): Promise<Record<string, unknown>>;
  createWithdrawal(userId: string, amountYuan: number, idempotencyKey: string): Promise<Record<string, unknown>>;
  listWithdrawals(userId: string): Promise<Array<Record<string, unknown>>>;
  settleEligibleCommissions(): Promise<number>;
}

function payoutKey(value?: string): Buffer {
  if (!value || !/^[a-f0-9]{64}$/i.test(value)) throw new Error("提现加密密钥未配置：请配置 64 位十六进制 PARTNER_PAYOUT_ENCRYPTION_KEY");
  return Buffer.from(value, "hex");
}

export function encryptPayoutValue(value: string, keyHex?: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", payoutKey(keyHex), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join(":");
}

export function decryptPayoutValue(value: string, keyHex?: string): string {
  const [version, iv, tag, encrypted] = value.split(":");
  if (version !== "v1" || !iv || !tag || !encrypted) throw new Error("提现资料密文格式无效");
  const decipher = createDecipheriv("aes-256-gcm", payoutKey(keyHex), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(encrypted, "base64url")), decipher.final()]).toString("utf8");
}

function audit(client: PoolClient, input: { userId: string; actorUserId?: string; entityType: string; entityId?: string; action: string; details?: Record<string, unknown> }) {
  return client.query(
    "INSERT INTO partner_audit_events (user_id, actor_user_id, entity_type, entity_id, action, details) VALUES ($1, $2, $3, $4, $5, $6::jsonb)",
    [input.userId, input.actorUserId ?? null, input.entityType, input.entityId ?? null, input.action, JSON.stringify(input.details ?? {})],
  );
}

async function inTransaction<T>(pool: Pool, run: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function safeTimeZone(value: string): string {
  try { new Intl.DateTimeFormat("en-US", { timeZone: value }).format(); return value; }
  catch { return "Asia/Shanghai"; }
}

async function ensureWallet(client: PoolClient, userId: string) {
  const inserted = await client.query(
    "INSERT INTO wallets (user_id, available_credits, free_available_credits) VALUES ($1, 600, 600) ON CONFLICT (user_id) DO NOTHING RETURNING user_id",
    [userId],
  );
  if (inserted.rowCount) {
    await client.query(
      "INSERT INTO billing_ledger (user_id, type, amount, free_amount, description) VALUES ($1, 'grant', 600, 600, $2)",
      [userId, "新账号注册体验积分"],
    );
  }
  const result = await client.query(
    "SELECT available_credits FROM wallets WHERE user_id = $1 FOR UPDATE",
    [userId],
  );
  if (!result.rows[0]) throw new Error("钱包初始化失败");
  return Number(result.rows[0].available_credits);
}

export async function settleEligiblePartnerCommissions(pool: Pool): Promise<number> {
  return inTransaction(pool, async (client) => {
    const settled = await client.query<{ id: string; beneficiary_user_id: string }>(`
      UPDATE partner_commissions c
      SET status = 'settled', settle_at = now()
      FROM billing_orders o
      WHERE c.order_id = o.id
        AND c.status = 'pending'
        AND o.status = 'paid'
        AND o.payment_provider = 'opcpay'
        AND o.provider_payment_status = 'PAID'
        AND o.provider_paid_checked_at IS NOT NULL
        AND o.provider_paid_checked_at <= now() - ($1::int * interval '1 day')
      RETURNING c.id, c.beneficiary_user_id
    `, [GROWTH_REWARDS.settlementDays]);
    for (const row of settled.rows) {
      await audit(client, { userId: row.beneficiary_user_id, entityType: "commission", entityId: row.id, action: "commission.settled", details: { settlementDays: GROWTH_REWARDS.settlementDays } });
    }
    return settled.rowCount ?? settled.rows.length;
  });
}

export function createPgGrowthStore(pool: Pool, payoutEncryptionKey?: string): GrowthStore {
  return {
    async getOverview(userId, timeZone) {
      const tz = safeTimeZone(timeZone);
      const userResult = await pool.query<{
        invite_code: string; partner_activated_at: Date | null; partner_province: string | null; partner_city: string | null;
      }>(
        "SELECT invite_code, partner_activated_at, partner_province, partner_city FROM users WHERE id = $1 AND deleted_at IS NULL",
        [userId],
      );
      const user = userResult.rows[0];
      if (!user) throw new Error("用户不存在");
      const [inviteStats, checkin, commissions, invitees, withdrawals] = await Promise.all([
        pool.query<{ invited_count: string; rewarded_count: string }>(
          "SELECT count(*)::text AS invited_count, count(rr.id)::text AS rewarded_count FROM users u LEFT JOIN referral_rewards rr ON rr.invitee_user_id = u.id WHERE u.inviter_user_id = $1 AND u.deleted_at IS NULL",
          [userId],
        ),
        pool.query<{ checked_in: boolean }>(
          "SELECT EXISTS (SELECT 1 FROM user_daily_checkins WHERE user_id = $1 AND checkin_date = (now() AT TIME ZONE $2)::date) AS checked_in",
          [userId, tz],
        ),
        pool.query<{ pending: string; settled: string; total: string }>(
          `SELECT coalesce(sum(c.commission_amount_yuan) FILTER (WHERE c.status = 'pending'), 0)::text AS pending,
             coalesce(sum(c.commission_amount_yuan) FILTER (WHERE c.status = 'settled'), 0)::text AS settled,
             coalesce(sum(c.commission_amount_yuan) FILTER (WHERE c.status <> 'cancelled'), 0)::text AS total
           FROM partner_commissions c JOIN billing_orders o ON o.id = c.order_id
           WHERE c.beneficiary_user_id = $1 AND o.payment_provider = 'opcpay'
             AND o.provider_payment_status = 'PAID' AND o.status = 'paid'`,
          [userId],
        ),
        pool.query<{ id: string; display_name: string | null; created_at: Date; rewarded: boolean }>(
          "SELECT u.id, u.display_name, u.created_at, (rr.id IS NOT NULL) AS rewarded FROM users u LEFT JOIN referral_rewards rr ON rr.invitee_user_id = u.id WHERE u.inviter_user_id = $1 AND u.deleted_at IS NULL ORDER BY u.created_at DESC LIMIT 100",
          [userId],
        ),
        pool.query<{ reserved: string; in_transit: string; withdrawn: string }>(
          "SELECT coalesce(sum(net_amount_yuan) FILTER (WHERE status IN ('pending','approved')), 0)::text AS in_transit, coalesce(sum(net_amount_yuan) FILTER (WHERE status = 'paid'), 0)::text AS withdrawn, coalesce(sum(amount_yuan) FILTER (WHERE status IN ('pending','approved','paid')), 0)::text AS reserved FROM partner_withdrawals WHERE user_id = $1",
          [userId],
        ),
      ]);
      const counts = inviteStats.rows[0] ?? { invited_count: "0", rewarded_count: "0" };
      const money = commissions.rows[0] ?? { pending: "0", settled: "0", total: "0" };
      const withdrawalTotals = withdrawals.rows[0] ?? { reserved: "0", in_transit: "0", withdrawn: "0" };
      const reserved = Number(withdrawalTotals.reserved);
      const settled = Number(money.settled);
      const invitedCount = Number(counts.invited_count);
      return {
        inviteCode: user.invite_code,
        invitedCount,
        rewardedCount: Number(counts.rewarded_count),
        invitees: invitees.rows.map((row) => ({
          id: row.id,
          displayName: row.display_name || "简兮用户",
          createdAt: row.created_at.toISOString(),
          rewarded: row.rewarded,
        })),
        checkedInToday: Boolean(checkin.rows[0]?.checked_in),
        checkinRewardCredits: 100,
        referralRewardCredits: 200,
        partner: {
          active: Boolean(user.partner_activated_at),
          activatedAt: user.partner_activated_at?.toISOString() ?? null,
          province: user.partner_province,
          city: user.partner_city,
          target: 5,
          progress: Math.min(invitedCount, 5),
          pendingYuan: Number(money.pending),
          settledYuan: settled,
          inTransitYuan: Number(Number(withdrawalTotals.in_transit).toFixed(2)),
          withdrawnYuan: Number(Number(withdrawalTotals.withdrawn).toFixed(2)),
          withdrawableYuan: Number(Math.max(0, settled - reserved).toFixed(2)),
          totalYuan: Number(money.total),
          levelOneRate: GROWTH_REWARDS.levelOneRate,
          levelTwoRate: GROWTH_REWARDS.levelTwoRate,
        },
      };
    },

    async checkin(userId, timeZone, rewardCredits) {
      if (!Number.isSafeInteger(rewardCredits) || rewardCredits !== 100) throw new Error("签到奖励规则无效");
      return inTransaction(pool, async (client) => {
        const balance = await ensureWallet(client, userId);
        const tz = safeTimeZone(timeZone);
        const inserted = await client.query<{ id: string }>(
          "INSERT INTO user_daily_checkins (user_id, checkin_date, reward_credits) VALUES ($1, (now() AT TIME ZONE $2)::date, $3) ON CONFLICT (user_id, checkin_date) DO NOTHING RETURNING id",
          [userId, tz, rewardCredits],
        );
        if (!inserted.rowCount) return { already: true, balance };
        const updated = await client.query<{ available_credits: string | number }>(
          "UPDATE wallets SET available_credits = available_credits + $1, free_available_credits = free_available_credits + $1, updated_at = now() WHERE user_id = $2 RETURNING available_credits",
          [rewardCredits, userId],
        );
        await client.query(
          "INSERT INTO billing_ledger (user_id, type, amount, free_amount, description) VALUES ($1, 'grant', $2, $2, $3)",
          [userId, rewardCredits, "每日签到奖励 +100 积分"],
        );
        return { already: false, rewardCredits, balance: Number(updated.rows[0]!.available_credits) };
      });
    },

    async activatePartner(userId, province, city, target) {
      const cleanProvince = province.trim().slice(0, 80);
      const cleanCity = city.trim().slice(0, 80);
      if (!cleanProvince || !cleanCity) throw new Error("请选择合伙人负责省份和城市");
      if (!Number.isSafeInteger(target) || target !== 5) throw new Error("合伙人申请条件无效");
      return inTransaction(pool, async (client) => {
        const userResult = await client.query<{ phone: string | null; partner_activated_at: Date | null }>(
          "SELECT phone, partner_activated_at FROM users WHERE id = $1 AND deleted_at IS NULL FOR UPDATE",
          [userId],
        );
        const user = userResult.rows[0];
        if (!user) throw new Error("用户不存在");
        if (user.partner_activated_at) return { already: true, activatedAt: user.partner_activated_at.toISOString() };
        const countResult = await client.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM users WHERE inviter_user_id = $1",
          [userId],
        );
        const count = Number(countResult.rows[0]?.count ?? 0);
        if (count < target) throw new Error(`邀请人数不足：当前 ${count}/${target} 人`);
        await client.query(
          "INSERT INTO partner_city_assignments (user_id, province, city, status) VALUES ($1, $2, $3, 'active')",
          [userId, cleanProvince, cleanCity],
        );
        const activated = await client.query<{ partner_activated_at: Date }>(
          "UPDATE users SET partner_activated_at = now(), partner_province = $2, partner_city = $3, updated_at = now() WHERE id = $1 RETURNING partner_activated_at",
          [userId, cleanProvince, cleanCity],
        );
        return { already: false, activatedAt: activated.rows[0]!.partner_activated_at.toISOString(), province: cleanProvince, city: cleanCity, invitedCount: count };
      });
    },
    async getPayoutProfile(userId) {
      const result = await pool.query<{ payout_channel: string; account_last4: string; verification_status: string; verification_note: string | null; updated_at: Date }>(
        "SELECT payout_channel, account_last4, verification_status, verification_note, updated_at FROM partner_payout_profiles WHERE user_id = $1",
        [userId],
      );
      const row = result.rows[0];
      return row ? { channel: row.payout_channel, accountLast4: row.account_last4, verificationStatus: row.verification_status, verificationNote: row.verification_note, updatedAt: row.updated_at.toISOString() } : null;
    },
    async savePayoutProfile(userId, accountName, account) {
      const cleanName = accountName.trim();
      const cleanAccount = account.trim();
      if (cleanName.length < 2 || cleanName.length > 80 || /[\r\n\0]/.test(cleanName)) throw new Error("请输入有效的支付宝实名姓名");
      if (cleanAccount.length < 5 || cleanAccount.length > 160 || /[\r\n\0]/.test(cleanAccount) || !(/^(?:1[3-9]\d{9}|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})$/.test(cleanAccount))) throw new Error("请输入有效的支付宝账号（手机号或邮箱）");
      const nameCipher = encryptPayoutValue(cleanName, payoutEncryptionKey);
      const accountCipher = encryptPayoutValue(cleanAccount, payoutEncryptionKey);
      return inTransaction(pool, async (client) => {
        const user = await client.query<{ partner_activated_at: Date | null }>("SELECT partner_activated_at FROM users WHERE id = $1 AND deleted_at IS NULL FOR UPDATE", [userId]);
        if (!user.rows[0]?.partner_activated_at) throw new Error("仅城市合伙人可以绑定提现账户");
        const saved = await client.query<{ account_last4: string; verification_status: string; updated_at: Date }>(`
          INSERT INTO partner_payout_profiles (user_id, payout_channel, account_name_ciphertext, account_ciphertext, account_last4, verification_status, verification_note, verified_at)
          VALUES ($1, 'alipay', $2, $3, $4, 'pending', '等待管理员核验', NULL)
          ON CONFLICT (user_id) DO UPDATE SET payout_channel = 'alipay', account_name_ciphertext = EXCLUDED.account_name_ciphertext,
            account_ciphertext = EXCLUDED.account_ciphertext, account_last4 = EXCLUDED.account_last4,
            verification_status = 'pending', verification_note = '收款账户变更，需重新核验', verified_at = NULL, updated_at = now()
          RETURNING account_last4, verification_status, updated_at
        `, [userId, nameCipher, accountCipher, cleanAccount.slice(-4)]);
        await audit(client, { userId, entityType: "payout_profile", action: "payout_profile.saved", details: { channel: "alipay", accountLast4: cleanAccount.slice(-4), verificationStatus: "pending" } });
        const row = saved.rows[0]!;
        return { channel: "alipay", accountLast4: row.account_last4, verificationStatus: row.verification_status, updatedAt: row.updated_at.toISOString() };
      });
    },
    async createWithdrawal(userId, amountYuan, idempotencyKey) {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(idempotencyKey)) throw new Error("提现请求标识无效");
      const amountCents = Math.round(amountYuan * 100);
      if (!Number.isFinite(amountYuan) || !Number.isInteger(amountYuan) || !Number.isSafeInteger(amountCents) || amountCents < GROWTH_REWARDS.withdrawalMinYuan * 100 || amountCents > GROWTH_REWARDS.withdrawalMaxYuan * 100 || amountCents % 1_000 !== 0) throw new Error(`单笔提现金额须为 ${GROWTH_REWARDS.withdrawalMinYuan} 至 ${GROWTH_REWARDS.withdrawalMaxYuan} 元，且为 10 元的整数倍`);
      const feeCents = Math.max(GROWTH_REWARDS.withdrawalFeeMinimumYuan * 100, Math.round(amountCents * GROWTH_REWARDS.withdrawalFeeRate));
      return inTransaction(pool, async (client) => {
        // Serialize withdrawal requests per account before checking the idempotency key.
        // This prevents two simultaneous retries from racing into the unique index.
        const user = await client.query<{ partner_activated_at: Date | null }>("SELECT partner_activated_at FROM users WHERE id = $1 AND deleted_at IS NULL FOR UPDATE", [userId]);
        if (!user.rows[0]?.partner_activated_at) throw new Error("仅已开通的城市合伙人可以申请提现");
        const prior = await client.query<{ id: string; amount_yuan: string; fee_yuan: string; net_amount_yuan: string; status: string; created_at: Date }>(
          "SELECT id, amount_yuan, fee_yuan, net_amount_yuan, status, created_at FROM partner_withdrawals WHERE user_id = $1 AND idempotency_key = $2",
          [userId, idempotencyKey],
        );
        if (prior.rows[0]) {
          const row = prior.rows[0];
          return { id: row.id, amountYuan: Number(row.amount_yuan), feeYuan: Number(row.fee_yuan), netAmountYuan: Number(row.net_amount_yuan), status: row.status, createdAt: row.created_at.toISOString(), replayed: true };
        }
        const profile = await client.query<{ payout_channel: string; account_name_ciphertext: string; account_ciphertext: string; account_last4: string; verification_status: string }>(
          "SELECT payout_channel, account_name_ciphertext, account_ciphertext, account_last4, verification_status FROM partner_payout_profiles WHERE user_id = $1 FOR UPDATE",
          [userId],
        );
        const payout = profile.rows[0];
        if (!payout) throw new Error("请先绑定支付宝收款账号");
        if (payout.verification_status !== "verified") throw new Error("收款账户尚未通过管理员核验，暂不能申请提现");
        const daily = await client.query<{ daily_count: string; daily_amount: string }>(`
          SELECT
            count(*)::text AS daily_count,
            coalesce(sum(amount_yuan), 0)::text AS daily_amount
          FROM partner_withdrawals
          WHERE user_id = $1
            AND status IN ('pending','approved','paid')
            AND (created_at AT TIME ZONE 'Asia/Shanghai')::date = (now() AT TIME ZONE 'Asia/Shanghai')::date
        `, [userId]);
        const dailyCount = Number(daily.rows[0]?.daily_count ?? 0);
        const dailyAmountCents = Math.round(Number(daily.rows[0]?.daily_amount ?? 0) * 100);
        if (dailyCount >= GROWTH_REWARDS.withdrawalDailyCount) {
          throw new Error(`今日提现次数已达上限（每日最多 ${GROWTH_REWARDS.withdrawalDailyCount} 次）`);
        }
        if (dailyAmountCents + amountCents > GROWTH_REWARDS.withdrawalDailyMax * 100) {
          const remaining = Math.max(0, (GROWTH_REWARDS.withdrawalDailyMax * 100 - dailyAmountCents) / 100);
          throw new Error(`今日累计提现已达上限，今日剩余可提 ${remaining.toFixed(2)} 元`);
        }
        const balances = await client.query<{ settled: string; reserved: string }>(`
          SELECT
            coalesce((SELECT sum(c.commission_amount_yuan) FROM partner_commissions c JOIN billing_orders o ON o.id = c.order_id
              WHERE c.beneficiary_user_id = $1 AND c.status = 'settled' AND o.payment_provider = 'opcpay'
                AND o.provider_payment_status = 'PAID' AND o.status = 'paid'), 0)::text AS settled,
            coalesce((SELECT sum(amount_yuan) FROM partner_withdrawals WHERE user_id = $1 AND status IN ('pending','approved','paid')), 0)::text AS reserved
        `, [userId]);
        const availableCents = Math.round((Number(balances.rows[0]?.settled ?? 0) - Number(balances.rows[0]?.reserved ?? 0)) * 100);
        if (amountCents > availableCents) throw new Error("可提现余额不足");
        const inserted = await client.query<{ id: string; created_at: Date }>(`
          INSERT INTO partner_withdrawals
            (user_id, amount_yuan, fee_yuan, net_amount_yuan, status, idempotency_key, payout_channel, payout_name_ciphertext, payout_account_ciphertext, payout_account_last4)
          VALUES ($1, $2, $3, $4, 'pending', $5, $6, $7, $8, $9)
          RETURNING id, created_at
        `, [userId, amountCents / 100, feeCents / 100, (amountCents - feeCents) / 100, idempotencyKey, payout.payout_channel, payout.account_name_ciphertext, payout.account_ciphertext, payout.account_last4]);
        const row = inserted.rows[0]!;
        await audit(client, { userId, entityType: "withdrawal", entityId: row.id, action: "withdrawal.requested", details: { amountYuan: amountCents / 100, feeYuan: feeCents / 100, netAmountYuan: (amountCents - feeCents) / 100, accountLast4: payout.account_last4 } });
        return { id: row.id, amountYuan: amountCents / 100, feeYuan: feeCents / 100, netAmountYuan: (amountCents - feeCents) / 100, status: "pending", createdAt: row.created_at.toISOString(), replayed: false };
      });
    },
    async listWithdrawals(userId) {
      const result = await pool.query<{ id: string; amount_yuan: string; fee_yuan: string; net_amount_yuan: string; status: string; note: string | null; proof_url: string | null; created_at: Date; processed_at: Date | null; payout_account_last4: string | null; arrival_type: string }>(
        "SELECT id, amount_yuan, fee_yuan, net_amount_yuan, status, note, proof_url, created_at, processed_at, payout_account_last4, arrival_type FROM partner_withdrawals WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100",
        [userId],
      );
      return result.rows.map((row) => ({ id: row.id, amountYuan: Number(row.amount_yuan), feeYuan: Number(row.fee_yuan), netAmountYuan: Number(row.net_amount_yuan), status: row.status, note: row.note, proofUrl: row.proof_url, createdAt: row.created_at.toISOString(), processedAt: row.processed_at?.toISOString() ?? null, accountLast4: row.payout_account_last4, arrivalType: row.arrival_type }));
    },
    async settleEligibleCommissions() {
      return settleEligiblePartnerCommissions(pool);
    },
    async listInvitees(userId) {
      return listPartnerInvitees(pool, userId);
    },
    async listCommissions(userId) {
      return listPartnerCommissions(pool, userId);
    },
  };
}

export const GROWTH_REWARDS = {
  signupCredits: 600,
  dailyCheckinCredits: 100,
  inviteCredits: 200,
  partnerInviteTarget: 5,
  levelOneRate: 0.15,
  levelTwoRate: 0.05,
  settlementDays: 7,
  withdrawalMinYuan: 100,
  withdrawalMaxYuan: 5000,
  withdrawalDailyMax: 10000,
  withdrawalDailyCount: 3,
  withdrawalFeeRate: 0.01,
  withdrawalFeeMinimumYuan: 2,
};

export async function claimDailyCheckin(pool: Pool, userId: string) {
  return inTransaction(pool, async (client) => {
    const date = await client.query<{ day: string }>("SELECT (now() AT TIME ZONE 'Asia/Shanghai')::date::text AS day");
    const day = date.rows[0]!.day;
    const inserted = await client.query(
      "INSERT INTO user_daily_checkins (user_id, checkin_date, reward_credits) VALUES ($1, $2::date, $3) ON CONFLICT (user_id, checkin_date) DO NOTHING RETURNING id",
      [userId, day, GROWTH_REWARDS.dailyCheckinCredits],
    );
    const balance = await ensureWallet(client, userId);
    if (!inserted.rowCount) return { alreadyCheckedIn: true, rewardCredits: 0, availableCredits: balance, day };
    const wallet = await client.query<{ available_credits: string | number }>(
      "UPDATE wallets SET available_credits = available_credits + $1, updated_at = now() WHERE user_id = $2 RETURNING available_credits",
      [GROWTH_REWARDS.dailyCheckinCredits, userId],
    );
    await client.query(
      "INSERT INTO billing_ledger (user_id, type, amount, description) VALUES ($1, 'grant', $2, $3)",
      [userId, GROWTH_REWARDS.dailyCheckinCredits, "每日签到奖励 +100 积分"],
    );
    return { alreadyCheckedIn: false, rewardCredits: GROWTH_REWARDS.dailyCheckinCredits, availableCredits: Number(wallet.rows[0]!.available_credits), day };
  });
}

export async function getGrowthOverview(pool: Pool, userId: string) {
  const result = await pool.query(`
    SELECT u.invite_code, u.inviter_user_id, u.partner_activated_at, u.partner_province, u.partner_city,
      (SELECT count(*) FROM users d WHERE d.inviter_user_id = u.id AND d.deleted_at IS NULL) AS invited_count,
      (SELECT count(*) FROM users d2 JOIN users d1 ON d2.inviter_user_id = d1.id WHERE d1.inviter_user_id = u.id AND d2.deleted_at IS NULL AND d1.deleted_at IS NULL) AS second_level_count,
      EXISTS (SELECT 1 FROM user_daily_checkins c WHERE c.user_id = u.id AND c.checkin_date = (now() AT TIME ZONE 'Asia/Shanghai')::date) AS checked_today,
      coalesce((SELECT sum(c.commission_amount_yuan) FROM partner_commissions c JOIN billing_orders o ON o.id = c.order_id
        WHERE c.beneficiary_user_id = u.id AND c.status = 'pending' AND o.payment_provider = 'opcpay'
          AND o.provider_payment_status = 'PAID' AND o.status = 'paid'), 0) AS pending,
      coalesce((SELECT sum(c.commission_amount_yuan) FROM partner_commissions c JOIN billing_orders o ON o.id = c.order_id
        WHERE c.beneficiary_user_id = u.id AND c.status = 'settled' AND o.payment_provider = 'opcpay'
          AND o.provider_payment_status = 'PAID' AND o.status = 'paid'), 0) AS settled,
      coalesce((SELECT sum(w.amount_yuan) FROM partner_withdrawals w WHERE w.user_id = u.id AND w.status NOT IN ('rejected','failed')), 0) AS withdrawn,
      (SELECT count(DISTINCT c.source_user_id) FROM partner_commissions c JOIN billing_orders o ON o.id = c.order_id
        WHERE c.beneficiary_user_id = u.id AND c.level = 1 AND c.status <> 'cancelled' AND o.payment_provider = 'opcpay'
          AND o.provider_payment_status = 'PAID' AND o.status = 'paid') AS level1_count,
      (SELECT count(DISTINCT c.source_user_id) FROM partner_commissions c JOIN billing_orders o ON o.id = c.order_id
        WHERE c.beneficiary_user_id = u.id AND c.level = 2 AND c.status <> 'cancelled' AND o.payment_provider = 'opcpay'
          AND o.provider_payment_status = 'PAID' AND o.status = 'paid') AS level2_count
    FROM users u WHERE u.id = $1 AND u.deleted_at IS NULL LIMIT 1
  `, [userId]);
  const row = result.rows[0];
  if (!row) throw new Error("用户不存在");
  const pending = Number(row.pending);
  const settled = Number(row.settled);
  const withdrawn = Number(row.withdrawn);
  return {
    inviteCode: row.invite_code,
    inviterUserId: row.inviter_user_id,
    inviteUrl: `https://jansee.cn/?ref=${encodeURIComponent(row.invite_code)}`,
    checkin: { checkedToday: row.checked_today, rewardCredits: GROWTH_REWARDS.dailyCheckinCredits },
    referral: {
      invitedCount: Number(row.invited_count),
      secondLevelCount: Number(row.second_level_count),
      rewardCredits: GROWTH_REWARDS.inviteCredits,
      signupCredits: GROWTH_REWARDS.signupCredits,
    },
    partner: {
      isPartner: Boolean(row.partner_activated_at),
      activatedAt: row.partner_activated_at?.toISOString() ?? null,
      target: GROWTH_REWARDS.partnerInviteTarget,
      progress: Math.min(Number(row.invited_count), GROWTH_REWARDS.partnerInviteTarget),
      province: row.partner_province ?? "",
      city: row.partner_city ?? "",
      rates: { levelOne: GROWTH_REWARDS.levelOneRate, levelTwo: GROWTH_REWARDS.levelTwoRate },
      earnings: {
        pending: Number(pending.toFixed(2)),
        settled: Number(settled.toFixed(2)),
        withdrawn: Number(withdrawn.toFixed(2)),
        withdrawable: Number(Math.max(0, settled - withdrawn).toFixed(2)),
        total: Number((pending + settled).toFixed(2)),
      },
    },
  };
}

export async function activateCityPartner(pool: Pool, userId: string) {
  return inTransaction(pool, async (client) => {
    const user = await client.query<{ partner_activated_at: Date | null; invite_count: string }>(
      "SELECT u.partner_activated_at, (SELECT count(*) FROM users d WHERE d.inviter_user_id = u.id AND d.deleted_at IS NULL) AS invite_count FROM users u WHERE u.id = $1 AND u.deleted_at IS NULL FOR UPDATE",
      [userId],
    );
    if (!user.rows[0]) throw new Error("用户不存在");
    if (user.rows[0].partner_activated_at) return { alreadyPartner: true, inviteCount: Number(user.rows[0].invite_count), target: GROWTH_REWARDS.partnerInviteTarget };
    const inviteCount = Number(user.rows[0].invite_count);
    if (inviteCount < GROWTH_REWARDS.partnerInviteTarget) throw new Error(`邀请人数不足：当前 ${inviteCount}/${GROWTH_REWARDS.partnerInviteTarget} 人`);
    const updated = await client.query<{ partner_activated_at: Date }>(
      "UPDATE users SET partner_activated_at = now(), updated_at = now() WHERE id = $1 RETURNING partner_activated_at",
      [userId],
    );
    return { alreadyPartner: false, inviteCount, target: GROWTH_REWARDS.partnerInviteTarget, activatedAt: updated.rows[0]!.partner_activated_at.toISOString() };
  });
}

export async function reservePartnerCity(pool: Pool, userId: string, provinceInput: string, cityInput: string) {
  const province = provinceInput.trim().slice(0, 80);
  const city = cityInput.trim().slice(0, 80);
  if (!province || !city) throw new Error("请选择省份和城市");
  return inTransaction(pool, async (client) => {
    const user = await client.query<{ partner_activated_at: Date | null }>(
      "SELECT partner_activated_at FROM users WHERE id = $1 AND deleted_at IS NULL FOR UPDATE",
      [userId],
    );
    if (!user.rows[0]?.partner_activated_at) throw new Error("请先完成城市合伙人资格升级");
    await client.query(`INSERT INTO partner_city_assignments (user_id, province, city, status)
      VALUES ($1, $2, $3, 'active')
      ON CONFLICT (user_id) DO UPDATE SET province = EXCLUDED.province, city = EXCLUDED.city, status = 'active', released_at = NULL`,
      [userId, province, city],
    );
    await client.query("UPDATE users SET partner_province = $2, partner_city = $3, updated_at = now() WHERE id = $1", [userId, province, city]);
    return { province, city };
  });
}

export async function listPartnerInvitees(pool: Pool, userId: string) {
  const result = await pool.query(`
    SELECT 1 AS level, u.id, u.display_name, u.email, u.phone, u.created_at,
      EXISTS (SELECT 1 FROM billing_orders o WHERE o.user_id = u.id AND o.status = 'paid'
        AND o.payment_provider = 'opcpay' AND o.provider_payment_status = 'PAID') AS has_paid
    FROM users u WHERE u.inviter_user_id = $1 AND u.deleted_at IS NULL
    UNION ALL
    SELECT 2 AS level, u2.id, u2.display_name, u2.email, u2.phone, u2.created_at,
      EXISTS (SELECT 1 FROM billing_orders o WHERE o.user_id = u2.id AND o.status = 'paid'
        AND o.payment_provider = 'opcpay' AND o.provider_payment_status = 'PAID') AS has_paid
    FROM users u1 JOIN users u2 ON u2.inviter_user_id = u1.id
    WHERE u1.inviter_user_id = $1 AND u1.deleted_at IS NULL AND u2.deleted_at IS NULL
    ORDER BY level, created_at DESC
  `, [userId]);
  return result.rows.map((row: any) => ({
    level: Number(row.level), userId: row.id, displayName: row.display_name ?? "",
    contact: row.phone ? `${row.phone.slice(0, 3)}****${row.phone.slice(-4)}` : row.email ? row.email.replace(/^(.).+(@.*)$/, "$1***$2") : "",
    joinedAt: row.created_at.toISOString(), hasPaid: Boolean(row.has_paid),
  }));
}

export async function listPartnerCommissions(pool: Pool, userId: string) {
  const result = await pool.query(`
    SELECT c.id, c.level, c.order_amount_yuan, c.commission_rate, c.commission_amount_yuan,
      c.status, c.created_at, c.settle_at, u.display_name AS source_name, u.email AS source_email, u.phone AS source_phone
    FROM partner_commissions c JOIN users u ON u.id = c.source_user_id
    JOIN billing_orders o ON o.id = c.order_id
    WHERE c.beneficiary_user_id = $1 AND o.payment_provider = 'opcpay'
      AND o.provider_payment_status = 'PAID' AND o.status = 'paid'
    ORDER BY c.created_at DESC LIMIT 200
  `, [userId]);
  return result.rows.map((row: any) => ({
    id: row.id, level: Number(row.level), orderAmountYuan: Number(row.order_amount_yuan),
    rate: Number(row.commission_rate), commissionYuan: Number(row.commission_amount_yuan),
    status: row.status, createdAt: row.created_at.toISOString(), settledAt: row.settle_at?.toISOString() ?? null,
    source: row.source_phone ? `${row.source_phone.slice(0, 3)}****${row.source_phone.slice(-4)}` : row.source_email ? row.source_email.replace(/^(.).+(@.*)$/, "$1***$2") : row.source_name ?? "",
  }));
}
