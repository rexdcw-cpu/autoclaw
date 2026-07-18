'use strict';

/**
 * test/matchTarget.test.js
 * -------------------------------------------------------------------------
 * 纯函数 PlatformAdapter.matchTarget 单元测试（无浏览器、绝不发网络）。
 *
 * 覆盖：
 *   - strict 模式：双匹配命中 / 未中
 *   - 用 mock resolver 返回真实域名，模拟「百度跳转链接被解析」
 *   - resolver 支持同步 / 异步 / 抛错回退
 *   - non-strict domain-only 兜底（标题无关键词但域名命中）
 *   - non-strict title-only 兜底（按需、titleOnly:true 才启用；默认关闭返回 null）
 *   - top-10 限制（第 11 条忽略；top 10 内命中仍生效）
 *   - 全不中 / 边界（items 非数组、target 缺失）返回 null
 */

const test = require('node:test');
const assert = require('node:assert');

const { PlatformAdapter } = require('../core/adapters/platformAdapter');

const TARGET = { domain: 'manincorp.cn', titleKeywords: ['万年移民'] };

// -------------------------------------------------------------------------
// strict 模式
// -------------------------------------------------------------------------

test('matchTarget(strict): 标题+域名双命中返回 resolved href, score 2, reason title+domain', async () => {
  const items = [
    { title: '广告位招租', href: 'https://ads.com/1' },
    { title: '万年移民官网', href: 'https://www.manincorp.cn/' },
  ];
  const m = await PlatformAdapter.matchTarget(items, TARGET, { strict: true });
  assert.deepStrictEqual(m, { href: 'https://www.manincorp.cn/', score: 2, reason: 'title+domain' });
});

test('matchTarget(strict): 标题命中但域名未中 -> null', async () => {
  const items = [{ title: '万年移民攻略', href: 'https://blog.com/post' }];
  assert.strictEqual(await PlatformAdapter.matchTarget(items, TARGET, { strict: true }), null);
});

test('matchTarget(strict): 域名命中但标题未中 -> null（strict 不兜底）', async () => {
  const items = [{ title: '万年县移民局官网', href: 'https://www.manincorp.cn/' }];
  assert.strictEqual(await PlatformAdapter.matchTarget(items, TARGET, { strict: true }), null);
});

// -------------------------------------------------------------------------
// mock resolver 模拟「百度跳转链接被解析为真实域名」
// -------------------------------------------------------------------------

test('matchTarget(strict): resolver 把 baidu 跳转链接解析为真实域名后双命中', async () => {
  const items = [{ title: '万年移民官网', href: 'https://www.baidu.com/link?url=xyz' }];
  const resolve = (h) => (h.includes('baidu.com/link') ? 'https://www.manincorp.cn/' : h);
  const m = await PlatformAdapter.matchTarget(items, TARGET, { strict: true, resolve });
  assert.deepStrictEqual(m, { href: 'https://www.manincorp.cn/', score: 2, reason: 'title+domain' });
});

test('matchTarget: resolver 支持异步（返回 Promise）', async () => {
  const items = [{ title: '万年移民官网', href: 'https://www.baidu.com/link?url=xyz' }];
  const resolve = async (h) => (h.includes('baidu.com/link') ? 'https://www.manincorp.cn/' : h);
  const m = await PlatformAdapter.matchTarget(items, TARGET, { strict: true, resolve });
  assert.strictEqual(m.href, 'https://www.manincorp.cn/');
});

test('matchTarget: resolver 抛错时回退原 href（不中断、仍可命中）', async () => {
  const items = [{ title: '万年移民官网', href: 'https://www.manincorp.cn/' }];
  const resolve = () => { throw new Error('network down'); };
  const m = await PlatformAdapter.matchTarget(items, TARGET, { strict: true, resolve });
  assert.deepStrictEqual(m, { href: 'https://www.manincorp.cn/', score: 2, reason: 'title+domain' });
});

// -------------------------------------------------------------------------
// non-strict domain-only 兜底
// -------------------------------------------------------------------------

test('matchTarget(non-strict): 标题无关键词但域名命中 -> domain-only 兜底', async () => {
  const items = [{ title: '万年县移民局官网', href: 'https://www.manincorp.cn/' }];
  const m = await PlatformAdapter.matchTarget(items, TARGET, { strict: false });
  assert.deepStrictEqual(m, { href: 'https://www.manincorp.cn/', score: 1, reason: 'domain-only' });
});

test('matchTarget(non-strict): title+domain 优先于 domain-only', async () => {
  const items = [
    { title: '随便站点', href: 'https://www.manincorp.cn/about' }, // domain-only
    { title: '万年移民官网', href: 'https://www.manincorp.cn/' }, // title+domain
  ];
  const m = await PlatformAdapter.matchTarget(items, TARGET, { strict: false });
  assert.strictEqual(m.href, 'https://www.manincorp.cn/');
  assert.strictEqual(m.reason, 'title+domain');
});

// -------------------------------------------------------------------------
// non-strict title-only 兜底（按需启用）
// -------------------------------------------------------------------------

test('matchTarget(non-strict): 默认不启用 title-only，标题命中但域名未中 -> null', async () => {
  const items = [{ title: '万年移民攻略', href: 'https://blog.com/post' }];
  assert.strictEqual(await PlatformAdapter.matchTarget(items, TARGET, { strict: false }), null);
});

test('matchTarget(non-strict, titleOnly:true): 标题命中但域名未中 -> title-only', async () => {
  const items = [{ title: '万年移民攻略', href: 'https://blog.com/post' }];
  const m = await PlatformAdapter.matchTarget(items, TARGET, { strict: false, titleOnly: true });
  assert.deepStrictEqual(m, { href: 'https://blog.com/post', score: 1, reason: 'title-only' });
});

test('matchTarget(non-strict): domain-only 优先于 title-only', async () => {
  const items = [
    { title: '万年移民攻略', href: 'https://blog.com/post' }, // 仅标题
    { title: '别的站点', href: 'https://www.manincorp.cn/' }, // 仅域名
  ];
  const m = await PlatformAdapter.matchTarget(items, TARGET, { strict: false, titleOnly: true });
  assert.strictEqual(m.href, 'https://www.manincorp.cn/');
  assert.strictEqual(m.reason, 'domain-only');
});

// -------------------------------------------------------------------------
// top-10 限制
// -------------------------------------------------------------------------

test('matchTarget: 仅考察前 10 条，第 11 条（索引 10）被忽略', async () => {
  const items = [];
  for (let i = 0; i < 12; i += 1) {
    items.push({ title: `结果 ${i}`, href: `https://other${i}.com/` });
  }
  items[10] = { title: '万年移民官网', href: 'https://www.manincorp.cn/' };
  assert.strictEqual(await PlatformAdapter.matchTarget(items, TARGET, { strict: true }), null);
});

test('matchTarget: top 10 内的匹配仍生效（未超过限制）', async () => {
  const items = [];
  for (let i = 0; i < 12; i += 1) {
    items.push({ title: `结果 ${i}`, href: `https://other${i}.com/` });
  }
  items[5] = { title: '万年移民官网', href: 'https://www.manincorp.cn/' };
  const m = await PlatformAdapter.matchTarget(items, TARGET, { strict: true });
  assert.strictEqual(m.href, 'https://www.manincorp.cn/');
});

test('matchTarget: max 选项可配置', async () => {
  const items = [];
  for (let i = 0; i < 20; i += 1) {
    items.push({ title: `结果 ${i}`, href: `https://other${i}.com/` });
  }
  items[15] = { title: '万年移民官网', href: 'https://www.manincorp.cn/' };
  // 默认 max=10 -> 忽略
  assert.strictEqual(await PlatformAdapter.matchTarget(items, TARGET, { strict: true }), null);
  // max=20 -> 命中
  const m = await PlatformAdapter.matchTarget(items, TARGET, { strict: true, max: 20 });
  assert.strictEqual(m.href, 'https://www.manincorp.cn/');
});

// -------------------------------------------------------------------------
// 全不中 / 边界
// -------------------------------------------------------------------------

test('matchTarget: 全不中返回 null', async () => {
  const items = [
    { title: '天气预报', href: 'https://weather.com/' },
    { title: '新闻', href: 'https://news.com/' },
  ];
  assert.strictEqual(await PlatformAdapter.matchTarget(items, TARGET, { strict: false }), null);
});

test('matchTarget: items 非数组 / target 缺失返回 null', async () => {
  assert.strictEqual(await PlatformAdapter.matchTarget(null, TARGET), null);
  assert.strictEqual(await PlatformAdapter.matchTarget(undefined, TARGET), null);
  assert.strictEqual(await PlatformAdapter.matchTarget([], null), null);
  assert.strictEqual(await PlatformAdapter.matchTarget([], {}), null);
});

// -------------------------------------------------------------------------
// 补充边界（QA 独立验证新增）：空数组 / item 缺字段
// -------------------------------------------------------------------------

test('matchTarget: 空 items 数组 + 合法 target -> null（不抛错，走正常分支而非早返回）', async () => {
  assert.strictEqual(await PlatformAdapter.matchTarget([], TARGET, { strict: true }), null);
  assert.strictEqual(await PlatformAdapter.matchTarget([], TARGET, { strict: false }), null);
});

test('matchTarget: item 缺 href -> 视为空 href，strict/non-strict 均不命中', async () => {
  const items = [{ title: '万年移民官网' }]; // 无 href
  assert.strictEqual(await PlatformAdapter.matchTarget(items, TARGET, { strict: true }), null);
  assert.strictEqual(await PlatformAdapter.matchTarget(items, TARGET, { strict: false }), null);
});

test('matchTarget: item 缺 title -> 视为空 title，但 domain-only 仍生效（non-strict）', async () => {
  const items = [{ href: 'https://www.manincorp.cn/' }]; // 无 title
  assert.strictEqual(await PlatformAdapter.matchTarget(items, TARGET, { strict: true }), null);
  const m = await PlatformAdapter.matchTarget(items, TARGET, { strict: false });
  assert.strictEqual(m.reason, 'domain-only', '缺 title 不应破坏 domain-only 兜底');
  assert.strictEqual(m.href, 'https://www.manincorp.cn/');
});

test('matchTarget: resolve 抛错回退原 href（non-strict domain-only 仍命中）', async () => {
  const items = [{ title: '万年县移民局官网', href: 'https://www.manincorp.cn/' }];
  const resolve = () => { throw new Error('boom'); };
  const m = await PlatformAdapter.matchTarget(items, TARGET, { strict: false, resolve });
  assert.deepStrictEqual(m, { href: 'https://www.manincorp.cn/', score: 1, reason: 'domain-only' });
});
