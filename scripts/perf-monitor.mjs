import os from 'os';
import fs from 'fs';
import path from 'path';

// 记录基线指标
const logFile = 'storage/outputs/perf_monitor.json';
const baseline = {
  timestamp: new Date().toISOString(),
  cpuCores: os.cpus().length,
  cpuModel: os.cpus()[0].model,
  totalMemMB: Math.round(os.totalmem() / 1024 / 1024),
  freeMemMB: Math.round(os.freemem() / 1024 / 1024),
  initialTime: Date.now()
};

fs.mkdirSync('storage/outputs', { recursive: true });
fs.writeFileSync(logFile, JSON.stringify(baseline, null, 2), 'utf8');
console.log('[PERF MONITOR] 性能与资源监控哨兵已部署完成，基线已锁定。');
