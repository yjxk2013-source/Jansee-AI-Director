#!/usr/bin/env node
/**
 * 简兮云端常驻监控器（systemd 托管，随机启动，日志不落 /tmp）
 *
 * 采集三类数据：
 *   1. 资源：系统负载、可用内存、网关进程 CPU/RSS、ffmpeg 进程 CPU/RSS
 *   2. 合成：每次 ffmpeg 起止时刻与真实运行时长
 *   3. 计费：积分账本新增流水（扣费/退款/充值/赠送）与当前余额
 *
 * 日志：/var/log/jansee-mon/
 *   resource-YYYYMMDD.csv   每 2 秒一行资源采样
 *   events-YYYYMMDD.log     合成事件与计费事件（人类可读）
 * 保留 14 天，自动清理。
 */

import fs from 'node:fs';
import { execSync } from 'node:child_process';

const LOG_DIR = process.env.JM_LOG_DIR || '/var/log/jansee-mon';
const LEDGER_PATH = process.env.JM_LEDGER || '/srv/jansee/apps/web/server/data/credit-accounts.json';
const SERVICE = process.env.JM_SERVICE || 'jianxi';
const RESOURCE_TICK_MS = 2000;
const LEDGER_TICK_MS = 5000;
const BALANCE_TICK_MS = 60000;
const KEEP_DAYS = 14;

fs.mkdirSync(LOG_DIR, { recursive: true });

const pad2 = (n) => String(n).padStart(2, '0');

function dateKey(d = new Date()) {
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;
}

function tsStr(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function append(kind, line) {
  try {
    fs.appendFileSync(`${LOG_DIR}/${kind}-${dateKey()}.log`, line + '\n');
  } catch (e) {
    console.error('[monitor] 写日志失败:', e.message);
  }
}

function sh(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return '';
  }
}

// ---------- 资源采样 ----------

function readLoad1() {
  try {
    return Number(fs.readFileSync('/proc/loadavg', 'utf8').trim().split(/\s+/)[0]) || 0;
  } catch {
    return 0;
  }
}

function readMemAvailableMB() {
  try {
    const m = fs.readFileSync('/proc/meminfo', 'utf8').match(/MemAvailable:\s+(\d+)\s+kB/);
    return m ? Math.round(Number(m[1]) / 1024) : 0;
  } catch {
    return 0;
  }
}

function gatewayStat() {
  const pid = sh(`systemctl show ${SERVICE} -p MainPID --value`).trim();
  if (!pid || pid === '0') return { pid: 0, cpu: 0, rssMB: 0 };
  const line = sh(`ps -p ${pid} -o pcpu=,rss= --no-headers`).trim();
  if (!line) return { pid: Number(pid), cpu: 0, rssMB: 0 };
  const [cpu, rss] = line.split(/\s+/).map(Number);
  return { pid: Number(pid), cpu: cpu || 0, rssMB: Math.round((rss || 0) / 1024) };
}

function ffmpegProcs() {
  const out = sh('ps -eo pid,pcpu,rss,etimes,args --no-headers');
  const rows = [];
  for (const raw of out.split('\n')) {
    const line = raw.trim();
    if (!line || !line.includes('ffmpeg')) continue;
    if (line.includes('ps -eo')) continue;
    const m = line.match(/^(\d+)\s+([\d.]+)\s+(\d+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    rows.push({
      pid: Number(m[1]),
      cpu: Number(m[2]) || 0,
      rssMB: Math.round((Number(m[3]) || 0) / 1024),
      etimes: Number(m[4]) || 0,
    });
  }
  return rows;
}

// ---------- ffmpeg 生命周期 ----------

const seenFf = new Map(); // pid -> 最后观测到的 etimes

function trackFfmpeg(procs) {
  const nowPids = new Set(procs.map((p) => p.pid));

  for (const p of procs) {
    if (!seenFf.has(p.pid)) {
      append('events', `[FF] ${tsStr()} START pid=${p.pid} 已有运行=${p.etimes}s 并发=${procs.length}`);
    }
    seenFf.set(p.pid, p.etimes);
  }

  for (const [pid, lastEt] of seenFf.entries()) {
    if (!nowPids.has(pid)) {
      append('events', `[FF] ${tsStr()} END   pid=${pid} 运行=${lastEt}s`);
      seenFf.delete(pid);
    }
  }
}

// ---------- 账本监控 ----------

function readLedger() {
  try {
    return JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function totalsOf(ledger) {
  const map = {};
  for (const [uid, acc] of Object.entries(ledger.accounts || {})) {
    map[uid] = Number(acc?.paid || 0) + Number(acc?.free || 0);
  }
  return map;
}

let lastSeq = -1;
let lastBalances = {};

function checkLedger(initial = false) {
  const ledger = readLedger();
  if (!ledger) return;

  const txs = Array.isArray(ledger.transactions) ? ledger.transactions : [];
  const seq = Number(ledger.seq) || txs.length;

  if (lastSeq < 0) {
    lastSeq = seq;
    lastBalances = totalsOf(ledger);
    append('events', `[BILL] ${tsStr()} 基线建立：流水 ${txs.length} 条，余额 ${formatBalances(lastBalances)}`);
    return;
  }

  if (seq > lastSeq) {
    const fresh = txs.filter((t) => (Number(t.seq) || 0) > lastSeq);
    const balances = totalsOf(ledger);
    for (const t of fresh) {
      const kind = String(t.type || '');
      const sign = kind === 'consume' ? '-' : '+';
      const uidShort = String(t.userId || '').slice(-8);
      const after = balances[t.userId];
      append(
        'events',
        `[BILL] ${tsStr()} ${kind.toUpperCase()} ${sign}${t.amount} uid=…${uidShort} task=${t.taskId || '-'} 余额=${after !== undefined ? after : '?'} 原因=${String(t.reason || '').slice(0, 60)}`,
      );
    }
    lastSeq = seq;
    lastBalances = balances;
  }
}

function formatBalances(map) {
  return Object.entries(map)
    .map(([uid, v]) => `…${uid.slice(-8)}=${v}`)
    .join(' ');
}

// ---------- 日志清理 ----------

function cleanupOldLogs() {
  try {
    const cutoff = Date.now() - KEEP_DAYS * 24 * 3600 * 1000;
    for (const f of fs.readdirSync(LOG_DIR)) {
      const full = `${LOG_DIR}/${f}`;
      const st = fs.statSync(full);
      if (st.mtimeMs < cutoff) {
        fs.unlinkSync(full);
        append('events', `[MON] ${tsStr()} 清理过期日志 ${f}`);
      }
    }
  } catch {
    // 清理失败不影响采样
  }
}

// ---------- 主循环 ----------

append('events', `[MON] ${tsStr()} 监控器启动 pid=${process.pid} 日志目录=${LOG_DIR}`);
checkLedger(true);
cleanupOldLogs();

const resourceTimer = setInterval(() => {
  try {
    const load1 = readLoad1();
    const memAvail = readMemAvailableMB();
    const gw = gatewayStat();
    const ff = ffmpegProcs();
    const ffCpu = ff.reduce((s, p) => s + p.cpu, 0);
    const ffRss = ff.reduce((s, p) => s + p.rssMB, 0);
    const line = [
      tsStr(),
      load1.toFixed(2),
      memAvail,
      gw.pid,
      gw.cpu.toFixed(1),
      gw.rssMB,
      ff.length,
      ffCpu.toFixed(1),
      ffRss,
    ].join(',');
    append('resource', line);
    trackFfmpeg(ff);
  } catch (e) {
    append('events', `[MON] ${tsStr()} 采样异常 ${e.message}`);
  }
}, RESOURCE_TICK_MS);

const ledgerTimer = setInterval(() => {
  try {
    checkLedger();
  } catch (e) {
    append('events', `[MON] ${tsStr()} 账本读取异常 ${e.message}`);
  }
}, LEDGER_TICK_MS);

const balanceTimer = setInterval(() => {
  try {
    const ledger = readLedger();
    if (ledger) append('events', `[BAL] ${tsStr()} ${formatBalances(totalsOf(ledger))}`);
  } catch {
    // 忽略
  }
}, BALANCE_TICK_MS);

function shutdown(sig) {
  clearInterval(resourceTimer);
  clearInterval(ledgerTimer);
  clearInterval(balanceTimer);
  append('events', `[MON] ${tsStr()} 监控器停止 信号=${sig}`);
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
