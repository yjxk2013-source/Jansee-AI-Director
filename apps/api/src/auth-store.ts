import { randomBytes } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { AuthStore, AuthUser } from "./auth.js";

interface UserRow {
  id: string;
  email?: string | null;
  phone?: string | null;
  display_name: string | null;
  created_at: Date;
  password_hash?: string;
  status?: string;
}

function mapUser(row: UserRow): AuthUser {
  return {
    id: row.id,
    ...(row.email ? { email: row.email } : {}),
    ...(row.phone ? { phone: row.phone } : {}),
    displayName: row.display_name,
    createdAt: row.created_at,
  };
}

async function inTransaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const value = await fn(client);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export function createPgAuthStore(pool: Pool): AuthStore {
  return {
    async createUser(input) {
      return inTransaction(pool, async (client) => {
        const inviteCode = randomBytes(6).toString("hex").toUpperCase();
        const inserted = await client.query<UserRow>(
          "INSERT INTO users (email, phone, password_hash, display_name, invite_code, register_province, register_city, register_region) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, email, phone, display_name, created_at",
          [input.email ?? null, input.phone ?? null, input.passwordHash ?? null, input.displayName, inviteCode, input.registerProvince ?? null, input.registerCity ?? null, input.registerRegion ?? null],
        );
        const user = inserted.rows[0]!;
        const signupWallet = await client.query(
          "INSERT INTO wallets (user_id, available_credits, free_available_credits) VALUES ($1, 600, 600) ON CONFLICT (user_id) DO NOTHING RETURNING user_id",
          [user.id],
        );
        if (signupWallet.rowCount) {
          await client.query(
            "INSERT INTO billing_ledger (user_id, type, amount, free_amount, description) VALUES ($1, 'grant', 600, 600, $2)",
            [user.id, "\u65b0\u8d26\u53f7\u6ce8\u518c\u4f53\u9a8c\u79ef\u5206"],
          );
        }
        const requestedCode = String(input.inviteCode ?? "").trim().toUpperCase();
        if (requestedCode) {
          const inviterResult = await client.query<{ id: string }>(
            "SELECT id FROM users WHERE invite_code = $1 AND deleted_at IS NULL AND status = 'active' AND id <> $2 LIMIT 1 FOR UPDATE",
            [requestedCode, user.id],
          );
          const inviterId = inviterResult.rows[0]?.id;
          if (inviterId) {
            await client.query("UPDATE users SET inviter_user_id = $1 WHERE id = $2", [inviterId, user.id]);
            const referralReward = await client.query(
              "INSERT INTO referral_rewards (inviter_user_id, invitee_user_id, reward_credits) VALUES ($1, $2, 200) ON CONFLICT (invitee_user_id) DO NOTHING RETURNING id",
              [inviterId, user.id],
            );
            if (referralReward.rowCount) {
              const wallet = await client.query(
                "INSERT INTO wallets (user_id, available_credits, free_available_credits) VALUES ($1, 600, 600) ON CONFLICT (user_id) DO NOTHING RETURNING user_id",
                [inviterId],
              );
              if (wallet.rowCount) {
                await client.query(
                  "INSERT INTO billing_ledger (user_id, type, amount, free_amount, description) VALUES ($1, 'grant', 600, 600, $2)",
                  [inviterId, "新账号注册体验积分"],
                );
              }
              const reward = await client.query(
                "UPDATE wallets SET available_credits = available_credits + 200, free_available_credits = free_available_credits + 200, updated_at = now() WHERE user_id = $1 RETURNING user_id",
                [inviterId],
              );
              if (reward.rowCount) {
                await client.query(
                  "INSERT INTO billing_ledger (user_id, type, amount, free_amount, description) VALUES ($1, 'grant', 200, 200, $2)",
                  [inviterId, "邀请好友注册奖励 +200 积分"],
                );
              }
            }
          }
        }
        return mapUser(user);
      });
    },

    async findUserByEmail(email) {
      const result = await pool.query<UserRow>(
        "SELECT id, email, phone, display_name, created_at, password_hash, status FROM users WHERE lower(email) = $1 AND deleted_at IS NULL LIMIT 1",
        [email],
      );
      const row = result.rows[0];
      return row?.password_hash ? { ...mapUser(row), passwordHash: row.password_hash, status: row.status ?? "active" } : null;
    },

    async findUserByPhone(phone) {
      const result = await pool.query<UserRow>(
        "SELECT id, email, phone, display_name, created_at, password_hash, status FROM users WHERE phone = $1 AND deleted_at IS NULL LIMIT 1",
        [phone],
      );
      const row = result.rows[0];
      return row ? { ...mapUser(row), ...(row.password_hash ? { passwordHash: row.password_hash } : {}), status: row.status ?? "active" } : null;
    },

    async setPassword(userId, passwordHash) {
      const result = await pool.query<UserRow>(
        "UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1 AND deleted_at IS NULL AND status = 'active' RETURNING id, email, phone, display_name, created_at",
        [userId, passwordHash],
      );
      return result.rows[0] ? mapUser(result.rows[0]) : null;
    },

    async updateDisplayName(userId, displayName) {
      const result = await pool.query<UserRow>(
        "UPDATE users SET display_name = $2, updated_at = now() WHERE id = $1 AND deleted_at IS NULL AND status = 'active' RETURNING id, email, phone, display_name, created_at",
        [userId, displayName],
      );
      return result.rows[0] ? mapUser(result.rows[0]) : null;
    },

    async createSession(input) {
      await pool.query(
        "INSERT INTO auth_sessions (user_id, token_hash, user_agent, ip_hash, expires_at) VALUES ($1, $2, $3, $4, $5)",
        [input.userId, input.tokenHash, input.userAgent, input.ipHash, input.expiresAt],
      );
    },

    async findSession(tokenHash) {
      const result = await pool.query<UserRow & { expires_at: Date }>(
        "SELECT u.id, u.email, u.phone, u.display_name, u.created_at, s.expires_at FROM auth_sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now() AND u.status = 'active' AND u.deleted_at IS NULL LIMIT 1",
        [tokenHash],
      );
      const row = result.rows[0];
      return row ? { user: mapUser(row), expiresAt: row.expires_at } : null;
    },

    async revokeSession(tokenHash) {
      await pool.query("UPDATE auth_sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL", [tokenHash]);
    },
  };
}
