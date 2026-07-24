'use strict';

/**
 * core/vpnLauncher.js
 * ---------------------------------------------------------------------------
 * 谷歌任务「步骤1 · 开启 VPN」启动器。
 *
 * 通过子进程调用 scripts/vpn_toggle.py，让它在桌面 Mihomo Party 上点击左上角
 * 「系统代理」开启按钮（灰色=关 → 蓝色=开）。这样 autoclaw 的谷歌阶段就真的有
 * 一个“先把 VPN 打开”的显式步骤，而不是假设用户已经手动开好了。
 *
 * 设计原则（重要）：
 *   - 永不抛异常；任何失败（python 缺失 / 脚本不存在 / 点击失败 / 7890 仍不通）
 *     都降级为 { ok:false, error }，由上层发一条 ALERT 提示用户手动开启，
 *     绝不阻断谷歌任务本身（用户在桌面会话里手动点一下也能继续）。
 *   - “是否已开”的客观判据是 TCP 连一下 127.0.0.1:7890（能连即已开）。
 */

const { spawn, spawnSync } = require('child_process');
const net = require('net');
const path = require('path');
const fs = require('fs');
const P = require('./progressEvent');

const PROXY_PORT = parseInt(process.env.AUTOCLAW_VPN_PROXY_PORT, 10) || 7890;
const SCRIPT = path.join(__dirname, '..', 'scripts', 'vpn_toggle.py');

/** TCP 探测本机代理端口是否监听 */
function isPortListening(port, host, timeoutMs) {
  return new Promise((resolve) => {
    const s = net.connect({ host: host || '127.0.0.1', port: port }, () => {
      s.destroy();
      resolve(true);
    });
    s.setTimeout(timeoutMs || 1500);
    s.on('timeout', () => { try { s.destroy(); } catch (e) { /* ignore */ } resolve(false); });
    s.on('error', () => { try { s.destroy(); } catch (e) { /* ignore */ } resolve(false); });
  });
}

/** 探测可用的 python 可执行名（windows 上 python / python3 / py 都试） */
function findPython() {
  const candidates = ['python', 'python3', 'py'];
  for (const c of candidates) {
    try {
      const r = spawnSync(c, ['--version'], { timeout: 3000, windowsHide: true });
      if (r.error === undefined) return c; // 能 spawn 起来即视为可用
    } catch (e) { /* ignore */ }
  }
  return null;
}

function _stepEvent(taskId, status, detail) {
  return P.makeProgress({
    taskId: taskId,
    type: P.EventType.STEP,
    step: { step: 'vpn_on', status: status, detail: detail || '' },
  });
}

function _alertEvent(taskId, message) {
  return P.makeProgress({ taskId: taskId, type: P.EventType.ALERT, message: message });
}

/**
 * 确保 Mihomo 「系统代理」已开启（步骤1）。
 * @param {{emit?:function, taskId?:string}} opts
 * @returns {Promise<{ok:boolean, error:?string, method:?string}>}
 */
async function ensureOn(opts) {
  opts = opts || {};
  const emit = opts.emit;
  const taskId = opts.taskId;

  const already = await isPortListening(PROXY_PORT);
  if (already) {
    if (emit) emit(_stepEvent(taskId, 'success', '7890 已监听，VPN 系统代理已处于开启状态'));
    return { ok: true, method: 'already', error: null };
  }

  if (!fs.existsSync(SCRIPT)) {
    const err = '未找到 vpn_toggle.py（' + SCRIPT + '）';
    if (emit) emit(_alertEvent(taskId, '⚠ ' + err + '，请手动在 Mihomo Party 点亮「系统代理」'));
    return { ok: false, method: null, error: err };
  }

  const py = findPython();
  if (!py) {
    const err = '本机未找到 python（需 pip install uiautomation，且在交互桌面会话运行）';
    if (emit) emit(_alertEvent(taskId, '⚠ ' + err + '，请手动在 Mihomo Party 点亮「系统代理」'));
    return { ok: false, method: null, error: err };
  }

  return new Promise((resolve) => {
    const child = spawn(py, [SCRIPT, '--on'], { windowsHide: true, timeout: 30000 });
    let errOut = '';
    child.stderr.on('data', (d) => (errOut += String(d)));
    child.on('error', (e) => {
      resolve({ ok: false, method: 'script', error: e.message });
    });
    child.on('close', async (code) => {
      const after = await isPortListening(PROXY_PORT);
      if (after) {
        if (emit) emit(_stepEvent(taskId, 'success', '已通过脚本点击开启 Mihomo 系统代理（7890 监听）'));
        resolve({ ok: true, method: 'script', error: null });
      } else {
        const err = '脚本退出码 ' + code + '，7890 仍未监听' + (errOut ? '：' + errOut.slice(0, 200) : '');
        if (emit) emit(_alertEvent(taskId, '⚠ ' + err + '，请手动在 Mihomo Party 点亮「系统代理」'));
        resolve({ ok: false, method: 'script', error: err });
      }
    });
  });
}

module.exports = { ensureOn, isPortListening, findPython, SCRIPT, PROXY_PORT };
