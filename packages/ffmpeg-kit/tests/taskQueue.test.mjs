import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskQueueEngine, TASK_STATUS } from '../taskQueue.mjs';

test('TaskQueue 1: 注册处理器、提交任务并正常消费完成', async () => {
  const engine = new TaskQueueEngine({ concurrency: 2 });
  engine.registerHandler('mock-render', async (task, updateProgress) => {
    updateProgress(50);
    await new Promise(r => setTimeout(r, 20));
    updateProgress(100);
    return { output: 'success.mp4' };
  });

  const taskId = engine.enqueue('mock-render', { sceneCount: 3 });
  assert.ok(taskId.startsWith('task_'));

  await new Promise(r => engine.on('completed', r));

  const finished = engine.getTask(taskId);
  assert.equal(finished.status, TASK_STATUS.COMPLETED);
  assert.equal(finished.progress, 100);
  assert.equal(finished.result.output, 'success.mp4');
});

test('TaskQueue 2: 并发门控与任务排队机制', async () => {
  const engine = new TaskQueueEngine({ concurrency: 1 });
  let activeMax = 0;
  let activeCurrent = 0;

  engine.registerHandler('slow-job', async () => {
    activeCurrent++;
    if (activeCurrent > activeMax) activeMax = activeCurrent;
    await new Promise(r => setTimeout(r, 30));
    activeCurrent--;
    return true;
  });

  const t1 = engine.enqueue('slow-job');
  const t2 = engine.enqueue('slow-job');

  await new Promise(r => {
    let done = 0;
    engine.on('completed', () => {
      done++;
      if (done === 2) r();
    });
  });

  assert.equal(activeMax, 1, '最大并发活跃数绝不能超过配置的 concurrency: 1');
  assert.equal(engine.getTask(t1).status, TASK_STATUS.COMPLETED);
  assert.equal(engine.getTask(t2).status, TASK_STATUS.COMPLETED);
});

test('TaskQueue 3: 任务超时强杀看门狗与状态标记', async () => {
  const engine = new TaskQueueEngine({ concurrency: 2, defaultTimeoutMs: 30 });
  engine.registerHandler('stuck-job', async () => {
    // 模拟死锁阻塞任务
    await new Promise(r => setTimeout(r, 200));
    return 'never';
  });

  const stuckId = engine.enqueue('stuck-job', {}, { timeoutMs: 30, retries: 0 });

  await new Promise(r => engine.on('failed', r));

  const task = engine.getTask(stuckId);
  assert.equal(task.status, TASK_STATUS.TIMEOUT, '超时任务必须被标记为 TIMEOUT');
  assert.ok(task.error.includes('TIMEOUT'));
});

test('TaskQueue 4: 幂等键去重窗口保障 (杜绝重复出片与重复扣费)', () => {
  const engine = new TaskQueueEngine({ concurrency: 2 });
  engine.registerHandler('idempotent-job', async () => 'ok');

  const id1 = engine.enqueue('idempotent-job', { orderId: 'ORD_1001' }, { idempotencyKey: 'IDEMP_KEY_888' });
  const id2 = engine.enqueue('idempotent-job', { orderId: 'ORD_1001' }, { idempotencyKey: 'IDEMP_KEY_888' });

  assert.equal(id1, id2, '同一去重窗口内的相同幂等键必须返回同一 taskId，杜绝重复入队');
});

test('TaskQueue 5: Auto-QC 修正建议消费闭环与定向重试', async () => {
  const engine = new TaskQueueEngine({ concurrency: 1, maxRetries: 1 });
  let runCount = 0;
  let receivedCorrections = null;

  engine.registerHandler('dub-with-qc', async (task) => {
    runCount++;
    if (runCount === 1) {
      // 模拟第一次生成，质检发现音画漂移并输出修正建议
      return {
        videoPath: '/mock/out.mp4',
        qcResult: {
          passed: false,
          grade: 'REJECT',
          suggestedCorrections: [
            { issue: 'AV_SYNC_DRIFT', action: 'PAD_AUDIO_TAIL', driftMs: 120 }
          ]
        }
      };
    }
    // 第二次执行：消费上一轮质检教练输出的建议
    receivedCorrections = task.appliedCorrections;
    return {
      videoPath: '/mock/out_fixed.mp4',
      qcResult: { passed: true, grade: 'A', suggestedCorrections: [] }
    };
  });

  const taskId = engine.enqueue('dub-with-qc', {}, { retries: 1 });

  await new Promise(r => engine.on('completed', r));

  const finalTask = engine.getTask(taskId);
  assert.equal(runCount, 2, '未通过质检且带有建议的任务必须触发定向重试');
  assert.equal(finalTask.status, TASK_STATUS.COMPLETED);
  assert.ok(receivedCorrections, '重试时必须将修正建议注入 task 供渲染器消费');
  assert.equal(receivedCorrections[0].issue, 'AV_SYNC_DRIFT');
});


