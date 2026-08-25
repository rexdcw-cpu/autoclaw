#!/usr/bin/env node
/**
 * ===========================================================================
 * autoclaw 自启守护进程（autostart guardian）
 * ---------------------------------------------------------------------------
 * 职责：
 *   1) 单实例保护：通过 data/guardian.lock 记录 pid，避免重复启动互抢 7788
 *   2) 拉起并守护 app.js：子进程退出/崩溃后自动重启（默认 10 秒后）
 *   3) 落盘日志：把 app.js 的 stdout/stderr 统一写入 data/autostart.log
 *      —— 项目原先只有控制台输出，崩溃原因常常丢失，这里补上文件日志
 *   4) 日志轮转：超过 5MB 转存为 autostart.log.old，避免无限增长
 *
 * 启动方式：
 *   - 开机自启：Startup 文件夹的 autoclaw-autostart.vbs（隐藏窗口）调用本文件
 *   - 手动启动：双击 autostart-autoclaw.bat，或 node autostart-guardian.js
 *
 * 停止方式：
 *   - 结束本守护进程（父 node），再结束 app.js 子进程
 *   - 只杀子进程 app.js 的话，守护会在 10 秒后自动把它拉起来（这是设计意图）
 * ===========================================================================
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const APP_DIR = __dirname;
const DATA_DIR = path.join(APP_DIR, 'data');
const LOG_FILE = path.join(DATA_DIR, 'autostart.log');
const LOCK_FILE = path.join(DATA_DIR, 'guardian.lock');

const RESTART_DELAY_MS = 10 * 1000;
const MAX_LOG_BYTES = 5 * 1024 * 1024;

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

/* ----------------------------- 日志 ----------------------------- */

function stamp() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function rotateIfNeeded() {
  try {
    if (!fs.existsSync(LOG_FILE)) return;
    if (fs.statSync(LOG_FILE).size <= MAX_LOG_BYTES) return;
    const old = LOG_FILE + '.old';
    try { if (fs.existsSync(old)) fs.unlinkSync(old); } catch (_) {}
    fs.renameSync(LOG_FILE, old);
  } catch (_) { /* 轮转失败不影响主流程 */ }
}

function writeRaw(text) {
  try { fs.appendFileSync(LOG_FILE, text); } catch (_) {}
}

function log(msg) {
  rotateIfNeeded();
  writeRaw(`[${stamp()}] [guardian] ${msg}\n`);
}

/* --------------------------- 单实例保护 --------------------------- */

function pidAlive(pid) {
  if (!pid || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM 说明进程存在但无权限发信号 —— 仍视为存活
    return err && err.code === 'EPERM';
  }
}

function acquireLock() {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const prev = parseInt(String(fs.readFileSync(LOCK_FILE, 'utf8')).trim(), 10);
      if (pidAlive(prev)) {
        log(`已有守护进程在运行（pid=${prev}），本次退出以避免端口冲突`);
        return false;
      }
    }
    fs.writeFileSync(LOCK_FILE, String(process.pid), 'utf8');
    return true;
  } catch (err) {
    log(`写入 lock 失败（继续运行）：${err && err.message}`);
    return true;
  }
}

function releaseLock() {
  try {
    if (!fs.existsSync(LOCK_FILE)) return;
    const cur = parseInt(String(fs.readFileSync(LOCK_FILE, 'utf8')).trim(), 10);
    if (cur === process.pid) fs.unlinkSync(LOCK_FILE);
  } catch (_) {}
}

/* ------------------------- 环境变量（对齐 start-win.bat） ------------------------- */

process.env.AUTOCLAW_TOKEN = process.env.AUTOCLAW_TOKEN || 'autoclaw-dev';
process.env.AUTOCLAW_DB_TYPE = process.env.AUTOCLAW_DB_TYPE || 'sqlite';

/* ----------------------------- 守护主体 ----------------------------- */

let child = null;
let stopping = false;
let restartCount = 0;

function launch() {
  if (stopping) return;
  rotateIfNeeded();
  log(`启动 app.js（第 ${restartCount + 1} 次）`);

  child = spawn(process.execPath, ['app.js'], {
    cwd: APP_DIR,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  const pipe = (stream, tag) => {
    if (!stream) return;
    stream.on('data', (buf) => {
      const text = buf.toString();
      writeRaw(tag ? text.replace(/^/gm, `[${tag}] `) : text);
    });
  };
  pipe(child.stdout, '');
  pipe(child.stderr, 'stderr');

  log(`app.js 已启动，pid=${child.pid}`);

  child.on('error', (err) => {
    log(`spawn app.js 失败：${err && err.message}`);
  });

  child.on('exit', (code, signal) => {
    const dead = child ? child.pid : '?';
    child = null;
    if (stopping) return;
    restartCount += 1;
    log(`app.js（pid=${dead}）退出：code=${code} signal=${signal}，${RESTART_DELAY_MS / 1000} 秒后自动重启`);
    setTimeout(launch, RESTART_DELAY_MS);
  });
}

function shutdown(reason) {
  if (stopping) return;
  stopping = true;
  log(`守护收到 ${reason}，正在停止 app.js 并退出`);
  if (child) { try { child.kill(); } catch (_) {} }
  releaseLock();
  setTimeout(() => process.exit(0), 300);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('exit', releaseLock);

if (!acquireLock()) process.exit(0);

log('======================================================');
log(`守护启动：pid=${process.pid}  node=${process.execPath}`);
log(`工作目录：${APP_DIR}`);
launch();
