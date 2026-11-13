/**
 * 字体入库审计 —— 字体进库 ≠ 能上版面
 *
 * 判据全部是实测，不看厂商宣传：
 *   1. 能否被 opentype.js 解析（解析不了等于废文件）
 *   2. GB2312 一级汉字 3755 字覆盖率（标题文案由 LLM 生成，不可预知，覆盖率必须逼近 100%）
 *   3. 抽样字形能否生成合法矢量路径（NaN / 空路径 = 上版面就露白）
 *   4. 拉丁字母 + 数字覆盖（副标、编号、JANSEE.CN 都要用）
 *
 * 用法：
 *   node scripts/font-audit.mjs            # 只打印报告
 *   node scripts/font-audit.mjs --write    # 同时把实测结果写回 index.json
 */
import fs from 'node:fs';
import path from 'node:path';
import opentype from 'opentype.js';

const ROOT = 'materials/fonts';
const INDEX = path.join(ROOT, 'index.json');
const WRITE = process.argv.includes('--write');

/* ---------- 判据数据 ---------- */

// GB2312 一级汉字（3755 字），用 Node 内置 GBK 解码器按国标区位码枚举，不经任何外部字表
function gb2312Level1() {
  const dec = new TextDecoder('gbk');
  const out = new Set();
  for (let q = 0xb0; q <= 0xd7; q += 1) {
    for (let w = 0xa1; w <= 0xfe; w += 1) {
      const ch = dec.decode(new Uint8Array([q, w]));
      if (ch && ch !== '\uFFFD' && /[\u4e00-\u9fff]/.test(ch)) out.add(ch);
    }
  }
  return [...out];
}

const CN = gb2312Level1();
const LATIN = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789·&—-'];
// 路径抽样：横竖撇捺折都有，避免只抽到简单字得出假结论
const PATH_SAMPLE = [...'手作咖啡奶茶甜品面包臻选好物质感呈现永国'];

/* ---------- 单字体审计 ---------- */

function auditFont(abs) {
  const rel = abs.split(path.sep).join('/');
  const out = { rel, ok: false };

  let font;
  try {
    const buf = fs.readFileSync(abs);
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    font = opentype.parse(ab, {});
  } catch (e) {
    out.error = `解析失败：${e.message.slice(0, 80)}`;
    return out;
  }

  out.ok = true;
  out.name = font.names?.fontFamily?.en || font.names?.fullName?.en || path.basename(abs);
  out.style = font.names?.fontSubfamily?.en || '';
  out.unitsPerEm = font.unitsPerEm;
  out.glyphCount = font.glyphs.length;

  // 中文覆盖
  const missCN = CN.filter((ch) => font.charToGlyph(ch).index === 0);
  out.cnTotal = CN.length;
  out.cnMissing = missCN.length;
  out.cnCoverage = +(((CN.length - missCN.length) / CN.length) * 100).toFixed(2);
  out.cnMissingSample = missCN.slice(0, 24).join('');

  // 拉丁覆盖
  const missLatin = LATIN.filter((ch) => font.charToGlyph(ch).index === 0);
  out.latinCoverage = +(((LATIN.length - missLatin.length) / LATIN.length) * 100).toFixed(2);
  out.latinMissing = missLatin.join('');

  // 路径可用性
  let pathFail = 0;
  let cmdTotal = 0;
  const failChars = [];
  for (const ch of PATH_SAMPLE) {
    if (font.charToGlyph(ch).index === 0 && /[\u4e00-\u9fff]/.test(ch)) continue;
    const p = font.charToGlyph(ch).getPath(0, 0, 200);
    const cmds = (p.commands || []).length;
    const d = cmds ? p.toPathData(2) : '';
    cmdTotal += cmds;
    if (!cmds || !d || d.includes('NaN') || d.includes('Infinity')) {
      pathFail += 1;
      failChars.push(ch);
    }
  }
  out.pathOk = pathFail === 0;
  out.pathFailChars = failChars.join('');

  // 排版需要：上下沿相对 em 的位置（算行高、贴顶、裁切都靠它）
  const upm = font.unitsPerEm;
  out.ascender = +(font.ascender / upm).toFixed(3);
  out.descender = +(font.descender / upm).toFixed(3);

  // 判定等级：程序按这个筛池子
  if (out.cnCoverage >= 99.9 && out.pathOk) out.level = 'cn-full';
  else if (out.cnCoverage >= 95) out.level = 'cn-partial';
  else if (out.latinCoverage >= 99 && out.pathOk) out.level = 'latin-only';
  else out.level = 'unusable';

  return out;
}

/* ---------- 主流程 ---------- */

const dirs = fs
  .readdirSync(ROOT, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();

const report = [];
for (const d of dirs) {
  const dirAbs = path.join(ROOT, d);
  const files = fs.readdirSync(dirAbs).filter((f) => /\.(ttf|otf)$/i.test(f)).sort();
  for (const f of files) report.push({ family: d, ...auditFont(path.join(dirAbs, f)) });
}

/* ---------- 打印 ---------- */

const pad = (s, n) => String(s).padEnd(n);
console.log('\n字体入库审计 · 判据为 GB2312 一级汉字 3755 字实测\n');
console.log(
  pad('字体', 26) + pad('等级', 13) + pad('中文覆盖', 11) + pad('拉丁', 8) + pad('字形', 9) + '路径'
);
console.log('-'.repeat(80));
for (const r of report) {
  if (!r.ok) {
    console.log(pad(path.basename(r.rel), 26) + '解析失败 · ' + r.error);
    continue;
  }
  const cn = `${r.cnCoverage}%`;
  console.log(
    pad(path.basename(r.rel), 26) +
      pad(r.level, 13) +
      pad(cn, 11) +
      pad(r.latinCoverage + '%', 8) +
      pad(r.glyphCount, 9) +
      (r.pathOk ? 'OK' : '失败 ' + r.pathFailChars)
  );
  if (r.cnMissing > 0 && r.level !== 'latin-only') {
    console.log('  └ 缺字 ' + r.cnMissing + ' 个，例：' + r.cnMissingSample);
  }
}

const usable = report.filter((r) => r.level === 'cn-full' || r.level === 'latin-only');
console.log('\n可上版面：' + usable.length + ' / ' + report.length);
console.log('不可用：' + report.filter((r) => !r.ok || r.level === 'unusable').length + '\n');

/* ---------- 回写 ---------- */

if (WRITE) {
  const idx = JSON.parse(fs.readFileSync(INDEX, 'utf8'));
  const byId = new Map(idx.fonts.map((f) => [f.id, f]));
  let touched = 0;
  for (const r of report) {
    const id = r.family;
    let entry = byId.get(id);
    if (!entry) {
      // 新入库的字体，补一个最小条目（名称/分类/授权仍需人工补全）
      entry = {
        id,
        pkg: id,
        name: r.name || id,
        family: r.name || id,
        category: 'uncategorized',
        license: '',
        tags: [],
        bestFor: '',
        files: [],
        _needsReview: true,
      };
      idx.fonts.push(entry);
      byId.set(id, entry);
    }
    entry.primaryRelPath = r.rel;
    entry.glyphCount = r.glyphCount;
    entry.audit = {
      level: r.level,
      pathOk: r.pathOk,
      cnCoverage: r.cnCoverage,
      cnMissing: r.cnMissing,
      cnMissingSample: r.cnMissingSample,
      latinCoverage: r.latinCoverage,
      unitsPerEm: r.unitsPerEm,
      ascender: r.ascender,
      descender: r.descender,
      checkedAt: new Date().toISOString().slice(0, 10),
    };
    touched += 1;
  }
  idx.version = '4.0.0';
  idx.updatedAt = new Date().toISOString().slice(0, 10);
  idx.totalCount = idx.fonts.length;
  fs.writeFileSync(INDEX, JSON.stringify(idx, null, 2) + '\n');
  console.log(`已写回 ${INDEX}（${touched} 条实测记录，共 ${idx.fonts.length} 款）\n`);
}
