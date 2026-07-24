'use strict';

/**
 * test/vpnController.test.js
 * ---------------------------------------------------------------------------
 * VPN 控制器单测。通过 setTransport 注入假传输层，不触达真实 9090、不依赖本机 VPN。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { mkdtempSync } = require('fs');
const { tmpdir } = require('os');

const Vpn = require('../core/vpnController');

/** 构造一个假 transport：按 url 路径返回预置响应 */
function fakeTransport(map) {
  // map key 形如 'GET /proxies/🔰 主节点'（仅 pathname，忽略 query；节点名按解码后匹配，
  // 因为控制器会 encodeURIComponent 节点名，如 [HK]香港... 变成 %5BHK%5D...）
  return async function (method, urlStr, opts) {
    const u = new URL(urlStr);
    let p = u.pathname;
    try { p = decodeURIComponent(p); } catch (e) { /* 忽略 */ }
    const key = method + ' ' + p;
    const hit = map[key];
    if (hit) return { status: hit.status != null ? hit.status : 200, body: hit.body || '' };
    return { status: 404, body: '{"error":"not found"}' };
  };
}

test('resolveConfig + getProxyUrl：env 覆盖生效', () => {
  Vpn.setConfig({
    api: 'http://127.0.0.1:9090',
    secret: 'test-secret',
    mainGroup: '🔰 主节点',
    proxyPort: 7890,
    delayUrl: 'http://www.gstatic.com/generate_204',
  });
  const cfg = Vpn.resolveConfig();
  assert.strictEqual(cfg.secret, 'test-secret');
  assert.strictEqual(Vpn.getProxyUrl(), 'http://127.0.0.1:7890');
  Vpn.setConfig(null);
});

test('getAvailableMainNodes：剔除【超时】/不可达，按延迟升序返回可用节点', async () => {
  const groupJson = JSON.stringify({
    name: '🔰 主节点',
    type: 'Selector',
    now: '[HK]香港直连HK1',
    all: ['[HK]香港直连HK1', '[TW]台湾直连TW1', '♻️ 自动选择', '🎯 不使用代理'],
  });
  const map = {
    'GET /proxies/🔰 主节点': { status: 200, body: groupJson },
    // HK1 延迟 23，TW1 超时（返回非 2xx → 视为不可用）
    'GET /proxies/[HK]香港直连HK1/delay': { status: 200, body: JSON.stringify({ delay: 23 }) },
    'GET /proxies/[TW]台湾直连TW1/delay': { status: 408, body: '' },
  };
  Vpn.setTransport(fakeTransport(map));
  Vpn.setConfig({ api: 'http://x', secret: 's', mainGroup: '🔰 主节点', proxyPort: 7890, delayUrl: 'http://www.gstatic.com/generate_204' });

  const diag = await Vpn.getAvailableMainNodes();
  assert.deepStrictEqual(diag.available, ['[HK]香港直连HK1']);
  assert.strictEqual(diag.availableDetail[0].delay, 23);
  assert.deepStrictEqual(diag.unavailable, ['[TW]台湾直连TW1']);
  assert.strictEqual(diag.total, 2); // 仅真实节点（子组/直连不计入）
  assert.strictEqual(diag.current, '[HK]香港直连HK1');
  assert.strictEqual(diag.proxyUrl, 'http://127.0.0.1:7890');
  Vpn.setTransport(null);
  Vpn.setConfig(null);
});

test('getAvailableMainNodes：多可用节点按延迟升序', async () => {
  const groupJson = JSON.stringify({ name: 'g', type: 'Selector', now: 'A', all: ['A', 'B', 'C'] });
  const map = {
    'GET /proxies/g': { status: 200, body: groupJson },
    'GET /proxies/A/delay': { status: 200, body: JSON.stringify({ delay: 200 }) },
    'GET /proxies/B/delay': { status: 200, body: JSON.stringify({ delay: 10 }) },
    'GET /proxies/C/delay': { status: 200, body: JSON.stringify({ delay: 50 }) },
  };
  Vpn.setTransport(fakeTransport(map));
  Vpn.setConfig({ api: 'http://x', secret: 's', mainGroup: 'g', proxyPort: 7890, delayUrl: 'http://www.gstatic.com/generate_204' });
  const diag = await Vpn.getAvailableMainNodes();
  assert.deepStrictEqual(diag.available, ['B', 'C', 'A']);
  Vpn.setTransport(null);
  Vpn.setConfig(null);
});

test('getAvailableMainNodes：API 不可达 → 返回 available:[] 不抛', async () => {
  Vpn.setTransport(async () => ({ status: 0, error: 'ECONNREFUSED' }));
  Vpn.setConfig({ api: 'http://x', secret: 's', mainGroup: 'g', proxyPort: 7890, delayUrl: 'http://www.gstatic.com/generate_204' });
  const diag = await Vpn.getAvailableMainNodes();
  assert.deepStrictEqual(diag.available, []);
  assert.ok(diag.error, '应包含错误原因');
  assert.strictEqual(diag.proxyUrl, 'http://127.0.0.1:7890');
  Vpn.setTransport(null);
  Vpn.setConfig(null);
});

test('selectNode：PATCH 主节点组并带 name', async () => {
  let captured = null;
  Vpn.setTransport(async (method, urlStr, opts) => {
    captured = { method, url: urlStr, body: opts && opts.body };
    return { status: 204, body: '' };
  });
  Vpn.setConfig({ api: 'http://x', secret: 's', mainGroup: '🔰 主节点', proxyPort: 7890, delayUrl: 'http://www.gstatic.com/generate_204' });
  const ok = await Vpn.selectNode('[HK]香港直连HK1');
  assert.strictEqual(ok, true);
  assert.strictEqual(captured.method, 'PATCH');
  assert.ok(captured.url.includes('/proxies/') && captured.url.includes(encodeURIComponent('🔰 主节点')));
  assert.strictEqual(JSON.parse(captured.body).name, '[HK]香港直连HK1');
  Vpn.setTransport(null);
  Vpn.setConfig(null);
});

test('readMihomoSecret：从 yaml 解析 secret 字段（去引号）', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'autoclaw-vpn-test-'));
  const appData = path.join(dir, 'Roaming');
  fs.mkdirSync(path.join(appData, 'mihomo-party'), { recursive: true });
  fs.writeFileSync(
    path.join(appData, 'mihomo-party', 'mihomo.yaml'),
    'external-controller: 127.0.0.1:9090\nsecret: "abc123deadbeef"\n',
    'utf8',
  );
  const old = process.env.APPDATA;
  process.env.APPDATA = appData;
  try {
    const s = Vpn.readMihomoSecret();
    assert.strictEqual(s, 'abc123deadbeef');
  } finally {
    process.env.APPDATA = old;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
