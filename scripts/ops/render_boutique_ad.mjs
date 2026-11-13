import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import '../../apps/web/server/env.mjs';
import { synthViaNode, audioDurationSec } from '../../packages/tts-kit/index.js';

const FFMPEG = 'F:\\janseeV2\\node_modules\\ffmpeg-static\\ffmpeg.exe';
const WORK_DIR = 'F:\\Jansee-COO';

async function main() {
  console.log('=== [1/4] 开始合成腾讯云 TTS 旁白语音 ===');
  
  // 3段分镜台词设计 (女声亲和自然温润，如 101027 或 101016)
  const voiceId = 101027; // 智丽/温和亲切女声
  const lines = [
    {
      id: 'shot1',
      text: '开服装店的老板娘，白天进货接待，真的不用熬夜死磕剪辑。',
      startOffset: 0.8, // 视频第 0.8 秒开始说话
    },
    {
      id: 'shot2',
      text: '手机擦干净，随手拍下衣服的真实细节，直接丢给简兮。',
      startOffset: 8.65, // 分镜2 (7.85s开始) + 0.8s
    },
    {
      id: 'shot3',
      text: '电影感开场、高级排版一气呵成。把时间省下来，多卖两件衣服！简兮。',
      startOffset: 16.5, // 分镜3 (15.70s开始) + 0.8s
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
    
    // 探测时长
    const dur = audioDurationSec(outPath);
    item.duration = dur;
    item.filePath = outPath;
    console.log(`语音 [${item.id}] 生成成功，时长: ${dur.toFixed(2)}s`);
  }

  console.log('\n=== [2/4] 生成专业微距 ASS 字幕 ===');
  // 生成 ASS 字幕，符合大厂级 4 级文字排版亮度规范与微距无衬线发丝美感
  const assHeader = `[Script Info]
Title: Jansee Boutique Ad
ScriptType: v4.00+
WrapStyle: 0
ScaledBorderAndShadow: yes
YCbCr Matrix: TV.709
PlayResX: 1080
PlayResY: 1920

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: JanseeSub,Microsoft YaHei,54,&H00FFFFFF,&H000000FF,&H40000000,&H80000000,-1,0,0,0,100,100,2,0,1,3,0,2,80,80,260,1
Style: JanseeTag,Microsoft YaHei,32,&H40FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,1,0,1,0,0,9,60,60,60,1
Style: JanseeBrand,Microsoft YaHei,46,&H00FFFFFF,&H000000FF,&H00000000,&H60000000,-1,0,0,0,100,100,6,0,1,0,0,2,80,80,480,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Comment: 角标贯穿全程 (合规标识)
Dialogue: 0,0:00:00.00,0:00:23.55,JanseeTag,,0,0,0,,AI 生成 · 简兮 JANSEE
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

  // 分镜1字幕拆分两半更自然
  // "开服装店的老板娘，白天进货接待，真的不用熬夜死磕剪辑。"
  const s1Start = lines[0].startOffset;
  const s1Dur = lines[0].duration;
  const s1Mid = s1Start + s1Dur * 0.48;
  const s1End = s1Start + s1Dur + 0.2;
  assEvents += `Dialogue: 1,${toAssTime(s1Start)},${toAssTime(s1Mid)},JanseeSub,,0,0,0,,开服装店的老板娘\n`;
  assEvents += `Dialogue: 1,${toAssTime(s1Mid)},${toAssTime(s1End)},JanseeSub,,0,0,0,,白天进货接待 · 不用熬夜死磕剪辑\n`;

  // 分镜2字幕
  // "手机擦干净，随手拍下衣服的真实细节，直接丢给简兮。"
  const s2Start = lines[1].startOffset;
  const s2Dur = lines[1].duration;
  const s2Mid = s2Start + s2Dur * 0.45;
  const s2End = s2Start + s2Dur + 0.2;
  assEvents += `Dialogue: 1,${toAssTime(s2Start)},${toAssTime(s2Mid)},JanseeSub,,0,0,0,,手机擦干净 · 随手拍下真实细节\n`;
  assEvents += `Dialogue: 1,${toAssTime(s2Mid)},${toAssTime(s2End)},JanseeSub,,0,0,0,,直接丢给简兮\n`;

  // 分镜3字幕
  // "电影感开场、高级排版一气呵成。把时间省下来，多卖两件衣服！简兮。"
  const s3Start = lines[2].startOffset;
  const s3Dur = lines[2].duration;
  const s3p1 = s3Start + s3Dur * 0.42;
  const s3p2 = s3Start + s3Dur * 0.82;
  const s3End = s3Start + s3Dur + 0.2;
  assEvents += `Dialogue: 1,${toAssTime(s3Start)},${toAssTime(s3p1)},JanseeSub,,0,0,0,,电影感开场 · 高级排版一气呵成\n`;
  assEvents += `Dialogue: 1,${toAssTime(s3p1)},${toAssTime(s3p2)},JanseeSub,,0,0,0,,把时间省下来 · 多卖两件衣服\n`;

  // 片尾收束卡 (21.5s ~ 23.55s)
  assEvents += `Dialogue: 2,${toAssTime(21.2)},0:00:23.55,JanseeBrand,,0,0,0,,简 兮  J A N S E E\\N{\\fs28\\c&HCCCCCC&\\b0}全栈短视频重构工场 · 手机随手拍 即刻出好片\n`;

  const assContent = assHeader + assEvents;
  const assPath = path.join(WORK_DIR, 'ad_subtitles.ass');
  fs.writeFileSync(assPath, assContent, 'utf8');
  console.log(`ASS 字幕生成完成: ${assPath}`);

  console.log('\n=== [3/4] 准备视频与音频拼接参数 ===');
  
  // 查找 BGM
  const bgmPath = 'F:\\janseeV2\\materials\\audio\\warm\\warm_01.mp3';
  console.log(`使用 BGM: ${bgmPath}`);

  // 写入视频 concat 列表
  const concatTxt = path.join(WORK_DIR, 'concat_list.txt');
  const shot1 = path.join(WORK_DIR, 'Boutique_owner_turns_off_phone_b4cf87d3_1080p.mp4');
  const shot2 = path.join(WORK_DIR, 'Woman_photographing_coat_with_sm…_094f85a1_1080p.mp4');
  const shot3 = path.join(WORK_DIR, 'Boutique_owner_smiling_at_smartp…_2ecba355_1080p.mp4');
  
  fs.writeFileSync(concatTxt, `file '${shot1.replace(/\\/g, '/')}'\nfile '${shot2.replace(/\\/g, '/')}'\nfile '${shot3.replace(/\\/g, '/')}'\n`, 'utf8');

  // 构建复杂音频滤镜：
  // 1. bgm 循环截取 23.55s，两端 fade in 1s, fade out 1.5s, 基础音量 0.22
  // 2. 3 段 tts 通过 adelay 延时定位
  // 3. amix 混音
  // 4. 视频层：fade in 0.5s，fade out 0.6s，挂载 ass 字幕
  const totalDuration = 23.55;
  const d1Ms = Math.round(lines[0].startOffset * 1000);
  const d2Ms = Math.round(lines[1].startOffset * 1000);
  const d3Ms = Math.round(lines[2].startOffset * 1000);

  const tts1 = lines[0].filePath.replace(/\\/g, '/');
  const tts2 = lines[1].filePath.replace(/\\/g, '/');
  const tts3 = lines[2].filePath.replace(/\\/g, '/');
  const assEscaped = assPath.replace(/\\/g, '/').replace(/:/g, '\\:');
  const finalOutput = path.join(WORK_DIR, 'JANSEE_Boutique_Owner_Final_Ad.mp4');

  console.log('\n=== [4/4] 运行 FFmpeg 全流水线高保真单遍合成 ===');

  // ffmpeg 命令组装
  const cmd = [
    `"${FFMPEG}" -y`,
    `-f concat -safe 0 -i "${concatTxt}"`, // [0:v]
    `-stream_loop -1 -i "${bgmPath}"`,      // [1:a] bgm
    `-i "${tts1}"`,                        // [2:a] tts1
    `-i "${tts2}"`,                        // [3:a] tts2
    `-i "${tts3}"`,                        // [4:a] tts3
    `-filter_complex "`,
    `[0:v]fade=t=in:st=0:d=0.5,fade=t=out:st=22.8:d=0.75,subtitles='${assEscaped}'[v];`,
    `[1:a]atrim=0:${totalDuration},afade=t=in:st=0:d=1,afade=t=out:st=22.0:d=1.5,volume=0.22[bgm];`,
    `[2:a]adelay=${d1Ms}|${d1Ms},volume=1.35[a1];`,
    `[3:a]adelay=${d2Ms}|${d2Ms},volume=1.35[a2];`,
    `[4:a]adelay=${d3Ms}|${d3Ms},volume=1.35[a3];`,
    `[bgm][a1][a2][a3]amix=inputs=4:duration=first:dropout_transition=2[a]`,
    `"`,
    `-map "[v]" -map "[a]"`,
    `-c:v libx264 -preset fast -crf 18 -pix_fmt yuv420p`,
    `-c:a aac -b:a 192k`,
    `-t ${totalDuration}`,
    `"${finalOutput}"`
  ].join(' ');

  console.log('执行命令:\n', cmd);
  execSync(cmd, { stdio: 'inherit' });

  console.log('\n=== 合成圆满完成! ===');
  console.log(`成片路径: ${finalOutput}`);

  // 验证成片
  const finalDur = audioDurationSec(finalOutput);
  console.log(`成片总时长: ${finalDur.toFixed(2)}s`);
}

main().catch(err => {
  console.error('合成失败:', err);
  process.exit(1);
});
