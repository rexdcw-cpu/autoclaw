'use strict';

/**
 * test/googleAdapter.test.js
 * ---------------------------------------------------------------------------
 * 谷歌适配器「完善」后的回归测试，镜像 baiduAdapter.test.js 的模式：
 * 用假 Playwright `page` 驱动适配器，其 `evaluate` 在受控作用域里执行适配器
 * 注入的页面函数（带假 document/window/Event）。
 *
 * 锁定以下行为，任何回归立即失败：
 *   1. open() 等待 `textarea[name="q"]` 且 state:'attached'（不要求可见）。
 *   2. open() 命中 Google 同意页（consent.google.com）→ 自动点击「同意」并离开。
 *   3. open() 命中验证码（google.com/sorry）→ 轮询等待手动过码 / 卡死抛 ERR_GOOGLE_CAPTCHA。
 *   4. search() 步骤A 等待搜索框 attached；步骤B 用 evaluate 写值（无 fill）；
 *      步骤C 用 evaluate 提交（requestSubmit，无 press/click API）；步骤D 等待 #rso。
 *   5. locateTarget() 用 `#rso h3 a` 精准取标题主链接（修复旧版遍历全部 `a` 的噪声），
 *      复用基类 matchTarget 做双匹配，未命中时抛出可诊断错误。
 */

const test = require('node:test');
const assert = require('node:assert');

const { GoogleAdapter } = require('../core/adapters/googleAdapter');

// ---------------------------------------------------------------------------
// 假 Playwright page
// ---------------------------------------------------------------------------

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
 * 构造假 page。行为由 opts 控制：
 *   - startConsent: 初始落在同意页（URL=consent.google.com）。配合 opts.consent
 *     （{accepted:false}）与 opts.consentButtons（含「同意」按钮）模拟同意流程。
 *   - captchaPolls: 前 N 次轮询处于验证码页（URL=sorry），之后恢复正常结果页。
 *   - resultAnchors: locateTarget 时 `page.$$('#rso h3 a')` 返回的假链接数组（旧版 DOM）。
 *   - newStyleAnchors: locateTarget 时新版 `page.$$('#rso a[data-ved]')` 返回的假链接数组
 *     （2026 Google SERP 新结构）。每项为 { title, href }，title 模拟 [role="heading"] 子元素文本。
 *   - pages: 多页场景。`[{ anchors, nextHref }, ...]`，pageIndex 从 0 起，
 *     调 goto 含 `start=` 的 URL 时推进到下一页；默认由 resultAnchors 退化为单页。
 *   - baseUrl/baseBody: 正常（非同意/非验证码）时的 URL/正文。
 */
function makeGooglePage(opts = {}) {
  const inputProto = makeInputProto();
  const pages =
    opts.pages ||
    (opts.resultAnchors ? [{ anchors: opts.resultAnchors, nextHref: null }] : []);
  let pageIndex = 0;
  const curPage = () => pages[pageIndex] || { anchors: [], nextHref: null };
  const FakeEvent = function FakeEvent(type, o) {
    this.type = type;
    this.bubbles = !!(o && o.bubbles);
  };
  const calls = {
    goto: [],
    waitForSelector: [],
    evaluate: [],
    $$: [],
    url: [],
    kwValue: null,
    kwEvents: [],
    formSubmitted: false,
  };

  let poll = 0;
  const captchaPolls = opts.captchaPolls || 0;
  const onCaptcha = () => poll < captchaPolls;

  const q = {
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
  const form = {
    submitted: false,
    requestSubmit() {
      this.submitted = true;
    },
  };
  const consentButtons = opts.consentButtons || [];

  const document = {
    querySelector(sel) {
      if (sel === 'textarea[name="q"]') return q;
    if (sel === 'input[name="btnK"]')
      return opts.human
        ? { getBoundingClientRect: () => ({ x: 10, y: 10, width: 80, height: 30 }) }
        : null;
      if (sel === 'form[action="/search"]' || sel === 'form[role="search"]' || sel === 'form')
        return form;
      // 分页：当前页存在下一页链接时返回带 href 的假锚点
      if (sel === 'a#pnnext') {
        const np = curPage().nextHref;
        return np ? { getAttribute: (n) => (n === 'href' ? np : '') } : null;
      }
      return null;
    },
    querySelectorAll(sel) {
      if (/button|input\[type="submit"\]|a\[role="button"\]/.test(sel)) return consentButtons;
      // 分页兜底：带 aria-label 下一页/Next 的 start= 链接
      if (sel.includes('a[href*="start="]')) {
        const np = curPage().nextHref;
        return np
          ? [{ getAttribute: (n) => (n === 'href' ? np : n === 'aria-label' ? 'Next' : ''), textContent: 'Next' }]
          : [];
      }
      return [];
    },
    body: {
      get innerText() {
        if (opts.consent && opts.consent.accepted) return '';
        if (onCaptcha()) return 'unusual traffic detected';
        return opts.baseBody || '';
      },
    },
  };

  const computeUrl = () => {
    if (opts.consent && opts.consent.accepted) return 'https://www.google.com';
    if (opts.startConsent && !(opts.consent && opts.consent.accepted))
      return 'https://consent.google.com/intro';
    if (onCaptcha()) return 'https://www.google.com/sorry/?continue=https://www.google.com/search';
    return opts.baseUrl || 'https://www.google.com/search?q=x';
  };

  const page = {
    // 拟人模式：提供真实 focus/keyboard/mouse，用于验证「逐字输入 + 真实鼠标点击」
    focus: opts.human
      ? async (sel) => {
          calls.focus = sel;
        }
      : undefined,
    keyboard: opts.human
      ? {
          type: async (text) => {
            calls.keyboardType = (calls.keyboardType || '') + text;
            calls.keyboardTypeCalls = (calls.keyboardTypeCalls || 0) + 1;
          },
          press: async (k) => {
            calls.keyboardPress = k;
          },
        }
      : undefined,
    mouse: opts.human
      ? {
          move: async (x, y) => {
            calls.mouseMove = { x, y };
          },
          click: async (x, y) => {
            calls.mouseClick = { x, y };
          },
        }
      : undefined,
    url: () => {
      calls.url.push(computeUrl());
      return computeUrl();
    },
    title: opts.title || (async () => 'Google'),
    waitForTimeout: opts.waitForTimeout || (async () => {
      poll += 1; // 推进轮询计数，模拟时间流逝
    }),
    async goto(url, o) {
      calls.goto.push({ url, o });
      // 翻页：goto 含 start= 的下一页 URL 时推进到下一页
      if (typeof url === 'string' && /[?&]start=\d+/.test(url) && pageIndex < pages.length - 1) {
        pageIndex += 1;
      }
    },
    async waitForSelector(sel, o) {
      calls.waitForSelector.push({ sel, o });
      if (sel === '#rso') {
        // 结果页仅在「非验证码且非同意」时出现
        const isBlocked =
          (opts.consent && !opts.consent.accepted && opts.startConsent) || onCaptcha();
        if (!isBlocked) return {};
        throw new Error('no #rso yet');
      }
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
      const result = runner(document, { HTMLInputElement: { prototype: inputProto } }, FakeEvent, arg);
      calls.evaluate.push({ fn, arg });
      calls.kwValue = q._v;
      calls.kwEvents = q.dispatched.slice();
      calls.formSubmitted = form.submitted;
      return result;
    },
    async $$(sel) {
      calls.$$.push(sel);
      // 新版 2026 Google SERP: a[data-ved] 容器（优先）
      if (sel.includes('a[data-ved]') && opts.newStyleAnchors) {
        return (opts.newStyleAnchors || []).slice();
      }
      // 旧版 #rso h3 a
      if (sel === '#rso h3 a') return (curPage().anchors || []).slice();
      // 第三层兜底（v0.3.37）：区域化 / 未完全加载 SERP 下 NEW/OLD 失效时，
      // 直接从 #rso a[href] 提取真实外链
      if (sel === '#rso a[href]' && opts.genericAnchors) return (opts.genericAnchors || []).slice();
      return [];
    },
  };

  return { page, calls, q, form };
}

/** 构造假结果链接：textContent / getAttribute 均为 async（适配安全读取函数）。 */
function makeAnchor(title, href) {
  return {
    textContent: async () => title,
    getAttribute: async (n) => (n === 'href' ? href : ''),
  };
}

/**
 * 构建新版 Google SERP（2026 a[data-ved] 容器）假链接。
 * 标题在 [role="heading"] 子元素内，不在 <a> 的直接 textContent 中。
 */
function makeNewStyleAnchor(title, href) {
  const heading = {
    textContent: async () => title,
  };
  return {
    textContent: async () => '', // <a> 本身无直接文本
    getAttribute: async (n) => (n === 'href' ? href : n === 'data-ved' ? '2ahUKEwi' : ''),
    $: async (sel) => {
      if (sel === '[role="heading"], h3, [data-attrid="title"]') return heading;
      return null;
    },
    $$: async (sel) => {
      if (sel === '[role="heading"], h3, [data-attrid="title"]') return [heading];
      return [];
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('open(): waits for textarea[name="q"] with state "attached" (not "visible")', async () => {
  const adapter = new GoogleAdapter();
  const { page, calls } = makeGooglePage();

  await adapter.open(page);

  assert.strictEqual(calls.goto.length, 1, 'should navigate once');
  assert.strictEqual(calls.goto[0].url, 'https://www.google.com');

  const boxWaits = calls.waitForSelector.filter((c) => c.sel === 'textarea[name="q"]');
  assert.strictEqual(boxWaits.length, 1, 'open waits for search box exactly once');
  assert.strictEqual(boxWaits[0].o.state, 'attached', 'open must use attached, bypassing hidden');
  assert.notStrictEqual(boxWaits[0].o.state, 'visible', 'open must NOT require visibility');
});

test('open(): consent page → click 同意 and leave, then wait search box', async () => {
  const adapter = new GoogleAdapter();
  const consent = { accepted: false };
  const acceptBtn = { textContent: 'I agree', getAttribute: () => null, click() { consent.accepted = true; } };
  const { page } = makeGooglePage({ startConsent: true, consent, consentButtons: [acceptBtn] });

  await adapter.open(page); // 不应抛错
  assert.strictEqual(consent.accepted, true, 'should have clicked the consent accept button');
});

test('open(): stuck on consent (no button) → throws ERR_GOOGLE_CONSENT', async () => {
  const adapter = new GoogleAdapter();
  const { page } = makeGooglePage({ startConsent: true, consent: { accepted: false } });

  await assert.rejects(
    () => adapter.open(page),
    /ERR_GOOGLE_CONSENT/,
    'open must throw ERR_GOOGLE_CONSENT when consent cannot be passed'
  );
});

test('open(): captcha solved after N polls → success', async () => {
  const adapter = new GoogleAdapter();
  const { page } = makeGooglePage({ captchaPolls: 2 });

  await adapter.open(page); // 前 2 轮验证码，第 3 轮结果页 → 成功
  assert.ok(page.url().includes('google.com'), '最终不在 sorry 拦截页');
});

test('open(): stuck on captcha forever → throws ERR_GOOGLE_CAPTCHA', async () => {
  const adapter = new GoogleAdapter();
  const { page } = makeGooglePage({ captchaPolls: Number.MAX_SAFE_INTEGER });

  await assert.rejects(
    () => adapter.open(page),
    /ERR_GOOGLE_CAPTCHA/,
    'open must throw ERR_GOOGLE_CAPTCHA after polling exhausts'
  );
});

// ---------------------------------------------------------------------------
// search()
// ---------------------------------------------------------------------------

test('search(): step A waits for textarea[name="q"] with state "attached"', async () => {
  const adapter = new GoogleAdapter();
  const { page, calls } = makeGooglePage();

  await adapter.search(page, '万年移民');

  const boxWaits = calls.waitForSelector.filter((c) => c.sel === 'textarea[name="q"]');
  assert.strictEqual(boxWaits.length, 1, 'search waits for search box exactly once (step A)');
  assert.strictEqual(boxWaits[0].o.state, 'attached', 'step A must use attached');
});

test('search(): sets keyword via evaluate (no fill), value present', async () => {
  const adapter = new GoogleAdapter();
  const { page, calls } = makeGooglePage();
  const keyword = '万年移民官网';

  await adapter.search(page, keyword);

  assert.strictEqual(calls.kwValue, keyword, 'keyword should be set via evaluate');
  assert.ok(calls.kwEvents.includes('input'), 'should dispatch input event');
  assert.ok(calls.kwEvents.includes('change'), 'should dispatch change event');
});

test('search(): submits via evaluate (requestSubmit), not press/click API', async () => {
  const adapter = new GoogleAdapter();
  const { page, calls, form } = makeGooglePage();

  // 假 page 没有 fill/press/click；若适配器回退到这些可见性相关 API 会抛错。
  await adapter.search(page, '万年移民');

  assert.strictEqual(form.submitted, true, 'should call form.requestSubmit()');
  const resultWait = calls.waitForSelector.find((c) => c.sel === '#rso');
  assert.ok(resultWait, 'search should wait for #rso at the end');
});

test('search(): 拟人模式逐字输入 + 真实鼠标移动并点击搜索按钮（human）', async () => {
  const adapter = new GoogleAdapter();
  const { page, calls } = makeGooglePage({ human: true });
  const keyword = '万年移民';

  await adapter.search(page, keyword);

  // 1) 逐字输入：keyword 经 keyboard.type 累积为完整串，且按字数多次调用（带抖动）
  assert.strictEqual(calls.keyboardType, keyword, 'should type keyword char-by-char via real keyboard');
  assert.strictEqual(calls.keyboardTypeCalls, keyword.length, 'should call keyboard.type once per character');
  assert.strictEqual(calls.focus, 'textarea[name="q"]', 'should focus the search box first');
  // 2) 提交：先真实鼠标移动 + 点击搜索按钮
  assert.ok(calls.mouseClick, 'should click the search button via real mouse');
  assert.ok(calls.mouseMove, 'should move mouse to the search button before clicking');
  assert.strictEqual(calls.keyboardPress, undefined, 'human path should NOT fall back to Enter press');
});

test('search(): wraps a failed step A in a step-named error', async () => {
  const adapter = new GoogleAdapter();
  const { page } = makeGooglePage();
  page.waitForSelector = async () => {
    throw new Error('timeout');
  };

  await assert.rejects(
    () => adapter.search(page, 'x'),
    /等待谷歌搜索框挂载超时/,
    'should surface a step-named error instead of a raw timeout'
  );
});

test('search(): results appear immediately (no captcha) → success', async () => {
  const adapter = new GoogleAdapter();
  const { page } = makeGooglePage({ captchaPolls: 0 });

  await adapter.search(page, '万年移民'); // 不应抛错
  assert.ok(page.url().includes('google.com'), '最终不在 sorry 拦截页');
});

test('search(): hits captcha, user solves after N polls, then results appear → success', async () => {
  const adapter = new GoogleAdapter();
  const { page } = makeGooglePage({ captchaPolls: 2 });

  await adapter.search(page, '万年移民'); // 不应抛错
  assert.ok(page.url().includes('google.com'), '最终落在结果页');
});

test('search(): stuck on captcha forever → throws ERR_GOOGLE_CAPTCHA', async () => {
  const adapter = new GoogleAdapter();
  const { page } = makeGooglePage({ captchaPolls: Number.MAX_SAFE_INTEGER });

  await assert.rejects(
    () => adapter.search(page, '万年移民'),
    /ERR_GOOGLE_CAPTCHA/,
    'search must throw ERR_GOOGLE_CAPTCHA after polling exhausts'
  );
});

// ---------------------------------------------------------------------------
// locateTarget()
// ---------------------------------------------------------------------------

test('locateTarget(): uses #rso h3 a (regression: not all <a>)', async () => {
  const adapter = new GoogleAdapter();
  const { page, calls } = makeGooglePage({
    resultAnchors: [makeAnchor('万年移民局官网', 'https://www.manincorp.cn/')],
  });

  await adapter.locateTarget(page, { domain: 'manincorp.cn', titleKeywords: ['万年移民'] });

  assert.ok(calls.$$.includes('#rso h3 a'), 'must query title links via #rso h3 a');
  assert.strictEqual(calls.$$.filter((s) => s === '#rso h3 a').length, 1, 'should query title links exactly once');
});

test('locateTarget(): title + domain double match returns href', async () => {
  const adapter = new GoogleAdapter();
  const { page } = makeGooglePage({
    resultAnchors: [
      makeAnchor('无关结果', 'https://example.com/'),
      makeAnchor('万年移民局官网首页', 'https://www.manincorp.cn/'),
    ],
  });

  const href = await adapter.locateTarget(page, {
    domain: 'manincorp.cn',
    titleKeywords: ['万年移民'],
  });
  assert.strictEqual(href, 'https://www.manincorp.cn/', 'should return the double-matched href');
});

test('locateTarget(): domain-only fallback (title lacks keyword, domain matches)', async () => {
  const adapter = new GoogleAdapter();
  // 标题「万年县移民局」不含连续子串「万年移民」（中间有「县」），靠 domain-only 兜底命中
  const { page } = makeGooglePage({
    resultAnchors: [makeAnchor('万年县移民局官方网站', 'https://www.manincorp.cn/')],
  });

  const href = await adapter.locateTarget(page, {
    domain: 'manincorp.cn',
    titleKeywords: ['万年移民'],
  });
  assert.strictEqual(href, 'https://www.manincorp.cn/', 'should fall back to domain-only match');
});

test('locateTarget(): no target domain in top 10 → throws diagnostic error', async () => {
  const adapter = new GoogleAdapter();
  const { page } = makeGooglePage({
    resultAnchors: [
      makeAnchor('其他站点A', 'https://a.example.com/'),
      makeAnchor('其他站点B', 'https://b.example.com/'),
    ],
  });

  await assert.rejects(
    () => adapter.locateTarget(page, { domain: 'manincorp.cn', titleKeywords: ['万年移民'] }),
    /目标域名「manincorp.cn」未出现在已扫描的 1 页搜索结果中/,
    'should diagnose missing domain with actionable message'
  );
});

test('locateTarget(): v0.3.37 fallback — NEW/OLD empty but #rso a[href] holds target', async () => {
  const adapter = new GoogleAdapter();
  // 模拟区域化 / 未完全加载的 SERP：不提供 newStyleAnchors / resultAnchors，
  // 使 NEW(#rso a[data-ved]) 与 OLD(#rso h3 a) 选择器均抓空，仅靠第三层 #rso a[href] 兜底。
  const { page, calls } = makeGooglePage({
    genericAnchors: [
      makeAnchor('其他无关站点', 'https://other-site.com/'),
      makeAnchor('万年移民局官网首页', 'https://www.manincorp.cn/'),
    ],
  });

  const href = await adapter.locateTarget(page, {
    domain: 'manincorp.cn',
    titleKeywords: ['万年移民'],
  });

  assert.ok(calls.$$.includes('#rso a[href]'), 'should fall back to generic #rso a[href] third layer');
  assert.strictEqual(
    href,
    'https://www.manincorp.cn/',
    'third-layer fallback should still resolve and match the target domain'
  );
});

test('locateTarget(): scans ALL results on page 1 (target beyond top 10 still matches)', async () => {
  const adapter = new GoogleAdapter();
  const anchors = [];
  for (let i = 0; i < 12; i += 1) {
    anchors.push(makeAnchor(`无关结果${i}`, `https://x${i}.example.com/`));
  }
  anchors.push(makeAnchor('万年移民局官网首页', 'https://www.manincorp.cn/')); // 第 13 条

  const { page, calls } = makeGooglePage({ resultAnchors: anchors });

  const href = await adapter.locateTarget(page, {
    domain: 'manincorp.cn',
    titleKeywords: ['万年移民'],
  });
  assert.strictEqual(href, 'https://www.manincorp.cn/', 'should match even though target is beyond top 10');
  // 只查询一次 #rso h3 a（单页场景，无下一页）
  assert.strictEqual(calls.$$.filter((s) => s === '#rso h3 a').length, 1, 'single page: query once');
});

test('locateTarget(): target on page 2 found after pagination', async () => {
  const adapter = new GoogleAdapter();
  const { page, calls } = makeGooglePage({
    pages: [
      {
        anchors: [
          makeAnchor('无关站点A', 'https://a.example.com/'),
          makeAnchor('无关站点B', 'https://b.example.com/'),
        ],
        nextHref: '/search?q=x&start=10',
      },
      {
        anchors: [makeAnchor('万年移民局官网首页', 'https://www.manincorp.cn/')],
        nextHref: null,
      },
    ],
  });

  const href = await adapter.locateTarget(page, {
    domain: 'manincorp.cn',
    titleKeywords: ['万年移民'],
  });
  assert.strictEqual(href, 'https://www.manincorp.cn/', 'should follow 下一页 and match on page 2');
  // 翻页至少触发一次 goto 到 start=10
  assert.ok(
    calls.goto.some((g) => typeof g.url === 'string' && /[?&]start=\d+/.test(g.url)),
    'should navigate to next page'
  );
});

test('locateTarget(): Google /url?q= wrapper decoded to REAL url (not the wrapper)', async () => {
  const adapter = new GoogleAdapter();
  // 真实环境下 Google 有机结果的 href 是跳转包装，包含编码后的真实地址
  const wrapper =
    'https://www.google.com/url?q=https%3A%2F%2Fwww.manincorp.cn%2F&sa=U&ved=2ahUKEwi';
  const { page } = makeGooglePage({
    resultAnchors: [makeAnchor('万年移民局官网首页', wrapper)],
  });

  const href = await adapter.locateTarget(page, {
    domain: 'manincorp.cn',
    titleKeywords: ['万年移民'],
  });
  // 必须返回解码后的真实地址，clickTarget 才能 goto 到真实站点（而非 Google 重定向页）
  assert.strictEqual(href, 'https://www.manincorp.cn/', 'should decode google /url?q= wrapper to real URL');
  assert.ok(!href.includes('google.com/url'), 'decoded href must NOT be the google redirect wrapper');
});

test('locateTarget(): relative /url?q= wrapper decoded to REAL url (domain-only fallback)', async () => {
  const adapter = new GoogleAdapter();
  // 相对跳转包装；标题「万年县移民局」不含连续「万年移民」→ 靠 domain-only 兜底，
  // 但前提是包装被解码成真实域名地址
  const { page } = makeGooglePage({
    resultAnchors: [makeAnchor('万年县移民局', '/url?q=https%3A%2F%2Fwww.manincorp.cn%2F')],
  });

  const href = await adapter.locateTarget(page, {
    domain: 'manincorp.cn',
    titleKeywords: ['万年移民'],
  });
  assert.strictEqual(href, 'https://www.manincorp.cn/', 'should decode relative google redirect wrapper');
  assert.ok(!href.includes('google.com/url'), 'decoded relative wrapper must NOT retain google redirect');
});

test('locateTarget(): 2026 new SERP structure (a[data-ved] + [role="heading]) matches target', async () => {
  const adapter = new GoogleAdapter();
  // 新版 DOM：#rso h3 a 返回空（旧选择器失效），但 #rso a[data-ved] 有结果
  const { page, calls } = makeGooglePage({
    resultAnchors: [],  // 旧选择器返回空
    newStyleAnchors: [
      makeNewStyleAnchor('人才引进计划-香港永居申请', 'https://www.globevisa.com.sg/'),
      makeNewStyleAnchor('萬年移民—中國香港移民', 'https://www.maninvisa.com/'),
      makeNewStyleAnchor('万年移民', 'https://www.manincorp.cn/'),  // ← 目标
      makeNewStyleAnchor('其他移民服务', 'https://other.example.com/'),
    ],
  });

  const href = await adapter.locateTarget(page, {
    domain: 'manincorp.cn',
    titleKeywords: ['万年移民'],
  });
  assert.strictEqual(href, 'https://www.manincorp.cn/', 'should match from new-style a[data-ved] anchors');
  // 应该先尝试新选择器，旧选择器作为回退也被调用但返回空
  const triedNew = calls.$$.some(function (s) { return s.includes('a[data-ved]'); });
  assert.ok(triedNew, 'should try new a[data-ved] selector first');
});

test('locateTarget(): options.maxResultPages caps scanning (target on page 3, limit 2 → not reached)', async () => {
  const adapter = new GoogleAdapter();
  const pages = [
    { anchors: [makeAnchor('无关A', 'https://a.example.com/')], nextHref: '/search?q=x&start=10' },
    { anchors: [makeAnchor('无关B', 'https://b.example.com/')], nextHref: '/search?q=x&start=20' },
    { anchors: [makeAnchor('万年移民局官网首页', 'https://www.manincorp.cn/')], nextHref: null },
  ];
  const { page, calls } = makeGooglePage({ pages });

  await assert.rejects(
    () => adapter.locateTarget(
      page,
      { domain: 'manincorp.cn', titleKeywords: ['万年移民'] },
      { maxResultPages: 2 }
    ),
    /已扫描的 2 页/,
    'limit=2 should stop after scanning 2 pages, never reaching page 3'
  );
  // 不应导航到 start=20（第 3 页）
  assert.ok(
    !calls.goto.some((g) => typeof g.url === 'string' && /[?&]start=20/.test(g.url)),
    'should NOT navigate to page 3 when maxResultPages=2'
  );
});

test('locateTarget(): options.maxResultPages=3 finds target on page 3', async () => {
  const adapter = new GoogleAdapter();
  const pages = [
    { anchors: [makeAnchor('无关A', 'https://a.example.com/')], nextHref: '/search?q=x&start=10' },
    { anchors: [makeAnchor('无关B', 'https://b.example.com/')], nextHref: '/search?q=x&start=20' },
    { anchors: [makeAnchor('万年移民局官网首页', 'https://www.manincorp.cn/')], nextHref: null },
  ];
  const { page } = makeGooglePage({ pages });

  const href = await adapter.locateTarget(
    page,
    { domain: 'manincorp.cn', titleKeywords: ['万年移民'] },
    { maxResultPages: 3 }
  );
  assert.strictEqual(href, 'https://www.manincorp.cn/', 'limit=3 should follow pagination to page 3 and match');
});
