import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { performAutoQc, QC_THRESHOLDS } from '../autoQc.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '../../..');

test('Auto-QC 1: 拦截不存在的伪造视频文件', async () => {
  const fakePath = path.join(root, 'storage/not_exist_video.mp4');
  const res = await performAutoQc(fakePath);
  assert.equal(res.passed, false, '不存在的文件必须判定为不通过');
  assert.equal(res.grade, 'REJECT', '评级必须为 REJECT');
  assert.ok(res.errors.length > 0, '必须包含错误原因');
});

test('Auto-QC 2: 拦截异常过小的空壳视频文件', async () => {
  const tinyTmpPath = path.join(root, 'storage/tmp_tiny_test.mp4');
  fs.mkdirSync(path.dirname(tinyTmpPath), { recursive: true });
  fs.writeFileSync(tinyTmpPath, Buffer.alloc(1024)); // 1KB 垃圾数据

  try {
    const res = await performAutoQc(tinyTmpPath);
    assert.equal(res.passed, false, '小于 100KB 的空壳文件必须被拦截');
    assert.equal(res.grade, 'REJECT');
    assert.ok(res.errors.some(e => e.includes('过小') || e.includes('流探测失败')));
  } finally {
    if (fs.existsSync(tinyTmpPath)) fs.unlinkSync(tinyTmpPath);
  }
});

test('Auto-QC 3: 真实样片成片质检与结构化指标提取', async () => {
  const sampleVideo = path.join(root, 'apps/web/client/assets/gemini_generated_video_daa127b4.mp4');
  if (!fs.existsSync(sampleVideo)) {
    console.log('[SKIP] 未找到样片文件，跳过本项');
    return;
  }

  const res = await performAutoQc(sampleVideo, {
    requireAudio: false,
    maxDriftMs: 400
  });

  assert.equal(res.passed, true, '合法真实样片必须通过 QC 质检');
  assert.ok(['A', 'B'].includes(res.grade), '合法样片评级应为 A 或 B');
  assert.ok(res.metrics.fileSizeBytes > 100000, '必须正确提取物理文件大小');
  assert.ok(res.metrics.durationSec > 0, '必须探测出有效时长');
  assert.ok(res.metrics.video, '必须提取视频流参数');
  assert.equal(res.metrics.video.codec, 'h264', '主流样片应为 h264 编码');
  assert.ok(res.metrics.checkedAt, '必须包含质检打标时间戳');
  assert.ok(Array.isArray(res.suggestedCorrections), '必须包含结构化重试修正建议列表');
});

test('Auto-QC 4: 产生定向修正建议闭环 (非标准分辨率与音画漂移建议)', async () => {
  const sampleVideo = path.join(root, 'apps/web/client/assets/gemini_generated_video_daa127b4.mp4');
  if (!fs.existsSync(sampleVideo)) return;

  const res = await performAutoQc(sampleVideo, {
    requireAudio: false,
    requireStandardVertical: true,
    expectedAudioDurationSec: 99.0, // 故意设置大幅漂移触发建议
    maxAvSyncDriftMs: 100
  });

  assert.ok(Array.isArray(res.suggestedCorrections), '必须返回结构化建议');
  assert.ok(res.suggestedCorrections.some(c => c.issue === 'AV_SYNC_DRIFT'), '必须输出音画漂移定向建议');
});


