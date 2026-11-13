const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ffmpegPath = path.resolve(__dirname, '../node_modules/ffmpeg-static/ffmpeg.exe');
const srcDir = 'F:\\截图';
const outDir = path.join(srcDir, 'compressed_480');

if (!fs.existsSync(outDir)) {
  fs.mkdirSync(outDir, { recursive: true });
}

const validExts = ['.png', '.jpg', '.jpeg', '.webp'];
const files = fs.readdirSync(srcDir).filter(f => {
  const ext = path.extname(f).toLowerCase();
  return validExts.includes(ext) && fs.statSync(path.join(srcDir, f)).isFile();
});

console.log(`找到 ${files.length} 个文件，开始使用 FFmpeg 缩放压缩至 480 分辨率...`);

for (const file of files) {
  const inputPath = path.join(srcDir, file);
  const outputPath = path.join(outDir, file);
  
  // 缩放规则：保持宽高比，长边或短边适配 480（这里按长边最大480限制，保证适合测试）
  // scale='if(gt(iw,ih),480,-2)':'if(gt(iw,ih),-2,480)'
  const scaleFilter = "scale='if(gt(iw,ih),480,-2)':'if(gt(iw,ih),-2,480)'";
  const cmd = `"${ffmpegPath}" -y -i "${inputPath}" -vf "${scaleFilter}" "${outputPath}"`;
  
  try {
    execSync(cmd, { stdio: 'pipe' });
    const inSize = (fs.statSync(inputPath).size / 1024 / 1024).toFixed(2);
    const outSize = (fs.statSync(outputPath).size / 1024).toFixed(1);
    console.log(`[成功] ${file} : ${inSize}MB -> ${outSize}KB`);
  } catch (err) {
    console.error(`[失败] ${file}:`, err.message);
  }
}

console.log(`\n全部完成！输出目录: ${outDir}`);
