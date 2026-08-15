'use strict';

/**
 * core/vpnController.js
 * ---------------------------------------------------------------------------
 * VPN 出口控制器（对接本地 Mihomo Party / Clash 内核的 REST API）。
 *
 * 用途：在 autoclaw 跑「谷歌」任务前，先弄清楚当前 VPN 主节点组里到底有几个
 * 节点能正常出去（剔除【超时】/不可达的），然后：
 *   1) 选一个延迟最低的可用节点切过去（让出口最优）；
 *   2) 返回给引擎「代理地址」（本机 mihomo 的 mixed 端口，默认 7890），
 *      引擎据此重拉 Chrome 走 VPN 出口访问 Google。
 *
 * 安全设计（重要）：
 *   - 控制端口 secret **不写死在源码里**。优先读环境变量 AUTOCLAW_VPN_SECRET；
 *     缺失时回落到「读取 %APPDATA%/mihomo-party/mihomo.yaml 的 secret 字段」。
 *     这样仓库（含公开 GitHub）不会泄露本机 VPN 的 API 令牌。
 *   - 所有 HTTP 调用均 try/catch 包裹；API 不可达 / 鉴权失败 / 节点探测异常时，
 *     一律返回 `{ available: [], error }`，由上层决定「跳过谷歌任务」而非崩溃。
 *
 * 可测试性：
 *   - 默认 transport 走本机 http；可通过 setTransport(fn) 注入假实现（单测用），
 *     从而不触达真实 9090、不依赖本机 VPN。
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const { URL } = require('url');

// ---------------------------------------------------------------------------
// 配置解析（懒加载 + 可覆盖）
// ---------------------------------------------------------------------------

let _overrideConfig = null;
let _overrideTransport = null;

/** 默认延迟探测地址：Google 基础设施，能通即代表能翻墙访问 Google 服务 */
const DEFAULT_DELAY_URL = 'http://www.gstatic.com/generate_204';

/**
 * 读取 %APPDATA%/mihomo-party/mihomo.yaml 里的 secret 字段。
 * 失败（文件不存在/无权限）一律返回 ''，由上层降级处理。
 * @returns {string}
 */
function readMihomoSecret() {
  try {
    const appData = process.env.APPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Roaming');
    const yamlPath = path.join(appData, 'mihomo-party', 'mihomo.yaml');
    const txt = fs.readFileSync(yamlPath, 'utf8');
    const m = txt.match(/^secret:\s*(.+)$/m);
    if (!m) return '';
    return m[1].trim().replace(/^["']|["']$/g, '');
  } catch (e) {
    return '';
  }
}

/**
 * 解析控制器配置（环境变量优先，回落到本机 mihomo.yaml）。
 * @returns {{api:string, secret:string, mainGroup:string, proxyPort:number, delayUrl:string}}
 */
function resolveConfig() {
  if (_overrideConfig) return _overrideConfig;
  const api = (process.env.AUTOCLAW_VPN_API || 'http://127.0.0.1:9090').replace(/\/+$/, '');
  const secret = process.env.AUTOCLAW_VPN_SECRET || readMihomoSecret() || '';
  const mainGroup = process.env.AUTOCLAW_VPN_MAIN_GROUP || '🔰 主节点';
  const proxyPort = parseInt(process.env.AUTOCLAW_VPN_PROXY_PORT, 10) || 7890;
  const delayUrl = process.env.AUTOCLAW_VPN_DELAY_URL || DEFAULT_DELAY_URL;
  return { api, secret, mainGroup, proxyPort, delayUrl };
}

/** 仅测试注入：覆盖配置 */
function setConfig(cfg) {
  _overrideConfig = cfg || null;
}

/** 仅测试注入：覆盖 transport（fn(method, url, {headers, body, timeoutMs}) => Promise<{status, body}>） */
function setTransport(fn) {
  _overrideTransport = fn || null;
}

/** 代理地址（给 Chrome 用）：本机 mihomo mixed 端口 */
function getProxyUrl(cfg) {
  const c = cfg || resolveConfig();
  return 'http://127.0.0.1:' + c.proxyPort;
}

// ---------------------------------------------------------------------------
// 传输层（默认本机 http，直连 127.0.0.1，不走系统代理）
// ---------------------------------------------------------------------------

function _defaultTransport(method, urlStr, opts) {
  opts = opts || {};
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
      const headers = Object.assign({}, opts.headers || {});
      req = http.request(
        {
          method: method,
          hostname: u.hostname,
          port: u.port,
          path: u.pathname + u.search,
          headers: headers,
          timeout: opts.timeoutMs || 8000,
        },
        (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => finish({ status: res.statusCode, body: data }));
        },
      );
      req.on('timeout', () => {
        try { req.destroy(); } catch (e) { /* ignore */ }
        finish({ status: 0, error: '请求超时' });
      });
      req.on('error', (e) => finish({ status: 0, error: e.message }));
      if (opts.body) req.write(opts.body);
      req.end();
    } catch (e) {
      finish({ status: 0, error: e.message });
    }
  });
}

function _transport() {
  return _overrideTransport || _defaultTransport;
}

/**
 * 硬超时包装：无论内部 promise 是否真的会 settle（如底层 socket 半开、Node 超时事件未触发），
 * 都保证在 timeoutMs 内 reject，避免调用方永久挂起（曾导致 worker 在「谷歌阶段诊断」处静默卡死 10 分钟被看门狗强杀）。
 */
function withTimeout(promise, timeoutMs, label) {
  let timer = null;
  const guarded = Promise.race([
    Promise.resolve().then(() => promise),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error((label || '操作') + ' 超时（' + timeoutMs + 'ms）')), timeoutMs);
    }),
  ]);
  // 无论成败都清理定时器，避免泄漏
  return guarded.finally(() => { if (timer) clearTimeout(timer); });
}

function _authHeaders(cfg) {
  const h = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (cfg.secret) h['Authorization'] = 'Bearer ' + cfg.secret;
  return h;
}

/** 解析 JSON 响应；失败返回 null（不抛） */
async function _getJson(url, cfg) {
  const r = await _transport()('GET', url, { headers: _authHeaders(cfg), timeoutMs: 8000 });
  if (!r.status || r.status < 200 || r.status >= 300) {
    const err = (r.error ? '：' + r.error : '') + (r.status ? '（HTTP ' + r.status + '）' : '');
    throw new Error('VPN API 请求失败' + err);
  }
  try {
    return JSON.parse(r.body || 'null');
  } catch (e) {
    throw new Error('VPN API 返回非 JSON：' + (r.body || '').slice(0, 80));
  }
}

// ---------------------------------------------------------------------------
// 对外能力
// ---------------------------------------------------------------------------

/** 控制 API 是否可达（/version） */
async function isHealthy() {
  const cfg = resolveConfig();
  try {
    const r = await _transport()('GET', cfg.api + '/version', {
      headers: _authHeaders(cfg),
      timeoutMs: 4000,
    });
    return !!r.status && r.status >= 200 && r.status < 300;
  } catch (e) {
    return false;
  }
}

/**
 * 探测单个节点的真实出口延迟（走控制 API 的 /delay 端点）。
 * @returns {Promise<number|null>} 成功返回毫秒数；超时/不可达返回 null（即【超时】项）
 */
async function _testDelay(nodeName, cfg) {
  const enc = encodeURIComponent(nodeName);
  const url =
    cfg.api + '/proxies/' + enc + '/delay?url=' +
    encodeURIComponent(cfg.delayUrl) + '&timeout=5000';
  try {
    // 硬超时兜底：即便底层 socket 处于「连上但不响应、Node 超时事件未触发」的半开状态，
    // 也保证 9s 内必有结果（transport 自带 7s 超时，这里再垫一层保险）。
    const r = await withTimeout(
      _transport()('GET', url, { headers: _authHeaders(cfg), timeoutMs: 7000 }),
      9000,
      'VPN 节点延迟探测',
    );
    if (!r.status || r.status < 200 || r.status >= 300) return null;
    const j = JSON.parse(r.body || '{}');
    if (typeof j.delay === 'number') return j.delay;
    return null;
  } catch (e) {
    return null; // 探测失败 = 超时/不可达，剔除
  }
}

/**
 * 列出主节点组下「可用」的节点（剔除【超时】/不可达项）。
 *
 * @returns {Promise<{available:string[], availableDetail:{name:string,delay:number}[], unavailable:string[], current:?string, total:number, proxyUrl:string, error?:string}>}
 *   - available：按延迟升序的真实节点名（已剔除超时/不可达/子组/直连）
 *   - current：主节点组当前选中的节点
 *   - proxyUrl：给 Chrome 用的代理地址
 *   任何异常都返回 available:[]（让上层优雅跳过谷歌，而非崩溃）
 */
async function _getAvailableMainNodes() {
  const cfg = resolveConfig();
  const proxyUrl = getProxyUrl(cfg);
  try {
    const group = encodeURIComponent(cfg.mainGroup);
    const g = await _getJson(cfg.api + '/proxies/' + group, cfg);
    const all = Array.isArray(g.all) ? g.all : [];
    const current = g.now || null;

    // 子组 / 直连不是真实出口节点，不纳入延迟探测
    const SKIP = new Set(['♻️ 自动选择', '🎯 不使用代理']);
    const realNodes = all.filter((n) => !SKIP.has(n));

    const availableDetail = [];
    const unavailable = [];
    for (const n of realNodes) {
      const d = await _testDelay(n, cfg);
      if (typeof d === 'number') availableDetail.push({ name: n, delay: d });
      else unavailable.push(n);
    }
    availableDetail.sort((a, b) => a.delay - b.delay);

    return {
      available: availableDetail.map((a) => a.name),
      availableDetail: availableDetail,
      unavailable: unavailable,
      current: current,
      total: realNodes.length,
      proxyUrl: proxyUrl,
    };
  } catch (e) {
    return {
      available: [],
      availableDetail: [],
      unavailable: [],
      current: null,
      total: 0,
      proxyUrl: proxyUrl,
      error: e.message,
    };
  }
}

/**
 * 对外入口：在 _getAvailableMainNodes 之上加「整体超时兜底」。
 * 即便内部某个节点探测卡死（半开连接未触发超时），整体也保证 90s 内必有返回，
 * 避免调用方（worker 谷歌阶段入口）永久挂起被看门狗强杀。超时则返回 available:[]，
 * 由上层优雅跳过谷歌并告警，而非整任务静默失败。
 */
async function getAvailableMainNodes() {
  try {
    return await withTimeout(_getAvailableMainNodes(), 90000, 'VPN 主节点诊断');
  } catch (e) {
    const proxyUrl = getProxyUrl();
    return {
      available: [],
      availableDetail: [],
      unavailable: [],
      current: null,
      total: 0,
      proxyUrl: proxyUrl,
      error: e.message,
    };
  }
}

/**
 * 把主节点组切到指定节点（最优可用节点）。
 * 失败仅记录，不抛（best-effort，切不动也不阻断谷歌任务）。
 * @param {string} nodeName
 * @returns {Promise<boolean>}
 */
async function selectNode(nodeName) {
  const cfg = resolveConfig();
  try {
    const group = encodeURIComponent(cfg.mainGroup);
    const r = await _transport()('PATCH', cfg.api + '/proxies/' + group, {
      headers: _authHeaders(cfg),
      body: JSON.stringify({ name: nodeName }),
      timeoutMs: 6000,
    });
    return !!r.status && r.status >= 200 && r.status < 300;
  } catch (e) {
    return false;
  }
}

module.exports = {
  resolveConfig,
  readMihomoSecret,
  getProxyUrl,
  isHealthy,
  getAvailableMainNodes,
  selectNode,
  setConfig,
  setTransport,
};
