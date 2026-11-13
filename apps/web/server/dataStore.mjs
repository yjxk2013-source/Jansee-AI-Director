// 简兮后端 · dataStore.mjs —— 统一数据访问层（业务 JSON 落盘唯一入口）
// ---------------------------------------------------------------------------
// 目的（三点）：
//   ① 落盘位置收敛：所有业务数据文件都在 paths.DATA_DIR 下（可用 JX_DATA_DIR 覆盖），
//      不再出现「有的模块写在 server/routes/data/」这类漂移；
//   ② 写盘原子化：先写同目录临时文件 → fsync 落盘 → rename 覆盖。
//      进程崩溃 / 断电 / 并发写都不会留下半截 JSON（旧文件始终完好）；
//   ③ 读写容错：读失败给安全默认值、写失败保留旧文件并从日志告警，调用方无需各自 try/catch。
//
// 用法：
//   import { dataFile, readJson, writeJsonAtomic } from './dataStore.mjs';
//   const FILE = dataFile('db.json');
//   const db = readJson(FILE, {});      // 文件缺失/损坏 → {}
//   writeJsonAtomic(FILE, db);          // 原子替换，返回 true/false
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR } from './paths.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 数据文件绝对路径（name 为文件名，如 'db.json'；支持 'tasks' 子目录） */
export function dataFile(name) {
  return path.join(DATA_DIR, name);
}

/** 读取 JSON：文件不存在或内容损坏时返回 fallback（绝不抛异常） */
export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

// —— 原子写：临时文件名带进程号 + 自增序号，避免同进程内并发撞名 ——
let tmpSeq = 0;

/**
 * 原子写入 JSON 文件。
 * @param {string} file 目标文件绝对路径
 * @param {any} data 待写入数据（会被 JSON.stringify）
 * @param {{pretty?:boolean}} [opts] pretty 默认 true（2 空格缩进，便于人工排查）
 * @returns {boolean} 是否写入成功；失败时旧文件内容保持不变
 */
export function writeJsonAtomic(file, data, { pretty = true } = {}) {
  let text;
  try {
    text = JSON.stringify(data, null, pretty ? 2 : 0);
  } catch (err) {
    // 序列化就失败（如循环引用）→ 绝不触碰目标文件
    console.error(`[dataStore] 序列化失败 ${file}: ${err.message}`);
    return false;
  }
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.${path.basename(file)}.tmp-${process.pid}-${++tmpSeq}`);
  let fd = null;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fd = fs.openSync(tmp, 'w');
    fs.writeFileSync(fd, text, 'utf8');
    fs.fsyncSync(fd); // 先确保临时文件内容真正落盘，再改名（否则崩溃时可能出现空文件）
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmp, file); // 同目录改名：POSIX/Windows 均为原子替换
    return true;
  } catch (err) {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch (_) {
        /* 已关闭则忽略 */
      }
    }
    try {
      fs.rmSync(tmp, { force: true });
    } catch (_) {
      /* 清理失败不影响主流程 */
    }
    console.error(`[dataStore] 写入失败 ${file}: ${err.message}`);
    return false;
  }
}

// —— 一次性迁移：历史版本把后台数据写在 server/routes/data/，现统一收敛到 DATA_DIR ——
/**
 * 把 legacyDir 下的 *.json 搬到 targetDir。
 * 仅搬「目标位置还没有」的文件；两边都有时以目标位置为准，避免覆盖较新数据。搬空后旧目录自删。
 * @returns {number} 实际搬移的文件数
 */
export function migrateLegacyDir(legacyDir, targetDir) {
  let names;
  try {
    names = fs.readdirSync(legacyDir);
  } catch (_) {
    return 0; // 旧目录不存在（新部署）→ 无需迁移
  }
  let moved = 0;
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const from = path.join(legacyDir, name);
    const to = path.join(targetDir, name);
    try {
      if (fs.existsSync(to)) continue;
      fs.mkdirSync(targetDir, { recursive: true });
      fs.renameSync(from, to);
      moved += 1;
    } catch (err) {
      console.warn(`[dataStore] 迁移旧数据 ${name} 失败: ${err.message}`);
    }
  }
  if (moved) console.log(`[dataStore] 旧数据已迁移 ${moved} 个文件 → ${targetDir}`);
  try {
    fs.rmdirSync(legacyDir); // 迁移后应为空；若仍有文件（非 json）则保留
  } catch (_) {
    /* 目录非空或不可删 → 保持原样 */
  }
  return moved;
}

// 只在「使用默认 DATA_DIR」时执行迁移：测试/多实例用 JX_DATA_DIR 指定了独立目录，
// 不能让它顺手把仓库里的真实数据搬走。
if (!process.env.JX_DATA_DIR) {
  migrateLegacyDir(path.join(__dirname, 'routes', 'data'), DATA_DIR);
}
