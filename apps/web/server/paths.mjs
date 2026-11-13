// 简兮后端 · paths.mjs —— 六大版块共享路径常量（单一事实源）
// 各路由/工具原先各自手写同一套 __dirname/REPO_ROOT/OUTPUT_ROOT/... 常量，本模块收敛为一处，
// 供六大版块直接 import 调用；改动目录布局只需改这里。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// 先装载 .env：本模块（及所有 import 它的模块）在顶层就读 process.env，
// 若等入口 index.js 里的 dotenv.config()，这里读到的会是系统环境、.env 配置失效。
import './env.mjs';

// 本文件位于 web/server/ 下 → 上溯 3 层到项目根
const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

// 后端 JSON 数据目录（用户 / 订单 / 佣金 / 结算流水等落盘位置）
// 默认 server/data；可用 JX_DATA_DIR 覆盖 —— 供自动化测试指向临时目录（不污染真实数据），
// 也是将来数据层换成 MySQL/Redis 时的唯一挂载点。
export const DATA_DIR = process.env.JX_DATA_DIR ? path.resolve(process.env.JX_DATA_DIR) : path.join(__dirname, 'data');

export const OUTPUT_ROOT = path.join(REPO_ROOT, 'outputs');
export const UPLOAD_ROOT = path.join(REPO_ROOT, 'uploads');
export const MATERIALS_ROOT = process.env.JX_MATERIALS_ROOT || path.resolve(REPO_ROOT, 'materials');
export const ASSETS_ROOT = process.env.JX_ASSETS_ROOT || path.resolve(REPO_ROOT, 'apps', 'engine', 'assets');
export const BGM_DIR = path.join(ASSETS_ROOT, 'bgm');
export const LIBRARY_DIR = path.join(ASSETS_ROOT, 'video', '_library');
export const LIBRARY_INDEX = path.join(LIBRARY_DIR, 'index.json');

// ffmpeg 二进制（ffmpeg-static 包，随仓库安装，免系统 PATH 依赖）
// 文件名随平台不同：Windows 为 ffmpeg.exe、Linux/macOS 为 ffmpeg。
// 可用 JX_FFMPEG 显式指定（如系统自带 ffmpeg / 容器内非默认安装路径）。
export const FFMPEG =
  process.env.JX_FFMPEG ||
  path.resolve(
    REPO_ROOT,
    'apps',
    'engine',
    'node_modules',
    'ffmpeg-static',
    process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg',
  );
// 空串=相对路径，跟随当前请求的 host/端口
export const PUBLIC_BASE = process.env.PUBLIC_BASE || '';
