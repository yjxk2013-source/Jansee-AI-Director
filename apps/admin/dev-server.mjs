// 简兮后台管理 · 本地静态服务（3001）
// 原先是 package.json 里一行内联的 `node -e "...一大段..."`，无法以独立窗口进程启动、
// 也没法在编辑器里正常格式化，这里抽成独立文件，行为与原来完全一致。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3001;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

http
  .createServer((req, res) => {
    const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
    const filePath = path.join(__dirname, urlPath === '/' ? 'index.html' : urlPath);

    // 目录穿越防护：解析后的真实路径必须仍在 apps/admin 内
    if (!filePath.startsWith(__dirname)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(filePath)] || 'text/plain',
        'Cache-Control': 'no-store',
      });
      fs.createReadStream(filePath).pipe(res);
    } else {
      res.writeHead(404);
      res.end('Not Found');
    }
  })
  .listen(PORT, () => console.log(`Jansee Admin running on http://localhost:${PORT}`));
