'use strict';

/**
 * test/baiduAdapter.test.js
 * ---------------------------------------------------------------------------
 * Regression tests for the BaiduAdapter bugfix:
 *   "baidu #kw input resolved as hidden → open() waitForSelector visible times
 *    out 15s; fix via attached-wait + evaluate-set-value to bypass visibility."
 *
 * These tests DO NOT launch a real browser. They drive the adapter against a
 * fake Playwright `page` whose `evaluate` actually executes the adapter's
 * in-page function in a controlled scope with a fake `document`/`window`/`Event`.
 *
 * What we pin (so a regression immediately fails):
 *   1. open() waits for '#kw' with state:'attached' (NOT 'visible').
 *   2. search() step A waits for '#kw' with state:'attached' (NOT 'visible').
 *   3. search() writes the keyword via page.evaluate (native value setter +
 *      input/change events) — proven to set the value even when the input would
 *      be hidden (no visibility check is performed by evaluate).
 *   4. search() submits via page.evaluate (form.requestSubmit(), fallback
 *      #su click) — NOT via page.press('#kw','Enter') / page.fill.
 *   5. The fake page deliberately OMITS fill / press / click. If the adapter
 *      ever reverts to those visibility-dependent APIs, the call throws and the
 *      test fails.
 */

const test = require('node:test');
const assert = require('node:assert');

const { BaiduAdapter } = require('../core/adapters/baiduAdapter');

// ---------------------------------------------------------------------------
// Fake Playwright page
// ---------------------------------------------------------------------------

/** Build a minimal fake `document` with a #kw / #su / #form. */
function makeFakeDom(captchaDom = false) {
  // #kw element (the "hidden" search box). We model it as a plain object with a
  // value accessor; crucially it has NO visibility semantics, proving the
  // evaluate-set-value path works regardless of visibility.
  const kw = {
    _v: '',
    get value() {
      return this._v;
    },
    set value(v) {
      this._v = v;
    },
    dispatched: [],
    dispatchEvent(ev) {
      this.dispatched.push(ev && ev.type);
    },
  };
  const su = {
    clicked: false,
    click() {
      this.clicked = true;
    },
  };
  const form = {
    submitted: false,
    requestSubmit() {
      this.submitted = true;
    },
  };
  const document = {
    querySelector(sel) {
      if (sel === '#kw') return kw;
      if (sel === '#su') return su;
      if (sel === '#form') return form;
      // captcha DOM markers used by BaiduAdapter._isCaptchaPage via page.evaluate
      // (passed as a single compound selector string). Only present when the
      // fake page is configured to simulate a captcha DOM (captchaDom: true).
      if (captchaDom && /#captcha|\.passMod|\.tuxing|input\[name=captcha\]/.test(sel)) return {};
      return null;
    },
  };
  return { kw, su, form, document };
}

/** Native-ish HTMLInputElement.prototype with an own `value` accessor. */
function makeInputProto() {
  const proto = {};
  Object.defineProperty(proto, 'value', {
    configurable: true,
    get() {
      return this._v;
    },
    set(v) {
      this._v = v;
    },
  });
  return proto;
}

/**
 * Create a fake page whose `evaluate` runs the adapter's in-page function in a
 * scope with fake document/window/Event. fill/press/click are intentionally
 * undefined so any visibility-dependent call throws (regression guard).
 */
function makeFakePage(opts = {}) {
  const { captchaDom = false } = opts;
  const dom = makeFakeDom(captchaDom);
  const inputProto = makeInputProto();
  const FakeEvent = function FakeEvent(type, o) {
    this.type = type;
    this.bubbles = !!(o && o.bubbles);
  };
  const calls = {
    goto: [],
    waitForSelector: [],
    evaluate: [],
    $$: [],
    // captured results of the value-setting evaluate:
    kwValue: null,
    kwEvents: [],
  };

  const page = {
    // NOTE: no fill / press / click on purpose (visibility-dependent APIs).
    // 验证码探测所需的 page 方法：默认「未拦截」状态，可被 opts 覆盖以模拟验证码页。
    url: opts.url || (() => 'https://www.baidu.com'),
    title: opts.title || (async () => '百度一下，你就知道'),
    $: opts.$ || (async () => null),
    $$: opts.$$ || (async (sel) => {
      calls.$$.push(sel);
      return [];
    }),
    waitForTimeout: opts.waitForTimeout || (async () => {}),
    async goto(url, o) {
      calls.goto.push({ url, o });
    },
    async waitForSelector(sel, o) {
      calls.waitForSelector.push({ sel, o });
      return {};
    },
    async evaluate(fn, arg) {
      // Execute the in-page function with our fakes in scope.
      const runner = new Function(
        'document',
        'window',
        'Event',
        'arg',
        `return (${fn.toString()})(arg);`
      );
      const result = runner(dom.document, { HTMLInputElement: { prototype: inputProto } }, FakeEvent, arg);
      calls.evaluate.push({ fn, arg });
      // Snapshot the #kw value/events after each evaluate so tests can inspect.
      calls.kwValue = dom.kw._v;
      calls.kwEvents = dom.kw.dispatched.slice();
      return result;
    },
  };

  return { page, calls, dom };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('open(): waits for #kw with state "attached" (not "visible")', async () => {
  const adapter = new BaiduAdapter();
  const { page, calls } = makeFakePage();

  await adapter.open(page);

  assert.strictEqual(calls.goto.length, 1, 'should navigate once');
  assert.strictEqual(calls.goto[0].url, 'https://www.baidu.com');

  assert.strictEqual(calls.waitForSelector.length, 1, 'open waits for one selector');
  const w = calls.waitForSelector[0];
  assert.strictEqual(w.sel, '#kw');
  assert.strictEqual(w.o.state, 'attached', 'open must use attached, bypassing hidden');
  assert.notStrictEqual(w.o.state, 'visible', 'open must NOT require visibility');
});

test('search(): step A waits for #kw with state "attached"', async () => {
  const adapter = new BaiduAdapter();
  const { page, calls } = makeFakePage();

  await adapter.search(page, '万年移民');

  const boxWaits = calls.waitForSelector.filter((c) => c.sel === '#kw');
  assert.strictEqual(boxWaits.length, 1, 'search waits for #kw exactly once (step A)');
  assert.strictEqual(boxWaits[0].o.state, 'attached', 'step A must use attached');
  assert.notStrictEqual(boxWaits[0].o.state, 'visible', 'step A must NOT require visibility');
});

test('search(): sets keyword via evaluate (no fill), value present even if hidden', async () => {
  const adapter = new BaiduAdapter();
  const { page, calls } = makeFakePage();
  const keyword = '万年移民官网';

  await adapter.search(page, keyword);

  // The value must have been written through the native setter (bypassing any
  // visibility requirement that fill() would impose).
  assert.strictEqual(calls.kwValue, keyword, 'keyword should be set on #kw via evaluate');
  assert.ok(calls.kwEvents.includes('input'), 'should dispatch input event');
  assert.ok(calls.kwEvents.includes('change'), 'should dispatch change event');
});

test('search(): submits via evaluate (requestSubmit / #su click), not press/click API', async () => {
  const adapter = new BaiduAdapter();
  const { page, calls, dom } = makeFakePage();

  // If the adapter called the missing fill/press/click, this would throw.
  await adapter.search(page, '万年移民');

  // The submit evaluate must have triggered the form submit (or #su click).
  const submitted = dom.form.submitted || dom.su.clicked;
  assert.ok(submitted, 'submit should be triggered via evaluate, not page.press/click');
  // Prefer form.requestSubmit() when available; assert the form path here.
  assert.strictEqual(dom.form.submitted, true, 'should call form.requestSubmit()');

  // And the results container is awaited at the end.
  const resultWait = calls.waitForSelector.find((c) => c.sel === '#content_left');
  assert.ok(resultWait, 'search should wait for #content_left at the end');
});

test('search(): wraps a failed step A in a step-named error', async () => {
  const adapter = new BaiduAdapter();
  const { page } = makeFakePage();
  // Force step A's waitForSelector to reject.
  page.waitForSelector = async () => {
    throw new Error('timeout');
  };

  await assert.rejects(
    () => adapter.search(page, 'x'),
    /等待搜索框挂载超时/,
    'should surface a step-named error instead of a raw timeout'
  );
});

test('search(): evaluate-set-value works when #kw is "hidden" (no visibility check)', async () => {
  const adapter = new BaiduAdapter();
  const { page, calls, dom } = makeFakePage();

  // Simulate baidu hiding #kw: mark it hidden via an own property the adapter
  // would otherwise check. The evaluate path must still set the value because
  // it never consults visibility.
  Object.defineProperty(dom.kw, 'offsetParent', { configurable: true, get: () => null });
  Object.defineProperty(dom.kw, 'getClientRects', {
    configurable: true,
    value: () => [],
  });

  await adapter.search(page, 'hidden-kw-test');

  assert.strictEqual(calls.kwValue, 'hidden-kw-test', 'value set even when #kw is hidden');
});

// ---------------------------------------------------------------------------
// Captcha / verification-block detection (_isCaptchaPage + manual-solve poll)
// ---------------------------------------------------------------------------

// 一个支持「轮询过程」的假 page：captchaPolls 次轮询内页面是验证码页、#content_left 不可见；
// 超过后变为结果页（#content_left 可见）。waitForTimeout 立即返回（不真实 sleep），
// 但每次调用推进 poll 计数，模拟时间流逝。
function makeCaptchaHarness(opts) {
  const { captchaPolls = 0 } = opts || {};
  let poll = 0;
  const onCaptcha = () => poll < captchaPolls;
  const calls = { waitForSelector: [], evaluate: [], url: [] };
  const page = {
    url: () => {
      calls.url.push(poll);
      return onCaptcha() ? 'https://wappass.baidu.com/static/captcha/tuxing_v2.html' : 'https://www.baidu.com/s?wd=x';
    },
    title: async () => (onCaptcha() ? '百度安全验证' : '百度一下，你就知道'),
    // #content_left 仅在「已过码」的轮询后出现
    async waitForSelector(sel) {
      calls.waitForSelector.push({ sel, poll });
      // step A/B/C selectors (#kw/#su/#form) must resolve so search() can proceed
      if (sel !== '#content_left') return {};
      // #content_left only appears once the captcha has been passed
      if (!onCaptcha()) return {};
      throw new Error('not ready');
    },
    waitForTimeout: async () => {
      poll += 1; // 推进轮询计数
    },
    // #kw 写值 / 提交所需的 evaluate（与 makeFakePage 同构，这里不校验 DOM）
    evaluate: async (fn, arg) => {
      calls.evaluate.push({ fn, arg });
      return undefined;
    },
    // _isCaptchaPage 通过 page.evaluate 查询验证码 DOM；默认无验证码元素
    $: async () => null,
  };
  return { page, calls, getPoll: () => poll };
}

test('_isCaptchaPage(): true on wappass URL / 验证 title / captcha DOM; false on normal page', async () => {
  const adapter = new BaiduAdapter();

  assert.strictEqual(
    await adapter._isCaptchaPage(makeFakePage({ url: () => 'https://wappass.baidu.com/static/captcha/tuxing_v2.html' }).page),
    true,
    'wappass.baidu.com url => captcha'
  );
  assert.strictEqual(
    await adapter._isCaptchaPage(makeFakePage({ title: async () => '百度安全验证' }).page),
    true,
    'title 含「安全验证」 => captcha'
  );
  assert.strictEqual(
    await adapter._isCaptchaPage(makeFakePage({ captchaDom: true }).page),
    true,
    'captcha DOM element present => captcha'
  );
  assert.strictEqual(
    await adapter._isCaptchaPage(makeFakePage().page),
    false,
    'normal baidu page => not captcha'
  );
  // 负向边界：URL 仅含 "wappass" 子串而非 "wappass.baidu.com" 域名时不应误判。
  assert.strictEqual(
    await adapter._isCaptchaPage(makeFakePage({ url: () => 'https://www.baidu.com/s?wd=wappass' }).page),
    false,
    '"wappass" as a query substring (not the host) must NOT be treated as blocked'
  );
});

test('search(): #content_left appears immediately (no captcha) -> success, no captcha branch', async () => {
  const adapter = new BaiduAdapter();
  // captchaPolls=0 => 首轮即结果页
  const { page } = makeCaptchaHarness({ captchaPolls: 0 });

  await adapter.search(page, '万年移民'); // 不应抛错
  assert.strictEqual(page.url(), 'https://www.baidu.com/s?wd=x');
});

test('search(): hits captcha, user solves after N polls, then results appear -> success', async () => {
  const adapter = new BaiduAdapter();
  const { page } = makeCaptchaHarness({ captchaPolls: 2 }); // 前 2 轮验证码，第 3 轮结果

  await adapter.search(page, '万年移民'); // 不应抛错（最终拿到结果页）
  assert.ok(page.url().includes('www.baidu.com/s'), '最终落在结果页');
});

test('search(): stuck on captcha, never solved -> throws ERR_BAIDU_CAPTCHA', async () => {
  const adapter = new BaiduAdapter();
  // captchaPolls 极大 => 永远验证码页，轮询耗尽后抛错
  const { page } = makeCaptchaHarness({ captchaPolls: Number.MAX_SAFE_INTEGER });

  await assert.rejects(
    () => adapter.search(page, '万年移民'),
    /ERR_BAIDU_CAPTCHA/,
    'search must throw ERR_BAIDU_CAPTCHA after polling exhausts'
  );
});

test('locateTarget(): throws ERR_BAIDU_CAPTCHA when on captcha page (secondary guard)', async () => {
  const adapter = new BaiduAdapter();
  const { page, calls } = makeFakePage({ url: () => 'https://wappass.baidu.com/...' });

  await assert.rejects(
    () => adapter.locateTarget(page, { domain: 'example.com', titleKeywords: ['Example'] }),
    /ERR_BAIDU_CAPTCHA/,
    'locateTarget must throw the captcha error (secondary guard)'
  );
  // 二次保险：守卫须在解析结果列表（page.$$）之前短路，避免误解析验证码页。
  assert.strictEqual(
    calls.$$.length,
    0,
    'locateTarget must NOT parse results (page.$$) when verification-blocked'
  );
});

// ---------------------------------------------------------------------------
// open() — captcha-aware (多 round 连续搜索触发百度验证码页)
// ---------------------------------------------------------------------------

test('open(): captcha page solved after N polls -> returns success (no #kw 15s timeout)', async () => {
  const adapter = new BaiduAdapter();
  let poll = 0;
  const captchaPolls = 2; // 前 2 次轮询为验证码页，第 3 次变回正常首页
  const onCaptcha = () => poll < captchaPolls;
  const page = {
    url: () => (onCaptcha() ? 'https://wappass.baidu.com/static/captcha/tuxing_v2.html' : 'https://www.baidu.com'),
    title: async () => (onCaptcha() ? '百度安全验证' : '百度一下，你就知道'),
    goto: async () => {},
    // 过码后 #kw 立即可 attached
    waitForSelector: async () => ({}),
    waitForTimeout: async () => { poll += 1; },
    evaluate: async () => undefined,
    $: async () => null,
  };

  // 不应抛错：过码成功后 open 立即返回（而非傻等 #kw 15s 超时）
  await adapter.open(page);
});

test('open(): stuck on captcha forever -> throws ERR_BAIDU_CAPTCHA', async () => {
  const adapter = new BaiduAdapter();
  const page = {
    url: () => 'https://wappass.baidu.com/static/captcha/tuxing_v2.html',
    title: async () => '百度安全验证',
    goto: async () => {},
    waitForSelector: async () => ({}),
    waitForTimeout: async () => {}, // 立即返回，轮询耗尽后抛错（不真实 sleep）
    evaluate: async () => undefined,
    $: async () => null,
  };

  await assert.rejects(
    () => adapter.open(page),
    /ERR_BAIDU_CAPTCHA/,
    'open must throw ERR_BAIDU_CAPTCHA when stuck on captcha forever'
  );
});

test('open(): captcha detected immediately, does NOT wait #kw 15s before polling', async () => {
  const adapter = new BaiduAdapter();
  let poll = 0;
  const captchaPolls = 1;
  const onCaptcha = () => poll < captchaPolls;
  let enteredPoll = false;
  const page = {
    url: () => (onCaptcha() ? 'https://wappass.baidu.com/static/captcha/tuxing_v2.html' : 'https://www.baidu.com'),
    title: async () => (onCaptcha() ? '百度安全验证' : '百度一下，你就知道'),
    goto: async () => {},
    waitForSelector: async () => ({}),
    waitForTimeout: async () => { enteredPoll = true; poll += 1; },
    evaluate: async () => undefined,
    $: async () => null,
  };

  await adapter.open(page);
  assert.strictEqual(enteredPoll, true, 'should enter captcha poll (warn) instead of waiting #kw 15s');
});
