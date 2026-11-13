// 简兮后端 · env.mjs —— 环境变量装载（必须在 index.js 的**第一个 import** 引入）
// ---------------------------------------------------------------------------
// 为什么单独成文件：ESM 的 import 会被提升，index.js 里写在代码中的 dotenv.config()
// 实际执行时机在所有 import 之后 —— 于是「模块顶层就读 process.env」的模块
// （routes/asset / backup / settlementGateway / composer 等）
// 拿到的仍是系统环境，.env 里的配置被静默忽略。
// 把 dotenv 放进这个模块并让它第一个被 import，即可保证后续所有模块读到的都是最终值。
//
// 优先级：系统/容器环境变量 > 根目录全局 .env 文件 > 本地 .env 文件
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  try {
    const lines = fs.readFileSync(filePath, 'utf8').split('\n');
    for (const l of lines) {
      const trimmed = l.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const idx = trimmed.indexOf('=');
      if (idx > 0) {
        const k = trimmed.slice(0, idx).trim();
        const v = trimmed.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
        if (process.env[k] === undefined) process.env[k] = v;
      }
    }
  } catch (_) {}
}

if (process.env.JX_SKIP_ENV_FILE !== '1') {
  // 1. 优先加载 Monorepo 工作区根目录下的全局唯一 .env
  const rootEnvPath = path.resolve(__dirname, '..', '..', '..', '.env');
  parseEnvFile(rootEnvPath);

  // 2. 兼容兜底加载服务端当前目录下的 .env（若有）
  const localEnvPath = path.join(__dirname, '.env');
  if (localEnvPath !== rootEnvPath) {
    parseEnvFile(localEnvPath);
  }
}

