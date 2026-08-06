'use strict';

/**
 * test/normalizeRounds.test.js
 * 回归：eng.run 按平台过滤出的子数组（如 googleRounds）应把 roundIndex 重新编号为
 * 子数组内 0-based、totalRounds=子数组长度。修复 buildRounds 给百度排第一占 0/1/2、
 * 谷歌原始 roundIndex 3/4/5，只改 totalRounds 不改 roundIndex 导致进度显示
 * 「3/3、4/3、5/3」（roundIndex>totalRounds）的错乱。
 */

const test = require('node:test');
const assert = require('node:assert');
const P = require('../core/progressEvent');

test('normalizeRounds：子数组内 roundIndex 重新编号、totalRounds=子数组长度', () => {
  // 模拟 buildRounds 的全局输出：百度 0/1/2，谷歌 3/4/5，total=6
  const all = [
    { roundIndex: 0, totalRounds: 6, platform: 'baidu', keyword: 'k1' },
    { roundIndex: 1, totalRounds: 6, platform: 'baidu', keyword: 'k2' },
    { roundIndex: 2, totalRounds: 6, platform: 'baidu', keyword: 'k3' },
    { roundIndex: 3, totalRounds: 6, platform: 'google', keyword: 'k1' },
    { roundIndex: 4, totalRounds: 6, platform: 'google', keyword: 'k2' },
    { roundIndex: 5, totalRounds: 6, platform: 'google', keyword: 'k3' },
  ];
  const google = all.filter((r) => r.platform === 'google');

  // eng.run 直接复用 googleRounds（不改 roundIndex），旧实现只改 totalRounds
  const buggy = google.map((r) => Object.assign({}, r, { totalRounds: google.length }));
  for (const r of buggy) {
    assert.ok(r.roundIndex >= r.totalRounds, '旧实现：roundIndex 会 >= totalRounds（3/3,4/3,5/3）');
  }

  // 修复后：normalizeRounds
  const fixed = P.normalizeRounds(google);
  assert.strictEqual(fixed.length, 3);
  fixed.forEach((r, i) => {
    assert.strictEqual(r.roundIndex, i, 'roundIndex 应为子数组内 0-based');
    assert.strictEqual(r.totalRounds, 3, 'totalRounds 应为子数组长度');
    assert.ok(r.roundIndex < r.totalRounds, 'roundIndex 应 < totalRounds');
    assert.strictEqual(r.platform, 'google');
    assert.strictEqual(r.keyword, all[3 + i].keyword);
  });
});

test('normalizeRounds：空/非数组安全返回空数组且不改原数组', () => {
  assert.deepStrictEqual(P.normalizeRounds(null), []);
  assert.deepStrictEqual(P.normalizeRounds(undefined), []);
  assert.deepStrictEqual(P.normalizeRounds([]), []);
  const src = [{ roundIndex: 9, totalRounds: 9, platform: 'google', keyword: 'k' }];
  const out = P.normalizeRounds(src);
  assert.strictEqual(out[0].roundIndex, 0); // 重新编号
  assert.strictEqual(src[0].roundIndex, 9); // 原数组未被改
});
