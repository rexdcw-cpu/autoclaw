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
  return new Promise((resolve) => {
    const cmd = 'chcp 65001 >nul && netsh wlan ' + args;
    exec(
      cmd,
      { encoding: 'utf8', maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        // 部分命令即使非零退出也会输出有用信息，尽量返回全部
        resolve((stdout || '') + (stderr || ''));
      },
    );
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
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

/** 生成 WLAN 配置文件 XML（带 UTF-8 BOM 由调用方写入）。 */
function buildProfileXml(ssid, authentication, encryption, password) {
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
 * @returns {Promise<{ok:boolean, code?:string, message:string, diagnostics?:object}>}
 */
async function connect(ssid, password) {
  const iface = await getInterface();
  const nets = await listNetworks(iface);
  const net = nets.find((n) => n.ssid === ssid);
  if (!net) {
    return {
      ok: false,
      code: 'ERR_WIFI_NOT_FOUND',
      message: '未找到网络『' + ssid + '』，可能已不在范围内',
    };
  }
  const sec = normalizeSecurity(net.auth, net.enc);
  if (!sec) {
    return {
      ok: false,
      code: 'ERR_WIFI_UNSUPPORTED',
      message: '『' + ssid + '』是企业网络（需账号/证书），暂不支持',
    };
  }
  if (sec.authentication !== 'open' && !password) {
    return { ok: false, code: 'ERR_WIFI_NEED_PASSWORD', message: '该网络需要密码' };
  }

  const xml = buildProfileXml(ssid, sec.authentication, sec.encryption, password || '');
  const tmp = path.join(os.tmpdir(), '_autoclaw_wifi_' + Math.abs(hashStr(ssid)) + '.xml');
  // UTF-8 BOM：netsh 才能正确解析含中文的 SSID
  fs.writeFileSync(tmp, '﻿' + xml, 'utf8');
  try {
    const add = await runNetsh(
      'add profile filename="' + tmp + '" user=current interface="' + iface + '"',
    );
    const conn = await runNetsh(
      'connect name="' + ssid + '" ssid="' + ssid + '" interface="' + iface + '"',
    );
    for (let i = 0; i < 5; i++) {
      const cur = await getCurrentSsid(iface);
      if (cur === ssid) return { ok: true, message: '已连接到『' + ssid + '』' };
      await sleep(1000);
    }
    return {
      ok: false,
      code: 'ERR_WIFI_CONNECT_FAILED',
      message: '连接未完成（可能是密码错误或信号太弱）',
      diagnostics: { add: add, conn: conn },
    };
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch (e) {
      /* 忽略清理失败 */
    }
  }
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

/**
 * 取「可见且本机已保存凭证」的 WIFI 列表（顺序同前端可见列表）。
 * 这些 WIFI 可无密码直连（netsh wlan connect），即轮询所需的「可用 WIFI」。
 * @returns {Promise<string[]>}
 */
async function getConnectableNetworks() {
  // 候选 = 本机已保存凭证（可无密码直连）的全部 WIFI，即「可用 WIFI」。
  // 当前已连的置顶作为轮询起点；其余按 netsh 配置顺序。
  // 不限于当前可见列表：已连但未出现在扫描结果的 WIFI 也必须纳入，
  // 否则轮询序列会漏掉当前网络。切到信号外的 WIFI 时 connectSaved 会失败，
  // worker 层会跳过并继续下一个，不阻塞整体轮询。
  const saved = await listSavedProfiles();
  const arr = Array.from(saved);
  const cur = await getCurrentSsid();
  if (cur && saved.has(cur)) {
    const idx = arr.indexOf(cur);
    if (idx > 0) {
      arr.splice(idx, 1);
      arr.unshift(cur);
    }
  }
  return arr;
}

/**
 * 切换到本机已保存凭证的 WIFI（无需密码，直接 netsh wlan connect）。
 * @param {string} ssid
 * @returns {Promise<{ok:boolean, code?:string, message:string}>}
 */
async function connectSaved(ssid) {
  const iface = await getInterface();
  const conn = await runNetsh('connect name="' + ssid + '" interface="' + iface + '"');
  for (let i = 0; i < 8; i += 1) {
    const cur = await getCurrentSsid(iface);
    if (cur === ssid) return { ok: true, message: '已连接到『' + ssid + '』' };
    await sleep(1000);
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
  buildProfileXml,
  listNetworks,
  connect,
  listSavedProfiles,
  getConnectableNetworks,
  connectSaved,
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
  return new Promise((resolve) => {
    const cmd = 'chcp 65001 >nul && netsh ' + args;
    exec(
      cmd,
      { encoding: 'utf8', maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        resolve((stdout || '') + (stderr || ''));
      },
    );
  });
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
