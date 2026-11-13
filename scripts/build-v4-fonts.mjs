/**
 * V4 实验室字体内嵌构建
 *
 * 为什么必须内嵌：V4 会被三种方式打开——双击（file://）、本地 http 服务、以及 IDE 的静态预览面板。
 * 前两种能把 `../../materials/fonts/x.ttf` 解析到真实文件，第三种（面板把 HTML 单独拷到
 * `static-html/<hash>/` 下）**一律 404**，字体静默回退到系统字体，画面不报错但"细体"变"常规体"。
 * 85MB 的原文件也不可能整包内嵌，所以先按页面实际用到的字符子集化再塞进去。
 *
 * 代价：子集只含本页出现的字符。改了 LY_COPY 或任何文案之后必须重跑本脚本，否则新字缺字形。
 * 这也是为什么 @font-face 块带 BEGIN/END 标记——只替换那一段，别的地方随便改。
 *
 * 跑法：node scripts/build-v4-fonts.mjs [--dry]
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const PAGE = 'docs/visual-gallery/v4.html';
const REG = 'materials/fonts/index.json';
const CACHE = 'storage/tmp/v4fonts';
const PY = process.env.PYFTSUBSET
  || 'C:/Users/Administrator/.workbuddy/binaries/python/envs/default/Scripts/pyftsubset.exe';
const dry = process.argv.includes('--dry');

if (!fs.existsSync(PY)) {
  console.error(`找不到 pyftsubset：${PY}\n装法：python -m venv <venv> && <venv>/Scripts/pip install fonttools brotli`);
  process.exit(1);
}

const reg = JSON.parse(fs.readFileSync(REG, 'utf8'));
let html = fs.readFileSync(PAGE, 'utf8');

/* 1) 字符集：页面里出现的每一个字符都要有字形，宁可多收不能漏 */
const CHARS = path.join(CACHE, 'chars.txt');
fs.mkdirSync(CACHE, { recursive: true });
const charset = new Set();
for (const ch of html) if (ch.codePointAt(0) > 31) charset.add(ch);
for (let i = 32; i < 127; i += 1) charset.add(String.fromCharCode(i));
charset.add('　'); // 全角空格：竖排与字距之间会用到
const text = [...charset].sort().join('');
fs.writeFileSync(CHARS, text, 'utf8');
const cjkCount = [...charset].filter((c) => c.codePointAt(0) > 127).length;

/* 2) 逐文件子集化。weight 与文件一一对应，同一家族多字重必须是多个 woff2 */
const faces = [];
for (const font of reg.fonts) {
  for (const file of font.files.filter((x) => typeof x === 'object')) {
    const src = path.join('materials/fonts', font.id, file.file);
    const out = path.join(CACHE, `${font.id}-${file.weight}.woff2`);
    if (!fs.existsSync(src)) throw new Error(`注册表里的文件不存在：${src}`);
    if (!dry) {
      execFileSync(PY, [
        src,
        `--text-file=${CHARS}`,
        `--output-file=${out}`,
        '--flavor=woff2',
        '--no-hinting',
        '--layout-features=kern,liga',
        '--name-IDs=*',
        '--drop-tables+=DSIG',
      ], { stdio: ['ignore', 'ignore', 'pipe'] });
    }
    const bytes = fs.existsSync(out) ? fs.statSync(out).size : 0;
    faces.push({ family: font.family, weight: file.weight, file: file.file, out, bytes });
  }
}

const totalBytes = faces.reduce((sum, f) => sum + f.bytes, 0);

/* 3) 生成 @font-face 块（base64 data URL），替换 BEGIN/END 之间的内容 */
const css = faces.map((f) => {
  const b64 = dry ? '' : fs.readFileSync(f.out).toString('base64');
  return `@font-face{font-family:'${f.family}';font-weight:${f.weight};font-style:normal;font-display:swap;`
    + `src:url('data:font/woff2;base64,${b64}') format('woff2')}`;
}).join('\n');

const header = `/* ===== V4FONTS:BEGIN 由 scripts/build-v4-fonts.mjs 生成，勿手改 =====
   ${faces.length} 面 · 字符 ${charset.size}（含中文 ${cjkCount}）· woff2 ${(totalBytes / 1024).toFixed(0)}KB
   全部取自 materials/fonts 的 OFL 字体，按页面实际字符子集化后内嵌。
   改任何文案后重跑：node scripts/build-v4-fonts.mjs */
`;
const footer = '/* ===== V4FONTS:END ===== */';

const beginMark = '/* ===== V4FONTS:BEGIN';
const beginAt = html.indexOf(beginMark);
if (beginAt >= 0) {
  const endMark = '/* ===== V4FONTS:END ===== */';
  const endAt = html.indexOf(endMark, beginAt);
  if (endAt < 0) throw new Error('找到 V4FONTS:BEGIN 但没有 END，先手工修好再跑');
  html = html.slice(0, beginAt) + header + css + '\n' + footer + html.slice(endAt + endMark.length);
} else {
  /* 首次运行：把原来的外部 url 版 @font-face 整段换成内嵌版。
     起点是"真实字库"注释，终点是 :root{ —— 这段只有字体声明，换掉不会伤到别的样式。 */
  const legacyStart = html.indexOf('/* ============ 真实字库');
  const legacyEnd = html.indexOf(':root{color-scheme:dark;');
  if (legacyStart < 0 || legacyEnd < 0) throw new Error('找不到旧的外部 @font-face 段，页面结构变了');
  html = html.slice(0, legacyStart) + header + css + '\n' + footer + '\n' + html.slice(legacyEnd);
}

if (!dry) fs.writeFileSync(PAGE, html);

console.log(`字体块：${faces.length} 面 / 字符 ${charset.size}（中文 ${cjkCount}）`);
for (const f of faces) console.log(`  ${String(f.weight).padEnd(4)} ${f.family.padEnd(24)} ${(f.bytes / 1024).toFixed(0).padStart(4)}KB  ${f.file}`);
console.log(`woff2 合计 ${(totalBytes / 1024).toFixed(0)}KB，base64 后约 ${(totalBytes * 4 / 3 / 1024).toFixed(0)}KB`);
console.log(`页面体积 ${(html.length / 1024).toFixed(0)}KB${dry ? '（dry run，未写入）' : ''}`);
