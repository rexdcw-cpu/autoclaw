'use strict';

/**
 * core/wifiManager.js
 * ---------------------------------------------------------------------------
 * WiFi 检测与切换（Windows netsh 封装）。把「检测可连 WiFi + 输密码切换」做成
 * autoclaw 控制台的一个功能，复用本机无线网卡。
 *
 * 设计要点：
 *   - netsh 输出在中文 Windows 下为 GBK；用 `chcp 65001` 让其以 UTF-8 输出，
 *     再以 utf8 解码，避免中文 SSID / 中文标签乱码。
 *   - 兼容中英文标签（身份验证/Authentication、加密/Encryption、信号/Signal）。
 *   - 安全类型归一化：WPA2 个人→WPA2PSK/AES、WPA3→WPA3SAE/AES、WPA 个人→WPAPSK、
 *     开放→open/none；企业 802.1X 识别为不支持。
 *   - 生成的 WLAN 配置 XML 带 UTF-8 BOM（netsh 才能解析中文 SSID），并对
 *     SSID / 密码做 XML 转义。
 *   - connect 仅对「当前用户」添加配置文件（user=current），通常无需管理员权限。
 *
 * 仅依赖 child_process / fs / os / path，无第三方依赖。
 */

const { exec } = require('child_process');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * 执行 netsh 命令，返回合并后的文本输出（stdout+stderr）。
 * 前置 chcp 65001 让 netsh 以 UTF-8 输出，便于解析中文。
 * @param {string} args netsh 的子命令，如 'show networks mode=bssid'
 * @returns {Promise<string>}
 */
function runNetsh(args) {
  const cmd = 'chcp 65001 >nul && netsh wlan ' + args;
  return execSafe(cmd, { timeoutMs: 20000 }).then((r) => r.out);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 安全执行外部命令（netsh / powershell 等）。
 * 关键：带硬超时，超时即杀子进程并 resolve（绝不 hang / 绝不 throw）。
 * 背景：异常网络状态下 netsh / wlanconnect.ps1 可能永不退出（如本机 Add-Type
 * 编译卡死、WlanConnect 阻塞），若用裸 exec 且回调永远 resolve，promise 会永久
 * 挂起，拖垮整个任务（被 10 分钟看门狗 SIGKILL，表现为「静默假失败」）。
 * 故统一走 execSafe，超时兜底强制结束。
 * @param {string} cmd
 * @param {object} [opts] { timeoutMs? }
 * @returns {Promise<{out:string, err:Error|null, timedOut:boolean}>}
 */
function execSafe(cmd, opts) {
  const o = opts || {};
  const timeoutMs = o.timeoutMs || 20000;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (val) => {
      if (settled) return;
      settled = true;
      resolve(val);
    };
    let cp;
    try {
      cp = exec(
        cmd,
        { encoding: 'utf8', maxBuffer: 1024 * 1024, windowsHide: true, timeout: timeoutMs },
        (err, stdout, stderr) => {
          finish({ out: ((stdout || '') + (stderr || '')), err: err || null, timedOut: !!(err && err.killed) });
        },
      );
    } catch (e) {
      finish({ out: '', err: e, timedOut: false });
      return;
    }
    // 双保险：即便 exec 的 timeout 选项未触发，也强制在超时 + 缓冲后兜底结束子进程
    const guard = setTimeout(() => {
      if (settled) return;
      try { if (cp && cp.pid) cp.kill('SIGKILL'); } catch (_) { /* ignore */ }
      finish({ out: '', err: new Error('exec guard timeout'), timedOut: true });
    }, timeoutMs + 5000);
    if (guard.unref) guard.unref();
  });
}

function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

function escapeXml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 探测无线网卡接口名（中文常见 WLAN / 英文 Wi-Fi）。 */
async function getInterface() {
  const out = await runNetsh('show ifaces');
  const m = out.match(/名称\s*:\s*(\S+)/) || out.match(/Name\s*:\s*(\S+)/);
  return m ? m[1] : 'WLAN';
}

/** 返回当前已连接 SSID（未连接返回 ''）。 */
async function getCurrentSsid(iface) {
  iface = iface || (await getInterface());
  const out = await runNetsh('show interfaces interface="' + iface + '"');
  const m = out.match(/^\s*SSID\s*:\s*(.+)$/m);
  const st = out.match(/状态\s*:\s*(.+)$/m) || out.match(/State\s*:\s*(.+)$/m);
  const connected =
    !!st && (st[1].includes('已连接') || st[1].toLowerCase().includes('connected'));
  return m && connected ? m[1].trim() : '';
}

/**
 * 解析 netsh 可见网络列表（逐行、锚定行首，避免把 BSSID 误当 SSID 切分）。
 * @param {string} out `netsh wlan show networks mode=bssid` 的输出
 * @returns {Array<{ssid:string, auth:string, enc:string, signal:number}>}
 */
function parseNetworks(out) {
  const lines = String(out || '').split(/\r?\n/);
  const nets = [];
  let cur = null;
  const ssidRe = /^\s*SSID\s+\d+\s*:\s*(.+?)\s*$/;
  const authRe = /^\s*(?:身份验证|Authentication)\s*:\s*(.+?)\s*$/;
  const encRe = /^\s*(?:加密|Encryption)\s*:\s*(.+?)\s*$/;
  const sigRe = /^\s*(?:信号|Signal)\s*:\s*(\d+)%/;
  for (const line of lines) {
    const sm = line.match(ssidRe);
    if (sm) {
      const name = sm[1].trim();
      if (!name) {
        cur = null; // 隐藏网络：后续字段忽略，直到下一个有效 SSID
        continue;
      }
      cur = { ssid: name, auth: '', enc: '', signal: 0 };
      nets.push(cur);
      continue;
    }
    if (!cur) continue;
    const am = line.match(authRe);
    if (am) {
      cur.auth = am[1].trim();
      continue;
    }
    const em = line.match(encRe);
    if (em) {
      cur.enc = em[1].trim();
      continue;
    }
    const sg = line.match(sigRe);
    if (sg) {
      const v = parseInt(sg[1], 10);
      if (v > cur.signal) cur.signal = v; // 多 BSSID 取最强信号
      continue;
    }
  }
  // 同名 SSID 去重（2.4G/5G 同名的多个 AP），保留信号最强
  const best = {};
  for (const n of nets) {
    if (!best[n.ssid] || n.signal > best[n.ssid].signal) best[n.ssid] = n;
  }
  return Object.keys(best).map((k) => best[k]);
}

/**
 * 把 netsh 的认证/加密描述归一化为 { authentication, encryption }。
 * 企业网络（需账号/证书）返回 null（本模块不支持）。
 */
function normalizeSecurity(authRaw, encRaw) {
  const a = (authRaw || '').toLowerCase();
  const e = (encRaw || '').toUpperCase();

  if (
    a.includes('open') ||
    (authRaw || '').includes('开放式') ||
    ['', '无', 'none'].includes(a.trim())
  ) {
    return { authentication: 'open', encryption: 'none' };
  }
  // 企业网络（需账号/证书）——不支持
  if (
    (authRaw || '').includes('企业') ||
    a.includes('enterprise') ||
    a.includes('802.1x') ||
    a.includes('802.1')
  ) {
    return null;
  }

  const encNorm = e.includes('TKIP') ? 'TKIP' : 'AES';
  if (a.includes('wpa3')) return { authentication: 'WPA3SAE', encryption: 'AES' };
  if (a.includes('wpa2')) return { authentication: 'WPA2PSK', encryption: encNorm };
  if (a.includes('wpa')) return { authentication: 'WPAPSK', encryption: encNorm };
  return null;
}

/**
 * 隐藏网络的候选安全类型列表（供 connect 的 hidden 分支使用）。
 * 覆盖 WPA2/AES、WPA3/AES、WPA2/TKIP、WPA1/TKIP、WPA1/AES。
 * 旧实现只试 WPAPSK/AES，缺 TKIP，导致 WPA1/TKIP 隐藏网（如 ROSNET2~5/10~12）连不上。
 * 注意：不能只用「已存 profile 的安全类型」——netsh 的 profile 信息只报
 * 「WPA - 个人」不含 TKIP 细节，normalizeSecurity 默认 AES，反而连不上 TKIP 网；
 * 因此统一用含 TKIP 的候选列表逐个尝试，由系统决定哪个能连。
 * @param {string} [password]
 * @returns {Array<{authentication:string, encryption:string}>}
 */
function hiddenCandidates(password) {
  if (!password) return [{ authentication: 'open', encryption: 'none' }];
  return [
    { authentication: 'WPA2PSK', encryption: 'AES' },
    { authentication: 'WPA3SAE', encryption: 'AES' },
    { authentication: 'WPA2PSK', encryption: 'TKIP' },
    { authentication: 'WPAPSK', encryption: 'TKIP' },
    { authentication: 'WPAPSK', encryption: 'AES' },
  ];
}

/**
 * 生成 WLAN 配置文件 XML（带 UTF-8 BOM 由调用方写入）。
 * @param {object} [opts]
 * @param {boolean} [opts.nonBroadcast] 隐藏网络（不广播 SSID）必须置 true，
 *        否则 Windows 只在「扫描到该 SSID 广播」时才连接，隐藏网永远连不上。
 */
function buildProfileXml(ssid, authentication, encryption, password, opts) {
  const nonBroadcast = !!(opts && opts.nonBroadcast);
  let security;
  if (authentication === 'open') {
    security =
      '            <authEncryption>\n' +
      '                <authentication>open</authentication>\n' +
      '                <encryption>none</encryption>\n' +
      '                <useOneX>false</useOneX>\n' +
      '            </authEncryption>';
  } else {
    security =
      '            <authEncryption>\n' +
      '                <authentication>' +
      escapeXml(authentication) +
      '</authentication>\n' +
      '                <encryption>' +
      escapeXml(encryption) +
      '</encryption>\n' +
      '                <useOneX>false</useOneX>\n' +
      '            </authEncryption>\n' +
      '            <sharedKey>\n' +
      '                <keyType>passPhrase</keyType>\n' +
      '                <protected>false</protected>\n' +
      '                <keyMaterial>' +
      escapeXml(password || '') +
      '</keyMaterial>\n' +
      '            </sharedKey>';
  }

  return (
    '<?xml version="1.0"?>\n' +
    '<WLANProfile xmlns="http://www.microsoft.com/networking/WLAN/profile/v1">\n' +
    '    <name>' +
    escapeXml(ssid) +
    '</name>\n' +
    '    <SSIDConfig>\n' +
    '        <SSID>\n' +
    '            <name>' +
    escapeXml(ssid) +
    '</name>\n' +
    '        </SSID>\n' +
    (nonBroadcast ? '        <nonBroadcast>true</nonBroadcast>\n' : '') +
    '    </SSIDConfig>\n' +
    '    <connectionType>ESS</connectionType>\n' +
    '    <connectionMode>auto</connectionMode>\n' +
    '    <MSM>\n' +
    '        <security>\n' +
    security +
    '\n' +
    '        </security>\n' +
    '    </MSM>\n' +
    '</WLANProfile>\n'
  );
}

/** 列出当前可见 WiFi（含 secured 标志）。 */
async function listNetworks(iface) {
  iface = iface || (await getInterface());
  const out = await runNetsh('show networks interface="' + iface + '" mode=bssid');
  const nets = parseNetworks(out);
  nets.forEach((n) => {
    const s = normalizeSecurity(n.auth, n.enc);
    n.secured = !!(s && s.authentication !== 'open');
  });
  return nets;
}

/**
 * 切换到指定 WiFi。
 * @param {string} ssid
 * @param {string} password 仅 secured 网络需要
 * @param {object} [opts]
 * @param {boolean} [opts.hidden] 隐藏网络（不广播 SSID）：跳过「必须可见」检查，
 *        按个人网常见安全类型依次尝试直连。
 * @returns {Promise<{ok:boolean, code?:string, message:string, diagnostics?:object}>}
 */
async function connect(ssid, password, opts) {
  opts = opts || {};
  const iface = await getInterface();
  const nets = await listNetworks(iface);
  const net = nets.find((n) => n.ssid === ssid);

  let candidates;
  if (net) {
    const sec = normalizeSecurity(net.auth, net.enc);
    if (!sec) {
      return {
        ok: false,
        code: 'ERR_WIFI_UNSUPPORTED',
        message: '『' + ssid + '』是企业网络（需账号/证书），暂不支持',
      };
    }
    // 本机已有保存凭证 → 无需重新输密码，直接无密码直连（与 hidden 分支一致）。
    // 否则可见加密网没填密码就只会报「该网络需要密码」，即便本机明明存了密码。
    let savedInfo = null;
    try {
      savedInfo = await getProfileInfo(ssid);
    } catch (e) {
      /* 读取失败按无 profile 处理 */
    }
    if (savedInfo && !password) {
      return await connectSaved(ssid);
    }
    if (sec.authentication !== 'open' && !password) {
      return { ok: false, code: 'ERR_WIFI_NEED_PASSWORD', message: '该网络需要密码' };
    }
    candidates = [sec];
  } else if (opts.hidden) {
    // 隐藏网络：未出现在扫描中，无法自动判定安全类型。
    // 已存 profile 且用户未手输密码 → 直接连已存 profile（安全类型 100% 正确，隐藏网也适用）；
    // 否则用真实安全类型（若有 profile）或常见组合（含 WPA1/TKIP）尝试。
    let savedInfo = null;
    try {
      savedInfo = await getProfileInfo(ssid);
    } catch (e) {
      /* 读取失败按无 profile 处理 */
    }
    if (savedInfo && !password) {
      const sec = normalizeSecurity(savedInfo.auth, '');
      if (sec) return await connectSaved(ssid);
    }
    candidates = hiddenCandidates(password);
  } else {
    return {
      ok: false,
      code: 'ERR_WIFI_NOT_FOUND',
      message: '未找到网络『' + ssid + '』，可能已不在范围内',
    };
  }

  let lastDiag = null;
  for (const sec of candidates) {
    if (!net && opts.hidden) {
      // 隐藏网按候选逐个尝试时，必须先清掉上一个候选写下的 profile，
      // 否则后续候选（如 WPA3/TKIP）的 add 会因「已存在」冲突被吞，
      // 导致那些安全类型永远不被真正尝试 → 非 WPA2 的隐藏网永远连不上。
      try {
        await runNetsh('delete profile name="' + ssid + '"');
      } catch (e) {
        /* 无 profile 时忽略 */
      }
    }
    // 隐藏网络（扫描不到、由调用方声明 hidden）必须写 nonBroadcast，否则
    // Windows 不会主动探测该 SSID，profile 建了也连不上。
    const xml = buildProfileXml(ssid, sec.authentication, sec.encryption, password || '', {
      nonBroadcast: !net && !!opts.hidden,
    });
    const tmp = path.join(os.tmpdir(), '_autoclaw_wifi_' + Math.abs(hashStr(ssid)) + '.xml');
    // UTF-8 BOM：netsh 才能正确解析含中文的 SSID
    fs.writeFileSync(tmp, '﻿' + xml, 'utf8');
    try {
      const add = await runNetsh(
        'add profile filename="' + tmp + '" user=current interface="' + iface + '"',
      );
      // 隐藏网络：netsh connect 不做定向探测（且不支持 ssid= 参数），必须用
      // WlanConnect API 显式带 SSID 才会主动 probe 该隐藏 SSID。可见网络仍走
      // netsh connect（更快、行为不变）。
      // 隐藏网 profile 已带 nonBroadcast，netsh connect 会主动探测该 SSID，无需 C#/WlanConnect。
      const conn = await runNetsh(
        'connect name="' + ssid + '" interface="' + iface + '"',
      );
      for (let i = 0; i < 8; i++) {
        const cur = await getCurrentSsid(iface);
        if (cur === ssid) {
          return {
            ok: true,
            message:
              '已连接到『' + ssid + '』' +
              (candidates.length > 1 ? '（' + sec.authentication + '）' : ''),
          };
        }
        await sleep(1000);
      }
      lastDiag = {
        authentication: sec.authentication,
        add: add,
        conn: conn,
        note: 'connected-but-ssid-not-current',
      };
    } catch (e) {
      // 该安全类型的 profile 不被系统支持（如旧系统无 WPA3SAE），
      // 或 connect 即时失败：记录诊断并继续下一个候选，而不是抛出导致 HTTP 500。
      lastDiag = { authentication: sec.authentication, error: String((e && e.message) || e) };
    } finally {
      try {
        fs.unlinkSync(tmp);
      } catch (e) {
        /* 忽略清理失败 */
      }
    }
  }
  return {
    ok: false,
    code: 'ERR_WIFI_CONNECT_FAILED',
    message: '连接未完成（可能是密码错误、信号太弱，或本机不支持该安全类型）',
    diagnostics: lastDiag,
  };
}

/**
 * 列出本机已保存（含凭证）的 WIFI 配置文件名。
 * @returns {Promise<Set<string>>}
 */
async function listSavedProfiles() {
  const out = await runNetsh('show profiles');
  const set = new Set();
  const re = /(?:所有用户配置文件|当前用户配置文件|Current User Profile|All User Profile)\s*:\s*(.+)/;
  String(out || '')
    .split(/\r?\n/)
    .forEach((line) => {
      const m = line.match(re);
      if (m && m[1].trim()) set.add(m[1].trim());
    });
  return set;
}

/** netsh「网络广播」行：已标记隐藏时显示「即使网络未广播也连接」。 */
const HIDDEN_MARK_RE =
  /即使网络未广播也连接|即使此网络未进行广播也连接|Connect even if this network is not broadcasting/i;

/**
 * 读取单个 WLAN 配置文件信息。
 * @param {string} ssid
 * @returns {Promise<null|{ssid:string, hidden:boolean, auth:string}>} 无此配置文件返回 null
 */
async function getProfileInfo(ssid) {
  const text = String((await runNetsh('show profile name="' + ssid + '"')) || '');
  // 有效 profile 输出必含「网络广播 / SSID 名称」字段；否则视为不存在
  if (!/(网络广播|Network broadcast|SSID 名称|SSID name)/i.test(text)) return null;
  const am = text.match(/(?:身份验证|Authentication)\s*:\s*(.+)/);
  return {
    ssid: ssid,
    hidden: HIDDEN_MARK_RE.test(text),
    auth: am ? am[1].trim() : '',
  };
}

/**
 * 列出本机已存 WLAN 配置文件及其状态。
 * hidden=是否已标记「即使不广播也连接」，visible=当前扫描是否可见。
 * @returns {Promise<Array<{ssid:string, hidden:boolean, visible:boolean, auth:string}>>}
 */
async function listSavedProfilesDetailed() {
  const saved = Array.from(await listSavedProfiles());
  let visibleSet = new Set();
  try {
    const visible = await listNetworks();
    visibleSet = new Set(visible.map((n) => n.ssid));
  } catch (e) {
    /* 扫描失败则全部按不可见处理，不影响列表本身 */
  }
  const out = [];
  for (const ssid of saved) {
    let info = null;
    try {
      info = await getProfileInfo(ssid);
    } catch (e) {
      /* 单条读取失败不影响整体 */
    }
    out.push({
      ssid: ssid,
      hidden: !!(info && info.hidden),
      visible: visibleSet.has(ssid),
      auth: (info && info.auth) || '',
    });
  }
  return out;
}

/**
 * 把本机已存的 WLAN 配置文件标记为「隐藏网络」（nonBroadcast=true）。
 *
 * 隐藏 WiFi 不广播 SSID，若 profile 未标记 nonBroadcast，Windows 只在扫描到广播
 * 时才连接 → 隐藏网永远连不上（表现为「信号弱或凭证失效」）。
 * 做法：导出现有 profile（key=clear 保留密码）→ 注入/改写 nonBroadcast → 重新
 * 导入覆盖，安全类型与密码原样保留，用户无需重新输入。
 *
 * @param {string} ssid
 * @param {boolean} [hidden=true] 传 false 可撤销标记
 * @returns {Promise<{ok:boolean, ssid:string, changed?:boolean, hidden?:boolean, code?:string, message:string, diagnostics?:object}>}
 */
async function markProfileHidden(ssid, hidden) {
  const want = hidden !== false;
  const iface = await getInterface();
  const before = await getProfileInfo(ssid);
  if (!before) {
    return {
      ok: false,
      ssid: ssid,
      code: 'ERR_WIFI_PROFILE_NOT_FOUND',
      message: '本机没有『' + ssid + '』的配置文件',
    };
  }
  if (before.hidden === want) {
    return {
      ok: true,
      ssid: ssid,
      changed: false,
      hidden: want,
      message: '『' + ssid + '』已是' + (want ? '隐藏' : '普通') + '标记，无需改动',
    };
  }

    // 关键修复：直接改 nonBroadcast 标记，不导出 / 不重新导入 profile。
  // 旧实现「导出 → 改写 → 重导」在本机禁止 key=clear 明文导出时，会把密码
  // （DPAPI 加密的 keyMaterial）一并重导，导致密码损坏、隐藏网连不上
  // （表现为 ROSNET1 连上又断、ROSNET2 直接「无法用于连接」）。
  // set profileparameter 由 Windows 原生支持，只改这一个标记，密码与安全类型原样保留。
  const ifaceArg = iface ? ' interface="' + iface + '"' : '';
  await runNetsh(
    'set profileparameter name="' + ssid + '"' + ifaceArg + ' nonBroadcast=' + (want ? 'yes' : 'no'),
  );
  const after = await getProfileInfo(ssid);
  if (after && after.hidden === want) {
    return {
      ok: true,
      ssid: ssid,
      changed: true,
      hidden: want,
      message: '『' + ssid + '』已标记为' + (want ? '隐藏' : '普通') + '网络',
    };
  }
  return {
    ok: false,
    ssid: ssid,
    code: 'ERR_WIFI_MARK_FAILED',
    message: '『' + ssid + '』标记未生效（可能需要管理员权限）',
    diagnostics: { before: before.hidden, after: after ? after.hidden : null },
  };
}

/**
 * 取「可见且本机已保存凭证」的 WIFI 列表（顺序同前端可见列表）。
 * 这些 WIFI 可无密码直连（netsh wlan connect），即轮询所需的「可用 WIFI」。
 * @returns {Promise<string[]>}
 */
async function getConnectableNetworks() {
  // 候选 = 本机已保存凭证（可无密码直连）的全部 WIFI（Windows 配置文件）。
  const saved = await listSavedProfiles();
  // 关键修正：只保留「当前可见（在范围内）」的已存配置文件。
  // netsh 的 show profiles 会把本机所有历史配置文件都列出来，包括早已搬走、
  // 信号范围外、或 Windows 自动记下的网络——这些网络切过去必然失败
  // （connectSaved 8s 轮询后报「信号弱或凭证失效」），纳入轮询只会白白占一轮
  // 并拉低完成率。连不上的网络本就不应出现在序列里。
  // 因此与当前扫描到的可见网络取交集，序列=「当前能搜到且本机有凭证」的 WIFI。
  //
  // 例外：标记了 nonBroadcast 的隐藏网络本就不会出现在扫描结果里，但凭 profile 名
  // 可以直连（实测 2~3s 连上），必须保留，否则隐藏网永远进不了轮询。
  const visible = await listNetworks();
  const visibleSet = new Set(visible.map((n) => n.ssid));
  const hiddenSet = new Set();
  for (const ssid of saved) {
    if (visibleSet.has(ssid)) continue;
    try {
      const info = await getProfileInfo(ssid);
      if (info && info.hidden) hiddenSet.add(ssid);
    } catch (e) {
      /* 单条读取失败按不可用处理 */
    }
  }
  const arr = Array.from(saved).filter((ssid) => visibleSet.has(ssid) || hiddenSet.has(ssid));
  // 当前已连的置顶作为轮询起点（当前网络一定在可见集合里，故必被保留）。
  const cur = await getCurrentSsid();
  if (cur && arr.includes(cur)) {
    const idx = arr.indexOf(cur);
    if (idx > 0) {
      arr.splice(idx, 1);
      arr.unshift(cur);
    }
  }
  return arr;
}

/**
 * 用 WlanConnect Win32 API 显式带上 SSID 做「定向探测」后连接。
 *
 * 这是隐藏 WiFi 能连上的唯一可靠方式：netsh 的 `wlan connect` 不向系统传入
 * SSID（其语法只有 name/interface，所谓 `ssid=` 参数被静默忽略），因此 Windows
 * 只对「扫描缓存里已有的 SSID」发起连接；隐藏网的 SSID 在缓存里是空的，于是
 * 永远报 "not available to connect"。connectionMode=auto 也不会自动连（实测等
 * 90s 无果）。必须走 WlanConnect 并传 pDot11Ssid，Windows 才会主动 probe 该 SSID。
 *
 * 通过 PowerShell 调用 wlanapi.dll 的 P/Invoke 实现（Windows 自带，无额外运行时
 * 依赖）。脚本内部会先精简自身环境变量，避免在环境块被撑大的 shell 里 Add-Type
 * 因超过 65535 字节上限而失败。
 *
 * @param {string} ssid
 * @param {object} [opts] { interface?, timeout? }
 * @returns {Promise<{ok:boolean, code?:string, message:string, diagnostics?:object}>}
 */
const PS_WLANCONNECT = path.join(__dirname, 'wlanconnect.ps1');

async function wlanConnectDirected(ssid, opts) {
  opts = opts || {};
  const timeout = opts.timeout || 30;
  const cli = [
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', PS_WLANCONNECT,
    '-Profile', ssid,
    '-Ssid', ssid,
    '-Timeout', String(timeout),
  ];
  const quoted = cli.map((a) => '"' + String(a).replace(/"/g, '\\"') + '"').join(' ');
  return new Promise((resolve) => {
    // execSafe 自带硬超时：即便 wlanconnect.ps1 内部 Add-Type 编译卡死 / WlanConnect 阻塞，
    // 也会在超时后被杀并 resolve 失败，绝不会让调用方（connectSaved）无限挂起。
    execSafe('powershell ' + quoted, { timeoutMs: (timeout + 15) * 1000 }).then((r) => {
      const out = r.out.trim();
      if (/OK:\s*connected/i.test(out)) {
        resolve({ ok: true, message: '已连接到『' + ssid + '』（定向探测）' });
        return;
      }
      const m = out.match(/FAIL:\s*(.+)$/m);
      resolve({
        ok: false,
        code: 'ERR_WIFI_CONNECT_FAILED',
        message: m ? m[1].trim() : (r.timedOut ? 'WlanConnect 调用超时（已兜底终止子进程）' : (out || 'WlanConnect 调用失败')),
        diagnostics: { raw: out, timedOut: r.timedOut },
      });
    });
  });
}

/**
 * 切换到本机已保存凭证的 WIFI（无需密码，直接 netsh wlan connect）。
 * 隐藏网络：netsh connect 不做定向探测会失败，自动回退到 WlanConnect 显式带 SSID。
 * @param {string} ssid
 * @returns {Promise<{ok:boolean, code?:string, message:string}>}
 */
async function connectSaved(ssid) {
  const iface = await getInterface();
  let hidden = false;
  try {
    const info = await getProfileInfo(ssid);
    hidden = !!(info && info.hidden);
  } catch (e) {
    /* 读取失败按非隐藏 */
  }
  // 主路径：netsh wlan connect。隐藏网 profile 已标记 nonBroadcast，netsh 会主动
  // 探测未广播的 SSID（与 Windows 手动连同源）；实测本机 ROSNET 系列可正常切换。
  // 旧实现对隐藏网走 WlanConnect Win32 API（wlanconnect.ps1 / Add-Type 编译 C#），
  // 但本机 Add-Type 调 csc.exe 编译失败（FileNotFound，DLL 未生成）→ 类型不存在 →
  // 整条路径不可用，所有隐藏网切换失败、任务被标 failed。故统一走 netsh 主路径，
  // WlanConnect 仅作兜底。
  const conn = await runNetsh('connect name="' + ssid + '" interface="' + iface + '"');
  for (let i = 0; i < 8; i += 1) {
    const cur = await getCurrentSsid(iface);
    if (cur === ssid) return { ok: true, message: '已连接到『' + ssid + '』' };
    await sleep(1000);
  }
  // 兜底：netsh 未连上（个别纯隐藏网/缓存异常）时，再试 WlanConnect API 定向探测。
  if (hidden) {
    const d = await wlanConnectDirected(ssid, { timeout: 20 });
    if (d.ok) return d;
    return {
      ok: false,
      code: 'ERR_WIFI_CONNECT_FAILED',
      message: '切换至『' + ssid + '』未完成（信号弱或凭证失效）',
      diagnostics: { conn, wlanConnect: d },
    };
  }
  return {
    ok: false,
    code: 'ERR_WIFI_CONNECT_FAILED',
    message: '切换至『' + ssid + '』未完成（信号弱或凭证失效）',
    diagnostics: { conn },
  };
}

module.exports = {
  runNetsh,
  runNetshRaw,
  getInterface,
  getCurrentSsid,
  parseNetworks,
  normalizeSecurity,
  hiddenCandidates,
  buildProfileXml,
  listNetworks,
  connect,
  listSavedProfiles,
  getProfileInfo,
  listSavedProfilesDetailed,
  markProfileHidden,
  getConnectableNetworks,
  connectSaved,
  wlanConnectDirected,
  getLocalIp,
  getWifiLocalIp,
  getPublicGeo,
  getCurrentInfo,
  parseLocalIp,
};

/**
 * 通用 netsh 调用（不限定 wlan 子命令），用于取本地 IP 等。
 * @param {string} args 如 'interface ipv4 show addresses'
 * @returns {Promise<string>}
 */
function runNetshRaw(args) {
  const cmd = 'chcp 65001 >nul && netsh ' + args;
  return execSafe(cmd, { timeoutMs: 20000 }).then((r) => r.out);
}

/**
 * 从 `netsh interface ipv4 show addresses` 输出里取「当前出口」的本地 IPv4。
 * 规则：挑「有默认网关」且 InterfaceMetric 最小的接口（即当前活跃出口），
 * 兼容 WLAN 被桥接的场景（IP 落在网桥上）。
 * @param {string} out
 * @returns {string} 如 '192.168.1.187'，无则 ''
 */
function parseLocalIp(out) {
  const blocks = String(out || '').split(/Configuration for interface\s+/);
  let best = null;
  for (let i = 1; i < blocks.length; i++) {
    const b = blocks[i];
    const ipm = b.match(/IP Address:\s*([\d.]+)/);
    const gw = b.match(/Default Gateway:\s*([\d.]+)/);
    if (!ipm || !gw) continue; // 无 IP 或无默认网关（Loopback / 未连接）
    const metricM = b.match(/InterfaceMetric:\s*(\d+)/);
    const metric = metricM ? parseInt(metricM[1], 10) : 9999;
    if (!best || metric < best.metric) best = { ip: ipm[1], metric: metric };
  }
  return best ? best.ip : '';
}

/** 取当前出口本地 IPv4（失败返回 ''）。 */
async function getLocalIp() {
  try {
    const out = await runNetshRaw('interface ipv4 show addresses');
    return parseLocalIp(out);
  } catch (e) {
    return '';
  }
}

/**
 * 取「当前 WiFi 网卡」的本地 IPv4 —— 即切换 WiFi 后应当更新的那个 IP。
 * 与 getLocalIp（取机器默认出口 IP，可能来自网线/以太网）不同，这里明确锁定 WLAN 接口：
 *   - 若 WLAN 适配器自身有 IP（未桥接），直接返回；
 *   - 若 WLAN 被桥接（适配器无独立 IP，IP 落在网桥上），取该网桥的 IP。
 * 这样切换 WiFi 后此值会随新连接变化，而不是恒为网线 IP。
 * 兼容中英文 netsh 输出（「接口 "网桥" 的配置」/「IP 地址:」）。
 * @param {string} iface WLAN 接口名（如 'WLAN'）
 * @returns {Promise<string>}
 */
async function getWifiLocalIp(iface) {
  try {
    const ipRe = /(?:IP\s*地址|IP Address)\s*:\s*([\d.]+)/i;
    // 1) WLAN 适配器自身 IP（未桥接场景）
    const selfOut = await runNetshRaw('interface ipv4 show addresses "' + iface + '"');
    const selfM = selfOut.match(ipRe);
    if (selfM) return selfM[1];
    // 2) 桥接场景：WLAN 无独立 IP，IP 在其所属网桥上。取网桥（bridge）接口的 IP。
    const all = await runNetshRaw('interface ipv4 show addresses');
    const blocks = all.split(/(?=接口\s+"|Configuration for interface)/);
    for (const b of blocks) {
      const nameM = b.match(/接口\s+"([^"]+)"\s*的配置|Configuration for interface\s+"?([^"\r\n]+)/);
      const name = (nameM && (nameM[1] || nameM[2]) ? nameM[1] || nameM[2] : '').trim();
      const ipM = b.match(ipRe);
      if (ipM && /网桥|bridge/i.test(name)) {
        return ipM[1];
      }
    }
    return '';
  } catch (e) {
    return '';
  }
}

/**
 * 极简 HTTPS GET 文本，带超时与单次结算，永不抛异常。
 * 返回 { ok, status, text, error }。
 */
function httpGetText(urlStr, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (!done) {
        done = true;
        resolve(v);
      }
    };
    let req;
    try {
      const u = new URL(urlStr);
      req = https.get(
        u,
        {
          timeout: timeoutMs || 6000,
          headers: { 'User-Agent': 'autoclaw/1.0', Accept: 'application/json, text/plain' },
        },
        (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => {
            finish({ ok: true, status: res.statusCode, text: data });
          });
        },
      );
      req.on('timeout', () => {
        try {
          req.destroy();
        } catch (e) {
          /* ignore */
        }
        finish({ ok: false, status: 0, text: '', error: '请求超时' });
      });
      req.on('error', (e) => finish({ ok: false, status: 0, text: '', error: e.message }));
    } catch (e) {
      finish({ ok: false, status: 0, text: '', error: e.message });
    }
  });
}

/**
 * 公网 IP / 归属地服务商列表（按顺序尝试，直到取到有效 IP）。
 * 默认首选 myip.ipip.net（中文文本，国内可达性好，如「中国 广东 肇庆 联通」）；
 * 备用 ipinfo.io（结构化 JSON，含城市/地区/国家/运营商，免 token）；
 * 再备 ipapi.co（常被 Cloudflare 拦截）。
 * 可用环境变量 AUTOCLAW_GEO_API 覆盖首选服务地址（不影响备用）。
 */
const GEO_PROVIDERS = [
  {
    name: 'myip.ipip.net',
    url: () => process.env.AUTOCLAW_GEO_API || 'https://myip.ipip.net',
    parse: (text) => {
      const ipm = text.match(/IP[：:]\s*([0-9a-fA-F:.]+)/);
      const cm = text.match(/来自于[：:]\s*(.+?)\s*$/m);
      let region = '';
      let country = '';
      let city = '';
      let org = '';
      if (cm) {
        const parts = cm[1].trim().split(/\s+/);
        country = parts[0] || '';
        region = parts[1] || '';
        city = parts[2] || '';
        org = parts.slice(3).join(' ') || '';
      }
      return { ip: ipm ? ipm[1] : '', region, country, city, org };
    },
  },
  {
    name: 'ipinfo.io',
    url: () => 'https://ipinfo.io/json',
    parse: (text) => {
      const b = JSON.parse(text);
      if (b.error) throw new Error(typeof b.error === 'string' ? b.error : 'ipinfo 返回错误');
      return {
        ip: b.ip || '',
        region: b.region || b.regionName || '',
        country: b.country || b.country_code || '',
        city: b.city || '',
        org: b.org || b.asn || '',
      };
    },
  },
  {
    name: 'ipapi.co',
    url: () => 'https://ipapi.co/json/',
    parse: (text) => {
      const b = JSON.parse(text);
      if (b.error) throw new Error(typeof b.error === 'string' ? b.error : 'ipapi 返回错误');
      return {
        ip: b.ip || '',
        region: b.region || b.regionName || b.province || '',
        country: b.country_name || b.country || '',
        city: b.city || '',
        org: b.org || b.asn || '',
      };
    },
  },
];

/**
 * 查公网 IP 归属地（城市/地区/国家/运营商）。多服务商容错：
 * 逐一尝试 GEO_PROVIDERS，跳过被拦截（返回 HTML）或解析失败或不含 IP 的服务。
 * @returns {Promise<{ok:boolean, ip?:string, region?:string, country?:string, city?:string, org?:string, source?:string, error?:string}>}
 */
async function getPublicGeo() {
  let lastErr = '所有服务均不可用';
  for (const p of GEO_PROVIDERS) {
    const r = await httpGetText(p.url(), 6000);
    if (!r.ok) {
      lastErr = p.name + '：' + (r.error || 'HTTP ' + r.status);
      continue;
    }
    const text = (r.text || '').trim();
    // 被 Cloudflare / 反爬拦截时返回 HTML 挑战页，直接跳过该服务
    if (!text || /^<!DOCTYPE|<html[\s>]/i.test(text)) {
      lastErr = p.name + '：返回了非数据页面（可能被拦截）';
      continue;
    }
    let parsed;
    try {
      parsed = p.parse(text);
    } catch (e) {
      lastErr = p.name + '：解析失败（' + e.message + '）';
      continue;
    }
    if (parsed && parsed.ip) {
      return Object.assign({ ok: true, source: p.name }, parsed);
    }
    lastErr = p.name + '：未返回有效 IP';
  }
  return { ok: false, error: lastErr };
}

/**
 * 聚合「当前连接」的全部信息：SSID、WiFi 连接 IP、公网 IP 与归属地。
 * 即使未连接 WiFi，也会尽力返回本地/公网 IP（机器仍在线上）。
 * 注意：wifiIp 锁定 WLAN 网卡（切换 WiFi 后会变化），publicIp 为公网出口 IP。
 */
async function getCurrentInfo() {
  const iface = await getInterface();
  const ssid = await getCurrentSsid(iface);
  const wifiIp = await getWifiLocalIp(iface);
  const geo = await getPublicGeo();
  return {
    ssid: ssid,
    interface: iface,
    wifiIp: wifiIp,
    localIp: wifiIp, // 兼容旧字段
    publicIp: geo.ok ? geo.ip : '',
    region: geo.ok ? geo.region : '',
    country: geo.ok ? geo.country : '',
    city: geo.ok ? geo.city : '',
    org: geo.ok ? geo.org : '',
    geoError: geo.ok ? '' : geo.error || '获取失败',
  };
}
