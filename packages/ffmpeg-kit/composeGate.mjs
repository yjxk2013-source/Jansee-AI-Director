// 进程级重型媒体任务闸门：同一 Node 服务进程最多同时占用 2 个重型处理名额。
// 所有 FFmpeg 合成、切片和本地 Whisper ASR 共用这一把闸，后台监控也读取同一状态。
// 当前生产服务由单个 systemd Node 进程承载；若将来横向扩容为多进程/多实例，必须改用 Redis 等分布式锁。
const MAX_CONCURRENT = 2;

const queue = [];
const active = new Map();
let nextSlotId = 0;

function makeRelease(slotId) {
  let released = false;
  return function release() {
    if (released) return;
    released = true;
    active.delete(slotId);
    pump();
  };
}

function pump() {
  while (active.size < MAX_CONCURRENT && queue.length > 0) {
    const item = queue.shift();
    active.set(item.slotId, item.label);
    item.resolve(makeRelease(item.slotId));
  }
}

/**
 * 获取一个重型处理名额；无空位时严格 FIFO 排队。
 * release() 与队列项通过唯一 slotId 绑定，重复 label 不会误删其他任务。
 */
export async function acquireComposeSlot(label = 'media-task') {
  const slotId = ++nextSlotId;
  const safeLabel = String(label || 'media-task').slice(0, 160);

  if (active.size < MAX_CONCURRENT) {
    active.set(slotId, safeLabel);
    return makeRelease(slotId);
  }

  return new Promise((resolve) => {
    queue.push({
      slotId,
      label: safeLabel,
      queuedAt: Date.now(),
      resolve,
    });
  });
}

/** 返回后台监控使用的真实闸门状态快照，不暴露可变内部集合。 */
export function getComposeGateSnapshot() {
  return {
    maxConcurrency: MAX_CONCURRENT,
    activeCount: active.size,
    queuedCount: queue.length,
    activeJobs: Array.from(active, ([slotId, label]) => ({ slotId, label })),
    queuedJobs: queue.map(({ slotId, label, queuedAt }) => ({ slotId, label, queuedAt })),
  };
}
