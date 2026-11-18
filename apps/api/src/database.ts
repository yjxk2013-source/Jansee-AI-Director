import { Pool, type PoolConfig } from "pg";

export interface DatabaseConfig {
  connectionString: string;
  ssl: boolean;
  maxConnections?: number;
}

const TRANSIENT_DATABASE_CODES = new Set([
  "08000", "08001", "08003", "08004", "08006", "08007", "08P01",
  "34000", "40001", "40P01", "53300", "57P01", "57P03",
]);

export function isTransientDatabaseError(error: unknown): boolean {
  const candidate = error as { code?: unknown; errno?: unknown; name?: unknown; message?: unknown } | null;
  const code = typeof candidate?.code === "string" ? candidate.code : "";
  const errno = typeof candidate?.errno === "string" ? candidate.errno : "";
  const message = typeof candidate?.message === "string" ? candidate.message : "";
  return TRANSIENT_DATABASE_CODES.has(code)
    || message.includes('portal "" does not exist')
    || ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "ENETUNREACH"].includes(code)
    || ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "ENETUNREACH"].includes(errno)
    || candidate?.name === "ConnectionError";
}

export async function withDatabaseRetry<T>(
  operation: () => Promise<T>,
  options: { attempts?: number; delayMs?: number } = {},
): Promise<T> {
  const attempts = Math.max(1, Math.min(3, options.attempts ?? 3));
  const delayMs = Math.max(0, options.delayMs ?? 100);
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !isTransientDatabaseError(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, delayMs * attempt));
    }
  }
  throw lastError;
}

export function createDatabasePool(config: DatabaseConfig): Pool {
  const poolConfig: PoolConfig = {
    connectionString: config.connectionString,
    max: config.maxConnections ?? 10,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 60_000,
    maxLifetimeSeconds: 300,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
    ...(config.ssl ? { ssl: { rejectUnauthorized: true } } : {}),
    application_name: "jansee-v4-api",
  };
  return new Pool(poolConfig);
}

export async function checkDatabase(pool: Pool): Promise<boolean> {
  try {
    await pool.query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}
