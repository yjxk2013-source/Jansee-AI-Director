import test from 'node:test';
import assert from 'node:assert/strict';
import { metrics } from '../../metrics.mjs';

test('Metrics 1: HTTP 请求计数与状态码分类归集', () => {
  metrics.clear();
  metrics.recordRequest('GET', '/health', 200, 5);
  metrics.recordRequest('POST', '/api/v1/auth', 200, 15);
  metrics.recordRequest('GET', '/api/v1/user', 401, 8);
  metrics.recordRequest('POST', '/api/v1/compose', 500, 120);

  const snapshot = metrics.getSnapshot();
  assert.equal(snapshot.http.requestsTotal, 4, '总请求数必须等于 4');
  assert.equal(snapshot.http.status['2xx'], 2, '2xx 计数必须为 2');
  assert.equal(snapshot.http.status['4xx'], 1, '4xx 计数必须为 1');
  assert.equal(snapshot.http.status['5xx'], 1, '5xx 计数必须为 1');
});

test('Metrics 2: 渲染出片任务耗时分位数与成功率计算', () => {
  metrics.clear();
  // 注入 10 个模拟渲染耗时 (毫秒)
  const durations = [1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 10000];
  durations.forEach(d => metrics.recordCompose('image-film', d, true));
  // 注入 1 个失败任务
  metrics.recordCompose('image-film', 500, false, 'COMPOSE_TIMEOUT');

  const snapshot = metrics.getSnapshot();
  assert.equal(snapshot.composePipeline.tasksTotal, 11, '总任务数应为 11');
  assert.equal(snapshot.composePipeline.successTotal, 10, '成功任务数应为 10');
  assert.equal(snapshot.composePipeline.failTotal, 1, '失败任务数应为 1');
  assert.ok(snapshot.composePipeline.successRatePercent > 90.0, '成功率应大于 90%');

  const latency = snapshot.composePipeline.latencyMs;
  assert.equal(latency.p50, 6000, 'P50 应约为第 50 分位数');
  assert.equal(latency.p90, 10000, 'P90 应对应高分位耗时');
  assert.equal(latency.avg, 5500, '平均值应计算正确');
  assert.equal(snapshot.errors['COMPOSE_TIMEOUT'], 1, '错误码分类应被记录');
});

test('Metrics 3: 内存防爆与滑窗容量上限截断', () => {
  metrics.clear();
  // 模拟写入 1500 条数据，验证环形缓冲区截断
  for (let i = 0; i < 1500; i++) {
    metrics.recordCompose('test', i, true);
  }
  const snapshot = metrics.getSnapshot();
  assert.ok(snapshot.composePipeline.recentSampleCount <= 1000, '滑窗样本数量绝不能超过 1000');
  assert.ok(snapshot.memory.heapUsedMb > 0, '必须能读取进程内存占用');
  assert.ok(snapshot.server.uptimeSec >= 0, '必须包含运行时长');
});

test('Metrics 4: 健康告警判定与自愈动作输出 (从指标到行动闭环)', () => {
  metrics.clear();
  // 注入 25 次请求，其中 5 次 500 错误 (20% 错误率，远超 5% 阈值)
  for (let i = 0; i < 20; i++) metrics.recordRequest('GET', '/health', 200, 5);
  for (let i = 0; i < 5; i++) metrics.recordRequest('POST', '/api/v1/compose', 500, 100);

  // 注入 1 次超长延迟 35 秒
  metrics.recordCompose('speech-cut', 35000, true);

  const snapshot = metrics.getSnapshot();
  assert.ok(snapshot.health, '快照必须包含 health 状态');
  assert.equal(snapshot.health.status, 'CRITICAL', '高 5xx 错误率必须判定为 CRITICAL 状态');
  assert.ok(snapshot.health.alerts.length >= 1, '必须包含结构化告警明细');
  assert.ok(snapshot.health.alerts.some(a => a.code === 'HIGH_HTTP_5XX_RATE'), '必须触发 5xx 错误率告警');
  assert.ok(snapshot.health.alerts.some(a => a.action.includes('熔断')), '必须包含处置动作建议');
});


