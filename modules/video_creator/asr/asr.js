// 简兮合成引擎 · asr.js —— 本地 whisper.cpp 语音识别（原声口播链路）
// ASR 全程本地推理（whisper.cpp，0 成本），音频不出服务器；
// 整条链路只有最后「生成剧本」那一次会调大模型（文本 LLM）。
// 调用链路：输入音频 → ffmpeg-static 转 16k 单声道 wav → whisper-cli（--output-json-full 词级时间戳）
//           → 读取 json 解析 文字 + 词级时间戳。

import { execFile, execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ffmpegStatic from 'ffmpeg-static';
import { Converter } from 'opencc-js/t2cn';
import { isFillerWord } from './trim.js';
import { acquireComposeSlot } from '@jansee/ffmpeg-kit/composeGate.mjs';

// whisper 对中文常输出繁体，这里统一转成简体（供核对弹窗 / 字幕 / 台词使用）
const toSimplified = Converter({ from: 'tw', to: 'cn' });

const COMPOSER_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(COMPOSER_DIR, '..', '..', '..'); // composer → engine → apps → 仓库根
const WHISPER_DIR = path.join(REPO_ROOT, 'whisper.cpp');
// 平台差异：Windows 为 whisper-cli.exe，Linux/macOS 为 whisper-cli（需自行编译）。
// 可用 JX_WHISPER_CLI / JX_WHISPER_MODEL 显式覆盖（容器或独立部署盘上很常见）。
const WHISPER_BIN_NAME = process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli';
const WHISPER_CLI = process.env.JX_WHISPER_CLI || path.join(WHISPER_DIR, 'bin', WHISPER_BIN_NAME);
const WHISPER_MODEL = process.env.JX_WHISPER_MODEL || path.join(WHISPER_DIR, 'models', 'ggml-small.bin');

const WHISPER_THREADS = 2; // 4 核服务器两路并行时每路 2 线程，避免 Whisper 总线程数翻倍过载

// whisper 特殊 token（_[_BEG_] / [_TT_xxx] 等）与纯标点，不计入台词
const PUNCT_RE = /^[，。？！、,.!?…\s'"“”‘’：:；;（）()\-—~]+$/;
function isNoiseToken(text) {
  if (!text) return true;
  if (/^\[.*\]$/.test(text)) return true; // 特殊 token
  if (PUNCT_RE.test(text)) return true; // 纯标点
  return false;
}

// 新版 whisper.cpp（v1.6+）JSON 输出：transcription[]，词级时间戳在 tokens[].offsets（毫秒）
// 从 tokens 提取规范词条 → { word, start, end }（秒）
function normalizeWords(transcription) {
  const words = [];
  for (const seg of transcription || []) {
    for (const t of seg.tokens || []) {
      const text = String(t.text || '').trim();
      if (isNoiseToken(text)) continue;
      const from = Number(t.offsets && t.offsets.from);
      const to = Number(t.offsets && t.offsets.to);
      if (!Number.isFinite(from) || !Number.isFinite(to)) continue;
      const start = from / 1000;
      let end = to / 1000;
      if (end <= start) end = start + 0.06; // token 时间戳为瞬时点时给最小宽度
      words.push({ word: toSimplified(text), start, end, is_filler: isFillerWord(text) });
    }
  }
  return words.sort((a, b) => a.start - b.start);
}

// 用 ffmpeg 把任意音频（webm/mp3/m4a/wav...）转成 whisper 需要的 16k 单声道 wav
export async function toWhisperWav(inputPath, outWav) {
  await new Promise((resolve, reject) => {
    execFile(
      ffmpegStatic,
      ['-y', '-i', inputPath, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', outWav],
      { maxBuffer: 50 * 1024 * 1024 },
      (err, _stdout, stderr) => {
        if (err)
          reject(
            new Error(
              '转码 wav 失败: ' +
                String(stderr || '')
                  .split('\n')
                  .slice(-3)
                  .join(' '),
            ),
          );
        else resolve();
      },
    );
  });
}

/**
 * 本地 whisper.cpp 识别
 * @param {string} audioPath 输入音频绝对路径
 * @param {string} workDir   输出目录（asr.json / asr.wav 放这里）
 * @returns {Promise<{text:string, words:Array<{word,start,end}>, segments:Array<{start,end,text}>, duration:number}>}
 */
async function runASRUnlocked(audioPath, workDir) {
  if (!audioPath) throw new Error('缺少音频文件路径');
  // 1. 二进制 / 模型自检（缺失给出明确指引，避免 FFmpeg 报错难排查）
  let cliOk = false;
  try {
    await fs.access(WHISPER_CLI);
    cliOk = true;
  } catch (e) {
    /* 下落 */
  }
  if (!cliOk) {
    throw new Error(
      `whisper-cli 未找到（${WHISPER_CLI}）。请先部署 whisper.cpp 预编译二进制：\n` +
        `1) Windows 下载 whisper-bin-x64.zip 解压出 bin/whisper-cli.exe；Linux 自行编译 whisper.cpp 得到 whisper-cli\n` +
        `2) 放入 whisper.cpp/bin/，或用环境变量 JX_WHISPER_CLI 指定绝对路径`,
    );
  }
  let modelOk = false;
  try {
    await fs.access(WHISPER_MODEL);
    modelOk = true;
  } catch (e) {
    /* 下落 */
  }
  if (!modelOk) {
    throw new Error(`whisper 模型未找到（${WHISPER_MODEL}）。请下载 ggml-small.bin 放入 whisper.cpp/models/`);
  }

  await fs.mkdir(workDir, { recursive: true });
  // 2. 转 wav（统一格式，兼容浏览器 webm/m4a 等）
  const wavPath = path.join(workDir, 'asr.wav');
  await toWhisperWav(audioPath, wavPath);

  // 3. 调 whisper-cli，输出 json（含词级时间戳）
  const outBase = path.join(workDir, 'asr');
  const args = [
    '-m',
    WHISPER_MODEL,
    '-f',
    wavPath,
    '-l',
    'zh',
    '-t',
    String(WHISPER_THREADS),
    '--split-on-word',
    '--output-json-full',
    '--output-txt',
    '-of',
    outBase,
    '--max-len',
    '30',
  ];
  await new Promise((resolve, reject) => {
    execFile(WHISPER_CLI, args, { maxBuffer: 50 * 1024 * 1024 }, (err, _stdout, stderr) => {
      if (err) {
        const tail = String(stderr || '')
          .split('\n')
          .slice(-6)
          .join(' ')
          .trim();
        reject(new Error('whisper 识别失败: ' + (tail || err.message)));
      } else {
        resolve();
      }
    });
  });

  // 4. 解析 json（新版结构：transcription[]，tokens 含词级时间戳）
  const jsonPath = `${outBase}.json`;
  let data;
  try {
    data = JSON.parse(await fs.readFile(jsonPath, 'utf8'));
  } catch (e) {
    throw new Error('whisper 输出 json 读取失败: ' + e.message);
  }
  const transcription = (data && data.transcription) || [];
  const words = normalizeWords(transcription);
  // 读取 txt（相对拼接更贴近 CLI 展示）；whisper 输出繁体，统一转简体
  let text = '';
  try {
    text = toSimplified((await fs.readFile(`${outBase}.txt`, 'utf8')).trim());
  } catch (e) {
    /* 忽略 */
  }
  if (!text) {
    text = toSimplified(
      transcription
        .map((s) => String(s.text || ''))
        .join('')
        .trim(),
    );
  }
  // 转录分段（whisper 自带分段，含时间戳）
  const segments = transcription
    .map((s) => ({
      start: Number(s.offsets && s.offsets.from) / 1000,
      end: Number(s.offsets && s.offsets.to) / 1000,
      text: toSimplified(String(s.text || '').trim()),
    }))
    .filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.text);

  let duration = segments.length ? segments[segments.length - 1].end : 0;
  if (words.length) duration = Math.max(duration, words[words.length - 1].end);
  if (!duration && transcription.length) duration = Number(transcription[transcription.length - 1].offsets.to) / 1000;

  return {
    text,
    words,
    segments,
    duration,
    model: WHISPER_MODEL,
  };
}

/** 本地 ASR 与 FFmpeg 抽音频统一占用全局重型处理名额。 */
export async function runASR(audioPath, workDir) {
  const workPath = String(workDir || '');
  const taskPart = workPath
    ? path.relative(REPO_ROOT, workPath).replace(/[\\/]+/g, '_')
    : path.basename(String(audioPath || 'asr'));
  const release = await acquireComposeSlot(`asr:${taskPart}`);
  try {
    return await runASRUnlocked(audioPath, workDir);
  } finally {
    release();
  }
}

export { WHISPER_CLI, WHISPER_MODEL };
