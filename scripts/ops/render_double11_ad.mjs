import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import '../../apps/web/server/env.mjs';
import { synthViaNode, audioDurationSec } from '../../packages/tts-kit/index.js';

const FFMPEG = 'F:\\janseeV2\\node_modules\\ffmpeg-static\\ffmpeg.exe';
const WORK_DIR = 'F:\\Jansee-COO';

async function main() {
  console.log('=== [1/4] 开始合成腾讯云 TTS 旁白语音 ===');

  const lines = [
    {
      id: 'shot1',
      text: '不管卖什么，手机随手拍几张，丢给简兮，10秒直出电影级带货视频。',
      startOffset: 0.5, // 视频第 0.5 秒开始说话
    },
    {
      id: 'shot2',
      text: '双十一限时大促，不要几百块，一块一毛一直接订阅Lite会员！抢完即止，简兮。',
      startOffset: 8.35, // 分镜2 (7.85s后衔接) + 0.5s
    }
  ];

  for (let i = 0; i < lines.length; i++) {
    const item = lines[i];
    const outPath = path.join(WORK_DIR, `${item.id}_tts.mp3`);
    console.log(`生成语音 [${item.id}]: ${item.text}`);
    const ok = await synthViaNode(item.text, 'f-warm', 'f-warm', outPath, 1.0);
    if (!ok || !fs.existsSync(outPath) || fs.statSync(outPath).size === 0) {
      throw new Error(`TTS 配音生成失败: ${item.text}`);
    }
    const dur = audioDurationSec(outPath);
    item.duration = dur;
    item.filePath = outPath;
    console.log(`语音 [${item.id}] 生成成功，时长: ${dur.toFixed(2)}s`);
  }

  console.log('\n=== [2/4] 生成专业微距 ASS 字幕 ===');
  const assHeader = `[Script Info]
Title: Jansee Double 11 Ad
ScriptType: v4.00+
WrapStyle: 0
ScaledBorderAndShadow: yes
YCbCr Matrix: TV.709
PlayResX: 1080
PlayResY: 1920

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: JanseeSub,Microsoft YaHei,54,&H00FFFFFF,&H000000FF,&H40000000,&H80000000,-1,0,0,0,100,100,2,0,1,3,0,2,80,80,260,1
Style: JanseeHighlight,Microsoft YaHei,56,&H007EE2A8,&H000000FF,&H40000000,&H80000000,-1,0,0,0,100,100,2,0,1,3,0,2,80,80,260,1
Style: JanseeTag,Microsoft YaHei,30,&H40FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,1,0,1,0,0,9,60,60,60,1
Style: JanseeBrand,Microsoft YaHei,46,&H00FFFFFF,&H000000FF,&H00000000,&H60000000,-1,0,0,0,100,100,6,0,1,0,0,2,80,80,440,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Comment: 角标贯穿全程 (合规标识)
Dialogue: 0,0:00:00.00,0:00:15.70,JanseeTag,,0,0,0,,AI 生成 · 简兮 JANSEE
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

  let assEvents = '';

  // 分镜1字幕拆分两半
  // "不管卖什么，手机随手拍几张，丢给简兮，10秒直出电影级带货视频。"
  const s1Start = lines[0].startOffset;
  const s1Dur = lines[0].duration;
  const s1Mid = s1Start + s1Dur * 0.45;
  const s1End = s1Start + s1Dur + 0.15;
  assEvents += `Dialogue: 1,${toAssTime(s1Start)},${toAssTime(s1Mid)},JanseeSub,,0,0,0,,不管卖什么 · 手机随手拍几张\n`;
  assEvents += `Dialogue: 1,${toAssTime(s1Mid)},${toAssTime(s1End)},JanseeSub,,0,0,0,,丢给简兮 · 10秒直出电影级带货视频\n`;

  // 分镜2字幕
  // "双十一限时大促，不要几百块，一块一毛一直接订阅Lite会员！抢完即止，简兮。"
  const s2Start = lines[1].startOffset;
  const s2Dur = lines[1].duration;
  const s2p1 = s2Start + s2Dur * 0.40;
  const s2p2 = s2Start + s2Dur * 0.85;
  const s2End = s2Start + s2Dur + 0.15;
  assEvents += `Dialogue: 1,${toAssTime(s2Start)},${toAssTime(s2p1)},JanseeSub,,0,0,0,,双十一限时大促 · 不要几百块\n`;
  assEvents += `Dialogue: 1,${toAssTime(s2p1)},${toAssTime(s2p2)},JanseeHighlight,,0,0,0,,1.11元直接订阅 Lite会员\n`;
  assEvents += `Dialogue: 1,${toAssTime(s2p2)},${toAssTime(s2End)},JanseeSub,,0,0,0,,抢完即止 · 简兮 JANSEE\n`;

  // 片尾品牌定格微光 (14.2s ~ 15.70s)
  assEvents += `Dialogue: 2,${toAssTime(14.2)},0:00:15.70,JanseeBrand,,0,0,0,,双11特别企划\\N{\\fs26\\c&HCCCCCC&\\b0}全栈AI短视频工场 · 限时 1.11 元体验\n`;

  const assContent = assHeader + assEvents;
  const assPath = path.join(WORK_DIR, 'double11_subtitles.ass');
  fs.writeFileSync(assPath, assContent, 'utf8');
  console.log(`ASS 字幕生成完成: ${assPath}`);

  console.log('\n=== [3/4] 准备视频无缝拼接与音频混流 ===');
  
  const shot1 = path.join(WORK_DIR, 'Laser_beam_transforms_product_ph…_fd56c4a2_1080p.mp4');
  const shot2 = path.join(WORK_DIR, 'Chrome_sculpture_displaying_1.11_34452f97_1080p.mp4');
  const concatTxt = path.join(WORK_DIR, 'concat_double11.txt');
  fs.writeFileSync(concatTxt, `file '${shot1.replace(/\\/g, '/')}'\nfile '${shot2.replace(/\\/g, '/')}'\n`, 'utf8');

  const bgmPath = 'F:\\janseeV2\\materials\\audio\\tech_future\\tech_future_01.mp3';
  console.log(`使用科技未来感官方 BGM: ${bgmPath}`);

  const totalDuration = 15.70;
  const d1Ms = Math.round(lines[0].startOffset * 1000);
  const d2Ms = Math.round(lines[1].startOffset * 1000);

  const tts1 = lines[0].filePath.replace(/\\/g, '/');
  const tts2 = lines[1].filePath.replace(/\\/g, '/');
  const assEscaped = assPath.replace(/\\/g, '/').replace(/:/g, '\\:');
  const finalOutput = path.join(WORK_DIR, 'JANSEE_Double11_Official_Ad_1080p.mp4');

  console.log('\n=== [4/4] 运行 FFmpeg 全流水线单遍直出渲染 ===');

  const cmd = [
    `"${FFMPEG}" -y`,
    `-f concat -safe 0 -i "${concatTxt}"`, // [0:v]
    `-stream_loop -1 -i "${bgmPath}"`,      // [1:a] bgm
    `-i "${tts1}"`,                        // [2:a] tts1
    `-i "${tts2}"`,                        // [3:a] tts2
    `-filter_complex "`,
    `[0:v]fade=t=in:st=0:d=0.3,fade=t=out:st=15.0:d=0.7,subtitles='${assEscaped}'[v];`,
    `[1:a]atrim=0:${totalDuration},afade=t=in:st=0:d=0.8,afade=t=out:st=14.5:d=1.2,volume=0.20[bgm];`,
    `[2:a]adelay=${d1Ms}|${d1Ms},volume=1.35[a1];`,
    `[3:a]adelay=${d2Ms}|${d2Ms},volume=1.35[a2];`,
    `[bgm][a1][a2]amix=inputs=3:duration=first:dropout_transition=2[a]`,
    `"`,
    `-map "[v]" -map "[a]"`,
    `-c:v libx264 -preset fast -crf 18 -pix_fmt yuv420p`,
    `-c:a aac -b:a 192k`,
    `-t ${totalDuration}`,
    `"${finalOutput}"`
  ].join(' ');

  console.log('执行命令:\n', cmd);
  execSync(cmd, { stdio: 'inherit' });

  console.log('\n=== 双11广告母片合成圆满完成! ===');
  console.log(`成片路径: ${finalOutput}`);
  const finalDur = audioDurationSec(finalOutput);
  console.log(`成片总时长: ${finalDur.toFixed(2)}s`);
}

main().catch(err => {
  console.error('合成失败:', err);
  process.exit(1);
});

