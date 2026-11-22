import { z } from "zod";
import type { CreationMode, AspectRatio, JobStatus } from "@jansee/contracts";
import type { FastifyInstance } from "fastify";
import type { AuthStore } from "./auth.js";
import type { AssetStore } from "./assets.js";
import { authenticatedUser } from "./assets.js";
import { assertJobTransition } from "@jansee/domain";
import type { BillingStore } from "./billing.js";
import { GENERATION_COST_CREDITS, isFreeCreationEntry } from "./billing.js";
import { detectSensitiveTerms } from "./content-safety.js";
import { BATCH_VERSION_LIMIT, deriveBatchIdempotencyKey } from "./batch-versions.js";
import { detectCreationScene, withCreationSceneMarker, type CreationEntryScene } from "./prompt-assembly.js";

export const CreateJobRequestSchema = z.object({
  mode: z.enum(["image-film", "video-dub", "storyboard"]),
  prompt: z.string().trim().min(1).max(2_000),
  aspectRatio: z.enum(["9:16", "16:9", "1:1", "4:3"]).default("9:16"),
  creationScene: z.enum(["online-ecommerce", "physical-store", "personal-creation", "quick-cut"]).optional(),
  assetIds: z.array(z.string().uuid()).min(1).max(9).refine((ids) => new Set(ids).size === ids.length, "素材不能重复"),
  directorPlan: z.record(z.string(), z.unknown()).optional(),
  // 批量赛马：规划接口一次 LLM 调用产出的 N 版差异化方案，逐版对应一个任务（下标即版本序）。
  directorPlans: z.array(z.record(z.string(), z.unknown())).max(BATCH_VERSION_LIMIT).optional(),
  idempotencyKey: z.string().uuid(),
  // 多版成片（批量赛马）：客户端由规划接口返回的 batch.total 透传；服务端在此校验上限
  versions: z.number().int().min(1).max(BATCH_VERSION_LIMIT).optional(),
}).strict().superRefine((val, ctx) => {
  if (val.mode === "video-dub" && val.assetIds.length !== 1) {
    ctx.addIssue({ code: "custom", path: ["assetIds"], message: "视频配音只接受一个视频素材" });
  }
  if (val.mode === "storyboard" && val.assetIds.length < 2) {
    ctx.addIssue({ code: "custom", path: ["assetIds"], message: "分镜成片至少需要两个视频素材" });
  }
});
export type CreateJobRequest = z.infer<typeof CreateJobRequestSchema>;

/** 批量赛马时服务端逐版构造的任务输入。 */
export type CreateJobInput = CreateJobRequest & {
  batchIndex?: number;
  creationScene?: CreationEntryScene;
};

export interface GenerationJobRecord {
  id: string;
  userId: string;
  mode: CreationMode;
  status: JobStatus;
  prompt: string;
  aspectRatio: AspectRatio;
  idempotencyKey: string;
  requestPayload: Record<string, unknown>;
  directorPlan: Record<string, unknown> | null;
  progress: number;
  errorCode: string | null;
  errorMessage: string | null;
  queuedAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  assetIds: string[];
}

export interface JobStore {
  createJob(userId: string, input: CreateJobInput): Promise<GenerationJobRecord>;
  findJobById(userId: string, jobId: string): Promise<GenerationJobRecord | null>;
  updateJobStatus?(userId: string, jobId: string, toStatus: JobStatus, progress?: number, error?: { code: string; message: string }, workerId?: string): Promise<GenerationJobRecord | null>;
  updateDirectorPlan?(userId: string, jobId: string, directorPlan: Record<string, unknown>, workerId?: string): Promise<void>;
  heartbeatJob?(userId: string, jobId: string, workerId: string, leaseSeconds?: number): Promise<boolean>;
  getJobQueuePosition?(jobId: string, queuedAt: Date): Promise<{ queuePosition: number; estimatedWaitSec: number }>;
}

export interface JobRoutesOptions {
  authStore: AuthStore;
  assetStore: AssetStore;
  jobStore: JobStore;
  billingStore?: BillingStore | undefined;
  allowedOrigins: string[];
}

function publicDirectorPlan(plan: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!plan) return null;
  const visible = { ...plan };
  delete visible["_telemetry"];
  delete visible["_providerTelemetry"];
  return visible;
}

export function registerJobRoutes(app: FastifyInstance, options: JobRoutesOptions): void {
  app.post("/api/v1/jobs", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (request, reply) => {
    if (typeof request.headers.origin === "string" && !options.allowedOrigins.includes(request.headers.origin)) {
      return reply.code(403).send({ error: { code: "ORIGIN_NOT_ALLOWED" } });
    }
    const user = await authenticatedUser(request, options.authStore);
    if (!user) return reply.code(401).send({ error: { code: "AUTH_REQUIRED", message: "请先登录后再提交制作任务" } });

    const parsed = CreateJobRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: { code: "INVALID_JOB_REQUEST", message: "生成任务参数不符合要求", requestId: request.id } });
    }
    const contentHits = detectSensitiveTerms({ prompt: parsed.data.prompt, directorPlan: parsed.data.directorPlan, directorPlans: parsed.data.directorPlans });
    if (contentHits.length > 0) {
      request.log.warn({ userId: user.id, scene: "jobs.create", hitCount: contentHits.length }, "blocked job content by local preflight");
      return reply.code(422).send({ error: { code: "CONTENT_POLICY_BLOCKED", message: "内容可能涉及平台禁止内容或高风险宣传用语，请调整描述后重试", requestId: request.id } });
    }
    // Only the authenticated confirmation flow may submit a speech-cut plan.
    if (parsed.data.directorPlan?.operation === "speech-cut" || parsed.data.directorPlan?._serverValidatedSpeechCut === true) {
      return reply.code(400).send({ error: { code: "UNTRUSTED_SPEECH_CUT_PLAN", message: "语音精剪必须先完成服务端分析并确认建议" } });
    }

    // 入口场景以客户端明确选择为准；旧客户端没有该字段时仍按提示词前缀/关键词推断。
    const creationScene: CreationEntryScene = parsed.data.creationScene ?? detectCreationScene(parsed.data.prompt, parsed.data.mode);
    const isFreeEntry = isFreeCreationEntry(creationScene);
    console.info(`[API-任务创建] 收到请求: mode=${parsed.data.mode}, scene=${creationScene}, versions=${parsed.data.versions ?? 1}, 用户=${user.id.slice(0, 8)}`);
    // 游客（未绑定手机/邮箱）不带可消费积分：收费场景直接引导注册，防止匿名会话白嫖付费产能。
    // 资格检查必须在素材归属/计费检查之前——先问资格，再查资源。
    if (!isFreeEntry && !user.phone && !user.email) {
      return reply.code(401).send({
        error: {
          code: "GUEST_PAID_SCENE_BLOCKED",
          message: "带货视频/门店获客为付费功能，请先注册登录后再使用；个人创作与一句话剪辑无需注册即可体验",
          requestId: request.id,
        },
      });
    }

    // 素材归属/类型一致性校验已移除：素材为用户自行上传、成片只交付提交者，无需在提交环节做归属检查。

    // 多版成片（批量赛马）：免费入口没有变体体系，强制降为单版（防客户端用 versions 放大免费额度）。
    const versions = isFreeEntry
      ? 1
      : Math.max(1, Math.min(BATCH_VERSION_LIMIT, parsed.data.versions ?? 1));
    // 把场景前缀写回任务提示词，worker/renderer 复用同一事实来源；quick-cut 由 requestPayload 标记。
    const storedPrompt = withCreationSceneMarker(parsed.data.prompt, creationScene);

    // 计费检查：个人创作/一句话剪辑入口免费；其余场景每版预冻结 200 积分，N 版共 N×200。
    const requiredCredits = isFreeEntry ? 0 : GENERATION_COST_CREDITS * versions;
    if (options.billingStore && !isFreeEntry) {
      const wallet = await options.billingStore.getWallet(user.id);
      if (wallet.availableCredits < requiredCredits) {
        return reply.code(402).send({
          error: {
            code: "INSUFFICIENT_CREDITS",
            message: `积分不足：当前可用 ${wallet.availableCredits} 积分，本次制作需要 ${requiredCredits} 积分`,
            availableCredits: wallet.availableCredits,
            requiredCredits,
            requestId: request.id,
          },
        });
      }
    }

    const jobSummary = (job: GenerationJobRecord) => ({
      id: job.id,
      mode: job.mode,
      status: job.status,
      prompt: job.prompt,
      aspectRatio: job.aspectRatio,
      progress: job.progress,
      directorPlan: publicDirectorPlan(job.directorPlan),
      createdAt: job.createdAt.toISOString(),
    });

    if (versions === 1) {
      const job = await options.jobStore.createJob(user.id, { ...parsed.data, prompt: storedPrompt, creationScene });
      if (options.billingStore && !isFreeEntry) {
        await options.billingStore.holdCredits(user.id, job.id, GENERATION_COST_CREDITS);
      }
      console.info(`[API-任务入队 | 任务:${job.id.slice(0, 8)}] 单任务已入库排队 (mode=${job.mode})`);
      return reply.code(201).send({ job: jobSummary(job) });
    }

    // 批量赛马：一次请求连续创建 N 个独立任务（各自幂等键、各自冻结 200 积分、独立生命周期）。
    // 新链路：规划接口一次 LLM 调用产出 N 版差异化方案，每版任务直接携带各自方案，worker 不再补跑。
    // 方案缺失的版本由 Worker 使用与单片一致的导演提示词独立补跑。
    const clientPlans = Array.isArray(parsed.data.directorPlans) ? parsed.data.directorPlans : [];
    const batchBaseInput: Omit<CreateJobRequest, "directorPlan" | "directorPlans"> & { creationScene: CreationEntryScene } = {
      creationScene,
      mode: parsed.data.mode,
      prompt: storedPrompt,
      aspectRatio: parsed.data.aspectRatio,
      assetIds: parsed.data.assetIds,
      idempotencyKey: parsed.data.idempotencyKey,
      ...(parsed.data.versions !== undefined ? { versions: parsed.data.versions } : {}),
    };
    const created: Array<{ job: GenerationJobRecord; billed: boolean }> = [];
    try {
      for (let index = 0; index < versions; index += 1) {
        const planForVersion = clientPlans[index] ?? (index === 0 ? parsed.data.directorPlan : undefined);
        const input: CreateJobInput = {
          ...batchBaseInput,
          idempotencyKey: index === 0
            ? parsed.data.idempotencyKey
            : deriveBatchIdempotencyKey(parsed.data.idempotencyKey, index + 1),
          batchIndex: index + 1,
          ...(planForVersion ? { directorPlan: planForVersion } : {}),
        };
        const job = await options.jobStore.createJob(user.id, input);
        created.push({ job, billed: false });
        // 只有带货视频/门店获客收费；免费入口即使将来放开多版也绝不冻结积分。
        if (options.billingStore && !isFreeEntry) {
          await options.billingStore.holdCredits(user.id, job.id, GENERATION_COST_CREDITS);
          created[created.length - 1]!.billed = true;
        }
      }
    } catch (error) {
      request.log.error({ userId: user.id, versions, createdCount: created.length }, "batch job creation failed; rolling back");
      // 商业信誉底线：批量创建中途失败，已冻结积分全额退还、已建任务标 failed（逆序幂等回退）。
      for (const item of [...created].reverse()) {
        if (item.billed && options.billingStore) {
          await options.billingStore.refundCredits(user.id, item.job.id).catch(() => undefined);
        }
        await options.jobStore.updateJobStatus?.(user.id, item.job.id, "failed", undefined, {
          code: "BATCH_CREATE_ROLLBACK",
          message: error instanceof Error ? error.message.slice(0, 200) : "批量创建失败，本任务已回退",
        }).catch(() => undefined);
      }
      return reply.code(500).send({
        error: {
          code: "BATCH_CREATE_FAILED",
          message: "批量创建任务失败，已创建的任务已回退并退还积分，请稍后重试",
          requestId: request.id,
        },
      });
    }

    return reply.code(201).send({
      jobs: created.map((item) => jobSummary(item.job)),
      job: jobSummary(created[0]!.job),
      batch: { total: versions },
    });
  });

  const serializeJobPayload = async (job: GenerationJobRecord) => {
    let queueInfo: { queuePosition: number; estimatedWaitSec: number } | undefined;
    if (job.status === "queued" && options.jobStore.getJobQueuePosition) {
      try {
        queueInfo = await options.jobStore.getJobQueuePosition(job.id, job.queuedAt);
      } catch {
        // ignore
      }
    }
    return {
      id: job.id,
      mode: job.mode,
      status: job.status,
      prompt: job.prompt,
      aspectRatio: job.aspectRatio,
      progress: job.progress,
      directorPlan: publicDirectorPlan(job.directorPlan),
      errorCode: job.errorCode,
      errorMessage: job.errorMessage,
      queuedAt: job.queuedAt.toISOString(),
      startedAt: job.startedAt?.toISOString() ?? null,
      finishedAt: job.finishedAt?.toISOString() ?? null,
      createdAt: job.createdAt.toISOString(),
      ...(queueInfo ? { queuePosition: queueInfo.queuePosition, estimatedWaitSec: queueInfo.estimatedWaitSec } : {}),
    };
  };

  app.get("/api/v1/jobs/:id", async (request, reply) => {
    const user = await authenticatedUser(request, options.authStore);
    if (!user) return reply.code(401).send({ error: { code: "AUTH_REQUIRED" } });
    const { id } = request.params as { id: string };
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
      return reply.code(400).send({ error: { code: "INVALID_JOB_ID", message: "任务 ID 格式无效" } });
    }
    const job = await options.jobStore.findJobById(user.id, id);
    if (!job) {
      return reply.code(404).send({ error: { code: "JOB_NOT_FOUND", message: "任务不存在或无权访问" } });
    }
    const jobPayload = await serializeJobPayload(job);
    return reply.send({ job: jobPayload });
  });

  // SSE 单向长连接端点：毫秒级实时下发任务进度与状态，彻底替代密集 HTTP 轮询
  app.get("/api/v1/jobs/:id/events", async (request, reply) => {
    const user = await authenticatedUser(request, options.authStore);
    if (!user) return reply.code(401).send({ error: { code: "AUTH_REQUIRED" } });
    const { id } = request.params as { id: string };
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
      return reply.code(400).send({ error: { code: "INVALID_JOB_ID" } });
    }
    const initialJob = await options.jobStore.findJobById(user.id, id);
    if (!initialJob) {
      return reply.code(404).send({ error: { code: "JOB_NOT_FOUND" } });
    }

    reply.raw.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    reply.raw.setHeader("Cache-Control", "no-cache, no-transform");
    reply.raw.setHeader("Connection", "keep-alive");
    reply.raw.setHeader("X-Accel-Buffering", "no");
    reply.raw.flushHeaders?.();

    const initialPayload = await serializeJobPayload(initialJob);
    reply.raw.write(`data: ${JSON.stringify({ job: initialPayload })}\n\n`);

    if (["completed", "failed", "cancelled"].includes(initialJob.status)) {
      reply.raw.end();
      return;
    }

    let isClosed = false;
    let lastProgress = initialJob.progress;
    let lastStatus = initialJob.status;

    const cleanup = () => {
      if (isClosed) return;
      isClosed = true;
      clearInterval(intervalTimer);
      clearInterval(heartbeatTimer);
    };

    request.raw.on("close", cleanup);
    request.raw.on("end", cleanup);

    // 每 15 秒下发一次 ping 心跳，防止中间网络代理或移动端静默切断
    const heartbeatTimer = setInterval(() => {
      if (isClosed) return;
      try { reply.raw.write(": ping\n\n"); } catch { cleanup(); }
    }, 15_000);

    // 每 1000ms 检测一次任务最新状态，有进度跃迁即刻向客户端推送
    const intervalTimer = setInterval(async () => {
      if (isClosed) return;
      try {
        const latestJob = await options.jobStore.findJobById(user.id, id);
        if (!latestJob) {
          cleanup();
          reply.raw.end();
          return;
        }
        if (latestJob.progress !== lastProgress || latestJob.status !== lastStatus) {
          lastProgress = latestJob.progress;
          lastStatus = latestJob.status;
          const payload = await serializeJobPayload(latestJob);
          reply.raw.write(`data: ${JSON.stringify({ job: payload })}\n\n`);
        }
        if (["completed", "failed", "cancelled"].includes(latestJob.status)) {
          cleanup();
          reply.raw.end();
        }
      } catch {
        cleanup();
        reply.raw.end();
      }
    }, 1000);
  });
}
