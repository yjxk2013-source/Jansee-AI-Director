/**
 * 简兮 (JANSEE) · 分布式可插拔任务队列与 Worker 调度引擎 (packages/ffmpeg-kit/taskQueue.mjs)
 * 职责：
 *   实现 DeepSeek 提出的“从单机防 OOM 走向多节点弹性调度”架构演进：
 *   1. 抽象统一的任务调度器接口（TaskQueue）；
 *   2. 规范任务状态流转生命周期：PENDING -> RUNNING -> COMPLETED / FAILED / TIMEOUT；
 *   3. 进程级并发槽位限制（复用已有的 acquireComposeSlot 信号量）与超时强杀看门狗；
 *   4. 支持无缝切入分布式调度（Master-Worker 模式）；
 *   5. 暴露标准度量快照供后台与可观测性探针实时读取。
 */

import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { acquireComposeSlot, getComposeGateSnapshot } from './composeGate.mjs';

/**
 * 任务生命周期枚举
 */
export const TASK_STATUS = {
  PENDING: 'pending',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  TIMEOUT: 'timeout',
};

/**
 * 任务队列核心引擎
 */
export class TaskQueueEngine extends EventEmitter {
  /**
   * @param {object} [options]
   * @param {number} [options.concurrency=2] 最大并发数
   * @param {number} [options.defaultTimeoutMs=120000] 单任务默认超时（2分钟）
   * @param {number} [options.maxRetries=1] 失败重试次数
   * @param {string} [options.stateFilePath] 状态落盘文件路径
   */
  constructor(options = {}) {
    super();
    this.concurrency = options.concurrency || 2;
    this.defaultTimeoutMs = options.defaultTimeoutMs || 120000;
    this.maxRetries = options.maxRetries || 1;
    this.stateFilePath = options.stateFilePath || null;

    // 内存队列与任务账本
    this.queue = [];
    this.activeTasks = new Map(); // taskId -> taskContext
    this.history = new Map();     // taskId -> taskSummary (保留最近 200 个完成任务)
    this.maxHistory = 200;

    // 幂等键窗口 (idempotencyKey -> { taskId, expiresAt })
    this.idempotencyMap = new Map();

    // 处理器注册表 (taskType -> handlerFn)
    this.handlers = new Map();
  }

  /**
   * 注册指定任务类型的执行 Handler
   * @param {string} taskType 任务类型（如 'video-dub', 'image-film', 'speech-cut'）
   * @param {(task: object, updateProgress: (pct: number) => void) => Promise<any>} handlerFn
   */
  registerHandler(taskType, handlerFn) {
    if (typeof handlerFn !== 'function') {
      throw new Error(`[TaskQueue] 处理器必须为可执行函数: ${taskType}`);
    }
    this.handlers.set(taskType, handlerFn);
  }

  /**
   * 提交新任务入队（支持幂等键去重与优先级排队）
   * @param {string} taskType
   * @param {object} payload
   * @param {object} [options]
   * @param {string} [options.idempotencyKey] 幂等请求键
   * @returns {string} taskId
   */
  enqueue(taskType, payload = {}, options = {}) {
    if (!this.handlers.has(taskType)) {
      throw new Error(`[TaskQueue] 未注册的任务类型: ${taskType}`);
    }

    // 幂等性校验：同一幂等键在窗口期内（10分钟）直接返回已存在任务
    if (options.idempotencyKey) {
      const existing = this.idempotencyMap.get(options.idempotencyKey);
      if (existing && existing.expiresAt > Date.now()) {
        const existingTask = this.getTask(existing.taskId);
        if (existingTask && existingTask.status !== TASK_STATUS.FAILED && existingTask.status !== TASK_STATUS.TIMEOUT) {
          return existing.taskId;
        }
      }
    }

    const taskId = options.taskId || `task_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const task = {
      taskId,
      type: taskType,
      payload: { ...payload },
      priority: options.priority || 0, // 优先级（越大越先出队）
      status: TASK_STATUS.PENDING,
      progress: 0,
      retriesLeft: options.retries !== undefined ? options.retries : this.maxRetries,
      timeoutMs: options.timeoutMs || this.defaultTimeoutMs,
      createdAt: Date.now(),
      startedAt: null,
      completedAt: null,
      result: null,
      error: null,
      childProcesses: [], // 绑定的子进程列表，用于孤儿清理
      appliedCorrections: null, // 上一轮 QC 质检教练输出的结构化修正建议
      registerChildProcess(child) {
        if (child && typeof child.kill === 'function') {
          this.childProcesses.push(child);
        }
      }
    };

    if (options.idempotencyKey) {
      this.idempotencyMap.set(options.idempotencyKey, {
        taskId,
        expiresAt: Date.now() + 10 * 60 * 1000 // 10分钟去重窗口
      });
    }

    // 按优先级降序插入队列
    const insertIdx = this.queue.findIndex((t) => t.priority < task.priority);
    if (insertIdx === -1) {
      this.queue.push(task);
    } else {
      this.queue.splice(insertIdx, 0, task);
    }

    this._persistState();
    this.emit('enqueued', task);
    this._processNext();
    return taskId;
  }

  /**
   * 清理任务关联的所有子进程（杜绝孤儿 FFmpeg 进程霸占显存与 CPU）
   */
  _cleanupOrphanProcesses(task) {
    if (!task || !Array.isArray(task.childProcesses)) return;
    for (const proc of task.childProcesses) {
      try {
        if (proc && !proc.killed && typeof proc.kill === 'function') {
          proc.kill('SIGKILL');
        }
      } catch {}
    }
    task.childProcesses = [];
  }

  /**
   * 调度核心：拉取就绪任务并在并发限额内执行
   */
  async _processNext() {
    if (this.activeTasks.size >= this.concurrency) {
      return;
    }
    if (this.queue.length === 0) {
      return;
    }

    const task = this.queue.shift();
    task.status = TASK_STATUS.RUNNING;
    task.startedAt = Date.now();
    this.activeTasks.set(task.taskId, task);
    this._persistState();
    this.emit('started', task);

    // 设置超时看门狗保护
    let timer = null;
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => {
        // 看门狗强杀：立即清理绑定的孤儿渲染进程
        this._cleanupOrphanProcesses(task);
        const err = new Error(`[TaskQueue TIMEOUT] 任务执行超过 ${task.timeoutMs}ms 阈值`);
        err.code = 'TASK_TIMEOUT';
        reject(err);
      }, task.timeoutMs);
    });

    // 获取底层并发槽位保护
    let releaseGate = null;
    try {
      releaseGate = await acquireComposeSlot(task.type);

      const handler = this.handlers.get(task.type);
      const updateProgress = (pct) => {
        task.progress = Math.min(100, Math.max(0, Math.round(pct)));
        this.emit('progress', { taskId: task.taskId, progress: task.progress });
      };

      const result = await Promise.race([
        handler(task, updateProgress),
        timeoutPromise,
      ]);

      clearTimeout(timer);

      // DeepSeek 提出的质检闭环：检查是否产出了未通过的 QC 报告且有修正建议
      if (result && result.qcResult && result.qcResult.passed === false && task.retriesLeft > 0) {
        if (Array.isArray(result.qcResult.suggestedCorrections) && result.qcResult.suggestedCorrections.length > 0) {
          // 质检教练介入：将修正建议注入下一次重试
          task.retriesLeft--;
          task.appliedCorrections = result.qcResult.suggestedCorrections;
          task.payload.appliedCorrections = result.qcResult.suggestedCorrections;
          task.status = TASK_STATUS.PENDING;
          task.startedAt = null;
          task.progress = 0;
          this.queue.unshift(task); // 高优先级重新入队执行定向修复
          this.emit('retried', task);
          return;
        }
      }

      task.status = TASK_STATUS.COMPLETED;
      task.progress = 100;
      task.completedAt = Date.now();
      task.result = result;
      this.emit('completed', task);
    } catch (err) {
      clearTimeout(timer);
      this._cleanupOrphanProcesses(task);
      task.error = err.message;

      // 评估常规失败重试机制
      if (task.retriesLeft > 0 && err.code !== 'TASK_TIMEOUT') {
        task.retriesLeft--;
        task.status = TASK_STATUS.PENDING;
        task.startedAt = null;
        this.queue.unshift(task); // 高优先级重新排队
        this.emit('retried', task);
      } else {
        task.status = err.code === 'TASK_TIMEOUT' ? TASK_STATUS.TIMEOUT : TASK_STATUS.FAILED;
        task.completedAt = Date.now();
        this.emit('failed', task);
      }
    } finally {
      if (releaseGate) {
        releaseGate();
      }
      this.activeTasks.delete(task.taskId);
      this._recordHistory(task);
      this._persistState();

      // 循环消费下一个就绪任务
      setImmediate(() => this._processNext());
    }
  }

  /**
   * 记录执行历史快照
   */
  _recordHistory(task) {
    if (this.history.size >= this.maxHistory) {
      const oldestKey = this.history.keys().next().value;
      if (oldestKey) this.history.delete(oldestKey);
    }
    this.history.set(task.taskId, {
      taskId: task.taskId,
      type: task.type,
      status: task.status,
      progress: task.progress,
      result: task.result,
      appliedCorrections: task.appliedCorrections,
      durationMs: task.completedAt && task.startedAt ? task.completedAt - task.startedAt : 0,
      error: task.error,
      completedAt: task.completedAt,
    });
  }

  /**
   * 轻量状态落盘（保证进程异常时状态可追溯）
   */
  _persistState() {
    if (!this.stateFilePath) return;
    try {
      const snapshot = {
        updatedAt: new Date().toISOString(),
        queued: this.queue.map(t => ({ taskId: t.taskId, type: t.type, status: t.status })),
        active: Array.from(this.activeTasks.values()).map(t => ({ taskId: t.taskId, type: t.type, startedAt: t.startedAt })),
      };
      fs.mkdirSync(path.dirname(this.stateFilePath), { recursive: true });
      fs.writeFileSync(this.stateFilePath, JSON.stringify(snapshot, null, 2), 'utf8');
    } catch {}
  }

  /**
   * 查询任务实时进度与状态
   * @param {string} taskId
   * @returns {object|null}
   */
  getTask(taskId) {
    if (this.activeTasks.has(taskId)) {
      return this.activeTasks.get(taskId);
    }
    const queued = this.queue.find((t) => t.taskId === taskId);
    if (queued) return queued;
    return this.history.get(taskId) || null;
  }

  /**
   * 导出任务队列运行快照
   */
  getSnapshot() {
    return {
      concurrency: this.concurrency,
      activeCount: this.activeTasks.size,
      queuedCount: this.queue.length,
      historyCount: this.history.size,
      activeTasks: Array.from(this.activeTasks.values()).map((t) => ({
        taskId: t.taskId,
        type: t.type,
        progress: t.progress,
        runningMs: Date.now() - t.startedAt,
      })),
      gateSnapshot: getComposeGateSnapshot(),
    };
  }

  /**
   * 重置状态（测试沙箱用）
   */
  clear() {
    this.queue = [];
    this.activeTasks.clear();
    this.history.clear();
    this.idempotencyMap.clear();
  }
}

// 导出单例
export const taskQueue = new TaskQueueEngine();
