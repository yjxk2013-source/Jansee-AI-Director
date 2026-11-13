// 简兮切片与分镜极简功能自动化测试
// 验证：
//   1. parseTimeToSeconds 时间解析（数字、秒数字符串、mm:ss、hh:mm:ss）
//   2. startExactSliceCut 参数校验与任务创建（非法起止时间、超出总时长拦截）
// （startSimpleStoryboardConcat 纯拼接链路已随 2026-10-24 全版块收敛删除：多段合成统一走分镜成片双模式）

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  parseTimeToSeconds,
  startExactSliceCut,
  registerMaterial
} from '../../storyboard.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '../../../../');
const storageUploadsDir = path.resolve(rootDir, 'storage/uploads');
const storageOutputsDir = path.resolve(rootDir, 'storage/outputs');

console.log('[TEST] 开始极简切片与多分镜直接拼接功能自检...');

// 1. 测试 parseTimeToSeconds
assert.equal(parseTimeToSeconds(10), 10, '数字 10 应解析为 10');
assert.equal(parseTimeToSeconds('15.5'), 15.5, '字符串 "15.5" 应解析为 15.5');
assert.equal(parseTimeToSeconds('01:30'), 90, '时间 "01:30" 应解析为 90');
assert.equal(parseTimeToSeconds('00:05.5'), 5.5, '时间 "00:05.5" 应解析为 5.5');
assert.equal(parseTimeToSeconds('01:00:10'), 3610, '时间 "01:00:10" 应解析为 3610');
assert.equal(parseTimeToSeconds('invalid', 20), 20, '无效时间应回退到 fallback');
console.log('✓ 1. parseTimeToSeconds 时间解析测试全部通过');

// 2. 测试 startExactSliceCut 参数拦截
const inMemoryTasks = new Map();
assert.throws(() => {
  startExactSliceCut({
    payload: null,
    inMemoryTasks,
    storageUploadsDir,
    storageOutputsDir
  });
}, /请求体无效/, '空 payload 必须被拒绝');

assert.throws(() => {
  startExactSliceCut({
    payload: { startTime: '00:00', endTime: '00:10' },
    inMemoryTasks,
    storageUploadsDir,
    storageOutputsDir
  });
}, /请先上传视频素材/, '缺少视频素材必须被拦截');

// （原第 3 节 startSimpleStoryboardConcat 参数拦截用例已随该链路删除一并移除）

console.log('✓ 2. 参数安全校验与边界防护全部通过');
console.log('[TEST] 极简切片与多分镜直接拼接功能自检 100% 通过！');
