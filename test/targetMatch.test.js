'use strict';

/**
 * test/targetMatch.test.js
 * ---------------------------------------------------------------------------
 * Unit tests for the "double-match" target-locating logic (Q3 / A1). NO browser.
 *
 * WHAT IS TESTABLE AS PURE FUNCTION:
 *   PlatformAdapter.matchTitle(title, titleKeywords)  -> boolean
 *   PlatformAdapter.matchHref(href, domain)           -> boolean
 * These are the two primitives the adapters use to decide whether a search
 * result is the real target (title contains one keyword AND href contains the
 * target domain). They are exported as static pure functions, so we test them
 * directly.
 *
 * WHAT IS NOT EXPORTED AS A PURE FUNCTION (QA FINDING):
 *   The orchestration loop (take top-10 results, for each item apply
 *   matchTitle && matchHref, return first match or null) lives INSIDE
 *   BaiduAdapter.locateTarget / GoogleAdapter.locateTarget, which receive a
 *   Playwright `page` and also call `resolveFinalUrl` (network fetch). There is
 *   NO injected / exported `matchTarget(results, target)` pure function.
 *
 *   => Per QA protocol we DO NOT modify production code. Instead the
 *      "doubleMatchTop10" characterization test below REPLICATES the exact
 *      matching algorithm described in the architecture (§4 + adapters) using
 *      the genuine exported primitives, and asserts its behaviour. This pins
 *      the intended semantics so that, if the matcher is later extracted into a
 *      pure function, these cases become its spec.
 *
 *   FINDING (route: QA / recommendation): extract the top-10 double-match loop
 *   into an exported pure function (e.g. `PlatformAdapter.matchTarget(items,
 *   target)`) so it can be unit-tested without a browser / network.
 *
 *   => 该建议现已落地：core/adapters/platformAdapter.js 新增静态纯函数
 *      PlatformAdapter.matchTarget(items, target, opts)。下方「EXTRACTED PURE
 *      FUNCTION」段直接对其做契约测试，与上面 replicated 语义互为交叉验证。
 */

const test = require('node:test');
const assert = require('node:assert');

const { PlatformAdapter } = require('../core/adapters/platformAdapter');

// ---------------------------------------------------------------------------
// Pure primitive: matchTitle
// ---------------------------------------------------------------------------

test('matchTitle: title contains one of the keywords -> true', () => {
  assert.strictEqual(PlatformAdapter.matchTitle('万年移民官网', ['万年移民']), true);
  assert.strictEqual(PlatformAdapter.matchTitle('海外移民咨询', ['万年移民', '海外移民']), true);
});

test('matchTitle: no keyword present -> false', () => {
  assert.strictEqual(PlatformAdapter.matchTitle('天气预报', ['万年移民']), false);
});

test('matchTitle: case-insensitive', () => {
  assert.strictEqual(PlatformAdapter.matchTitle('BAIDU Example', ['baidu']), true);
});

test('matchTitle: empty title or empty keywords -> false', () => {
  assert.strictEqual(PlatformAdapter.matchTitle('', ['万年移民']), false);
  assert.strictEqual(PlatformAdapter.matchTitle('万年移民', []), false);
  assert.strictEqual(PlatformAdapter.matchTitle(null, ['万年移民']), false);
});

// ---------------------------------------------------------------------------
// Pure primitive: matchHref
// ---------------------------------------------------------------------------

test('matchHref: href contains target domain -> true', () => {
  assert.strictEqual(
    PlatformAdapter.matchHref('https://www.manincorp.cn/about', 'manincorp.cn'),
    true
  );
});

test('matchHref: subdomain (www.) prefix compatible -> true', () => {
  assert.strictEqual(
    PlatformAdapter.matchHref('http://www.manincorp.cn/x', 'manincorp.cn'),
    true
  );
});

test('matchHref: case-insensitive domain', () => {
  assert.strictEqual(
    PlatformAdapter.matchHref('https://MANINCORP.cn/x', 'manincorp.cn'),
    true
  );
});

test('matchHref: unrelated domain -> false', () => {
  assert.strictEqual(PlatformAdapter.matchHref('https://example.com/x', 'manincorp.cn'), false);
});

test('matchHref: empty href or empty domain -> false', () => {
  assert.strictEqual(PlatformAdapter.matchHref('', 'manincorp.cn'), false);
  assert.strictEqual(PlatformAdapter.matchHref('https://manincorp.cn', ''), false);
});

// ---------------------------------------------------------------------------
// resolveFinalUrl guard (no network path)
// ---------------------------------------------------------------------------

test('resolveFinalUrl: non-http href returns as-is without network', async () => {
  const out = await PlatformAdapter.resolveFinalUrl('#anchor');
  assert.strictEqual(out, '#anchor');
});

// ---------------------------------------------------------------------------
// CHARACTERIZATION: top-10 double-match (replicates adapter algorithm)
// ---------------------------------------------------------------------------

/**
 * Replicates the double-match algorithm described in the adapters / architecture:
 * iterate the first 10 result items, return the href of the first item whose
 * title matches a keyword AND whose href matches the target domain; else null.
 */
function doubleMatchTop10(items, target) {
  const top = items.slice(0, 10);
  for (const it of top) {
    if (
      PlatformAdapter.matchTitle(it.title, target.titleKeywords) &&
      PlatformAdapter.matchHref(it.href, target.domain)
    ) {
      return it.href;
    }
  }
  return null;
}

const TARGET = { domain: 'manincorp.cn', titleKeywords: ['万年移民'] };

test('doubleMatch: returns first item matching title && href within top 10', () => {
  const items = [
    { title: '广告位招租', href: 'https://ads.com/1' },
    { title: '万年移民官网', href: 'https://www.manincorp.cn/' },
    { title: '万年移民论坛', href: 'https://www.manincorp.cn/forum' },
  ];
  const href = doubleMatchTop10(items, TARGET);
  assert.strictEqual(href, 'https://www.manincorp.cn/');
});

test('doubleMatch: returns null when no item matches both conditions', () => {
  const items = [
    { title: '万年移民攻略', href: 'https://blog.com/post' }, // title ok, href no
    { title: '随便看看', href: 'https://www.manincorp.cn/' }, // href ok, title no
  ];
  assert.strictEqual(doubleMatchTop10(items, TARGET), null);
});

test('doubleMatch: respects the top-10 limit (item #11 ignored)', () => {
  const items = [];
  for (let i = 0; i < 12; i += 1) {
    items.push({ title: `结果 ${i}`, href: `https://other${i}.com/` });
  }
  // only the 11th (index 10) item is the real target -> beyond top 10
  items[10] = { title: '万年移民官网', href: 'https://www.manincorp.cn/' };
  assert.strictEqual(doubleMatchTop10(items, TARGET), null);
});

test('doubleMatch: a matching item inside top 10 still wins (limit not exceeded)', () => {
  const items = [];
  for (let i = 0; i < 12; i += 1) {
    items.push({ title: `结果 ${i}`, href: `https://other${i}.com/` });
  }
  items[5] = { title: '万年移民官网', href: 'https://www.manincorp.cn/' };
  assert.strictEqual(doubleMatchTop10(items, TARGET), 'https://www.manincorp.cn/');
});

// ---------------------------------------------------------------------------
// EXTRACTED PURE FUNCTION: PlatformAdapter.matchTarget (cross-check)
// ---------------------------------------------------------------------------
// 上面 replicated 的 doubleMatchTop10 现在已抽成正式纯函数；以下用例直接调用
// 真实 matchTarget（strict 模式，resolve 恒等），验证其与「架构描述的双匹配语义」
// 一致，从而把原本只能靠复制算法做的表征测试升级为对真实实现的直接契约测试。

test('matchTarget(strict): 与 replicated doubleMatchTop10 语义一致（命中）', async () => {
  const items = [
    { title: '广告位招租', href: 'https://ads.com/1' },
    { title: '万年移民官网', href: 'https://www.manincorp.cn/' },
    { title: '万年移民论坛', href: 'https://www.manincorp.cn/forum' },
  ];
  const m = await PlatformAdapter.matchTarget(items, TARGET, { strict: true });
  assert.strictEqual(m.href, doubleMatchTop10(items, TARGET));
  assert.strictEqual(m.reason, 'title+domain');
});

test('matchTarget(strict): 与 replicated doubleMatchTop10 语义一致（未中返回 null）', async () => {
  const items = [
    { title: '万年移民攻略', href: 'https://blog.com/post' },
    { title: '随便看看', href: 'https://www.manincorp.cn/' },
  ];
  assert.strictEqual(
    await PlatformAdapter.matchTarget(items, TARGET, { strict: true }),
    doubleMatchTop10(items, TARGET)
  );
});
