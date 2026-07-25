'use strict';

/**
 * test/baiduAdapter.qa.test.js
 * ---------------------------------------------------------------------------
 * Comprehensive QA test suite for BaiduAdapter (QA Engineer — Edward).
 *
 * Scope: independently validate the #kw-hidden bugfix
 *   (open/search now use state:'attached' + page.evaluate set-value/submit,
 *    bypassing Playwright's visibility requirement) AND broaden coverage to
 *   edge cases the regression suite (baiduAdapter.test.js, 6 cases) does not
 *   pin:
 *      - step-level error wrapping for steps B / C / D
 *      - submit fallback path (#su click when form.requestSubmit missing)
 *      - submit selector precedence (#form > form[action*=baidu] > form)
 *      - empty-keyword set-value
 *      - regression guard: page.fill / page.press / page.click are NEVER used
 *      - locateTarget double-match (title + real-domain) with network mocked
 *
 * No real browser is launched. A fake Playwright `page` runs the adapter's
 * in-page `evaluate` functions in a controlled scope (fake document/window/
 * Event). fill/press/click are intentionally absent so any revert to the
 * visibility-dependent API throws (regression guard).
 */

const test = require('node:test');
const assert = require('node:assert');

const { BaiduAdapter } = require('../core/adapters/baiduAdapter');
const { PlatformAdapter } = require('../core/adapters/platformAdapter');

// ---------------------------------------------------------------------------
// Fake DOM / page builders
// ---------------------------------------------------------------------------

/** A #kw element modelled as hidden-irrelevant (no visibility semantics). */
function makeKw() {
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
  return kw;
}

/** A #su button. */
function makeSu() {
  return {
    clicked: false,
    click() {
      this.clicked = true;
    },
  };
}

/**
 * Build a form object.
 * @param {boolean} hasRequestSubmit if true, exposes a working requestSubmit()
 */
function makeForm(hasRequestSubmit) {
  const form = {
    submitted: false,
  };
  if (hasRequestSubmit) {
    form.requestSubmit = function requestSubmit() {
      this.submitted = true;
    };
  }
  return form;
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
 * Build a fake page + introspection handles.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.kw=true]        #kw present in DOM
 * @param {boolean} [opts.su=true]        #su present in DOM
 * @param {'requestSubmit'|'noRequestSubmit'|null} [opts.form='requestSubmit']
 *        #form element: 'requestSubmit' => has requestSubmit();
 *        'noRequestSubmit' => present but no requestSubmit();
 *        null => #form absent.
 * @param {'requestSubmit'|null} [opts.baiduForm=null]  form[action*=baidu]
 * @param {'requestSubmit'|null} [opts.genericForm=null] generic 'form'
 * @param {(sel:string)=>any} [opts.waitForSelectorImpl] override waitForSelector
 */
function buildHarness(opts = {}) {
  const {
    kw = true,
    su = true,
    form = 'requestSubmit',
    baiduForm = null,
    genericForm = null,
    waitForSelectorImpl = null,
  } = opts;

  const kwEl = kw ? makeKw() : null;
  const suEl = su ? makeSu() : null;
  const formEl = form === 'requestSubmit' ? makeForm(true) : form === 'noRequestSubmit' ? makeForm(false) : null;
  const baiduFormEl = baiduForm === 'requestSubmit' ? makeForm(true) : null;
  const genericFormEl = genericForm === 'requestSubmit' ? makeForm(true) : null;

  const document = {
    querySelector(sel) {
      switch (sel) {
        case '#kw':
          return kwEl;
        case '#su':
          return suEl;
        case '#form':
          return formEl;
        case 'form[action*="baidu"]':
          return baiduFormEl;
        case 'form':
          return genericFormEl;
        default:
          return null;
      }
    },
  };

  const inputProto = makeInputProto();
  const FakeEvent = function FakeEvent(type, o) {
    this.type = type;
    this.bubbles = !!(o && o.bubbles);
  };

  const calls = {
    goto: [],
    waitForSelector: [],
    evaluate: [],
    fill: [],
    press: [],
    click: [],
    kwValue: null,
    kwEvents: [],
  };

  const page = {
    // NOTE: fill / press / click are intentionally omitted. If the adapter
    // ever reverts to them, the call throws -> test fails (regression guard).

    // 验证码探测所需的 page 方法（默认「未拦截」状态）。adapter 的
    // _isVerificationBlocked + search 步骤C/D 之间的 settle 依赖这些方法；
    // 此处提供默认实现，保证既有用例不被新逻辑破坏。
    url: () => 'https://www.baidu.com',
    title: async () => '百度一下，你就知道',
    $: async () => null,
    waitForTimeout: async () => {},

    async goto(url, o) {
      calls.goto.push({ url, o });
    },

    async waitForSelector(sel, o) {
      if (waitForSelectorImpl) {
        return waitForSelectorImpl(sel, o, calls);
      }
      calls.waitForSelector.push({ sel, o });
      return {};
    },

    async evaluate(fn, arg) {
      const runner = new Function(
        'document',
        'window',
        'Event',
        'arg',
        `return (${fn.toString()})(arg);`
      );
      const result = runner(
        document,
        { HTMLInputElement: { prototype: inputProto } },
        FakeEvent,
        arg
      );
      calls.evaluate.push({ fn, arg });
      if (kwEl) {
        calls.kwValue = kwEl._v;
        calls.kwEvents = kwEl.dispatched.slice();
      }
      return result;
    },
  };

  return { page, calls, dom: { kwEl, suEl, formEl, baiduFormEl, genericFormEl, document } };
}

// ---------------------------------------------------------------------------
// open()
// ---------------------------------------------------------------------------

test('QA open(): navigates to baidu home with domcontentloaded + 20s, then waits #kw attached (not visible)', async () => {
  const adapter = new BaiduAdapter();
  const { page, calls } = buildHarness();

  await adapter.open(page);

  assert.strictEqual(calls.goto.length, 1, 'open must navigate exactly once');
  assert.strictEqual(calls.goto[0].url, 'https://www.baidu.com');
  assert.strictEqual(calls.goto[0].o.waitUntil, 'domcontentloaded');
  assert.strictEqual(calls.goto[0].o.timeout, 20000);

  assert.strictEqual(calls.waitForSelector.length, 1, 'open waits for exactly one selector');
  const w = calls.waitForSelector[0];
  assert.strictEqual(w.sel, '#kw');
  assert.strictEqual(w.o.state, 'attached', 'open must use attached to bypass hidden');
  assert.notStrictEqual(w.o.state, 'visible', 'open must NOT require visibility');
  assert.strictEqual(w.o.timeout, 15000, 'open waits up to 15s for attached');
});

// ---------------------------------------------------------------------------
// search() — step A (attached wait)
// ---------------------------------------------------------------------------

test('QA search(): step A waits #kw attached and never uses visible', async () => {
  const adapter = new BaiduAdapter();
  const { page, calls } = buildHarness();

  await adapter.search(page, '万年移民');

  const boxWaits = calls.waitForSelector.filter((c) => c.sel === '#kw');
  assert.strictEqual(boxWaits.length, 1, 'search waits for #kw exactly once (step A)');
  assert.strictEqual(boxWaits[0].o.state, 'attached');
  assert.notStrictEqual(boxWaits[0].o.state, 'visible');
  assert.strictEqual(boxWaits[0].o.timeout, 10000, 'step A uses WAIT_BOX timeout');
});

// ---------------------------------------------------------------------------
// search() — step B (evaluate set-value)
// ---------------------------------------------------------------------------

test('QA search(): step B sets keyword via native value setter + input/change events (no fill)', async () => {
  const adapter = new BaiduAdapter();
  const { page, calls } = buildHarness();
  const keyword = '万年移民官网';

  await adapter.search(page, keyword);

  // Value written through the native setter (bypasses visibility).
  assert.strictEqual(calls.kwValue, keyword, 'keyword should be set on #kw via evaluate');
  assert.ok(calls.kwEvents.includes('input'), 'should dispatch input event');
  assert.ok(calls.kwEvents.includes('change'), 'should dispatch change event');
  // Regression guard: fill must never be called.
  assert.strictEqual(calls.fill.length, 0, 'must NOT use page.fill');
});

test('QA search(): step B handles empty-string keyword (still sets value + dispatches)', async () => {
  const adapter = new BaiduAdapter();
  const { page, calls } = buildHarness();

  await adapter.search(page, '');

  assert.strictEqual(calls.kwValue, '', 'empty keyword should set value to empty string');
  assert.ok(calls.kwEvents.includes('input'));
  assert.ok(calls.kwEvents.includes('change'));
});

test('QA search(): step B wraps failure in step-named error "填写搜索词超时"', async () => {
  const adapter = new BaiduAdapter();
  // Remove #kw so the evaluate throws "#kw not found" internally.
  const { page } = buildHarness({ kw: false });

  await assert.rejects(
    () => adapter.search(page, 'x'),
    /填写搜索词超时/,
    'step B failure must surface as "填写搜索词超时"'
  );
});

// ---------------------------------------------------------------------------
// search() — step C (evaluate submit, with selector precedence + fallback)
// ---------------------------------------------------------------------------

test('QA search(): step C prefers #form.requestSubmit() when available', async () => {
  const adapter = new BaiduAdapter();
  const { page, calls, dom } = buildHarness({ form: 'requestSubmit' });

  await adapter.search(page, '万年移民');

  assert.strictEqual(dom.formEl.submitted, true, 'should call #form.requestSubmit()');
  assert.strictEqual(dom.suEl.clicked, false, 'should NOT click #su when requestSubmit exists');
  assert.strictEqual(calls.press.length, 0, 'must NOT use page.press');
  assert.strictEqual(calls.click.length, 0, 'must NOT use page.click');
});

test('QA search(): step C falls back to #su click when #form has no requestSubmit()', async () => {
  const adapter = new BaiduAdapter();
  const { page, dom } = buildHarness({ form: 'noRequestSubmit' });

  await adapter.search(page, '万年移民');

  assert.strictEqual(dom.formEl.submitted, false, 'form.requestSubmit absent -> not called');
  assert.strictEqual(dom.suEl.clicked, true, 'should click #su as fallback');
});

test('QA search(): step C falls back to form[action*=baidu] when #form absent', async () => {
  const adapter = new BaiduAdapter();
  const { page, dom } = buildHarness({ form: null, baiduForm: 'requestSubmit' });

  await adapter.search(page, '万年移民');

  assert.strictEqual(dom.formEl, null, '#form should be absent in this scenario');
  assert.strictEqual(dom.baiduFormEl.submitted, true, 'should use the baidu-action form');
  assert.strictEqual(dom.suEl.clicked, false);
});

test('QA search(): step C falls back to generic form when only a bare form exists', async () => {
  const adapter = new BaiduAdapter();
  const { page, dom } = buildHarness({ form: null, baiduForm: null, genericForm: 'requestSubmit' });

  await adapter.search(page, '万年移民');

  assert.strictEqual(dom.genericFormEl.submitted, true, 'should use the generic form');
});

test('QA search(): step C wraps failure in step-named error "提交搜索(表单/按钮)超时"', async () => {
  const adapter = new BaiduAdapter();
  // No form AND no #su -> evaluate throws "search form/button not found".
  const { page } = buildHarness({ form: null, su: false });

  await assert.rejects(
    () => adapter.search(page, 'x'),
    /提交搜索\(表单\/按钮\)超时/,
    'step C failure must surface as "提交搜索(表单/按钮)超时"'
  );
});

// ---------------------------------------------------------------------------
// search() — step D (poll for results container / captcha manual-solve)
// ---------------------------------------------------------------------------

test('QA search(): step D polls for #content_left (visible) until it appears', async () => {
  const adapter = new BaiduAdapter();
  const { page, calls } = buildHarness();

  await adapter.search(page, '万年移民');

  // 轮询：每一轮都会用 state:'visible' 探测 #content_left（默认 harness 立即命中）
  const resultPolls = calls.waitForSelector.filter((c) => c.sel === '#content_left');
  assert.ok(resultPolls.length >= 1, 'search must poll for #content_left at the end');
  assert.strictEqual(resultPolls[0].o.state, 'visible', 'polls #content_left with state:visible');
  assert.strictEqual(resultPolls[0].o.timeout, 2000, 'each poll uses CAPTCHA_POLL_INTERVAL (2000ms)');
});

test('QA search(): step D throws ERR_BAIDU_CAPTCHA when #content_left never appears', async () => {
  const adapter = new BaiduAdapter();
  const { page } = buildHarness({
    waitForSelectorImpl: (sel) => {
      if (sel === '#content_left') {
        throw new Error('timeout waiting for results');
      }
      return {};
    },
  });

  await assert.rejects(
    () => adapter.search(page, 'x'),
    /ERR_BAIDU_CAPTCHA/,
    'step D exhaustion must surface as "百度安全验证未通过或结果未加载（ERR_BAIDU_CAPTCHA）"'
  );
});

// ---------------------------------------------------------------------------
// Regression guard — visibility-dependent APIs must never be touched
// ---------------------------------------------------------------------------

test('QA search(): never calls page.fill / page.press / page.click (visibility-independent path)', async () => {
  const adapter = new BaiduAdapter();
  // Provide the forbidden APIs; if the adapter calls any, record it (and it
  // should NOT).
  const { page, calls } = buildHarness();
  page.fill = async (...a) => { calls.fill.push(a); };
  page.press = async (...a) => { calls.press.push(a); };
  page.click = async (...a) => { calls.click.push(a); };

  await adapter.search(page, '万年移民');

  assert.strictEqual(calls.fill.length, 0, 'search must not call page.fill');
  assert.strictEqual(calls.press.length, 0, 'search must not call page.press');
  assert.strictEqual(calls.click.length, 0, 'search must not call page.click');
});

// ---------------------------------------------------------------------------
// locateTarget() — double match (title + real domain)
// ---------------------------------------------------------------------------

/** Fake page exposing $$ / $ for locateTarget double-match testing. */
function buildLocateHarness(items) {
  const page = {
    async $$(sel) {
      return items;
    },
  };
  return page;
}

test('QA locateTarget(): returns first item whose title + real domain both match', async () => {
  const adapter = new BaiduAdapter();
  const original = PlatformAdapter.resolveFinalUrl;
  // Mock network resolution so tests are deterministic & offline.
  PlatformAdapter.resolveFinalUrl = async (href) => href;

  const linkA = { textContent: () => 'Other Site', getAttribute: () => 'https://other.com/x' };
  const linkB = { textContent: () => 'Example Official', getAttribute: () => 'https://example.com/p' };
  const items = [
    { $: async () => linkA },
    { $: async () => linkB },
  ];
  const page = buildLocateHarness(items);

  const result = await adapter.locateTarget(page, {
    domain: 'example.com',
    titleKeywords: ['Example', 'Official'],
  });

  assert.strictEqual(result, 'https://example.com/p');
  PlatformAdapter.resolveFinalUrl = original;
});

test('QA locateTarget(): throws diagnostic when neither title nor domain matches', async () => {
  const adapter = new BaiduAdapter();
  const original = PlatformAdapter.resolveFinalUrl;
  PlatformAdapter.resolveFinalUrl = async (href) => href;

  const link = { textContent: () => 'Unrelated', getAttribute: () => 'https://other.com/p' };
  const items = [{ $: async () => link }];
  const page = buildLocateHarness(items);

  try {
    await assert.rejects(
      () => adapter.locateTarget(page, { domain: 'example.com', titleKeywords: ['Example'] }),
      /目标域名「example.com」未出现/,
      'locateTarget must throw a diagnostic (domain not in top 10) instead of returning null'
    );
  } finally {
    PlatformAdapter.resolveFinalUrl = original;
  }
});

test('QA locateTarget(): domain-only fallback when title misses but domain matches (the 100% locate-failure fix)', async () => {
  const adapter = new BaiduAdapter();
  const original = PlatformAdapter.resolveFinalUrl;
  PlatformAdapter.resolveFinalUrl = async (href) => href;

  // 站点标题「万年县移民局」不含关键词「万年移民」，但域名命中 ->
  // 旧严格逻辑会 100% 失败；新 non-strict 应走 domain-only 兜底返回真实地址。
  const link = { textContent: () => '万年县移民局官网', getAttribute: () => 'https://www.manincorp.cn/' };
  const items = [{ $: async () => link }];
  const page = buildLocateHarness(items);

  const result = await adapter.locateTarget(page, {
    domain: 'manincorp.cn',
    titleKeywords: ['万年移民'],
  });

  assert.strictEqual(result, 'https://www.manincorp.cn/');
  PlatformAdapter.resolveFinalUrl = original;
});

test('QA locateTarget(): throws diagnostic when title matches but domain does not', async () => {
  const adapter = new BaiduAdapter();
  const original = PlatformAdapter.resolveFinalUrl;
  PlatformAdapter.resolveFinalUrl = async (href) => href;

  const link = { textContent: () => 'Example Site', getAttribute: () => 'https://other.com/p' };
  const items = [{ $: async () => link }];
  const page = buildLocateHarness(items);

  try {
    await assert.rejects(
      () => adapter.locateTarget(page, { domain: 'example.com', titleKeywords: ['Example'] }),
      /目标域名「example.com」未出现/,
      'locateTarget must throw a diagnostic (domain not in top 10) instead of returning null'
    );
  } finally {
    PlatformAdapter.resolveFinalUrl = original;
  }
});

test('QA locateTarget(): throws diagnostic when item has no link (a is null)', async () => {
  const adapter = new BaiduAdapter();
  const original = PlatformAdapter.resolveFinalUrl;
  PlatformAdapter.resolveFinalUrl = async (href) => href;

  const items = [{ $: async () => null }];
  const page = buildLocateHarness(items);

  try {
    await assert.rejects(
      () => adapter.locateTarget(page, { domain: 'example.com', titleKeywords: ['Example'] }),
      /目标域名「example.com」未出现/,
      'locateTarget must throw a diagnostic (no parseable result) instead of returning null'
    );
  } finally {
    PlatformAdapter.resolveFinalUrl = original;
  }
});

test('QA locateTarget(): uses container mu attribute for real URL (no network / 免网络)', async () => {
  const adapter = new BaiduAdapter();
  const original = PlatformAdapter.resolveFinalUrl;
  let resolveCalls = 0;
  PlatformAdapter.resolveFinalUrl = async (href) => { resolveCalls += 1; return href; };

  // 链接 href 是百度跳转链接，但容器 mu 直接声明真实 URL —— 应免网络直接采用。
  const link = {
    textContent: () => '万年县移民局官网',
    getAttribute: (name) => (name === 'href' ? 'https://www.baidu.com/link?url=xyz' : ''),
  };
  const item = {
    $: async () => link,
    getAttribute: (name) => (name === 'mu' ? 'https://www.manincorp.cn/' : ''),
  };
  const page = buildLocateHarness([item]);

  const result = await adapter.locateTarget(page, {
    domain: 'manincorp.cn',
    titleKeywords: ['万年移民'],
  });

  assert.strictEqual(result, 'https://www.manincorp.cn/', '应经 mu 真实 URL 走 domain-only 命中');
  assert.strictEqual(resolveCalls, 0, 'mu 路径不得触发 resolveFinalUrl（免网络）');
  PlatformAdapter.resolveFinalUrl = original;
});

test('QA locateTarget(): falls back to container data-url attribute for real URL (no network)', async () => {
  const adapter = new BaiduAdapter();
  const original = PlatformAdapter.resolveFinalUrl;
  let resolveCalls = 0;
  PlatformAdapter.resolveFinalUrl = async (href) => { resolveCalls += 1; return href; };

  const link = {
    textContent: () => '万年县移民局官网',
    getAttribute: (name) => (name === 'href' ? 'https://www.baidu.com/link?url=xyz' : ''),
  };
  const item = {
    $: async () => link,
    getAttribute: (name) => (name === 'data-url' ? 'https://www.manincorp.cn/' : ''),
  };
  const page = buildLocateHarness([item]);

  const result = await adapter.locateTarget(page, {
    domain: 'manincorp.cn',
    titleKeywords: ['万年移民'],
  });

  assert.strictEqual(result, 'https://www.manincorp.cn/', '应经 data-url 真实 URL 命中');
  assert.strictEqual(resolveCalls, 0, 'data-url 路径不得触发 resolveFinalUrl');
  PlatformAdapter.resolveFinalUrl = original;
});

test('QA locateTarget(): resolves baidu /link?url= via resolveFinalUrl when no mu/data-url', async () => {
  const adapter = new BaiduAdapter();
  const original = PlatformAdapter.resolveFinalUrl;
  let resolvedHref = null;
  PlatformAdapter.resolveFinalUrl = async (href) => {
    resolvedHref = href;
    return 'https://www.manincorp.cn/'; // mock HEAD 重定向解析
  };

  const link = {
    textContent: () => '万年县移民局官网',
    getAttribute: (name) => (name === 'href' ? 'https://www.baidu.com/link?url=xyz' : ''),
  };
  const item = {
    $: async () => link,
    getAttribute: () => '', // 无 mu、无 data-url
  };
  const page = buildLocateHarness([item]);

  const result = await adapter.locateTarget(page, {
    domain: 'manincorp.cn',
    titleKeywords: ['万年移民'],
  });

  assert.strictEqual(resolvedHref, 'https://www.baidu.com/link?url=xyz', '应把跳转链接交给 resolveFinalUrl');
  assert.strictEqual(result, 'https://www.manincorp.cn/', '应使用解析后的真实 URL（domain-only）');
  PlatformAdapter.resolveFinalUrl = original;
});

test('QA locateTarget(): scans ALL results on page 1 (item #11 now matched, not ignored)', async () => {
  const adapter = new BaiduAdapter();
  const original = PlatformAdapter.resolveFinalUrl;
  PlatformAdapter.resolveFinalUrl = async (href) => href;

  // 12 items; the 11th matches and must now be considered (no slice(0,10) cap).
  const matching = { textContent: () => 'Example Official', getAttribute: () => 'https://example.com/p' };
  const items = [];
  for (let i = 0; i < 12; i++) {
    if (i === 10) {
      items.push({ $: async () => matching });
    } else {
      items.push({ $: async () => ({ textContent: () => 'X', getAttribute: () => 'https://a.com' }) });
    }
  }
  const page = buildLocateHarness(items);

  try {
    const result = await adapter.locateTarget(page, { domain: 'example.com', titleKeywords: ['Example'] });
    assert.strictEqual(result, 'https://example.com/p', 'item #11 must be considered and matched');
  } finally {
    PlatformAdapter.resolveFinalUrl = original;
  }
});
