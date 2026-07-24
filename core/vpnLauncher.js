'use strict';

/**
 * core/vpnLauncher.js
 * ---------------------------------------------------------------------------
 * 谷歌任务「步骤1 · 确保 VPN 内核可用」。
 *
 * 重要认知（踩坑后修正）：
 *   autoclaw 的 Chrome 是用 --proxy-server=127.0.0.1:7890 直连 Mihomo 内核的，
 *   根本不读 Windows「系统代理」开关。所以“VPN 是否可用”的客观判据只有一个：
 *   **Mihomo 内核在不在跑、7890 在不在监听**。那个灰色的“系统代理”按钮点不点，
 *   对 Chrome 毫无影响——点它救不了谷歌，还可能误导。
 *
 * 因此本模块的“步骤1”逻辑是：
 *   1) 先 TCP 探 127.0.0.1:7890 —— 在监听就直接过（最常见情况，内核常驻）。
 *   2) 没监听 → 尝试拉起 Mihomo Party（让它把内核 sidecar 带起来），等几秒重测。
 *   3) 仍没监听 → 发明确告警：“请在 Mihomo Party 里启动内核”，绝不假装在“开 VPN”。
 *   4) （可选，默认关闭）极端情况下可开 AUTOCLAW_VPN_CLICK_SYSPROXY=1，
 *      再用 vpn_toggle.py 去点桌面“系统代理”按钮——但那只是 Windows 系统代理，
 *      对 Chrome 无效，仅作为兼容保留。
 *
 * 设计原则：永不抛异常；任何失败都降级为 { ok:false, error }，由上层告警，
 *           绝不阻断谷歌任务本身。
 */

const { spawn, spawnSync } = require('child_process');
const net = require('net');
const path = require('path');
const fs = require('fs');
const P = require('./progressEvent');

const PROXY_PORT = parseInt(process.env.AUTOCLAW_VPN_PROXY_PORT, 10) || 7890;
const SCRIPT = path.join(__dirname, '..', 'scripts', 'vpn_toggle.py');
// Mihomo Party 主程序（用于兜底拉起内核 sidecar）；可用环境变量覆盖
const MIHOMO_EXE = process.env.AUTOCLAW_MIHOMO_EXE
  || 'C:\\Program Files\\Mihomo Party\\Mihomo Party.exe';

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

/** Mihomo Party 主程序是否已在运行（按窗口标题/进程名粗判） */
function isMihomoPartyRunning() {
  try {
    const r = spawnSync('tasklist', ['/FI', 'IMAGENAME eq Mihomo Party.exe'], { timeout: 4000, windowsHide: true });
    if (r.error) return false;
    return /Mihomo Party\.exe/i.test(r.stdout ? String(r.stdout) : '');
  } catch (e) {
    return false;
  }
}

/** 兜底：拉起 Mihomo Party 主程序（让它把内核 sidecar 带起来）。非阻塞、best-effort。 */
function launchMihomoParty() {
  try {
    if (!fs.existsSync(MIHOMO_EXE)) return false;
    spawn('cmd.exe', ['/c', 'start', '', MIHOMO_EXE], { windowsHide: false, detached: true });
    return true;
  } catch (e) {
    return false;
  }
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

const ADVICE = '请在 Mihomo Party 中启动内核（点主界面的“开启/启动”），autoclaw 的 Chrome 走 127.0.0.1:'
  + PROXY_PORT + ' 直连内核，无需开启 Windows 系统代理。';

/**
 * 确保 Mihomo 内核可用（步骤1）。
 * @param {{emit?:function, taskId?:string}} opts
 * @returns {Promise<{ok:boolean, error:?string, method:?string}>}
 */
async function ensureOn(opts) {
  opts = opts || {};
  const emit = opts.emit;
  const taskId = opts.taskId;

  // 1) 内核已在跑（7890 监听）—— 直接过，绝大多数情况走这里
  const already = await isPortListening(PROXY_PORT);
  if (already) {
    if (emit) emit(_stepEvent(taskId, 'success', 'Mihomo 内核已在运行（7890 监听），VPN 出口可用'));
    return { ok: true, method: 'already', error: null };
  }

  // 2) 没监听 → 兜底拉起 Mihomo Party（让它带起内核 sidecar）
  if (!isMihomoPartyRunning()) {
    const launched = launchMihomoParty();
    if (emit && launched) emit(_stepEvent(taskId, 'running', '7890 未监听，正在拉起 Mihomo Party 以启动内核…'));
    // 给内核 sidecar 启动留时间
    await new Promise((r) => setTimeout(r, 5000));
    const afterLaunch = await isPortListening(PROXY_PORT);
    if (afterLaunch) {
      if (emit) emit(_stepEvent(taskId, 'success', '已拉起 Mihomo Party，内核启动、7890 监听'));
      return { ok: true, method: 'launched', error: null };
    }
  }

  // 3) 仍没监听 → 可选：开 AUTOCLAW_VPN_CLICK_SYSPROXY 时，用脚本点“系统代理”（仅 Windows 系统代理，对 Chrome 无效，保留兼容）
  if (process.env.AUTOCLAW_VPN_CLICK_SYSPROXY === '1' && fs.existsSync(SCRIPT)) {
    const py = findPython();
    if (py) {
      await new Promise((resolve) => {
        const child = spawn(py, [SCRIPT, '--on'], { windowsHide: true, timeout: 30000 });
        child.on('error', () => resolve());
        child.on('close', () => resolve());
      });
      const after = await isPortListening(PROXY_PORT);
      if (after) {
        if (emit) emit(_stepEvent(taskId, 'success', '已通过脚本点击系统代理（7890 监听）'));
        return { ok: true, method: 'script', error: null };
      }
    }
  }

  // 4) 彻底不行 → 明确告警（说真话：是内核没起，不是系统代理）
  const err = 'Mihomo 内核未启动（7890 未监听）';
  if (emit) emit(_alertEvent(taskId, '⚠ ' + err + '，' + ADVICE));
  return { ok: false, method: null, error: err };
}

module.exports = { ensureOn, isPortListening, findPython, isMihomoPartyRunning, launchMihomoParty, SCRIPT, MIHOMO_EXE, PROXY_PORT };
