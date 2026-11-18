import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// packages/shared → packages → 仓库根（两层）。原 apps/engine/core 下需三层，迁移后注意层级差异。
const REPO_ROOT = path.resolve(__dirname, '../../');

/**
 * 大厂标准多模态素材库统一寻址入口
 * 默认直接读取工作区顶层 materials/ 官方素材中心
 */
export function assetsDir(engineRoot) {
  const materialsDir = process.env.JX_MATERIALS_ROOT || path.resolve(REPO_ROOT, 'materials');
  if (process.env.JX_ASSETS_ROOT) return process.env.JX_ASSETS_ROOT;
  return materialsDir;
}
