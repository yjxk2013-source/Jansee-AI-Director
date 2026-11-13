// 分镜成片 · 原片直出链路测试（2026-10-24）
// 覆盖三层：
//   1) @jansee/speech-cut 分镜能力纯函数：planSegmentCut / shiftWordsToKeptTimeline
//   2) cutSegmentByRanges 真实 ffmpeg 单段剪除（音画同步）
//   3) BFF 编排：startStoryboardDirectAnalyze 校验 + startStoryboardDirectProduce
//      状态机与全链路集成（真实剪除 + 无声段垫静音 + 叠化拼接出片；ASR 用伪词表替代，
//      whisper 真实识别已由口播 e2e 覆盖，此处聚焦新胶水）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import ffmpegStatic from 'ffmpeg-static';
import {
  planSegmentCut,
  shiftWordsToKeptTimeline,
  cutSegmentByRanges,
} from '@jansee/speech-cut';
import {
  startStoryboardDirectAnalyze,
  startStoryboardDirectProduce,
} from '../../storyboard.mjs';
import { generatePublishOnly } from '../../director.mjs';
import { probeDurationSec, hasAudioStream } from '@jansee/ffmpeg-kit/probe.mjs';

const execFileP = promisify(execFile);

// —— 测试素材目录（临时，用完清理）——
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'sbd-test-'));
const uploadsDir = path.join(TMP_ROOT, 'uploads');
const outputsDir = path.join(TMP_ROOT, 'outputs');
fs.mkdirSync(uploadsDir, { recursive: true });
fs.mkdirSync(outputsDir, { recursive: true });

async function makeTestVideo(outFile, { withAudio = true, sec = 4 } = {}) {
  const args = [
    '-nostdin', '-y',
    '-f', 'lavfi', '-i', `color=c=navy:size=320x240:rate=15:duration=${sec}`,
  ];
  if (withAudio) {
    args.push('-f', 'lavfi', '-i', `sine=frequency=440:duration=${sec}`);
  }
  args.push(
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
  );
  if (withAudio) args.push('-c:a', 'aac', '-b:a', '96k', '-shortest');
  args.push(outFile);
  await execFileP(ffmpegStatic, args, { maxBuffer: 20 * 1024 * 1024 });
  return outFile;
}

// 伪 ASR 词表：第 1 段 4 秒，含 1 个语气词（0.9~1.1）与 1 个长停顿（2.7~3.5）
const SEG1_WORDS = [
  { word: '大家好', start: 0.2, end: 0.8 },
  { word: '呃', start: 0.9, end: 1.1 },
  { word: '今天', start: 1.3, end: 1.7 },
  { word: '天气', start: 1.8, end: 2.2 },
  { word: '不错', start: 2.3, end: 2.7 },
];
const SEG1_SUGGESTIONS = [
  { start: 0.9, end: 1.1, word: '呃', reason: 'filler' },
  { start: 2.7, end: 3.5, word: '停顿 0.8s', reason: 'pause' },
];

test('分镜直出 · planSegmentCut 区间规划（词块 + 长停顿合并口径）', () => {
  const plan = planSegmentCut({
    words: SEG1_WORDS,
    deletedStarts: new Set([0.9, 2.7]),
    pauseCuts: [{ start: 2.7, end: 3.5 }],
    durationSec: 4,
  });
  assert.equal(plan.error, null);
  // 词块「呃」：左切 max(0.8, 0.9-0.06)=0.84；右切 1.1+(1.3-1.1)/2=1.2
  // 长停顿：两端收缩 0.12 → [2.82, 3.38]（isPause 不外扩）；停顿后无后续词 → 右切点删到片尾 dur=4
  assert.equal(plan.cutRanges.length, 2);
  assert.ok(Math.abs(plan.cutRanges[0].start - 0.84) < 1e-6, `cut[0].start=${plan.cutRanges[0].start}`);
  assert.ok(Math.abs(plan.cutRanges[0].end - 1.2) < 1e-6, `cut[0].end=${plan.cutRanges[0].end}`);
  assert.ok(Math.abs(plan.cutRanges[1].start - 2.82) < 1e-6);
  assert.ok(Math.abs(plan.cutRanges[1].end - 4.0) < 1e-6, `cut[1].end=${plan.cutRanges[1].end}`);
  // 保留区间 = [0,0.84] [1.2,2.82]，总长 2.46（片尾静默一并剪除）
  assert.equal(plan.keepRanges.length, 2);
  assert.ok(Math.abs(plan.keepTotal - 2.46) < 1e-6, `keepTotal=${plan.keepTotal}`);
});

test('分镜直出 · planSegmentCut 无删除 = 全片保留', () => {
  const plan = planSegmentCut({ words: SEG1_WORDS, deletedStarts: new Set(), pauseCuts: [], durationSec: 4 });
  assert.equal(plan.error, null);
  assert.equal(plan.cutRanges.length, 0);
  assert.deepEqual(plan.keepRanges, [[0, 4]]);
});

test('分镜直出 · shiftWordsToKeptTimeline 词表重映射（删除区词塌缩过滤）', () => {
  const shifted = shiftWordsToKeptTimeline(SEG1_WORDS, [[0, 0.84], [1.2, 2.82]]);
  // 「呃」落在删除区被过滤；其余词全部落在第 2 保留段，统一偏移 -0.36
  assert.equal(shifted.length, 4);
  assert.deepEqual(shifted.map((w) => w.word), ['大家好', '今天', '天气', '不错']);
  assert.ok(Math.abs(shifted[1].start - (1.3 - 0.36)) < 0.01, `今天.start=${shifted[1].start}`);
  assert.ok(Math.abs(shifted[3].end - (2.7 - 0.36)) < 0.01);
});

test('发布方案 · generatePublishOnly 契约：LLM 不可用时落兜底且不抛错、无调试字段外泄', async () => {
  const prevMock = process.env.JIANXI_MOCK;
  process.env.JIANXI_MOCK = '1'; // 强制 llmUsable=false，走全兜底路径
  try {
    const pub = await generatePublishOnly({ transcript: '大家好，今天带大家看看这家新开的面馆', title: '老王面馆', scene: 'local' });
    // 四件套齐全（sanitizePublish 兜底恒有值，绝不阻断出片）
    for (const k of ['caption', 'cover_title', 'pinned_comment', 'post_time']) {
      assert.equal(typeof pub[k], 'string', `字段 ${k} 应为 string`);
    }
    assert.ok(pub.caption.length > 0, 'caption 兜底不应为空');
    // 调试字段绝不外泄（口播/分镜直出任务对象经 GET /video/task 原样透传）
    assert.equal(pub._banned_hits, undefined);
    // 空转写（全静音/全剪光）同样不抛错
    const empty = await generatePublishOnly({ transcript: '' });
    assert.ok(empty.caption.length > 0);
  } finally {
    if (prevMock === undefined) delete process.env.JIANXI_MOCK;
    else process.env.JIANXI_MOCK = prevMock;
  }
});

test('分镜直出 · BFF analyze 校验：少于 2 段 / 非法路径 / 超时长', async () => {
  const deps = { inMemoryTasks: new Map(), storageUploadsDir: uploadsDir, storageOutputsDir: outputsDir };
  assert.throws(
    () => startStoryboardDirectAnalyze({ payload: { videoPaths: [] }, ...deps }),
    (e) => e.code === 40010,
  );
  // 真实存在但不在白名单目录内的文件 → 40301（用本测试文件自身充当越权路径）
  assert.throws(
    () => startStoryboardDirectAnalyze({
      payload: { videoPaths: [new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')] },
      ...deps,
    }),
    (e) => e.code === 40301,
  );
  const longVideo = await makeTestVideo(path.join(uploadsDir, 'long.mp4'), { sec: 61 });
  assert.throws(
    () => startStoryboardDirectAnalyze({ payload: { videoPaths: [longVideo, longVideo] }, ...deps }),
    (e) => e.code === 40015,
  );
});

test('分镜直出 · BFF produce 状态机：未知任务 404 / 重复提交 409', () => {
  const inMemoryTasks = new Map();
  const deps = { inMemoryTasks, storageOutputsDir: outputsDir, chargeMockCredits: () => {} };
  assert.throws(
    () => startStoryboardDirectProduce({ taskId: 'sbd_none', selections: [], ...deps }),
    (e) => e.code === 40401,
  );
  inMemoryTasks.set('sbd_x', { taskId: 'sbd_x', kind: 'storyboard_direct', status: 'producing', segments: [] });
  assert.throws(
    () => startStoryboardDirectProduce({ taskId: 'sbd_x', selections: [], ...deps }),
    (e) => e.code === 40901,
  );
  // 伪造 kind 直接拒绝（不串到其它任务类型）
  inMemoryTasks.set('sbd_y', { taskId: 'sbd_y', kind: 'slicer', status: 'prepared', segments: [] });
  assert.throws(
    () => startStoryboardDirectProduce({ taskId: 'sbd_y', selections: [], ...deps }),
    (e) => e.code === 40401,
  );
});

test('分镜直出 · 全链路集成：逐段剪除 + 无声段垫静音 + 叠化拼接出片', { timeout: 300000 }, async () => {
  const seg1 = await makeTestVideo(path.join(uploadsDir, 'seg1.mp4'), { withAudio: true, sec: 4 });
  const seg2 = await makeTestVideo(path.join(uploadsDir, 'seg2.mp4'), { withAudio: false, sec: 4 });
  assert.ok(hasAudioStream(seg1), 'seg1 应含音轨');
  assert.ok(!hasAudioStream(seg2), 'seg2 应无音轨');

  // cutSegmentByRanges 单段剪除独立验证：保留 [0,0.84],[1.2,2.82] → 2.46s
  const cutDir = path.join(outputsDir, 'cut_unit');
  fs.mkdirSync(cutDir, { recursive: true });
  const cut = await cutSegmentByRanges({
    videoFile: seg1,
    keepRanges: [[0, 0.84], [1.2, 2.82]],
    taskDir: cutDir,
    outFile: 'unit_cut.mp4',
  });
  assert.ok(Math.abs(cut.durationSec - 2.46) < 0.25, `单段剪除时长 ${cut.durationSec}`);

  // 构造 analyzed 任务（伪词表替代 whisper）→ produce 全链路
  const inMemoryTasks = new Map();
  const taskId = 'sbd_test_full';
  inMemoryTasks.set(taskId, {
    taskId,
    kind: 'storyboard_direct',
    status: 'analyzed',
    segments: [
      { index: 1, name: 'seg1', file: seg1, durationSec: 4, silent: false, words: SEG1_WORDS, suggestions: SEG1_SUGGESTIONS, asrText: '大家好呃今天天气不错', note: '' },
      { index: 2, name: 'seg2', file: seg2, durationSec: 4, silent: true, words: [], suggestions: [], asrText: '', note: '无声空镜' },
    ],
    creditsCharged: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });

  let charged = 0;
  const r = startStoryboardDirectProduce({
    taskId,
    selections: [{ index: 1, deletedStarts: [0.9, 2.7] }],
    inMemoryTasks,
    storageOutputsDir: outputsDir,
    chargeMockCredits: () => { charged += 1; },
  });
  assert.equal(r.taskId, taskId);

  // 轮询任务完成（真实 ffmpeg 合成，4 核机 ~1 分钟内）
  const task = inMemoryTasks.get(taskId);
  const deadline = Date.now() + 240000;
  while (task.status !== 'completed' && task.status !== 'failed' && Date.now() < deadline) {
    await new Promise((res) => setTimeout(res, 500));
  }
  assert.equal(task.status, 'completed', `任务应完成，实际 ${task.status} / ${task.error || ''}`);
  assert.equal(charged, 1, '应恰好扣费一次');
  assert.ok(task.videoUrl && task.videoUrl.endsWith('/final.mp4'), `videoUrl=${task.videoUrl}`);

  const finalPath = path.join(outputsDir, taskId, 'final.mp4');
  assert.ok(fs.existsSync(finalPath), '成片文件应存在');
  const finalDur = probeDurationSec(finalPath);
  // 期望：seg1 剪除后 2.46s + seg2 静音 4s - 0.7s 叠化 ≈ 5.76s + 结尾卡尾段 2.95s ≈ 8.71s
  //（2026-10-24 全版块结尾收束标配：成片 = 叠化拼接原片 + 淡出黑停 CTA 尾段）
  assert.ok(Math.abs(finalDur - 8.71) < 0.9, `成片时长 ${finalDur.toFixed(2)}s，期望约 8.71s`);
  assert.ok(hasAudioStream(finalPath), '成片应含音轨（无声段垫静音轨后混流）');
  assert.ok(!!task.endingId, `结尾卡应随片交付（endingId=${task.endingId}）`);
  assert.ok(Math.abs((task.cutSec || 0) - (0.36 + 1.18)) < 0.1, `累计剪除 ${task.cutSec}s`);

  // 重复提交拦截
  assert.throws(
    () => startStoryboardDirectProduce({
      taskId, selections: [], inMemoryTasks, storageOutputsDir: outputsDir, chargeMockCredits: () => {},
    }),
    (e) => e.code === 40901,
  );
});

test.after?.(async () => {
  try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch (e) {}
});
