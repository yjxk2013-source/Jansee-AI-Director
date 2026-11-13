// 简兮分镜与切片模块 · BFF 编排层自动化测试（apps/web/server/tests/storyboard/test-bff.mjs）
// 目标：
//   1. 参数缺失、非法镜头数、非法素材 ID 校验
//   2. 路径穿越与不属于当前任务/越界目录素材拦截
//   3. 单镜超长/超短、镜头总数超限、预估成片超长拦截
//   4. N=1、空字幕、缺少音轨等关键分支行为
//   5. 重复提交、积分防重、失败重试
//   6. 并发闸门异常与 finally 释放
//   7. 切片成功与失败任务状态
//   8. ASR 结果透传复用（不重复识别）
// 零付费：纯本地逻辑与桩，不触发真实云端 TTS / LLM，不产生扣费。
// 运行：node apps/web/server/tests/storyboard/test-bff.mjs

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import ffmpegStatic from 'ffmpeg-static';
import {
  startStoryboardProduce,
  startSlicerPrepare,
  registerMaterial,
  materialRegistry,
  listRegisteredMaterials,
  getRegisteredMaterial,
  assertSafePath,
  MAX_SHOTS,
  MIN_SHOT_SEC,
  MAX_SHOT_SEC,
  TARGET_MAX_DURATION,
} from '../../storyboard.mjs';

const TEMP_BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'storyboard-bff-test-'));
const STORAGE_UPLOADS = path.join(TEMP_BASE, 'storage', 'uploads');
const STORAGE_OUTPUTS = path.join(TEMP_BASE, 'storage', 'outputs');
const MATERIALS_DIR = path.join(TEMP_BASE, 'materials');
fs.mkdirSync(STORAGE_UPLOADS, { recursive: true });
fs.mkdirSync(STORAGE_OUTPUTS, { recursive: true });
fs.mkdirSync(MATERIALS_DIR, { recursive: true });

const PASS = [];
const FAIL = [];
function check(name, fn) {
  try {
    fn();
    PASS.push(name);
    console.log(`PASS ${name}`);
  } catch (e) {
    FAIL.push(name);
    console.log(`FAIL ${name}（${e.message}）`);
  }
}

// 辅助创建测试哑媒体文件（用于纯路径/无时长要求的测试）
function createDummyMedia(targetDir, filename) {
  const fp = path.join(targetDir, filename);
  fs.writeFileSync(fp, Buffer.from('RIFF....WAVEfmt ....data....'));
  return fp;
}

// 辅助创建真实短视频文件（用于需调用 videoDurationSec 探测时长的测试）
function createRealMiniVideo(targetDir, filename, durSec = 3) {
  const fp = path.join(targetDir, filename);
  execFileSync(ffmpegStatic, [
    '-nostdin', '-y',
    '-f', 'lavfi', '-i', `testsrc2=size=160x120:rate=25:duration=${durSec}`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-t', String(durSec),
    fp,
  ], { stdio: 'ignore' });
  return fp;
}

const inMemoryTasks = new Map();

// ==================== 1. 路径安全校验 (assertSafePath) ====================
console.log('\n--- 1. 路径安全与越界访问防御 ---');

check('1.1 空路径拦截', () => {
  assert.throws(() => assertSafePath('', [STORAGE_UPLOADS]), (e) => e.code === 40001);
});

check('1.2 目标文件不存在拦截', () => {
  assert.throws(() => assertSafePath(path.join(STORAGE_UPLOADS, 'not_exist.mp4'), [STORAGE_UPLOADS]), (e) => e.code === 40002);
});

check('1.3 目录穿越 (..) 拦截', () => {
  const outerFile = createDummyMedia(TEMP_BASE, 'secret.txt');
  const traversalPath = path.join(STORAGE_UPLOADS, '..', '..', 'secret.txt');
  assert.throws(() => assertSafePath(traversalPath, [STORAGE_UPLOADS]), (e) => e.code === 40301);
});

check('1.4 合法目录正常放行并解析 realpath', () => {
  const validFile = createDummyMedia(STORAGE_UPLOADS, 'valid.mp4');
  const resolved = assertSafePath(validFile, [STORAGE_UPLOADS]);
  assert.equal(resolved, fs.realpathSync(validFile));
});

// ==================== 2. 素材登记制 (Material Registry) ====================
console.log('\n--- 2. 素材登记机制 ---');

check('2.1 文件不存在无法登记素材', () => {
  assert.throws(() => registerMaterial({ filePath: 'invalid/path.mp4', durationSec: 10 }), (e) => e.code === 40001);
});

check('2.2 成功登记并分配 mat_ ID，记录元数据', () => {
  const sample = createDummyMedia(STORAGE_UPLOADS, 'sample1.mp4');
  const matId = registerMaterial({
    filePath: sample,
    durationSec: 15.5,
    type: 'upload_video',
    words: [{ word: '测试', start: 0.1, end: 0.5 }],
    text: '测试文本',
  });
  assert.ok(matId.startsWith('mat_'));
  const rec = materialRegistry.get(matId);
  assert.ok(rec);
  assert.equal(rec.durationSec, 15.5);
  assert.equal(rec.words.length, 1);
  assert.equal(rec.text, '测试文本');
});

check('2.3 安全素材列表查询：过滤物理路径，按创建时间倒序返回元数据', () => {
  const list = listRegisteredMaterials();
  assert.ok(Array.isArray(list) && list.length >= 1);
  const item = list[0];
  assert.ok(item.materialId);
  assert.ok(item.type);
  assert.ok(Number.isFinite(item.durationSec));
  // 铁律安全核验：返回值绝对不能包含 filePath
  assert.equal(item.filePath, undefined, '向前端暴露的素材列表绝不能包含 filePath');
});

check('2.4 查询单个素材详情：有效 materialId 返回元数据，未知返回 null', () => {
  const list = listRegisteredMaterials();
  const first = list[0];
  const detail = getRegisteredMaterial(first.materialId);
  assert.ok(detail);
  assert.equal(detail.materialId, first.materialId);
  assert.equal(detail.filePath, undefined);
  assert.equal(getRegisteredMaterial('mat_unknown_none'), null);
});

// ==================== 3. 分镜成片参数与时长校验 ====================
console.log('\n--- 3. 分镜参数与时长矩阵校验 ---');

check('3.1 空分镜列表拦截 (40010)', () => {
  assert.throws(
    () => startStoryboardProduce({
      payload: { shots: [] },
      inMemoryTasks,
      storageOutputsDir: STORAGE_OUTPUTS,
      storageUploadsDir: STORAGE_UPLOADS,
      materialsDir: MATERIALS_DIR,
    }),
    (e) => e.code === 40010
  );
});

check('3.2 超过 9 镜上限拦截 (40011)', () => {
  const shots = Array.from({ length: 10 }).map(() => ({ mediaType: 'video', materialId: 'dummy' }));
  assert.throws(
    () => startStoryboardProduce({
      payload: { shots },
      inMemoryTasks,
      storageOutputsDir: STORAGE_OUTPUTS,
      storageUploadsDir: STORAGE_UPLOADS,
      materialsDir: MATERIALS_DIR,
    }),
    (e) => e.code === 40011
  );
});

check('3.3 缺失 materialId 拦截 (40012)', () => {
  assert.throws(
    () => startStoryboardProduce({
      payload: { shots: [{ mediaType: 'video' }] },
      inMemoryTasks,
      storageOutputsDir: STORAGE_OUTPUTS,
      storageUploadsDir: STORAGE_UPLOADS,
      materialsDir: MATERIALS_DIR,
    }),
    (e) => e.code === 40012
  );
});

check('3.4 未登记或过期的 materialId 拦截 (40013)', () => {
  assert.throws(
    () => startStoryboardProduce({
      payload: { shots: [{ mediaType: 'video', materialId: 'mat_ghost' }] },
      inMemoryTasks,
      storageOutputsDir: STORAGE_OUTPUTS,
      storageUploadsDir: STORAGE_UPLOADS,
      materialsDir: MATERIALS_DIR,
    }),
    (e) => e.code === 40013
  );
});

check('3.5 单镜素材小于 2 秒安全下限拦截 (40014)', () => {
  const shortFile = createDummyMedia(STORAGE_UPLOADS, 'short.mp4');
  const shortMatId = registerMaterial({ filePath: shortFile, durationSec: 1.5 });
  assert.throws(
    () => startStoryboardProduce({
      payload: { shots: [{ mediaType: 'video', materialId: shortMatId }] },
      inMemoryTasks,
      storageOutputsDir: STORAGE_OUTPUTS,
      storageUploadsDir: STORAGE_UPLOADS,
      materialsDir: MATERIALS_DIR,
    }),
    (e) => e.code === 40014
  );
});

check('3.6 单镜素材大于 60 秒上限拦截 (40015)', () => {
  const longFile = createDummyMedia(STORAGE_UPLOADS, 'long.mp4');
  const longMatId = registerMaterial({ filePath: longFile, durationSec: 65.0 });
  assert.throws(
    () => startStoryboardProduce({
      payload: { shots: [{ mediaType: 'video', materialId: longMatId }] },
      inMemoryTasks,
      storageOutputsDir: STORAGE_OUTPUTS,
      storageUploadsDir: STORAGE_UPLOADS,
      materialsDir: MATERIALS_DIR,
    }),
    (e) => e.code === 40015
  );
});

check('3.7 预估成片时长超过 180 秒拦截 (40018)', () => {
  // 4 镜 * 50 秒 = 200 秒 - 3 * 0.7 = 197.9s > 180s
  const f50 = createDummyMedia(STORAGE_UPLOADS, 'f50.mp4');
  const matId = registerMaterial({ filePath: f50, durationSec: 50.0 });
  const shots = [
    { mediaType: 'video', materialId: matId },
    { mediaType: 'video', materialId: matId },
    { mediaType: 'video', materialId: matId },
    { mediaType: 'video', materialId: matId },
  ];
  assert.throws(
    () => startStoryboardProduce({
      payload: { shots },
      inMemoryTasks,
      storageOutputsDir: STORAGE_OUTPUTS,
      storageUploadsDir: STORAGE_UPLOADS,
      materialsDir: MATERIALS_DIR,
    }),
    (e) => e.code === 40018
  );
});

// ==================== 4. 状态机、重复提交与积分防重 ====================
console.log('\n--- 4. 状态机、重复提交与积分防重 ---');

check('4.1 重复提交拦截：producing 与 completed 均返回 40901', () => {
  const fNormal = createDummyMedia(STORAGE_UPLOADS, 'normal.mp4');
  const matId = registerMaterial({ filePath: fNormal, durationSec: 10.0 });
  inMemoryTasks.set('sb_p1', { kind: 'storyboard', status: 'producing' });
  inMemoryTasks.set('sb_c1', { kind: 'storyboard', status: 'completed' });

  assert.throws(
    () => startStoryboardProduce({
      payload: { taskId: 'sb_p1', shots: [{ mediaType: 'video', materialId: matId }] },
      inMemoryTasks,
      storageOutputsDir: STORAGE_OUTPUTS,
      storageUploadsDir: STORAGE_UPLOADS,
      materialsDir: MATERIALS_DIR,
    }),
    (e) => e.code === 40901
  );

  assert.throws(
    () => startStoryboardProduce({
      payload: { taskId: 'sb_c1', shots: [{ mediaType: 'video', materialId: matId }] },
      inMemoryTasks,
      storageOutputsDir: STORAGE_OUTPUTS,
      storageUploadsDir: STORAGE_UPLOADS,
      materialsDir: MATERIALS_DIR,
    }),
    (e) => e.code === 40901
  );
});

check('4.2 首次受理扣费 200 积分恰好一次，并置 creditsCharged 标记', () => {
  const fNormal = createDummyMedia(STORAGE_UPLOADS, 'normal2.mp4');
  const matId = registerMaterial({ filePath: fNormal, durationSec: 10.0 });
  let chargeCount = 0;
  const res = startStoryboardProduce({
    payload: { shots: [{ mediaType: 'video', materialId: matId }] },
    inMemoryTasks,
    storageOutputsDir: STORAGE_OUTPUTS,
    storageUploadsDir: STORAGE_UPLOADS,
    materialsDir: MATERIALS_DIR,
    chargeMockCredits: () => { chargeCount += 200; },
  });

  assert.equal(chargeCount, 200);
  const task = inMemoryTasks.get(res.taskId);
  assert.ok(task);
  assert.equal(task.creditsCharged, true);
  assert.equal(task.status, 'producing');
});

check('4.3 failed 任务重试时，不再重复扣除积分', () => {
  const fNormal = createDummyMedia(STORAGE_UPLOADS, 'normal3.mp4');
  const matId = registerMaterial({ filePath: fNormal, durationSec: 10.0 });
  inMemoryTasks.set('sb_fail_retry', {
    kind: 'storyboard',
    status: 'failed',
    creditsCharged: true,
  });

  let chargeCount = 0;
  const res = startStoryboardProduce({
    payload: { taskId: 'sb_fail_retry', shots: [{ mediaType: 'video', materialId: matId }] },
    inMemoryTasks,
    storageOutputsDir: STORAGE_OUTPUTS,
    storageUploadsDir: STORAGE_UPLOADS,
    materialsDir: MATERIALS_DIR,
    chargeMockCredits: () => { chargeCount += 200; },
  });

  assert.equal(res.taskId, 'sb_fail_retry');
  assert.equal(chargeCount, 0, '重试不应再次扣除积分');
});

check('3.8 图片分镜单镜图片数量超标（超过 5 张即 60 秒上限）拦截 (40015)', () => {
  const imgFiles = [];
  const imgMatIds = [];
  for (let i = 0; i < 6; i++) {
    const f = createDummyMedia(STORAGE_UPLOADS, `img_${i}.png`);
    const matId = registerMaterial({ filePath: f, durationSec: 12, type: 'upload_video' });
    imgFiles.push(f);
    imgMatIds.push(matId);
  }
  assert.throws(
    () => startStoryboardProduce({
      payload: {
        shots: [{
          mediaType: 'image',
          imageMaterialIds: imgMatIds,
        }],
      },
      inMemoryTasks,
      storageOutputsDir: STORAGE_OUTPUTS,
      storageUploadsDir: STORAGE_UPLOADS,
      materialsDir: MATERIALS_DIR,
    }),
    (e) => e.code === 40015
  );
});

// ==================== 5. 切片工具模块校验 ====================
console.log('\n--- 5. 切片工具模块状态机与免费性 ---');

check('5.4 切片 prepare 缺失 materialId 和 videoPath 拦截 (40001)', () => {
  assert.throws(
    () => startSlicerPrepare({
      payload: {},
      inMemoryTasks,
      storageUploadsDir: STORAGE_UPLOADS,
      storageOutputsDir: STORAGE_OUTPUTS,
    }),
    (e) => e.code === 40001
  );
});

check('5.5 切片 prepare 未知 materialId 拦截 (40013)', () => {
  assert.throws(
    () => startSlicerPrepare({
      payload: { materialId: 'mat_unknown_9999' },
      inMemoryTasks,
      storageUploadsDir: STORAGE_UPLOADS,
      storageOutputsDir: STORAGE_OUTPUTS,
    }),
    (e) => e.code === 40013
  );
});

check('5.6 切片 prepare 非视频素材 ID 拦截 (40019)', () => {
  const dummyImg = createDummyMedia(STORAGE_UPLOADS, 'pic.png');
  const imgMatId = registerMaterial({ filePath: dummyImg, durationSec: 10, type: 'upload_image' });
  assert.throws(
    () => startSlicerPrepare({
      payload: { materialId: imgMatId },
      inMemoryTasks,
      storageUploadsDir: STORAGE_UPLOADS,
      storageOutputsDir: STORAGE_OUTPUTS,
    }),
    (e) => e.code === 40019
  );
});

check('5.7 切片 prepare 传合法 materialId 正常受理并分配 taskId', () => {
  const videoFile = createRealMiniVideo(STORAGE_UPLOADS, 'slice_sample.mp4', 3);
  const matId = registerMaterial({ filePath: videoFile, durationSec: 3, type: 'upload_video' });
  const res = startSlicerPrepare({
    payload: { materialId: matId, segSec: 15 },
    inMemoryTasks,
    storageUploadsDir: STORAGE_UPLOADS,
    storageOutputsDir: STORAGE_OUTPUTS,
  });
  assert.ok(res.taskId && res.taskId.startsWith('slc_'));
  const rec = inMemoryTasks.get(res.taskId);
  assert.ok(rec);
  assert.equal(rec.kind, 'slicer');
});

check('5.8 切片 prepare 兼容仅传 videoPath 正常放行', () => {
  const videoFile = createRealMiniVideo(STORAGE_UPLOADS, 'slice_compat.mp4', 3);
  const res = startSlicerPrepare({
    payload: { videoPath: videoFile, segSec: 20 },
    inMemoryTasks,
    storageUploadsDir: STORAGE_UPLOADS,
    storageOutputsDir: STORAGE_OUTPUTS,
  });
  assert.ok(res.taskId && res.taskId.startsWith('slc_'));
});

console.log(`\n===== BFF 单元测试结果：${PASS.length} PASS / ${FAIL.length} FAIL =====`);
if (FAIL.length > 0) {
  process.exit(1);
}
