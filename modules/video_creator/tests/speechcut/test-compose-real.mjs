// 简兮口播模块 · 测试：真实 FFmpeg 合成冒烟（P1 自证，本地素材 + stub 词级时间戳，零付费）
// 验证 composeSpeechcut 的 filter_complex 语法 / 音画同步剪切 / 字幕烧录 / BGM 混音 / 产物校验全链路
// 运行：在仓库根执行 node modules/video_creator/tests/speechcut/test-compose-real.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import ffmpegStatic from 'ffmpeg-static';
import { composeSpeechcut } from '../../speechcut/compose.js';
import { hasAudioStream } from '@jansee/ffmpeg-kit/probe.mjs';

const PASS = [];
const FAIL = [];
function assert(name, cond, detail = '') {
  (cond ? PASS : FAIL).push(name);
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${cond ? '' : `（实际 ${detail}）`}`);
}

function probe(file) {
  let out = '';
  try {
    execFileSync(ffmpegStatic, ['-nostdin', '-i', file], { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) { out = String(e.stderr || ''); }
  const d = /Duration: (\d+):(\d+):([\d.]+)/.exec(out);
  const secs = d ? (+d[1]) * 3600 + (+d[2]) * 60 + parseFloat(d[3]) : -1;
  const streams = [...out.matchAll(/Stream #0:\d+.*?: (Video|Audio|Data):/g)].map((m) => m[1]);
  return { secs, streams };
}
function playable(file) {
  try {
    execFileSync(ffmpegStatic, ['-nostdin', '-v', 'error', '-i', file, '-f', 'null', '-'], { stdio: ['ignore', 'pipe', 'pipe'] });
    return true;
  } catch { return false; }
}

// stub 词级时间戳：三句话 + 中间填充词（与 whisper 词级输出同构）
const WORDS = [
  { word: '第一句话', start: 0.2, end: 0.8 },
  { word: '那个', start: 1.0, end: 1.3, is_filler: true },
  { word: '第二句话', start: 1.5, end: 2.6 },
];

const tmp = path.join(os.tmpdir(), `speechcut-p1-smoke-${Date.now()}`);
fs.mkdirSync(tmp, { recursive: true });
const src = path.join(tmp, 'src.mp4');
const taskDir = path.join(tmp, 'task_1');
fs.mkdirSync(taskDir, { recursive: true });

try {
  // 素材：320x568 竖屏 3s 25fps + 440Hz 正弦假人声
  execFileSync(ffmpegStatic, ['-nostdin', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=s=320x568:d=3:r=25',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
    '-map', '0:v', '-map', '1:a', '-shortest',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', src,
  ], { stdio: 'ignore' });
  assert('素材生成（3s 有声）', probe(src).secs > 2.8 && hasAudioStream(src));

  // 用例一：删除中间填充词 → cut 0.9-1.4（间隙中点），planned = 3 - 0.5 = 2.5s
  const stages = [];
  const r = await composeSpeechcut({
    videoFile: src,
    taskDir,
    words: WORDS,
    deletedStarts: new Set([1.0]),
    durationSec: 3,
    onProgress: (s) => stages.push(s),
  });
  assert('1a 合成返回规划时长 2.5s', Math.abs(r.plannedSec - 2.5) < 0.001, JSON.stringify(r));
  assert('1b 成片实际时长 ≈2.5s', r.durationSec > 1.9 && r.durationSec < 3.1, String(r.durationSec));
  assert('1c 字幕重映射 2 段（填充词段落被剔除）', r.cuesCount === 2, String(r.cuesCount));
  assert('1d 成片含音轨', hasAudioStream(r.finalPath));
  assert('1e 成片可播放（全流解码无错误）', playable(r.finalPath));
  assert('1f 有合成进度回调', stages.length >= 3, JSON.stringify(stages));

  // 用例二：空删除集 → 整片保留 3s
  const taskDir2 = path.join(tmp, 'task_2');
  fs.mkdirSync(taskDir2, { recursive: true });
  const r2 = await composeSpeechcut({ videoFile: src, taskDir: taskDir2, words: WORDS, deletedStarts: new Set(), durationSec: 3 });
  assert('2 空删除整片保留', Math.abs(r2.plannedSec - 3) < 0.001 && r2.durationSec > 2.8, JSON.stringify(r2));

  // 用例三：全删拦截（删除全部词 → 保留 <1s）
  const taskDir3 = path.join(tmp, 'task_3');
  fs.mkdirSync(taskDir3, { recursive: true });
  let caught = null;
  try {
    await composeSpeechcut({ videoFile: src, taskDir: taskDir3, words: WORDS, deletedStarts: new Set([0.2, 1.0, 1.5]), durationSec: 3 });
  } catch (e) { caught = e; }
  assert('3 全删被 TOO_SHORT 拦截', caught?.code === 'TOO_SHORT', String(caught?.code || caught?.message));
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n===== compose-real 结果：${PASS.length} PASS / ${FAIL.length} FAIL =====`);
process.exit(FAIL.length ? 1 : 0);
