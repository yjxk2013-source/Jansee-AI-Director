// 简兮 (JANSEE) · 统一视频创作工作流编排层 (Workflow Orchestrator - S7 生产可用架构升级)
// 职责：
//   1. 统一任务创建、参数标准化、素材安全验证；
//   2. 挂接 CreationStore 持久化层、Delivery 统一产物交付层与 ErrorCodes 统一错误体系；
//   3. 预留 beforeCreateHook / afterCreateHook 积分支付鉴权钩子；
//   4. 调度 storyboard / video_dub / slicer / speechcut / image_creator 五大创作链路。

import fs from 'node:fs';
import path from 'node:path';
import { ERROR_CODES, createAppError } from './errors.mjs';
import { creationStore } from './creationStore.mjs';
import { normalizeOutput, pickPublishFields } from './delivery.mjs';
import {
  generateStoryboardScript,
  generateDirectorCut,
  generateConstitutionScript,
  generatePublishOnly,
} from './director.mjs';
import {
  materialRegistry,
  getRegisteredMaterial,
  startStoryboardProduce,
  startSlicerPrepare,
  DEFAULT_VOICE,
  ALLOWED_VOICES,
} from './storyboard.mjs';
import { startSpeechAnalyze } from '@jansee/speech-cut';
import { produceImageFilm } from '@jansee/image-film';
import { produceVideoDub } from '@jansee/video-dub';
import { isTemperament } from '@jansee/tts-kit';
import { creditStore } from './creditStore.mjs';
import { verifySession } from './auth.mjs';
import { detectSensitive, recordBlockedContent } from './sensitive.mjs';
import { getAnchorBlacklist, recordAnchors } from './anchorStore.mjs';
import { recordCreative } from './creativeLedger.mjs';
import { rankAnchors, getDna, getAnchor, getLocalRole } from '@jansee/anchor-kit';

// 支持的创作类型全景
export const SUPPORTED_CREATION_TYPES = new Set([
  'storyboard',
  'video_dub',
  'slicer',
  'speechcut',
  'image_creator',
]);

// 创作类型积分消耗对照表与批量上限：唯一真相源已迁至 billing.mjs，
// 此处 import 后原样透出，保持既有 import { CREATION_TYPE_COSTS, BATCH_VERSION_LIMIT } 调用方零改动。
import { CREATION_TYPE_COSTS, BATCH_VERSION_LIMIT, chargeForCreation, settleFailure } from './billing.mjs';
export { CREATION_TYPE_COSTS, BATCH_VERSION_LIMIT };

// 兼容既有直接引用 Map 的历史测试与上下文
export const creationTasks = creationStore.tasks;

// ==================== 多版成片（批量赛马）====================
// 一次提交同素材产出 N 条全维度差异化成片，服务投流赛马与矩阵分发场景。
// 差异化四要素：①台词钩子角度（LLM 按版分发，见 BATCH_VERSION_ANGLES）
//              ②版式（T1-T5 批内无重复轮转）③结尾卡/配对（renderTaskId 派生 seed 自动不同）
//              ④音频指纹（台词不同 → TTS 人声波形天然不同，是最强过查重维度）
export const BATCH_VERSION_CONCURRENCY = 2;
export const BATCH_VERSION_ANGLES = [
  '价格钩子（用价格/性价比反差直接开场）',
  '悬念钩子（先留悬念再揭示答案）',
  '场景钩子（从使用场景与痛点画面切入）',
  '对比钩子（新旧/使用前后强烈对比）',
  '身份钩子（从目标人群的身份共鸣切入）',
  '冲突钩子（打破常识的反直觉切入）',
  '教程钩子（步骤式干货拆解切入）',
  '利益钩子（限时福利与赠品切入）',
  '见证钩子（以用户口吻真实见证推荐）',
  '数据钩子（用数字与事实冲击开场）',
];

/**
 * 规范化多版参数：非法/缺省一律回落 1（单版路径与现状完全一致）。
 * 仅生成型链路支持多版：图片成片 / 视频配音 / 分镜 AI 配音（scriptMode=auto）。
 * 口播与切片是剪原片，剪出来只有一种正确结果，无版本概念，不支持。
 */
function normalizeBatchVersions(rawVersions, rawType, scriptMode) {
  const n = Math.max(1, Math.min(BATCH_VERSION_LIMIT, Math.floor(Number(rawVersions) || 1)));
  if (n <= 1) return 1;
  const supported = rawType === 'image_creator'
    || rawType === 'video_dub'
    || (rawType === 'storyboard' && scriptMode === 'auto');
  if (!supported) {
    throw createAppError(
      ERROR_CODES.PARAM_INVALID,
      '该创作类型不支持多版成片（多版仅支持：图片成片 / 视频配音 / 分镜 AI 配音）'
    );
  }
  return n;
}

/**
 * 批次内每条的钩子角度（按版序轮转角度池，同批不重复直到超出角度数）
 */
function batchAngleFor(index1Based) {
  return BATCH_VERSION_ANGLES[(index1Based - 1) % BATCH_VERSION_ANGLES.length];
}

/**
 * 批次内版式无重复分配：以 taskId 派生 seed 决定起始偏移，T1-T5 顺序轮转。
 * N ≤ 5 时每条版式必不相同；N > 5 时轮转回绕（配对/结尾卡仍由各自 seed 区分）。
 */
const BATCH_LAYOUT_CYCLE = ['layout_t1', 'layout_t2', 'layout_t3', 'layout_t4', 'layout_t5'];
function batchLayoutFor(taskId, index1Based) {
  let h = 0;
  const s = String(taskId || '');
  for (let i = 0; i < s.length; i++) {
    h = (h ^ s.charCodeAt(i)) >>> 0;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  const start = h % BATCH_LAYOUT_CYCLE.length;
  return BATCH_LAYOUT_CYCLE[(start + index1Based - 1) % BATCH_LAYOUT_CYCLE.length];
}

/**
 * 批次聚合进度：由各版本状态汇总出任务级 progress / stageText。
 * 部分失败不拖垮整批：≥1 条成功即整批 completed，交付成功版本列表。
 */
function syncBatchAggregate(creationTask) {
  const vs = creationTask.versions;
  if (!Array.isArray(vs) || !vs.length) return;
  const done = vs.filter((v) => v.status === 'completed').length;
  const failed = vs.filter((v) => v.status === 'failed').length;
  const settled = done + failed;
  const avg = vs.reduce((s, v) => s + (Number(v.progress) || 0), 0) / vs.length;
  creationTask.progress = settled === vs.length ? 100 : Math.min(99, 5 + Math.floor(avg * 0.94));
  creationTask.stageText = `批量成片：已完成 ${done}/${vs.length} 条${failed ? `，失败 ${failed} 条` : ''}`;
  creationTask.stage = settled === vs.length ? 'done' : 'batch';
  creationStore.updateTask(creationTask.taskId, creationTask);
}

/**
 * 有界并发池：worker 逐个领取版本索引执行，最多 lane 条并行。
 * cursor 的「检查+自增」之间无 await，单线程事件循环下无竞态。
 */
async function runVersionPool(total, worker) {
  let cursor = 0;
  const lanes = Math.min(BATCH_VERSION_CONCURRENCY, total);
  await Promise.all(Array.from({ length: lanes }, async () => {
    while (cursor < total) {
      const i = cursor++;
      await worker(i);
    }
  }));
}

/**
 * 创作任务创建前检查 Hook (鉴权与积分核销)
 * @param {object} params { payload, user, taskId, deps }
 * @returns {object} { ok, userId, cost, remainingCredits }
 */
export function beforeCreateHook({ payload = {}, user = {}, taskId, deps = {} } = {}) {
  // 身份只有两个可信来源：
  //   1) 调用方显式传入的 user（服务端内部派发/单测，非 HTTP 客户端可控）；
  //   2) payload.sessionToken —— 由网关用 Authorization 头注入并已验证。
  // 2026-10-28 删除 payload.user.uid / payload.userId 兜底：那是「客户端自带身份」，
  // 换个 userId 就能扣别人的余额、把任务记到别人名下。
  let effectiveUserId = user?.userId || '';
  if (!effectiveUserId && payload.sessionToken) {
    const verifyFn = deps.verifySession || verifySession;
    const sess = verifyFn(payload.sessionToken);
    if (sess) {
      effectiveUserId = sess.userId;
    } else {
      throw createAppError(40101, '登录会话已过期或无效，请重新登录', { status: 401 });
    }
  }

  // 计费与鉴权统一委托 billing.mjs：定价、互斥锁、余额预检、幂等扣费集中一处，
  // 本函数只负责「解析可信身份」，扣费实现不再在此重复。
  // 安全红线（2026-10-28 保留）：账户余额只能由服务端账本产生，
  // 客户端提交的 payload.user 积分数一律不可信，切勿在此初始化余额。
  return chargeForCreation({
    userId: effectiveUserId,
    type: payload.type,
    versions: payload.versions,
    taskId,
    store: deps.creditStore || creditStore,
  });
}

/**
 * 创作任务创建后 Hook (流水记账/业务埋点)
 * @param {object} params { task, user }
 * @returns {object}
 */
export function afterCreateHook({ task, user = {} } = {}) {
  return { ok: true, chargedCredits: CREATION_TYPE_COSTS[task?.type] || 200 };
}

/**
 * 轮询同步底层分镜任务状态至 creationTask
 * opts.sink：多版批次模式下传入版本槽对象（与 creationTask 同形），进度/终态写入 sink
 * 而非任务级字段，也不直写 store——聚合由 syncBatchAggregate 统一收口。
 */
// 分镜合成 timeoutMs 提升至 10 分钟（600000ms）：分镜 AI 配音涵盖 LLM 写词 + TTS + 多镜头 1080x1920 归一化转码 + 叠化拼接 + 结尾收束卡，
// 2~9 段素材正常耗时 60~120s，原 60s 硬超时会导致正常成片被误判中断（2026-10-26 实测复现）。
async function syncStoryboardSubTask(sbTaskId, creationTask, inMemoryTasks, deps = {}, { timeoutMs = 600000, intervalMs = 50, sink = null } = {}) {
  // 批次模式判定：sink 必须是独立版本槽（不等于任务本身）——单版路径 sink===creationTask 时走任务直写
  const isSinkMode = Boolean(sink) && sink !== creationTask;
  const t = isSinkMode ? sink : creationTask;
  const persist = () => { if (!isSinkMode) creationStore.updateTask(creationTask.taskId, creationTask); };
  const syncOverride = deps.syncSubTaskProgress;
  if (syncOverride) {
    await syncOverride(sbTaskId, t, inMemoryTasks);
    return;
  }

  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    const sbTask = inMemoryTasks.get(sbTaskId);
    if (!sbTask) {
      await new Promise((r) => setTimeout(r, intervalMs));
      continue;
    }

    if (sbTask.status === 'completed') {
      t.status = 'completed';
      t.stage = 'done';
      t.stageText = '成片合成完成';
      t.progress = 100;
      t.outputs = normalizeOutput({
        videoUrl: sbTask.videoUrl || '',
        coverUrl: sbTask.coverUrl || `/storage/outputs/${sbTaskId}/cover.jpg`,
        duration: sbTask.durationSec || sbTask.duration || 0,
      }, creationTask.taskId);
      persist();
      return;
    }

    if (sbTask.status === 'failed') {
      t.status = 'failed';
      t.stage = 'failed';
      t.error = createAppError(sbTask.code || ERROR_CODES.SYNTHESIS_FAILED, sbTask.error || '分镜合成执行失败');
      persist();
      return;
    }

    if (typeof sbTask.progress === 'number') {
      const mappedProgress = Math.min(99, Math.max(t.progress, 30 + Math.floor(sbTask.progress * 0.69)));
      t.progress = mappedProgress;
    }
    if (sbTask.stageText) {
      t.stageText = sbTask.stageText;
    }
    persist();

    await new Promise((r) => setTimeout(r, intervalMs));
  }

  t.status = 'failed';
  t.stage = 'failed';
  t.error = createAppError(ERROR_CODES.WORKFLOW_TIMEOUT, '分镜合成流水线执行超时');
  persist();
}

/**
 * 轮询同步底层切片任务状态至 creationTask
 * timeoutMs 缺省 10 分钟：切片 prepare 含逐段本地 whisper 识别（ASR 重活，长视频可达分钟级），
 * 60s 会把正常识别中的任务误判超时（2026-10-24 E2E 实测复现）。
 */
async function syncSlicerSubTask(slcTaskId, creationTask, inMemoryTasks, deps = {}, { timeoutMs = 600000, intervalMs = 50 } = {}) {
  const syncOverride = deps.syncSubTaskProgress;
  if (syncOverride) {
    await syncOverride(slcTaskId, creationTask, inMemoryTasks);
    return;
  }

  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    const slcTask = inMemoryTasks.get(slcTaskId);
    if (!slcTask) {
      await new Promise((r) => setTimeout(r, intervalMs));
      continue;
    }

    if (slcTask.status === 'prepared' || slcTask.status === 'completed') {
      creationTask.status = 'completed';
      creationTask.stage = 'done';
      creationTask.stageText = '视频切片完成';
      creationTask.progress = 100;

      const rawSegments = Array.isArray(slcTask.segments) ? slcTask.segments : (slcTask.slices || []);
      creationTask.outputs = normalizeOutput({
        slices: rawSegments.map((s) => ({
          videoUrl: s.videoUrl || `/storage/outputs/${slcTaskId}/slices/${s.name}`,
          durationSec: Number(s.durationSec) || 0,
          text: s.text || s.final_text || '',
          materialId: s.materialId || '',
        })),
      }, creationTask.taskId);

      creationStore.updateTask(creationTask.taskId, creationTask);
      return;
    }

    if (slcTask.status === 'failed') {
      creationTask.status = 'failed';
      creationTask.stage = 'failed';
      creationTask.error = createAppError(slcTask.code || ERROR_CODES.SYNTHESIS_FAILED, slcTask.error || '视频切片失败');
      creationStore.updateTask(creationTask.taskId, creationTask);
      return;
    }

    if (typeof slcTask.progress === 'number') {
      creationTask.progress = Math.min(99, Math.max(creationTask.progress, slcTask.progress));
    }
    if (slcTask.stageText) {
      creationTask.stageText = slcTask.stageText;
    }
    creationStore.updateTask(creationTask.taskId, creationTask);

    await new Promise((r) => setTimeout(r, intervalMs));
  }

  creationTask.status = 'failed';
  creationTask.stage = 'failed';
  creationTask.error = createAppError(ERROR_CODES.WORKFLOW_TIMEOUT, '视频切片执行超时');
  creationStore.updateTask(creationTask.taskId, creationTask);
}

/**
 * 轮询同步底层口播任务状态至 creationTask
 * timeoutMs 缺省 10 分钟：口播 analyze 含本地 whisper 词级识别（与切片同口径，ASR 重活）。
 */
async function syncSpeechcutSubTask(spkTaskId, creationTask, inMemoryTasks, deps = {}, { timeoutMs = 600000, intervalMs = 50 } = {}) {
  const syncOverride = deps.syncSubTaskProgress;
  if (syncOverride) {
    await syncOverride(spkTaskId, creationTask, inMemoryTasks);
    return;
  }

  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    const spkTask = inMemoryTasks.get(spkTaskId);
    if (!spkTask) {
      await new Promise((r) => setTimeout(r, intervalMs));
      continue;
    }

    if (spkTask.status === 'analyzed' || spkTask.status === 'completed') {
      creationTask.status = 'completed';
      creationTask.stage = 'done';
      creationTask.stageText = '口播分析完成';
      creationTask.progress = 100;
      creationTask.outputs = normalizeOutput({
        words: Array.isArray(spkTask.words) ? spkTask.words : [],
        suggestions: Array.isArray(spkTask.suggestions) ? spkTask.suggestions : [],
        durationSec: Number(spkTask.durationSec) || 0,
      }, creationTask.taskId);

      creationStore.updateTask(creationTask.taskId, creationTask);
      return;
    }

    if (spkTask.status === 'failed') {
      creationTask.status = 'failed';
      creationTask.stage = 'failed';
      creationTask.error = createAppError(spkTask.code || ERROR_CODES.SYNTHESIS_FAILED, spkTask.error || '口播分析失败');
      creationStore.updateTask(creationTask.taskId, creationTask);
      return;
    }

    if (typeof spkTask.progress === 'number') {
      creationTask.progress = Math.min(99, Math.max(creationTask.progress, spkTask.progress));
    }
    if (spkTask.stageText) {
      creationTask.stageText = spkTask.stageText;
    }
    creationStore.updateTask(creationTask.taskId, creationTask);

    await new Promise((r) => setTimeout(r, intervalMs));
  }

  creationTask.status = 'failed';
  creationTask.stage = 'failed';
  creationTask.error = createAppError(ERROR_CODES.WORKFLOW_TIMEOUT, '口播分析执行超时');
  creationStore.updateTask(creationTask.taskId, creationTask);
}

/**
 * 创建统一创作任务 (Creation Workflow Orchestrator)
 *
 * @param {object} opts
 * @param {object} opts.payload 客户端请求体
 * @param {Map} opts.inMemoryTasks 网关共享内存任务表
 * @param {string} opts.storageOutputsDir 产物存储目录
 * @param {string} opts.storageUploadsDir 上传存储目录
 * @param {string} opts.materialsDir 素材目录
 * @param {Function} [opts.chargeMockCredits] 积分扣减闭包
 * @param {object} [opts.deps] 可注入外部依赖 (便于自动化测试 stub)
 * @returns {object} { taskId, type, status, stage, progress }
 */
export function createCreationTask({
  payload = {},
  inMemoryTasks,
  storageOutputsDir,
  storageUploadsDir,
  materialsDir,
  chargeMockCredits,
  deps = {},
}) {
  if (!payload || typeof payload !== 'object') {
    throw createAppError(ERROR_CODES.PARAM_INVALID, '请求体无效，必须为 JSON 对象');
  }

  // 1. 安全防御：物理路径硬性拦截（任何字段包含物理路径一律 40301 拦截）
  if (
    payload.videoPath ||
    payload.filePath ||
    payload.imagePath ||
    payload.uploadDir ||
    payload.targetPath ||
    (Array.isArray(payload.shots) && payload.shots.some((s) => s?.videoPath || s?.filePath || s?.imagePath))
  ) {
    throw createAppError(ERROR_CODES.SECURITY_PATH_FORBIDDEN, '非法参数：禁止提交物理路径，必须使用已登记的素材 ID (materialId)');
  }

  // 2. 创作类型校验
  const rawType = String(payload.type || '').trim();
  if (!rawType) {
    throw createAppError(ERROR_CODES.MISSING_TYPE, '缺少创作类型参数 (type)');
  }
  if (!SUPPORTED_CREATION_TYPES.has(rawType)) {
    throw createAppError(ERROR_CODES.TYPE_UNSUPPORTED, `暂不支持的创作类型: ${rawType}`);
  }

  // 3. 防重复提交检查
  const providedTaskId = typeof payload.taskId === 'string' ? payload.taskId.trim() : '';
  if (providedTaskId) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(providedTaskId)) {
      throw createAppError(ERROR_CODES.PARAM_INVALID, 'taskId 格式非法，仅允许 1-64 位字母、数字、下划线与中划线');
    }
    const existing = creationStore.getTask(providedTaskId);
    if (existing && (existing.status === 'pending' || existing.status === 'processing' || existing.status === 'completed')) {
      throw createAppError(ERROR_CODES.TASK_DUPLICATED, '该创作任务已在处理中或已完成，请勿重复提交');
    }
  }

  // 4. 素材 ID 列表安全校验（严禁接受任何绝对路径与非法字符）
  const rawMatIds = Array.isArray(payload.materialIds) ? payload.materialIds : [];
  if (!rawMatIds.length) {
    throw createAppError(ERROR_CODES.MISSING_MATERIAL, '请至少提供一个已登记的素材 ID (materialIds)');
  }
  if (rawMatIds.length > 9) {
    throw createAppError(ERROR_CODES.MATERIAL_LIMIT_EXCEEDED, '素材数量不能超过 9 个');
  }

  const currentSessionId = String(payload.sessionId || payload.user?.uid || payload.user?.userId || payload.userId || '').trim();
  const verifiedMaterials = [];
  for (let i = 0; i < rawMatIds.length; i++) {
    const rawId = String(rawMatIds[i] || '').trim();
    if (!rawId || rawId.includes('/') || rawId.includes('\\')) {
      throw createAppError(ERROR_CODES.MATERIAL_ID_INVALID, `第 ${i + 1} 个素材 ID 格式非法`);
    }
    const mat = getRegisteredMaterial(rawId, currentSessionId);
    if (!mat) {
      throw createAppError(ERROR_CODES.MATERIAL_NOT_FOUND, `第 ${i + 1} 个素材不存在、已过期或无权访问（ID: ${rawId}）`);
    }
    const internalMat = materialRegistry.get(rawId);
    verifiedMaterials.push({
      ...mat,
      filePath: internalMat ? internalMat.filePath : '',
    });
  }

  // 5. 参数标准化提取与字符长度硬门禁（杜绝大模型 Token 溢出与算力炸弹）
  const title = String(payload.title || '').trim();
  const sellingPoints = String(payload.sellingPoints || payload.description || '').trim();
  const rawText = String(payload.text || payload.script || '').trim();

  if (title.length > 30) {
    throw createAppError(ERROR_CODES.PARAM_INVALID, `标题长度不能超过 30 字（当前 ${title.length} 字）`);
  }
  if (sellingPoints.length > 300) {
    throw createAppError(ERROR_CODES.PARAM_INVALID, `卖点与特色描述不能超过 300 字（当前 ${sellingPoints.length} 字）`);
  }
  if (rawText.length > 500) {
    throw createAppError(ERROR_CODES.PARAM_INVALID, `自定义台词内容不能超过 500 字（当前 ${rawText.length} 字）`);
  }

  // 5.01 视频配音必填门禁（杜绝文案全空导致大模型脱轨跑偏）
  if (rawType === 'video_dub') {
    const combinedDub = `${sellingPoints} ${rawText}`.trim();
    if (!combinedDub) {
      throw createAppError(ERROR_CODES.TEXT_REQUIRED, '请提供配音解说方案或商品核心卖点，AI 才能精准生成解说台词');
    }
  }

  // 5.02 单用户在途任务并发硬门禁：每个用户最多 1 个正在生成的任务（防算力独占与恶意刷单）
  const actorId = String(payload.user?.uid || payload.user?.userId || payload.userId || payload.sessionId || '').trim();
  if (actorId) {
    for (const [, task] of creationStore.tasks.entries()) {
      const matchUser = task.userId === actorId || task.input?.sessionId === actorId;
      if (matchUser && (task.status === 'pending' || task.status === 'processing')) {
        throw createAppError(
          ERROR_CODES.TASK_DUPLICATED,
          '您已有正在制作中的视频任务，请稍候完成后再提交新任务',
          { status: 409 }
        );
      }
    }
  }

  /* scriptMode 仅 storyboard（分镜成片）分支消费：auto=AI 导演逐镜生成 / provided=用户自备分镜台词。
     video_dub（视频配音）不消费——只保留 AI 配音一条路，用户 text 仅作导演素材。 */
  const scriptMode = payload.scriptMode === 'provided' ? 'provided' : 'auto';

  // 5.05 多版成片（批量赛马）：非法/缺省回落 1；不支持类型直接 400 拒绝
  const batchTotal = normalizeBatchVersions(payload.versions, rawType, scriptMode);

  // 5.1 本地 0 成本合规关键词拦截（涉黄/暴恐/违禁品/广告法绝对禁用词）
  const combinedAuditText = `${title} ${sellingPoints} ${rawText}`.trim();
  if (combinedAuditText) {
    const hits = detectSensitive(combinedAuditText);
    if (hits.length > 0) {
      recordBlockedContent({
        text: combinedAuditText,
        hits,
        userId: payload.user?.userId || '',
        scene: payload.scene || rawType,
      });
      throw createAppError(
        ERROR_CODES.CONTENT_SENSITIVE,
        `内容合规拦截：检测到违规或广告法禁用词 [${hits.join('、')}]，请调整文案后重新生成`,
        { status: 403, details: { hits } }
      );
    }
  }

  /* 音色执行口径（2026-10-24 修正）：用户显式选了音色 → 跟随用户（硬约束）；
     用户没选 → LLM 导演选的 cut.voice_id 优先（它看着商品定的），非法时才落默认。
     修复点：此前 cut.voice_id 从未被消费，LLM 的音色选择被静默丢弃（压测审查发现）。 */
  const userVoiceExplicit = String(payload.voiceConfig?.voiceId || payload.voiceId || '').trim();
  let voiceId = userVoiceExplicit;
  if (!voiceId || !ALLOWED_VOICES.has(voiceId)) {
    voiceId = DEFAULT_VOICE;
  }
  const resolveTtsVoice = (cut) =>
    userVoiceExplicit && ALLOWED_VOICES.has(userVoiceExplicit)
      ? voiceId
      : isTemperament(String(cut?.voice_id || ''))
        ? String(cut.voice_id)
        : voiceId;

  const taskId = providedTaskId || `crt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

  // 6. 创作前积分/鉴权 Hook 调用 (同步执行，若余额不足直接 40201 阻断)
  // payload.user 只允许由网关按服务端会话写入（index.mjs 会覆盖客户端提交的同名字段），
  // 任何直接把 HTTP body 透传给本函数的新调用方都必须先做同样的剥离。
  const beforeHookFn = deps.beforeCreateHook || beforeCreateHook;
  const hookResult = beforeHookFn({ payload, user: payload.user || {}, taskId, deps });
  const effectiveUserId = hookResult?.userId || payload.user?.userId || null;

  // 7. 初始化统一 creationTask 数据结构
  const chargedCost = Number(hookResult?.cost || 0);
  const creationTask = {
    taskId,
    userId: effectiveUserId,
    type: rawType,
    status: 'pending',
    stage: 'init',
    stageText: '创作任务已创建，等待编排调度...',
    progress: 5,
    creditsCharged: chargedCost,
    creditsRefunded: false,
    expireAt: Date.now() + 24 * 3600 * 1000, // 24 小时生命周期
    input: {
      type: rawType,
      scene: String(payload.scene || 'sell'),
      title,
      sellingPoints,
      materialIds: verifiedMaterials.map((m) => m.materialId),
      voiceConfig: { voiceId },
      options: payload.options || {},
      sessionId: String(payload.sessionId || '').trim(),
    },
    outputs: normalizeOutput({}, taskId),
    subTaskId: null,
    // 多版成片（批量赛马）：单版路径不携带批次字段，保证现状契约零变化
    ...(batchTotal > 1
      ? {
          batch: { total: batchTotal },
          versions: Array.from({ length: batchTotal }, (_, i) => ({
            index: i + 1,
            angle: batchAngleFor(i + 1),
            layoutId: batchLayoutFor(taskId, i + 1),
            status: 'pending',
            progress: 0,
            stageText: '排队等待合成...',
            videoUrl: '',
            duration: 0,
            publish: null,
            error: null,
          })),
        }
      : {}),
    error: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  // 持久化存储注册
  creationStore.createTask(creationTask);
  if (inMemoryTasks) {
    inMemoryTasks.set(taskId, creationTask);
  }

  // 创作后 Hook 调用 (预留记账/流水)
  const afterHookFn = deps.afterCreateHook || afterCreateHook;
  afterHookFn({ task: creationTask, user: payload.user || {} });

  const initialResponse = {
    taskId: creationTask.taskId,
    type: creationTask.type,
    status: creationTask.status,
    stage: creationTask.stage,
    progress: creationTask.progress,
  };

  // 8. 启动异步编排工作流
  (async () => {
    await Promise.resolve();
    try {
      creationTask.status = 'processing';
      creationStore.updateTask(taskId, creationTask);

      // ==================== 批次/单版统一基建 ====================
      // 进度落盘口：单版（sink===creationTask）直写任务存储；批次先把版本槽实时进度
      // 回写进 versions[i]（否则聚合在批次进行中恒见 0，进度条全程卡底），再统一聚合
      const persistSink = (sink) => {
        if (sink === creationTask) {
          creationStore.updateTask(taskId, creationTask);
        } else {
          const idx = sink.__versionIndex;
          if (Number.isInteger(idx) && creationTask.versions[idx]) {
            creationTask.versions[idx].progress = sink.progress;
            creationTask.versions[idx].stageText = sink.stageText || '';
          }
          syncBatchAggregate(creationTask);
        }
      };

      /* ==================== 主播风格排班（2026-10-24 定版） ====================
         两级黑名单：商家级（anchorStore 最近 6 次）+ 批次内（本任务累计，防同批撞风格）；
         seed 抽签由 @jansee/anchor-kit 承担（同 taskId 可复现）。personal 无人设体系不注入。
         预留式排班：上下文构建（首个 await 之前，同步）就把推荐主播占进黑名单——
         并发版本互相可见，杜绝「两条 LLM 都在途时互相看不见」的撞车竞窗；
         cut 返回后再把 LLM 实际选用的 anchor 记入商家级账本。 */
      const anchorState = { used: getAnchorBlacklist(effectiveUserId || '') };
      const buildAnchorContext = (renderTaskId, scene) => {
        if (scene === 'personal') return null;
        const ranked = (deps.rankAnchors || rankAnchors)({
          variantType: '',
          blacklist: anchorState.used,
          taskId: renderTaskId,
        });
        if (!ranked.length) return null;
        const reservedId = ranked[0].id;
        if (!anchorState.used.includes(reservedId)) anchorState.used.push(reservedId);
        /* scene 随上下文透传：导演层变体名归一要按场景池补全（sell/local 的 D 前缀不同型） */
        return { ranked, lockedAnchor: null, reservedId, scene };
      };
      const trackAnchor = (cut) => {
        const id = String(cut?.anchor_id || '').trim();
        if (!id) return;
        if (!anchorState.used.includes(id)) anchorState.used.push(id);
        recordAnchors(effectiveUserId || '', [id]);
      };
      /* 主播风格/实体角色标签（给交付卡展示）：DNA id → 中文 label */
      const anchorDnaLabel = (cut) => {
        if (payload.scene === 'local') {
          const role = getLocalRole(cut?.anchor_id) || getLocalRole(cut?.anchor_dna);
          if (role) return role.label;
          if (cut?.anchor_dna) return String(cut.anchor_dna);
        }
        const id = String(cut?.anchor_dna || '').trim();
        if (!id) return '';
        const d = (deps.getDna || getDna)(id);
        return d?.label || id;
      };

      /**
       * 单版/批次统一分发：batchTotal===1 时完全沿用现状路径（sink 即任务本身，
       * renderTaskId 即 taskId，angle 为空 → prompt/seed/目录与既有契约零变化）；
       * batchTotal>1 时按并发池跑 N 个版本槽，部分失败不拖垮整批。
       * @param {Function} runOneVersion async ({ sink, renderTaskId, angle, layoutId, vIdx, vTotal })
       */
      const runBatchOrSingle = async (runOneVersion) => {
        if (batchTotal === 1) {
          await runOneVersion({ sink: creationTask, renderTaskId: taskId, angle: '', layoutId: '', vIdx: 1, vTotal: 1 });
          return;
        }
        await runVersionPool(batchTotal, async (i) => {
          const v = creationTask.versions[i];
          const sink = { status: 'processing', stage: 'init', stageText: '', progress: 5, outputs: null, error: null, __versionIndex: i };
          v.status = 'processing';
          try {
            await runOneVersion({
              sink,
              renderTaskId: `${taskId}_v${i + 1}`,
              angle: v.angle,
              layoutId: v.layoutId,
              vIdx: i + 1,
              vTotal: batchTotal,
            });
            v.status = 'completed';
            v.progress = 100;
            v.videoUrl = sink.outputs?.videoUrl || '';
            v.coverUrl = sink.outputs?.coverUrl || (sink.subTaskId ? `/storage/outputs/${sink.subTaskId}/cover.jpg` : '');
            v.duration = Number(sink.outputs?.duration) || 0;
            v.publish = sink.outputs?.publish || null;
            v.anchorDna = sink.__anchorDna || '';
            v.title = sink.title || '';
            v.stageText = sink.stageText || '完成';
          } catch (err) {
            v.status = 'failed';
            v.error = err?.message || String(err);
            v.stageText = '本条生成失败';
            console.error(`[creation] 批量成片第 ${i + 1} 条失败:`, err?.message || err);
          }
          syncBatchAggregate(creationTask);
        });
        // 批次终态：≥1 条成功即整批 completed，交付成功版本列表（先好先看语义）
        const okVersions = creationTask.versions.filter((v) => v.status === 'completed');
        if (okVersions.length > 0) {
          creationTask.status = 'completed';
          creationTask.stage = 'done';
          creationTask.progress = 100;
          creationTask.stageText = `批量成片完成：成功 ${okVersions.length}/${batchTotal} 条`;
          creationTask.outputs = normalizeOutput({
            versions: okVersions.map((v) => ({
              videoUrl: v.videoUrl,
              coverUrl: v.coverUrl,
              duration: v.duration,
              publish: v.publish,
              anchorDna: v.anchorDna,
            })),
          }, taskId);
        } else {
          creationTask.status = 'failed';
          creationTask.stage = 'failed';
          creationTask.progress = 100;
          const firstErr = creationTask.versions.find((v) => v.status === 'failed');
          creationTask.error = createAppError(ERROR_CODES.SYNTHESIS_FAILED, firstErr?.error || '批量成片全部失败');
        }
        creationStore.updateTask(taskId, creationTask);
      };

      // ==========================================
      // 分支一：storyboard 分镜成片
      // ==========================================
      if (rawType === 'storyboard') {
        const runOneVersion = async ({ sink, renderTaskId, angle, vIdx, vTotal }) => {
          let shotsForProduce = [];
          // AI 配音（auto）的剧本结果（含主播层 anchor_id/speech_speed）；provided 模式恒 null
          let scriptResult = null;

          if (scriptMode === 'auto') {
            sink.stage = 'scripting';
            sink.stageText = 'AI 导演正在为每个分镜生成解说文案...';
            sink.progress = 15;
            persistSink(sink);

            const shotsMeta = verifiedMaterials.map((m, idx) => ({
              shotIndex: idx + 1,
              materialId: m.materialId,
              durationSec: m.durationSec,
              mediaType: m.type === 'upload_video' || m.type === 'slice_segment' ? 'video' : 'image',
            }));

            const scriptGenFn = deps.generateStoryboardScript || generateStoryboardScript;
            /* 主播风格层（2026-10-25 定案：所有 AI 配音链路统一走主播层）：
               排班上下文随调用注入（personal 无人设自动 null，提示词零回归）；
               分镜解说无变体判定，走排班锁定模式（reservedId，LLM 无改选权）。
               cut 返回后 trackAnchor 记账 + anchorDnaLabel 交付，与导演链路同口径。 */
            const sbScene = String(payload.scene || 'sell');
            const anchorContext = buildAnchorContext(renderTaskId, sbScene);
            try {
              scriptResult = await scriptGenFn({
                title: title || '精选视频',
                sellingPoints,
                shotsMeta,
                // 批量赛马差异化：批次内每条强制不同钩子角度；单版路径 angle 为空串不注入
                variantAngle: angle,
                variantIndex: vIdx,
                variantTotal: vTotal,
                anchorContext,
              });
            } catch (e) {
              // LLM 不可用（mock 模式 / 无 Key / 网关异常）→ 程序兜底剧本（宪法层），不出空任务
              //（与图片成片分支同口径：兜底是交付底线，不是报错出口）
              console.warn(`[creation] 分镜文案 LLM 生成失败，落程序兜底剧本: ${e?.message || e}`);
              const fb = (deps.generateConstitutionScript || generateConstitutionScript)(
                sbScene,
                String(payload.mode || ''),
                title || '精选视频',
                sellingPoints,
                verifiedMaterials.length,
                voiceId,
                null,
              );
              scriptResult = {
                shots: (Array.isArray(fb?.shots) ? fb.shots : []).map((s, i) => ({ shotIndex: i + 1, text: String(s?.line || '') })),
              };
              /* 兜底剧本字数物理裁剪：generateConstitutionScript 不感知每镜时长，
                 短镜长文案会被合成层 atempo 暴力加速（实测 25 字塞 3.13s 镜 = 8 字/秒）。
                 按 3.5 字/秒硬上限逐镜裁剪（对 LLM 校验红线 4.0 留 TTS 实测余量），超长时优先在片段内标点断句。 */
              scriptResult.shots = scriptResult.shots.map((shot, i) => {
                const dur = Number(verifiedMaterials[i]?.durationSec) || 0;
                if (dur <= 0 || !shot.text) return shot;
                const maxChars = Math.max(4, Math.ceil(dur * 3.5));
                if (shot.text.length <= maxChars) return shot;
                const head = shot.text.slice(0, maxChars);
                const punctIdx = Math.max(head.lastIndexOf('，'), head.lastIndexOf('、'), head.lastIndexOf('；'));
                const clipped = punctIdx >= Math.ceil(maxChars * 0.5) ? head.slice(0, punctIdx) : head;
                console.warn(`[creation] 兜底文案超长裁剪：第 ${i + 1} 镜 ${shot.text.length}字 -> ${clipped.length}字（镜时长 ${dur}s）`);
                return { ...shot, text: clipped };
              });
            }

            /* 主播层程序补齐：兜底剧本无主播概念，按排班 reserved 直接落（与 LLM 路径同口径）。 */
            if (anchorContext?.reservedId && !scriptResult.anchor_id) {
              const h = getAnchor(anchorContext.reservedId);
              scriptResult.anchor_id = anchorContext.reservedId;
              scriptResult.anchor_dna = h?.dna || '';
              scriptResult.speech_speed = 1;
            }
            trackAnchor(scriptResult);
            sink.__anchorDna = anchorDnaLabel(scriptResult);

            const generatedShots = Array.isArray(scriptResult?.shots) ? scriptResult.shots : [];
            shotsForProduce = verifiedMaterials.map((m, idx) => {
              const matched = generatedShots.find((s) => s.shotIndex === idx + 1) || generatedShots[idx];
              return {
                materialId: m.materialId,
                text: String(matched?.text || '').trim(),
                mediaType: m.type === 'image' ? 'image' : 'video',
              };
            });
          } else {
            const rawUserShots = Array.isArray(payload.shots) ? payload.shots : [];
            shotsForProduce = verifiedMaterials.map((m, idx) => {
              const userShot = rawUserShots[idx] || {};
              return {
                materialId: m.materialId,
                text: String(userShot.text || '').trim(),
                mediaType: m.type === 'image' ? 'image' : 'video',
              };
            });
          }

          const finalTitle = (scriptResult?.title && String(scriptResult.title).trim()) ? String(scriptResult.title).trim() : (title || '实拍精选成片');
          sink.title = finalTitle;
          sink.stage = 'rendering';
          sink.stageText = '正在进行分镜音画合成与字幕渲染...';
          sink.progress = 30;
          persistSink(sink);

          const produceFn = deps.startStoryboardProduce || startStoryboardProduce;
          const producePayload = {
            shots: shotsForProduce,
            voiceId,
            title: finalTitle,
            scene: String(payload.scene || 'sell'),
            // 主播层语速档位（anchor DNA 节奏）：非法/缺省 1.0，合成端再 clamp 一道
            speed: Number(scriptResult?.speech_speed) > 0 ? Number(scriptResult.speech_speed) : 1,
            bgmPath: payload.bgmPath || '',
          };

          // 发布方案（增值交付物）：与分镜合成并行生成（LLM 按各镜解说词/主题写四件套，
          // generatePublishOnly 内部自带兜底与超时，永不抛错、不拖慢出片）。
          const publishPromise = Promise.resolve()
            .then(() => (deps.generatePublishOnly || generatePublishOnly)({
              transcript: shotsForProduce.map((s) => s.text).filter(Boolean).join('。'),
              title: finalTitle,
              sellingPoints,
              scene: String(payload.scene || 'sell'),
            }))
            .catch((e) => {
              console.warn(`[creation] 分镜发布方案生成失败（不影响出片）: ${e?.message || e}`);
              return null;
            });

          const sbResult = await produceFn({
            payload: producePayload,
            inMemoryTasks,
            storageOutputsDir,
            storageUploadsDir,
            materialsDir,
            chargeMockCredits,
          });

          if (!sbResult || !sbResult.taskId) {
            throw createAppError(ERROR_CODES.SYNTHESIS_FAILED, '分镜底层合成任务受理失败，未返回有效任务 ID');
          }

          sink.subTaskId = sbResult.taskId;
          await syncStoryboardSubTask(sbResult.taskId, creationTask, inMemoryTasks, deps, { sink });
          // 成片完成且未被 sync 覆盖失败态时，补写发布方案进交付物
          //（generatePublishOnly 返回值已剥 _banned_hits，四字段纯净）
          if (sink.status === 'completed' && sink.outputs) {
            const pub = await publishPromise;
            if (pub && typeof pub === 'object') {
              const coverRel = sink.outputs.coverUrl || (sink.subTaskId ? `/storage/outputs/${sink.subTaskId}/cover.jpg` : '');
              sink.outputs.publish = pickPublishFields({
                ...pub,
                cover_url: coverRel,
              }, renderTaskId);
              persistSink(sink);
            }
          }
        };

        await runBatchOrSingle(runOneVersion);
        return;
      }

      // ==========================================
      // 分支二：video_dub 视频配音
      // 链路：导演旁白（LLM 视频分支优先 / 用户文案直构 / 程序兜底）→ TTS 逐段实测
      //       → BGM 人声闪避 → 合成内核音画对齐出片（@jansee/video-dub）
      // ==========================================
      if (rawType === 'video_dub') {
        const mat = verifiedMaterials[0];
        const safeVideoFile = mat.filePath;
        const dubScene = String(payload.scene || 'sell');
        const dubVoice = String(payload.voice || payload.voiceConfig?.voiceId || '').trim();

        const runOneVersion = async ({ sink, renderTaskId, angle, vIdx, vTotal }) => {
          const dubTaskDir = path.join(storageOutputsDir, renderTaskId);
          try { fs.mkdirSync(dubTaskDir, { recursive: true }); } catch (e) {}

          sink.stage = 'scripting';
          sink.stageText = 'AI 导演正在规划全片旁白...';
          sink.progress = 10;
          persistSink(sink);

          /* 导演剧本（视频分支）：videoMeta 传服务端实测时长——LLM 不得自行推测源视频时长。
             视频配音只保留 AI 配音一条路：LLM 大导演优先，不可用/两次失败落程序兜底
             剧本（宪法层），不出空任务。用户输入的 text 只作为素材喂给导演，不直接采信。
             主播风格层：排班上下文随调用注入（cut.anchor_* 由 sanitize 兜底校验）。 */
          const anchorContext = buildAnchorContext(renderTaskId, dubScene);
          let cut = null;
          try {
            cut = await (deps.generateDirectorCut || generateDirectorCut)({
              scene: dubScene,
              title,
              sellingPoints,
              imageCount: 1,
              voice: dubVoice,
              videoMeta: { durationSec: mat.durationSec },
              // 批量赛马差异化：批次内每条强制不同钩子角度；单版路径 angle 为空串不注入
              variantAngle: angle,
              variantIndex: vIdx,
              variantTotal: vTotal,
              anchorContext,
            });
          } catch (e) {
            cut = (deps.generateConstitutionScript || generateConstitutionScript)(
              dubScene,
              String(payload.mode || ''),
              title,
              sellingPoints,
              1,
              dubVoice,
              { durationSec: mat.durationSec },
            );
          }
          if (!cut || !Array.isArray(cut.shots) || !cut.shots.length) {
            throw createAppError(ERROR_CODES.SYNTHESIS_FAILED, '导演未产出有效旁白分段');
          }
          trackAnchor(cut);
          sink.__anchorDna = anchorDnaLabel(cut);
          // 作品标题：LLM 大导演返回的主标题优先，用户输入兜底（与图片成片分支口径一致；
          // 2026-10-29 修复：此前该分支从未落 title，作品列表恒显示客户端发来的占位标题）
          sink.title = String(cut.title || '').trim() || title || '配音成片';

          const produceFn = deps.produceVideoDub || produceVideoDub;
          const dubResult = await produceFn({
            taskId: renderTaskId,
            taskDir: dubTaskDir,
            videoFile: safeVideoFile,
            cut,
            voiceId: resolveTtsVoice(cut),
            scene: dubScene,
            endingId: cut?.ending_id || undefined,
            onStage: ({ progress, stageText } = {}) => {
              if (Number.isFinite(progress) && progress > sink.progress) sink.progress = progress;
              if (stageText) sink.stageText = stageText;
              persistSink(sink);
            },
          });

          sink.status = 'completed';
          sink.stage = 'done';
          sink.stageText = '视频配音合成完成';
          sink.progress = 100;
          // 创作防重账本：记录本片变体/BGM 情绪，供下次导演做差异化提示（内部静默吞错）
          recordCreative(cut);
          const coverRel = dubResult?.coverPath ? `/storage/outputs/${renderTaskId}/cover.jpg` : '';
          const publishWithCover = cut.publish ? { ...cut.publish, cover_url: coverRel } : null;
          sink.outputs = normalizeOutput({
            videoUrl: `/storage/outputs/${renderTaskId}/final.mp4`,
            coverUrl: coverRel,
            duration: dubResult?.videoSec || mat.durationSec || 0,
            // 发布方案（增值交付物）：导演层产出，随成片交用户直接复制发布
            publish: publishWithCover,
            // 主播风格标签（纯文本）：交付卡展示本片表达人格
            anchorDna: anchorDnaLabel(cut),
          }, renderTaskId);
          persistSink(sink);
        };

        await runBatchOrSingle(runOneVersion);
        return;
      }

      // ==========================================
      // 分支三：slicer 切片工具
      // ==========================================
      if (rawType === 'slicer') {
        creationTask.stage = 'analyzing';
        creationTask.stageText = '正在准备视频切片与识别...';
        creationTask.progress = 15;
        creationStore.updateTask(taskId, creationTask);

        const mat = verifiedMaterials[0];
        const segSec = Number(payload.options?.segSec) || 20;

        const slicerFn = deps.startSlicerPrepare || startSlicerPrepare;
        const slicerResult = await slicerFn({
          payload: {
            materialId: mat.materialId,
            segSec,
          },
          inMemoryTasks,
          storageUploadsDir,
          storageOutputsDir,
        });

        if (!slicerResult || !slicerResult.taskId) {
          throw createAppError(ERROR_CODES.SYNTHESIS_FAILED, '切片底层分析任务创建失败');
        }

        creationTask.subTaskId = slicerResult.taskId;
        await syncSlicerSubTask(slicerResult.taskId, creationTask, inMemoryTasks, deps);
        return;
      }

      // ==========================================
      // 分支四：speechcut 口播视频
      // ==========================================
      if (rawType === 'speechcut') {
        creationTask.stage = 'analyzing';
        creationTask.stageText = '正在分析口播语音与停顿冗余...';
        creationTask.progress = 15;
        creationStore.updateTask(taskId, creationTask);

        const mat = verifiedMaterials[0];
        const speechFn = deps.startSpeechAnalyze || startSpeechAnalyze;

        const speechResult = await speechFn({
          payload: {
            videoPath: mat.filePath,
            durationSec: mat.durationSec,
          },
          inMemoryTasks,
          storageUploadsDir,
          storageOutputsDir,
        });

        if (!speechResult || !speechResult.taskId) {
          throw createAppError(ERROR_CODES.SYNTHESIS_FAILED, '口播分析任务创建失败');
        }

        creationTask.subTaskId = speechResult.taskId;
        await syncSpeechcutSubTask(speechResult.taskId, creationTask, inMemoryTasks, deps);
        return;
      }

      // ==========================================
      // 分支五：image_creator 图片成片（V4 独立视觉引擎）
      // 链路：导演台词（LLM 优先 / 程序兜底）→ TTS 实测每镜时长 → 引擎一次合成
      // ==========================================
      if (rawType === 'image_creator') {
        if (!verifiedMaterials.length) {
          throw createAppError(ERROR_CODES.TEXT_REQUIRED, '图片成片至少需要上传 1 张商品图');
        }
        /* MAX-9 硬锁定：前端已拦，服务端再拦一次（超额图片直接忽略不报错，与前端口径一致） */
        const imageMats = verifiedMaterials.slice(0, 9);

        const runOneVersion = async ({ sink, renderTaskId, angle, layoutId, vIdx, vTotal }) => {
          sink.stage = 'scripting';
          sink.stageText = 'AI 导演正在为每张图片撰写台词与小标...';
          sink.progress = 10;
          persistSink(sink);

          let cut = null;
          try {
            cut = await (deps.generateDirectorCut || generateDirectorCut)({
              scene: String(payload.scene || 'sell'),
              title,
              sellingPoints,
              imageCount: imageMats.length,
              voice: String(payload.voice || payload.voiceConfig?.voiceId || '').trim(),
              // 批量赛马差异化：批次内每条强制不同钩子角度；单版路径 angle 为空串不注入
              variantAngle: angle,
              variantIndex: vIdx,
              variantTotal: vTotal,
              // 主播风格层：排班上下文随调用注入（cut.anchor_* 由 sanitize 兜底校验）
              anchorContext: buildAnchorContext(renderTaskId, String(payload.scene || 'sell')),
            });
          } catch (e) {
            /* LLM 不可用/两次调用失败 → 程序兜底剧本（宪法层），不出空任务 */
            cut = (deps.generateConstitutionScript || generateConstitutionScript)(
              String(payload.scene || 'sell'),
              String(payload.mode || ''),
              title,
              sellingPoints,
              imageMats.length,
              String(payload.voice || payload.voiceConfig?.voiceId || '').trim(),
              null,
            );
          }
          if (!cut || !Array.isArray(cut.shots) || !cut.shots.length) {
            throw createAppError(ERROR_CODES.SYNTHESIS_FAILED, '导演未产出有效分镜台词');
          }
          trackAnchor(cut);
          sink.__anchorDna = anchorDnaLabel(cut);
          // 作品标题：LLM 主标题优先（口径与图片成片/视频配音分支一致）
          sink.title = String(cut.title || '').trim() || title || '分镜成片';

          const taskDir = path.join(storageOutputsDir, renderTaskId);
          const produceFn = deps.produceImageFilm || produceImageFilm;
          const result = await produceFn({
            taskId: renderTaskId,
            taskDir,
            materials: imageMats,
            cut,
            voiceId: resolveTtsVoice(cut),
            scene: String(payload.scene || 'sell'),
            // 版式智能策展与字体配对：批量赛马批次显式指定优先；单版路径优先采纳 LLM 策展版式与字体配对（cut.layout_id / cut.pairing_id）；无则引擎按 seed 兜底抽选
            layoutId: layoutId || cut?.layout_id || undefined,
            pairingId: cut?.pairing_id || undefined,
            onStage: ({ progress, stageText } = {}) => {
              if (Number.isFinite(progress) && progress > sink.progress) sink.progress = progress;
              if (stageText) sink.stageText = stageText;
              persistSink(sink);
            },
          });

          sink.status = 'completed';
          sink.stage = 'done';
          sink.stageText = '图片成片完成';
          sink.progress = 100;
          // 创作防重账本：记录本片变体/BGM 情绪，供下次导演做差异化提示（内部静默吞错）
          recordCreative(cut);
          sink.outputs = normalizeOutput({
            videoUrl: `/storage/outputs/${renderTaskId}/final.mp4`,
            coverUrl: `/storage/outputs/${renderTaskId}/cover.jpg`,
            duration: result.videoSec || 0,
            // 发布方案（增值交付物）：导演层产出，随成片交用户直接复制发布
            publish: {
              ...(cut.publish || {}),
              cover_url: `/storage/outputs/${renderTaskId}/cover.jpg`,
            },
            // 主播风格标签（纯文本）：交付卡展示本片表达人格
            anchorDna: anchorDnaLabel(cut),
          }, renderTaskId);
          persistSink(sink);
        };

        await runBatchOrSingle(runOneVersion);
        return;
      }
    } catch (err) {
      /* Error 的 message 是非枚举属性，JSON.stringify 会丢——任务 API 里只见 code 不见原因。
         服务端必须留一条完整日志，否则线上排障只能看到 50001。 */
      console.error(`[creation] 任务 ${taskId} 失败:`, err.message, '\n', err.stack?.split('\n').slice(0, 4).join('\n') || '');
      creationTask.status = 'failed';
      creationTask.stage = 'failed';
      const appErr = createAppError(err.code || ERROR_CODES.SYNTHESIS_FAILED, err.message || '创作任务执行失败');
      creationTask.error = { name: appErr.name, code: appErr.code, status: appErr.status, message: appErr.message };

      // 【商业信誉底线：出片任务执行失败，100% 自动退还扣除积分】
      // 退款实现统一收敛至 billing.settleFailure（幂等 + 按原资产池原路退回）
      if (creationTask.creditsCharged > 0 && effectiveUserId && !creationTask.creditsRefunded) {
        const r = settleFailure({
          userId: effectiveUserId,
          taskId,
          amount: creationTask.creditsCharged,
          reason: '出片失败自动退还',
          store: deps.creditStore || creditStore,
        });
        if (r.ok) {
          creationTask.creditsRefunded = true;
          console.log(`[creation] 任务 ${taskId} 失败，已全额自动退还用户 ${effectiveUserId} 积分: ${creationTask.creditsCharged}`);
        } else if (r.error) {
          console.error(`[creation] 任务 ${taskId} 自动退还积分失败:`, r.error);
        }
      }
      creationStore.updateTask(taskId, creationTask);
    }
  })();

  return initialResponse;
}

/**
 * 查询统一创作任务状态
 * @param {string} taskId
 * @returns {object|null}
 */
export function isCreationTaskExpired(task, now = Date.now()) {
  if (!task) return false;
  const explicitExpireAt = Number(task.expireAt);
  if (Number.isFinite(explicitExpireAt) && explicitExpireAt > 0) return explicitExpireAt <= now;
  const createdAt = Number(task.createdAt);
  return Number.isFinite(createdAt) && createdAt > 0 && createdAt + 24 * 3600 * 1000 <= now;
}

export function getCreationTask(taskId) {
  if (!taskId || typeof taskId !== 'string') return null;
  const id = taskId.trim();
  const task = creationStore.getTask(id);
  if (isCreationTaskExpired(task)) return null;
  return task;
}

/**
 * 查询创作历史列表 (脱敏过滤安全输出)
 * 24 小时到期后立即移除作品记录，不依赖后台定时清理是否准时执行。
 * @param {object} [filter]
 * @returns {Array<object>}
 */
export function listCreationHistory(filter = {}) {
  const list = creationStore.listTasks(filter).filter((task) => !isCreationTaskExpired(task));
  return list.map((t) => ({
    taskId: t.taskId,
    type: t.type,
    status: t.status,
    // 落档标题（LLM 主标题）优先；旧任务无落档标题时回落用户输入
    title: t.title || t.input?.title || '',
    thumbnail: t.outputs?.cover || t.outputs?.coverUrl || '',
    createdAt: t.createdAt,
    duration: t.outputs?.duration || 0,
  }));
}
