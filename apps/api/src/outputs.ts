import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import type { AuthStore } from "./auth.js";
import { authenticatedUser } from "./assets.js";
import type { LocalObjectStorage } from "./storage-local.js";

export interface OutputRecord {
  id: string;
  jobId: string;
  userId: string;
  storageKey: string;
  mimeType: string;
  sizeBytes: number;
  durationMs: number | null;
  width: number | null;
  height: number | null;
  status: string;
  createdAt: Date;
  expiresAt: Date | null;
}

export interface NewOutput {
  id?: string;
  jobId: string;
  userId: string;
  storageKey: string;
  mimeType?: string;
  sizeBytes: number;
  durationMs?: number | null;
  width?: number | null;
  height?: number | null;
  expiresAt?: Date | null;
  workerId?: string;
}

export interface OutputStore {
  createOutput(output: NewOutput): Promise<OutputRecord>;
  listUserOutputs(userId: string): Promise<OutputRecord[]>;
  findOutputById(userId: string, outputId: string): Promise<OutputRecord | null>;
  incrementDownloadCount?(userId: string, outputId: string): Promise<void>;
  findExpiredOutputs?(now: Date, limit?: number): Promise<Array<{ id: string; storageKey: string }>>;
  markOutputExpired?(outputId: string, now: Date): Promise<void>;
}

export async function cleanupExpiredOutputs(
  store: OutputStore,
  storage: LocalObjectStorage,
  now = new Date(),
): Promise<number> {
  if (!store.findExpiredOutputs || !store.markOutputExpired) return 0;
  const expired = await store.findExpiredOutputs(now, 100);
  let removed = 0;
  for (const output of expired) {
    try {
      await storage.deleteObject(output.storageKey);
      await store.markOutputExpired(output.id, now);
      removed += 1;
    } catch {
      // Keep the row eligible for the next cleanup pass if either operation fails.
    }
  }
  return removed;
}

export interface OutputRoutesOptions {
  authStore: AuthStore;
  outputStore: OutputStore;
  storage: LocalObjectStorage;
  allowedOrigins: string[];
}

export function registerOutputRoutes(app: FastifyInstance, options: OutputRoutesOptions): void {
  app.get("/api/v1/works", async (request, reply) => {
    const user = await authenticatedUser(request, options.authStore);
    if (!user) return reply.code(401).send({ error: { code: "AUTH_REQUIRED" } });

    const outputs = await options.outputStore.listUserOutputs(user.id);
    return reply.header("cache-control", "no-store").send({
      works: outputs.map((out) => ({
        id: out.id,
        jobId: out.jobId,
        mimeType: out.mimeType,
        sizeBytes: out.sizeBytes,
        durationMs: out.durationMs,
        width: out.width,
        height: out.height,
        status: out.status,
        createdAt: out.createdAt.toISOString(),
        expiresAt: out.expiresAt?.toISOString() ?? null,
      })),
    });
  });

  app.get("/api/v1/works/:id", async (request, reply) => {
    const user = await authenticatedUser(request, options.authStore);
    if (!user) return reply.code(401).send({ error: { code: "AUTH_REQUIRED" } });
    const { id } = request.params as { id: string };
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
      return reply.code(400).send({ error: { code: "INVALID_OUTPUT_ID", message: "作品 ID 格式无效" } });
    }
    const output = await options.outputStore.findOutputById(user.id, id);
    if (!output) {
      return reply.code(404).send({ error: { code: "WORK_NOT_FOUND", message: "作品不存在或已过期" } });
    }
    return reply.header("cache-control", "no-store").send({ work: output });
  });

  app.get("/api/v1/works/:id/stream", async (request, reply) => {
    const user = await authenticatedUser(request, options.authStore);
    if (!user) return reply.code(401).send({ error: { code: "AUTH_REQUIRED" } });
    const { id } = request.params as { id: string };
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
      return reply.code(400).send({ error: { code: "INVALID_OUTPUT_ID" } });
    }
    const output = await options.outputStore.findOutputById(user.id, id);
    if (!output) {
      return reply.code(404).send({ error: { code: "WORK_NOT_FOUND" } });
    }
    const filePath = await options.storage.getFilePath(output.storageKey);
    const fileStat = await stat(filePath);
    if (options.outputStore.incrementDownloadCount && (request.query as { download?: string }).download === "1") {
      try { await options.outputStore.incrementDownloadCount(user.id, output.id); }
      catch { /* 统计失败不影响作品下载 */ }
    }
    reply.header("cache-control", "private, no-store");
    reply.header("content-type", output.mimeType || "video/mp4");
    reply.header("content-length", fileStat.size);
    reply.header("accept-ranges", "bytes");
    return reply.send(createReadStream(filePath));
  });
}

