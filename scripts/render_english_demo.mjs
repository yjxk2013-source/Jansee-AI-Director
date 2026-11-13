// 简兮 · 实测视频解说合成脚本（外贸英文出片演示 48s - 完美零重叠大厂定稿版）
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

const CLIPS = [
  'F:/janseeV2/COO/素材/切片/录屏-20261112-182943-0m04s-0m11s.mp4', // 7s (0~7s) 首页/线上商家
  'F:/janseeV2/COO/素材/切片/录屏-20261112-182943-0m14s-0m17s.mp4', // 3s (7~10s) 点击图片成片
  'F:/janseeV2/COO/素材/切片/录屏-20261112-182943-0m25s-0m38s.mp4', // 13s (10~23s) 放入8张睡衣照片
  'F:/janseeV2/COO/素材/切片/录屏-20261112-182943-1m31s-1m41s.mp4', // 10s (23~33s) 输入卖点并出片
  'F:/janseeV2/COO/素材/切片/录屏-20261112-182943-4m05s-4m20s.mp4', // 15s (33~48s) 交付大卡/全英文
];

const WORK_DIR = 'F:/janseeV2/storage/tmp/english_demo_work';
const OUT_VIDEO = 'F:/janseeV2/COO/素材/成片/简兮实测_外贸英文出片全流程演示.mp4';
const VOICE_KEY = 'm-calm'; // 腾讯云大模型磁性成熟男声 (401002)

await fs.mkdir(WORK_DIR, { recursive: true });
await fs.mkdir(path.dirname(OUT_VIDEO), { recursive: true });

// 解说台词规划（精确对齐 0~48s 画面动作，严防叠音与抢话）
// 阶段1：0~7s (7s) 首页 -> 0.5s ~ 6.3s
// 阶段2：7~10s (3s) 点击图片成片 -> 7.2s ~ 9.0s
// 阶段3：10~23s (13s) 上传8张实拍睡衣照片 -> 10.5s ~ 17.5s
// 阶段4：23~33s (10s) 输入卖点并出片 -> 23.5s ~ 31.8s
// 阶段5：33~48s (15s) 交付大卡，全英文描述与成片预览 -> 33.6s ~ 40.6s, 41.2s ~ 47.5s
const SCRIPT_SEGMENTS = [
  {
    id: 's01',
    startSec: 0.5,
    text: '实测外贸与TikTok商家，一键生成英文带货视频。首页进入线上商家。',
  },
  {
    id: 's02',
    startSec: 7.3,
    text: '接着点击进入图片成片。',
  },
  {
    id: 's03',
    startSec: 10.5,
    text: '这里最多支持九张图。直接放入拍好的八张居家睡衣照片，系统能智能解析构图。',
  },
  {
    id: 's04',
    startSec: 23.5,
    text: '在描述框输入：我家睡衣特惠九块九，我是TikTok商家，用英文出片。系统自动识别外贸意图。',
  },
  {
    id: 's05',
    startSec: 33.6,
    text: '极速出片！进入交付大卡。右侧可以预览全英文超自然配音的成片，还配套纯净封面。',
  },
  {
    id: 's06',
    startSec: 41.2,
    text: '左侧一键配套海外专属的英文文案、吸睛标题与置顶评论，出海带货直接发。',
  },
];

console.log('=== 第一步：生成大模型 TTS 配音 ===');
const audioSegments = [];
let hasOverlap = false;

for (let i = 0; i < SCRIPT_SEGMENTS.length; i++) {
  const seg = SCRIPT_SEGMENTS[i];
  const audioFile = path.join(WORK_DIR, `${seg.id}.mp3`);
  console.log(`正在合成 [${seg.id}] (${seg.startSec}s 开始): ${seg.text}`);
  const ok = await synthViaNode(seg.text, '', VOICE_KEY, audioFile, 1.08); // 略微提速至 1.08x 保持利落干练
  if (!ok) throw new Error(`TTS 合成失败: ${seg.id}`);
  const dur = audioDurationSec(audioFile);
  const actualEnd = seg.startSec + dur;
  console.log(`[${seg.id}] 时长: ${dur.toFixed(2)}s | 规划起止: ${seg.startSec}s -> ${actualEnd.toFixed(2)}s`);
  if (i > 0) {
    const prev = audioSegments[i - 1];
    const gap = seg.startSec - prev.endSec;
    if (gap < 0) {
      console.warn(`[严重警告] ${seg.id} 与 ${prev.id} 发生重叠！重叠时长: ${(-gap).toFixed(2)}s`);
      hasOverlap = true;
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

if (hasOverlap) {
  console.warn('❌ 仍有重叠，请立即修正时间戳！');
} else {
  console.log('\n🎉 所有台词起止完美避开重叠，呼吸气口极度舒适！');
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
  const end = formatAssTime(seg.endSec + 0.2); // 微延 0.2s 避免眨眼
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

console.log('\n=== 第四步：拼接视频并混音终审 ===');
const runFfmpeg = (args) =>
  new Promise((resolve, reject) => {
    execFile(ffmpegStatic, args, { maxBuffer: 200 * 1024 * 1024 }, (err, _o, stderr) => {
      if (err) reject(new Error(String(stderr || '').split('\n').slice(-10).join('\n')));
      else resolve();
    });
  });

// 1. 生成 5 个视频的 concat 清单
const concatListPath = path.join(WORK_DIR, 'concat_list.txt');
const concatContent = CLIPS.map(c => `file '${c.replace(/\\/g, '/')}'`).join('\n');
await fs.writeFile(concatListPath, concatContent, 'utf-8');

// 2. 先无损将 5 个相同规格的视频拼接为一个合并视频
const MERGED_VIDEO = path.join(WORK_DIR, 'merged_raw.mp4');
console.log('正在拼接 5 段录屏切片...');
await runFfmpeg([
  '-nostdin', '-y',
  '-f', 'concat',
  '-safe', '0',
  '-i', concatListPath,
  '-c', 'copy',
  MERGED_VIDEO
]);
console.log('切片拼接完毕:', MERGED_VIDEO);

// 3. 组装 FFmpeg 复合滤镜：字幕烧录 + 多段 TTS 延时混音 + BGM 避让
const ffmpegArgs = ['-nostdin', '-y'];

// 输入 0: 拼接好的视频 (48s)
ffmpegArgs.push('-i', MERGED_VIDEO);

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

const filterComplex = [];

// 视频滤镜：字幕烧录
const escapedAss = assFile.replace(/\\/g, '/').replace(/:/g, '\\:');
filterComplex.push(`[0:v]ass='${escapedAss}'[outv]`);

// 音频滤镜：adelay 对位与混音
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
  // BGM 降至 48s，音量 0.14，首尾淡入淡出
  filterComplex.push(`[${bgmIndex}:a]atrim=0:48,volume=0.14,afade=t=in:ss=0:d=1,afade=t=out:st=46:d=2[bgm_clean]`);
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
  '-t', '48',
  OUT_VIDEO
);

console.log('执行最终视频渲染 (字幕 + 人声 + BGM)...');
await runFfmpeg(ffmpegArgs);

const outStat = await fs.stat(OUT_VIDEO);
console.log(`\n🎉 英文带货实测演示视频渲染成功！`);
console.log(`成片输出路径: ${OUT_VIDEO}`);
console.log(`成片视频大小: ${(outStat.size / (1024 * 1024)).toFixed(2)} MB`);
