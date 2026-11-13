// 简兮 · 实测视频解说合成脚本（粤语方言出片演示 57s）
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import ffmpegStatic from 'ffmpeg-static';
import { synthViaNode, audioDurationSec } from '../packages/tts-kit/tts.js';
import { selectBgmByEmotion } from '../packages/audio-kit/bgm.js';
import { resolveObsidianFont } from '../packages/subtitle-kit/subtitle.js';

// 载入环境变量
const envText = await fs.readFile('f:/janseeV2/.env', 'utf-8');
for (const line of envText.split('\n')) {
  const m = line.match(/^([^=]+)=(.*)$/);
  if (m) process.env[m[1].trim()] = m[2].trim().replace(/^['"]|['"]$/g, '');
}

const SRC_VIDEO = 'F:/janseeV2/COO/素材/切片/合并-002250.mp4';
const WORK_DIR = 'F:/janseeV2/storage/tmp/cantonese_demo_work';
const OUT_VIDEO = 'F:/janseeV2/COO/素材/成片/简兮实测_粤语出片全流程演示.mp4';
const VOICE_KEY = 'm-calm'; // 腾讯云大模型磁性稳重男声 (401002)

await fs.mkdir(WORK_DIR, { recursive: true });
await fs.mkdir(path.dirname(OUT_VIDEO), { recursive: true });

// 解说台词规划（精确对齐 0~57s 画面动作，严防叠音与抢话）
const SCRIPT_SEGMENTS = [
  {
    id: 's01',
    startSec: 0.8,
    text: '以广东一家酒楼为例，带大家实测简兮的粤语方言出片。首先在首页，直接选择线下商家。',
  },
  {
    id: 's02',
    startSec: 10.8,
    text: '接着上传拍好的六张菜品图。在描述框里不用复杂设置，直接输入一句话：位于简兮路88号的简兮大酒楼，请帮我用粤语推广。',
  },
  {
    id: 's03',
    startSec: 23.8,
    text: '系统会自动识别粤语方言意图，调用超自然大模型来创作地道广府白话，点击立即出片。',
  },
  {
    id: 's04',
    startSec: 37.3,
    text: '后台极速生成，短短几秒就能搞定。',
  },
  {
    id: 's05',
    startSec: 41.5,
    text: '出片完成！进入商用交付大卡。右侧可以实时预览高清成片，还自动生成了纯净宣发封面。',
  },
  {
    id: 's06',
    startSec: 48.6,
    text: '左侧一键配套带货文案、吸睛标题、置顶评论与最佳发布时机，全套搞定。',
  },
];

console.log('=== 第一步：生成大模型 TTS 配音 ===');
const audioSegments = [];
for (let i = 0; i < SCRIPT_SEGMENTS.length; i++) {
  const seg = SCRIPT_SEGMENTS[i];
  const audioFile = path.join(WORK_DIR, `${seg.id}.mp3`);
  console.log(`正在合成 [${seg.id}] (${seg.startSec}s 开始): ${seg.text}`);
  const ok = await synthViaNode(seg.text, '', VOICE_KEY, audioFile, 1.0);
  if (!ok) throw new Error(`TTS 合成失败: ${seg.id}`);
  const dur = audioDurationSec(audioFile);
  const actualEnd = seg.startSec + dur;
  console.log(`[${seg.id}] 时长: ${dur.toFixed(2)}s | 规划起止: ${seg.startSec}s -> ${actualEnd.toFixed(2)}s`);
  if (i > 0) {
    const prev = audioSegments[i - 1];
    const gap = seg.startSec - prev.endSec;
    if (gap < 0) {
      console.warn(`[严重警告] ${seg.id} 与 ${prev.id} 发生重叠！重叠时长: ${(-gap).toFixed(2)}s`);
    } else {
      console.log(`  └ 与上一句间隔气口: ${gap.toFixed(2)}s (正常)`);
    }
  }
  audioSegments.push({
    ...seg,
    audioFile,
    dur,
    endSec: actualEnd,
  });
}

// 格式化为 ASS/SRT 时间格式: 0:00:00.00
function formatAssTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const cs = Math.floor((seconds % 1) * 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

console.log('\n=== 第二步：生成微距发丝字幕 ASS ===');
// 获取黑曜石发丝字体绝对路径
const fontPath = resolveObsidianFont('materials/fonts/noto-sans-sc/NotoSansSC_400Regular.ttf').replace(/\\:/g, ':');
console.log('字幕字体:', fontPath);

// 构造 1920x1080 横屏大厂级发丝字幕 ASS
const assLines = [
  '[Script Info]',
  'ScriptType: v4.00+',
  'PlayResX: 1920',
  'PlayResY: 1080',
  'WrapStyle: 0',
  'ScaledBorderAndShadow: yes',
  '',
  '[V4+ Styles]',
  'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
  // 黑曜石微距字幕：钛白纯净高光 &H00F8FAFC，1px 幽灵细描边 &H800A0A0E，半透明黑曜石底板 &H90050508，居中底部 MarginV=48
  'Style: ObsidianSub,Noto Sans SC,38,&H00F8FAFC,&H000000FF,&H800A0A0E,&H90050508,0,0,0,0,100,100,1,0,3,1.5,0,2,80,80,48,1',
  '',
  '[Events]',
  'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
];

for (const seg of audioSegments) {
  const start = formatAssTime(seg.startSec);
  const end = formatAssTime(seg.endSec + 0.3); // 微延 0.3s 避免字幕眨眼
  // 去除行尾标点
  const cleanText = seg.text.replace(/[。！!，,]$/, '');
  assLines.push(`Dialogue: 0,${start},${end},ObsidianSub,,0,0,0,,${cleanText}`);
}

const assFile = path.join(WORK_DIR, 'subtitles.ass');
await fs.writeFile(assFile, assLines.join('\n'), 'utf-8');
console.log('字幕文件已生成:', assFile);

console.log('\n=== 第三步：选配轻快科技环境 BGM ===');
const bgmInfo = await selectBgmByEmotion('fresh');
const bgmPath = bgmInfo?.bgmPath || '';
console.log('选用 BGM:', bgmPath ? `${bgmInfo.folder}/${bgmInfo.track}` : '无BGM');

console.log('\n=== 第四步：FFmpeg 单遍复合滤镜终混渲染 ===');
// 视频只取 0~57s: -ss 0 -t 57
// 音轨合成：通过 adelay 放置各个 TTS 片段并在 amix 混音
// 人声避让：TTS 人声音量为 1.25，BGM 音量常态 0.15，带 sidechain 人声避让降到 0.05
const runFfmpeg = (args) =>
  new Promise((resolve, reject) => {
    execFile(ffmpegStatic, args, { maxBuffer: 200 * 1024 * 1024 }, (err, _o, stderr) => {
      if (err) reject(new Error(String(stderr || '').split('\n').slice(-10).join('\n')));
      else resolve();
    });
  });

// 组装 FFmpeg 输入与复杂滤镜
const ffmpegArgs = ['-nostdin', '-y'];

// 输入 0: 原视频 (截取 0~57s)
ffmpegArgs.push('-ss', '0', '-t', '57', '-i', SRC_VIDEO);

// 输入 1~6: 6段 TTS 音频
for (const seg of audioSegments) {
  ffmpegArgs.push('-i', seg.audioFile);
}

// 输入 7: BGM
let bgmIndex = -1;
if (bgmPath && (await fs.stat(bgmPath).catch(() => null))) {
  ffmpegArgs.push('-stream_loop', '-1', '-i', bgmPath);
  bgmIndex = 7;
}

// 滤镜图构建
const filterComplex = [];

// 1. 视频滤镜：字幕烧录
// Windows 下 ass 滤镜路径必须转义反斜杠和冒号
const escapedAss = assFile.replace(/\\/g, '/').replace(/:/g, '\\:');
filterComplex.push(`[0:v]ass='${escapedAss}'[outv]`);

// 2. 音频滤镜：adelay 对位与混音
const delayedLabels = [];
for (let i = 0; i < audioSegments.length; i++) {
  const seg = audioSegments[i];
  const delayMs = Math.round(seg.startSec * 1000);
  const inputIdx = i + 1;
  filterComplex.push(`[${inputIdx}:a]adelay=${delayMs}|${delayMs},volume=1.25[a${i}]`);
  delayedLabels.push(`[a${i}]`);
}

// 混合所有人声
filterComplex.push(`${delayedLabels.join('')}amix=inputs=${delayedLabels.length}:dropout_transition=0:normalize=0[voice_all]`);

if (bgmIndex !== -1) {
  // BGM 降至 57s，音量 0.14，首尾微淡入淡出，并通过 sidechain 人声避让
  filterComplex.push(`[${bgmIndex}:a]atrim=0:57,volume=0.14,afade=t=in:ss=0:d=1,afade=t=out:st=55:d=2[bgm_clean]`);
  // 两路最终混合
  filterComplex.push(`[voice_all][bgm_clean]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[outa]`);
} else {
  filterComplex.push(`[voice_all]anull[outa]`);
}

ffmpegArgs.push(
  '-filter_complex', filterComplex.join(';'),
  '-map', '[outv]',
  '-map', '[outa]',
  '-c:v', 'libx264',
  '-preset', 'fast',
  '-crf', '19',
  '-pix_fmt', 'yuv420p',
  '-c:a', 'aac',
  '-b:a', '192k',
  '-t', '57',
  OUT_VIDEO
);

console.log('执行 FFmpeg 渲染中...');
await runFfmpeg(ffmpegArgs);

const outStat = await fs.stat(OUT_VIDEO);
console.log(`\n成片渲染成功！`);
console.log(`文件路径: ${OUT_VIDEO}`);
console.log(`文件大小: ${(outStat.size / (1024 * 1024)).toFixed(2)} MB`);
