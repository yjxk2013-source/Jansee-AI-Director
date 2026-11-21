import type { Pool } from "pg";
import { decryptPayoutValue } from "../growth-store.js";

function numeric(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

export interface PartnerSummaryItem {
  userId: string;
  displayName: string;
  contact: string;
  province: string | null;
  city: string | null;
  activatedAt: string;
  directInvites: number;
  secondLevelInvites: number;
  pendingCommissionYuan: number;
  settledCommissionYuan: number;
  reservedWithdrawalYuan: number;
  withdrawableYuan: number;
  payoutVerificationStatus: string;
  payoutAccountLast4: string | null;
}

export interface WithdrawalRecordItem {
  id: string;
  userId: string;
  displayName: string;
  contact: string;
  amountYuan: number;
  feeYuan: number;
  netAmountYuan: number;
  status: string;
  note: string | null;
  externalReference: string | null;
  payoutChannel: string;
  accountLast4: string;
  createdAt: string;
  processedAt: string | null;
}

export async function fetchPartnerDirectory(pool: Pool, limit: number): Promise<PartnerSummaryItem[]> {
  const result = await pool.query(`
    SELECT u.id AS user_id, u.display_name, u.phone, u.email, u.partner_province, u.partner_city,
      u.partner_activated_at,
      (SELECT count(*) FROM users d WHERE d.inviter_user_id = u.id AND d.deleted_at IS NULL)::int AS direct_invites,
      (SELECT count(*) FROM users d2 JOIN users d1 ON d2.inviter_user_id = d1.id
        WHERE d1.inviter_user_id = u.id AND d1.deleted_at IS NULL AND d2.deleted_at IS NULL)::int AS second_level_invites,
      coalesce((SELECT sum(c.commission_amount_yuan) FROM partner_commissions c JOIN billing_orders o ON o.id = c.order_id
        WHERE c.beneficiary_user_id = u.id AND c.status = 'pending' AND o.payment_provider = 'opcpay'
          AND o.provider_payment_status = 'PAID' AND o.status = 'paid'), 0) AS pending_commission,
      coalesce((SELECT sum(c.commission_amount_yuan) FROM partner_commissions c JOIN billing_orders o ON o.id = c.order_id
        WHERE c.beneficiary_user_id = u.id AND c.status = 'settled' AND o.payment_provider = 'opcpay'
          AND o.provider_payment_status = 'PAID' AND o.status = 'paid'), 0) AS settled_commission,
      coalesce((SELECT sum(w.amount_yuan) FROM partner_withdrawals w
        WHERE w.user_id = u.id AND w.status IN ('pending','approved','paid')), 0) AS reserved_withdrawal,
      p.verification_status AS payout_verification_status, p.account_last4
    FROM users u
    LEFT JOIN partner_payout_profiles p ON p.user_id = u.id
    WHERE u.partner_activated_at IS NOT NULL AND u.deleted_at IS NULL
    ORDER BY u.partner_activated_at DESC
    LIMIT $1
  `, [limit]);

  return result.rows.map((row) => ({
    userId: row.user_id,
    displayName: row.display_name ?? "简兮用户",
    contact: row.phone ? `${row.phone.slice(0, 3)}****${row.phone.slice(-4)}` : row.email ?? "",
    province: row.partner_province,
    city: row.partner_city,
    activatedAt: row.partner_activated_at.toISOString(),
    directInvites: numeric(row.direct_invites),
    secondLevelInvites: numeric(row.second_level_invites),
    pendingCommissionYuan: numeric(row.pending_commission),
    settledCommissionYuan: numeric(row.settled_commission),
    reservedWithdrawalYuan: numeric(row.reserved_withdrawal),
    withdrawableYuan: Math.max(0, Number((numeric(row.settled_commission) - numeric(row.reserved_withdrawal)).toFixed(2))),
    payoutVerificationStatus: row.payout_verification_status ?? "not_bound",
    payoutAccountLast4: row.account_last4 ?? null,
  }));
}

export async function fetchWithdrawals(pool: Pool, status: string | null, limit: number): Promise<WithdrawalRecordItem[]> {
  const result = await pool.query(`
    SELECT w.id, w.user_id, u.display_name, u.phone, u.email, w.amount_yuan, w.fee_yuan, w.net_amount_yuan,
      w.status, w.note, w.external_reference, w.payout_channel, w.payout_account_last4, w.created_at, w.processed_at,
      w.admin_user_id
    FROM partner_withdrawals w JOIN users u ON u.id = w.user_id
    WHERE ($1::text IS NULL OR w.status = $1)
    ORDER BY CASE WHEN w.status = 'pending' THEN 0 WHEN w.status = 'approved' THEN 1 ELSE 2 END, w.created_at ASC
    LIMIT $2
  `, [status, limit]);

  return result.rows.map((row) => ({
    id: row.id,
    userId: row.user_id,
    displayName: row.display_name ?? "简兮用户",
    contact: row.phone ? `${row.phone.slice(0, 3)}****${row.phone.slice(-4)}` : row.email ?? "",
    amountYuan: numeric(row.amount_yuan),
    feeYuan: numeric(row.fee_yuan),
    netAmountYuan: numeric(row.net_amount_yuan),
    status: row.status,
    note: row.note,
    externalReference: row.external_reference,
    payoutChannel: row.payout_channel,
    accountLast4: row.payout_account_last4,
    createdAt: row.created_at.toISOString(),
    processedAt: row.processed_at?.toISOString() ?? null,
  }));
}

export async function fetchWithdrawalPayoutDetail(pool: Pool, withdrawalId: string, operatorId: string) {
  const result = await pool.query<{ user_id: string; payout_channel: string; payout_name_ciphertext: string; payout_account_ciphertext: string; payout_account_last4: string; status: string }>(
    "SELECT user_id, payout_channel, payout_name_ciphertext, payout_account_ciphertext, payout_account_last4, status FROM partner_withdrawals WHERE id = $1",
    [withdrawalId],
  );
  const row = result.rows[0];
  if (!row) return null;
  const key = process.env.PARTNER_PAYOUT_ENCRYPTION_KEY;
  const accountName = decryptPayoutValue(row.payout_name_ciphertext, key);
  const account = decryptPayoutValue(row.payout_account_ciphertext, key);
  await pool.query(
    "INSERT INTO partner_audit_events (user_id, actor_user_id, entity_type, entity_id, action, details) VALUES ($1, $2, 'withdrawal', $3, 'withdrawal.payout_details_viewed', $4::jsonb)",
    [row.user_id, operatorId, withdrawalId, JSON.stringify({ accountLast4: row.payout_account_last4 })],
  );
  return { channel: row.payout_channel, accountName, account, accountLast4: row.payout_account_last4, withdrawalStatus: row.status };
}

export async function fetchPendingPartnerProfiles(pool: Pool) {
  const result = await pool.query(`
    SELECT p.user_id, p.payout_channel, p.account_last4, p.verification_status, p.updated_at,
      u.display_name, u.phone, u.email, u.partner_province, u.partner_city
    FROM partner_payout_profiles p JOIN users u ON u.id = p.user_id
    WHERE p.verification_status = 'pending'
    ORDER BY p.updated_at ASC LIMIT 200
  `);
  return result.rows.map((row) => ({
    userId: row.user_id,
    channel: row.payout_channel,
    accountLast4: row.account_last4,
    displayName: row.display_name ?? "简兮用户",
    contact: row.phone ? `${row.phone.slice(0, 3)}****${row.phone.slice(-4)}` : row.email ?? "",
    province: row.partner_province,
    city: row.partner_city,
    updatedAt: row.updated_at.toISOString(),
  }));
}

export async function fetchPartnerProfileDetail(pool: Pool, userId: string, operatorId: string) {
  const result = await pool.query<{ payout_channel: string; account_name_ciphertext: string; account_ciphertext: string; account_last4: string; verification_status: string }>(
    "SELECT payout_channel, account_name_ciphertext, account_ciphertext, account_last4, verification_status FROM partner_payout_profiles WHERE user_id = $1",
    [userId],
  );
  const row = result.rows[0];
  if (!row) return null;
  const key = process.env.PARTNER_PAYOUT_ENCRYPTION_KEY;
  const accountName = decryptPayoutValue(row.account_name_ciphertext, key);
  const account = decryptPayoutValue(row.account_ciphertext, key);
  await pool.query(
    "INSERT INTO partner_audit_events (user_id, actor_user_id, entity_type, action, details) VALUES ($1, $2, 'payout_profile', 'payout_profile.details_viewed', $3::jsonb)",
    [userId, operatorId, JSON.stringify({ accountLast4: row.account_last4 })],
  );
  return { channel: row.payout_channel, accountName, account, accountLast4: row.account_last4, verificationStatus: row.verification_status };
}

export async function reviewPartnerProfile(pool: Pool, userId: string, status: "verified" | "rejected", note: string, operatorId: string) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const profile = await client.query<{ verification_status: string }>("SELECT verification_status FROM partner_payout_profiles WHERE user_id = $1 FOR UPDATE", [userId]);
    if (!profile.rows[0]) {
      await client.query("ROLLBACK");
      return { code: "NOT_FOUND" as const };
    }
    if (profile.rows[0].verification_status !== "pending") {
      await client.query("ROLLBACK");
      return { code: "ALREADY_REVIEWED" as const };
    }
    await client.query("UPDATE partner_payout_profiles SET verification_status = $2, verification_note = $3, verified_at = CASE WHEN $2 = 'verified' THEN now() ELSE NULL END, updated_at = now() WHERE user_id = $1", [userId, status, note || null]);
    await client.query("INSERT INTO partner_audit_events (user_id, actor_user_id, entity_type, action, details) VALUES ($1, $2, 'payout_profile', 'payout_profile.reviewed', $3::jsonb)", [userId, operatorId, JSON.stringify({ status, note })]);
    await client.query("COMMIT");
    return { code: "OK" as const };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export async function reviewWithdrawal(pool: Pool, withdrawalId: string, status: "approved" | "rejected", note: string, operatorId: string) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const current = await client.query<{ user_id: string; status: string; amount_yuan: string }>(
      "SELECT user_id, status, amount_yuan FROM partner_withdrawals WHERE id = $1 FOR UPDATE",
      [withdrawalId],
    );
    const row = current.rows[0];
    if (!row) {
      await client.query("ROLLBACK");
      return { code: "NOT_FOUND" as const };
    }
    if (row.status !== "pending") {
      await client.query("ROLLBACK");
      return { code: "NOT_PENDING" as const };
    }
    await client.query(
      "UPDATE partner_withdrawals SET status = $2, note = $3, admin_user_id = $4, processed_at = now(), updated_at = now() WHERE id = $1",
      [withdrawalId, status, note || null, operatorId],
    );
    await client.query(
      "INSERT INTO partner_audit_events (user_id, actor_user_id, entity_type, entity_id, action, details) VALUES ($1, $2, 'withdrawal', $3, 'withdrawal.reviewed', $4::jsonb)",
      [row.user_id, operatorId, withdrawalId, JSON.stringify({ status, amountYuan: numeric(row.amount_yuan), note })],
    );
    await client.query("COMMIT");
    return { code: "OK" as const };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export async function markWithdrawalPaid(pool: Pool, withdrawalId: string, reference: string, note: string, operatorId: string) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const current = await client.query<{ user_id: string; status: string; net_amount_yuan: string }>(
      "SELECT user_id, status, net_amount_yuan FROM partner_withdrawals WHERE id = $1 FOR UPDATE",
      [withdrawalId],
    );
    const row = current.rows[0];
    if (!row) {
      await client.query("ROLLBACK");
      return { code: "NOT_FOUND" as const };
    }
    if (row.status !== "approved") {
      await client.query("ROLLBACK");
      return { code: "NOT_APPROVED" as const };
    }
    await client.query(
      "UPDATE partner_withdrawals SET status = 'paid', external_reference = $2, note = $3, admin_user_id = $4, processed_at = now(), updated_at = now() WHERE id = $1",
      [withdrawalId, reference, note || null, operatorId],
    );
    await client.query(
      "INSERT INTO partner_audit_events (user_id, actor_user_id, entity_type, entity_id, action, details) VALUES ($1, $2, 'withdrawal', $3, 'withdrawal.paid', $4::jsonb)",
      [row.user_id, operatorId, withdrawalId, JSON.stringify({ netAmountYuan: numeric(row.net_amount_yuan), externalReference: reference, note })],
    );
    await client.query("COMMIT");
    return { code: "OK" as const };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if ((error as { code?: string })?.code === "23505") {
      return { code: "REFERENCE_DUPLICATE" as const };
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function markWithdrawalFailed(pool: Pool, withdrawalId: string, note: string, operatorId: string) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const current = await client.query<{ user_id: string; status: string }>(
      "SELECT user_id, status FROM partner_withdrawals WHERE id = $1 FOR UPDATE",
      [withdrawalId],
    );
    const row = current.rows[0];
    if (!row) {
      await client.query("ROLLBACK");
      return { code: "NOT_FOUND" as const };
    }
    if (row.status !== "approved") {
      await client.query("ROLLBACK");
      return { code: "NOT_APPROVED" as const };
    }
    await client.query(
      "UPDATE partner_withdrawals SET status = 'failed', note = $2, admin_user_id = $3, processed_at = now(), updated_at = now() WHERE id = $1",
      [withdrawalId, note, operatorId],
    );
    await client.query(
      "INSERT INTO partner_audit_events (user_id, actor_user_id, entity_type, entity_id, action, details) VALUES ($1, $2, 'withdrawal', $3, 'withdrawal.failed', $4::jsonb)",
      [row.user_id, operatorId, withdrawalId, JSON.stringify({ note })],
    );
    await client.query("COMMIT");
    return { code: "OK" as const };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
