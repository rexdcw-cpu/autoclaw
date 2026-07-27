'use strict';

/**
 * test/wifiDedupCaptcha.test.js
 * ---------------------------------------------------------------------------
 * 验证两处优化：
 *   1. P1 — 百度 WIFI 归一化去重（buildWifiSeq + normalizeSsidKey）：
 *      同物理路由的 2.4G/5G 双频 / 品牌前缀变体归一后相同 → 只保留一个，
 *      避免百度阶段对同一网络重复点击目标站。
 *   2. P24 — 谷歌机器人验证 / 同意页拦截结构化记录：
 *      taskStats.recordWifi 接受 captcha 字段，summarize 计算 captchaWifi。
 */

const test = require('node:test');
const assert = require('node:assert');
const { buildWifiSeq, normalizeSsidKey } = require('../scripts/worker');
const taskStats = require('../core/taskStats');

// ----- P1: normalizeSsidKey -----
test('normalizeSsidKey 剥离品牌前缀', () => {
  assert.strictEqual(normalizeSsidKey('HUAWEI-805'), '805');
  assert.strictEqual(normalizeSsidKey('ChinaNet-home'), 'home');
  assert.strictEqual(normalizeSsidKey('CMCC-abc'), 'abc');
  assert.strictEqual(normalizeSsidKey('TP-LINK_xyz'), 'xyz');
});

test('normalizeSsidKey 剥离频段后缀（2.4G/5G/5.8G）', () => {
  assert.strictEqual(normalizeSsidKey('805_5G'), '805');
  assert.strictEqual(normalizeSsidKey('home-5g'), 'home');
  assert.strictEqual(normalizeSsidKey('abc 2.4G'), 'abc');
  assert.strictEqual(normalizeSsidKey('abc-5.8G'), 'abc');
});

test('normalizeSsidKey 前缀+后缀叠加 → 同路由双频归一一致', () => {
  const a = normalizeSsidKey('HUAWEI-805');
  const b = normalizeSsidKey('HUAWEI-805_5G');
  const c = normalizeSsidKey('805_5G');
  assert.strictEqual(a, b);
  assert.strictEqual(b, c);
  assert.strictEqual(a, '805');
});

// ----- P1: buildWifiSeq 去重 -----
function fakeWmForDedup(allSsids, current) {
  return {
    getCurrentSsid: async () => current || '',
    getConnectableNetworks: async () => [],
    listNetworks: async () => allSsids.map((s) => ({ ssid: s })), // 全部可见
    connectSaved: async () => ({ ok: true, message: 'ok' }),
  };
}

test('buildWifiSeq 对归一化后相同的 SSID 去重（保留首个）', async () => {
  const remembered = ['HUAWEI-805', 'HUAWEI-805_5G', '805_5G', 'CMCC-abc', 'CMCC-abc_5G'];
  const wm = fakeWmForDedup(remembered, '');
  const res = await buildWifiSeq({ rememberedWifis: remembered, pollWifi: true }, wm);

  // 两个独立物理路由：HUAWEI-805 系列 与 CMCC-abc 系列
  assert.deepStrictEqual(res.seq, ['HUAWEI-805', 'CMCC-abc']);
  // 3 个被去重（两个 805 变体 + 一个 abc 变体）
  assert.strictEqual(res.dedupDropped.length, 3);
  assert.ok(res.dedupDropped.includes('HUAWEI-805_5G'));
  assert.ok(res.dedupDropped.includes('805_5G'));
  assert.ok(res.dedupDropped.includes('CMCC-abc_5G'));
  // 描述含去重提示
  assert.ok(/已去重/.test(res.sourceDesc), 'sourceDesc 应说明已去重');
});

test('buildWifiSeq 真正不同的 SSID 不去重', async () => {
  const remembered = ['Office-WiFi', 'Home-5G', 'Cafe-Guest'];
  const wm = fakeWmForDedup(remembered, '');
  const res = await buildWifiSeq({ rememberedWifis: remembered, pollWifi: true }, wm);
  assert.strictEqual(res.seq.length, 3);
  assert.strictEqual(res.dedupDropped.length, 0);
});

// ----- P24: captcha 统计 -----
test('recordWifi + summarize：captcha 字段统计到 captchaWifi', () => {
  const run = {
    taskId: 't1', platform: 'google', perWifi: [], summary: null,
    startedAt: '2026-07-27T00:00:00Z',
  };
  taskStats.recordWifi(run, { ssid: 'N1', via: 'vpn', status: 'completed', found: true });
  taskStats.recordWifi(run, { ssid: 'N2', via: 'vpn', status: 'failed', captcha: true, error: 'ERR_GOOGLE_CAPTCHA' });
  taskStats.recordWifi(run, { ssid: 'N3', via: 'vpn', status: 'completed', found: true, captcha: true });
  taskStats.recordWifi(run, { ssid: 'N4', via: 'vpn', status: 'completed', found: true });
  const s = taskStats.summarize(run);
  assert.strictEqual(s.captchaWifi, 2, '应统计 2 个触发验证的节点');
  assert.strictEqual(s.totalWifi, 4);
  assert.strictEqual(s.completedWifi, 3);
});

test('recordWifi 不接受 captcha 时默认非验证', () => {
  const run = { taskId: 't2', platform: 'baidu', perWifi: [], summary: null, startedAt: 'x' };
  taskStats.recordWifi(run, { ssid: 'W1', via: 'wifi', status: 'completed', found: true });
  const s = taskStats.summarize(run);
  assert.strictEqual(s.captchaWifi, 0);
  assert.strictEqual(run.perWifi[0].captcha, false);
});
