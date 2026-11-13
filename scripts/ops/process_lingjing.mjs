import fs from 'fs';
import path from 'path';
import { execSync, execFileSync } from 'child_process';
import '../../apps/web/server/env.mjs';
import { synthViaNode, audioDurationSec } from '../../packages/tts-kit/index.js';

const FFMPEG = 'F:\\janseeV2\\node_modules\\ffmpeg-static\\ffmpeg.exe';
const WORK_DIR = 'F:\\Jansee-COO';

async function main() {
  console.log('=== [1/5] 定位目标视频并探测参数 ===');
  const files = fs.readdirSync(WORK_DIR);
  const targetFile = files.find(f => f.includes('06d907b8'));
  if (!targetFile) {
    throw new Error('未找到包含 06d907b8 的目标视频文件');
  }
  const inputVideoPath = path.join(WORK_DIR, targetFile);
  console.log(`目标视频: ${inputVideoPath}`);

  let probeOut = '';
  try {
    probeOut = execFileSync(FFMPEG, ['-i', inputVideoPath], { encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (e) {
    probeOut = e?.stderr || probeOut;
  }
  const durMatch = probeOut.match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/);
  let videoDur = 7.85;
  if (durMatch) {
    videoDur = parseInt(durMatch[1], 10) * 3600 + parseInt(durMatch[2], 10) * 60 + parseFloat(durMatch[3]);
  }
  console.log(`视频时长: ${videoDur.toFixed(2)}s`);

  console.log('\n=== [2/5] 合成快手「AI灵境计划」旁白语音 ===');
  // 设计 8 秒内的黄金台词 (总长约 4.8 秒)
  // 0.8s 开始出声，约 5.5s 结束，后留 2 秒纯视效与品牌收束
  const ttsText = '用代码把星光织成华服。在灵境里，随手拍都是大片。简兮。';
  const ttsPath = path.join(WORK_DIR, 'lingjing_tts.mp3');
  
  // 采用温和清澈的女性音色
  const ok = await synthViaNode(ttsText, 'f-warm', 'f-warm', ttsPath, 1.05);
  if (!ok || !fs.existsSync(ttsPath) || fs.statSync(ttsPath).size === 0) {
    throw new Error('TTS 合成失败');
  }
  const ttsDur = audioDurationSec(ttsPath);
  console.log(`旁白语音时长: ${ttsDur.toFixed(2)}s`);

  console.log('\n=== [3/5] 构建专业微距 ASS 字幕 ===');
  // 0 Emoji, 4级亮度规范, 底部240px避让
  const assHeader = `[Script Info]
Title: Jansee Lingjing Plan
ScriptType: v4.00+
WrapStyle: 0
ScaledBorderAndShadow: yes
YCbCr Matrix: TV.709
PlayResX: 1080
PlayResY: 1920

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: JanseeSub,Microsoft YaHei,54,&H00FFFFFF,&H000000FF,&H30000000,&H60000000,-1,0,0,0,100,100,2,0,1,3,0,2,80,80,260,1
Style: JanseeTag,Microsoft YaHei,32,&H40FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,1,0,1,0,0,9,60,60,60,1
Style: JanseeTopic,Microsoft YaHei,36,&H20D0E0FF,&H000000FF,&H00000000,&H60000000,0,0,0,0,100,100,2,0,1,0,0,7,60,60,60,1
Style: JanseeBrand,Microsoft YaHei,46,&H00FFFFFF,&H000000FF,&H00000000,&H60000000,-1,0,0,0,100,100,5,0,1,0,0,2,80,80,480,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Comment: 右上角合规角标 + 左上角话题标
Dialogue: 0,0:00:00.00,0:00:${videoDur.toFixed(2)},JanseeTag,,0,0,0,,AI 生成 · 简兮 JANSEE
Dialogue: 0,0:00:00.00,0:00:${videoDur.toFixed(2)},JanseeTopic,,0,0,0,,# AI 灵境计划
`;

  function toAssTime(sec) {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    const hStr = String(h);
    const mStr = String(m).padStart(2, '0');
    const sStr = s.toFixed(2).padStart(5, '0');
    return `${hStr}:${mStr}:${sStr}`;
  }

  // 语音分两句展示
  // 第1句：用代码把星光织成华服 (0.8s ~ 3.2s)
  // 第2句：在灵境里，随手拍都是大片 (3.2s ~ 5.8s)
  let assEvents = '';
  const startSec = 0.8;
  const p1End = startSec + ttsDur * 0.44;
  const p2End = startSec + ttsDur * 0.9;
  
  assEvents += `Dialogue: 1,${toAssTime(startSec)},${toAssTime(p1End)},JanseeSub,,0,0,0,,用代码把星光织成华服\n`;
  assEvents += `Dialogue: 1,${toAssTime(p1End)},${toAssTime(p2End)},JanseeSub,,0,0,0,,在灵境里 · 随手拍都是大片\n`;

  // 结尾品牌收束卡 (6.2s ~ 视频结束)
  assEvents += `Dialogue: 2,${toAssTime(6.2)},0:00:${videoDur.toFixed(2)},JanseeBrand,,0,0,0,,简 兮  J A N S E E\\N{\\fs28\\c&HCCCCCC&\\b0}全栈短视频重构工场 · 一秒入灵境\n`;

  const assContent = assHeader + assEvents;
  const assPath = path.join(WORK_DIR, 'lingjing_subtitles.ass');
  fs.writeFileSync(assPath, assContent, 'utf8');
  console.log(`ASS 字幕生成完成: ${assPath}`);

  console.log('\n=== [4/5] 挑选灵动空灵 BGM ===');
  // 选用空灵梦幻曲目 dreamy_01.mp3
  const bgmPath = 'F:\\janseeV2\\materials\\audio\\dreamy\\dreamy_01.mp3';
  console.log(`BGM 选用: ${bgmPath}`);

  console.log('\n=== [5/5] FFmpeg 单遍全流线高保真合成 ===');
  const finalOutput = path.join(WORK_DIR, 'JANSEE_Lingjing_Plan_8s.mp4');
  const dStartMs = Math.round(startSec * 1000);
  const assEscaped = assPath.replace(/\\/g, '/').replace(/:/g, '\\:');

  const cmd = [
    `"${FFMPEG}" -y`,
    `-i "${inputVideoPath}"`,                     // [0:v] 原视频
    `-stream_loop -1 -i "${bgmPath}"`,            // [1:a] BGM
    `-i "${ttsPath}"`,                            // [2:a] 旁白
    `-filter_complex "`,
    `[0:v]fade=t=in:st=0:d=0.4,fade=t=out:st=${(videoDur - 0.5).toFixed(2)}:d=0.5,subtitles='${assEscaped}'[v];`,
    `[1:a]atrim=0:${videoDur.toFixed(2)},afade=t=in:st=0:d=0.8,afade=t=out:st=${(videoDur - 1.0).toFixed(2)}:d=1.0,volume=0.25[bgm];`,
    `[2:a]adelay=${dStartMs}|${dStartMs},volume=1.35[a_tts];`,
    `[bgm][a_tts]amix=inputs=2:duration=first:dropout_transition=2[a]`,
    `"`,
    `-map "[v]" -map "[a]"`,
    `-c:v libx264 -preset fast -crf 18 -pix_fmt yuv420p`,
    `-c:a aac -b:a 192k`,
    `-t ${videoDur.toFixed(2)}`,
    `"${finalOutput}"`
  ].join(' ');

  console.log('执行 FFmpeg 合成...');
  execSync(cmd, { stdio: 'inherit' });

  const finalDur = audioDurationSec(finalOutput);
  console.log(`\n=== 灵境计划视频渲染成功! ===`);
  console.log(`产物路径: ${finalOutput}`);
  console.log(`成片时长: ${finalDur.toFixed(2)}s`);
}

main().catch(err => {
  console.error('合成流程异常:', err);
  process.exit(1);
});

