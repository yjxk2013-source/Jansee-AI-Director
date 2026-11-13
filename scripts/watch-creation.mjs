import { creationStore } from '../apps/web/server/creationStore.mjs';

console.log('[WATCHER] 简兮出片实时监控哨兵已启动，正在等待出片任务...');

let lastSeenTaskId = null;
let lastStatus = null;
let lastStage = null;
let lastProgress = null;

const timer = setInterval(() => {
  try {
    const tasks = creationStore.listTasks({ limit: 1 });
    if (!tasks || !tasks.length) return;
    const task = tasks[0];

    const isNewTask = task.taskId !== lastSeenTaskId;
    const isStateChanged = task.status !== lastStatus || task.stage !== lastStage || task.progress !== lastProgress;

    if (isNewTask) {
      lastSeenTaskId = task.taskId;
      lastStatus = task.status;
      lastStage = task.stage;
      lastProgress = task.progress;

      console.log('\n======================================================');
      console.log(`[WATCHER 捕获新创作任务] ID: ${task.taskId}`);
      console.log(`类型: ${task.type || task.rawType} | 场景: ${task.payload?.scene || 'sell'} | 标题: ${task.payload?.title || '未命名'}`);
      console.log(`当前阶段: ${task.stage} (${task.progress}%) - ${task.stageText || ''}`);
      console.log('======================================================\n');
    } else if (isStateChanged) {
      lastStatus = task.status;
      lastStage = task.stage;
      lastProgress = task.progress;
      console.log(`[WATCHER 进度更新] [${task.taskId}] 状态: ${task.status} | 阶段: ${task.stage} (${task.progress}%) | ${task.stageText || ''}`);
    }

    if (task.status === 'completed' && task.outputs && !task.__reported) {
      task.__reported = true;
      console.log('\n---------------- [任务交付物与视听决策详情] ----------------');
      console.log(`成片地址: ${task.outputs.videoUrl}`);
      console.log(`成片时长: ${task.outputs.duration}s`);
      if (task.outputs.publish) {
        console.log(`推荐发布标题: 《${task.outputs.publish.cover_title || ''}》`);
        console.log(`发布正文: ${task.outputs.publish.caption || ''}`);
        console.log(`置顶评论: ${task.outputs.publish.pinned_comment || ''}`);
      }
      console.log('-----------------------------------------------------------\n');
    }
  } catch (e) {
    // 忽略瞬态读取异常
  }
}, 1500);

process.on('SIGINT', () => {
  clearInterval(timer);
  process.exit(0);
});
