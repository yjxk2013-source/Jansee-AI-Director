// 简兮 (JANSEE) · Creation Task 持久化存储抽象层 (apps/web/server/creationStore.mjs)
// 职责：
//   1. 统一管理 creationTask 的保存、查询、更新、历史检索与状态恢复；
//   2. 抽象 Storage Interface，第一版提供健壮的内存实现，未来无缝插拔 Redis / PostgreSQL；
//   3. 保证线程安全与状态不可篡改。

/**
 * 任务存储抽象基类 (Storage Interface)
 */
export class CreationStore {
  constructor() {
    this.tasks = new Map();
  }

  /**
   * 保存新任务
   * @param {object} task 必须包含 taskId
   * @returns {object} 保存后的任务快照
   */
  createTask(task) {
    if (!task || !task.taskId) {
      throw new Error('保存任务失败：task 必须具备唯一 taskId');
    }
    const now = Date.now();
    const record = {
      ...task,
      createdAt: task.createdAt || now,
      updatedAt: now,
    };
    this.tasks.set(task.taskId, record);
    return { ...record };
  }

  /**
   * 获取任务详情
   * @param {string} taskId
   * @returns {object|null}
   */
  getTask(taskId) {
    if (!taskId || typeof taskId !== 'string') return null;
    const task = this.tasks.get(taskId.trim());
    return task ? { ...task } : null;
  }

  /**
   * 局部更新任务状态
   * @param {string} taskId
   * @param {object} patch 增量更新字段
   * @returns {object|null}
   */
  updateTask(taskId, patch) {
    if (!taskId || typeof taskId !== 'string') return null;
    const existing = this.tasks.get(taskId.trim());
    if (!existing) return null;

    const updated = {
      ...existing,
      ...patch,
      taskId: existing.taskId, // taskId 恒定不可被 patch 篡改
      updatedAt: Date.now(),
    };

    // 若 patch 中含有 outputs，保证合并
    if (patch.outputs && typeof patch.outputs === 'object') {
      updated.outputs = {
        ...(existing.outputs || {}),
        ...patch.outputs,
      };
    }

    this.tasks.set(taskId.trim(), updated);
    return { ...updated };
  }

  /**
   * 按条件查询任务列表
   * @param {object} [filter]
   * @param {string} [filter.type] 创作类型
   * @param {string} [filter.status] 任务状态
   * @param {number} [filter.limit=50] 最大返回数量
   * @param {number} [filter.offset=0] 偏移量
   * @returns {Array<object>} 按 createdAt 降序排列的任务列表
   */
  listTasks(filter = {}) {
    const { type, status, limit = 50, offset = 0 } = filter;
    let all = Array.from(this.tasks.values());

    if (filter.userId) {
      all = all.filter((t) => t.userId === filter.userId);
    }
    if (type) {
      all = all.filter((t) => t.type === type);
    }
    if (status) {
      all = all.filter((t) => t.status === status);
    }

    // 默认按创建时间倒序排列
    all.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

    return all.slice(offset, offset + limit).map((t) => ({ ...t }));
  }

  /**
   * 获取所有任务列表（大盘经营总览与数据统计用）
   * @returns {Array<object>}
   */
  listAll() {
    return Array.from(this.tasks.values()).map((t) => ({ ...t }));
  }

  /**
   * 清理过期任务（杜绝任务 Map 内存泄漏，与 24 小时生命周期对齐）
   * @param {number} [maxAgeMs=86400000] 默认 24 小时
   * @returns {number} 清理的任务数量
   */
  cleanExpiredTasks(maxAgeMs = 24 * 3600 * 1000) {
    const now = Date.now();
    let count = 0;
    for (const [taskId, task] of this.tasks.entries()) {
      const cTime = Number(task.createdAt) || 0;
      const expireAt = Number(task.expireAt) || (cTime ? cTime + maxAgeMs : 0);
      if (expireAt && now >= expireAt) {
        this.tasks.delete(taskId);
        count += 1;
      }
    }
    return count;
  }

  /**
   * 清理所有任务（主要用于自动化测试沙箱重置）
   */
  clear() {
    this.tasks.clear();
  }
}

// 导出全局存储单例
export const creationStore = new CreationStore();
