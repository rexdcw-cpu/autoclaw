'use strict';

/**
 * test/step1-boot.test.js
 * ---------------------------------------------------------------------------
 * 步骤①浏览器会话 + 健康检查（T1 交付）。
 *
 * 核心契约（架构 §7.2 / PRD §3 步骤①）：
 *   BrowserSession.healthCheck(ctx) → { ok, page?, reason? }
 *     - newPage() 成功 且 page.evaluate(() => true) 可返回 → { ok: true, page }
 *     - newPage / evaluate 任一抛错 → { ok: false, reason 有值 }（不抛）
 *     - 无可用 context → { ok: false, reason 有值 }
 *
 * 测试策略（PRD P0-4：每步独立可测、不依赖真实浏览器 / GUI）：
 *   - 用「手写 mock context」驱动 healthCheck，断言失败分支 ok:false + reason 有值；
 *   - 用「手写 mock context」驱动成功分支，断言 ok:true + page 返回；
 *   - 用「monkeypatch playwright.chromium.launchPersistentContext」断言 launch
 *     失败抛 ERR_BROWSER_LAUNCH（无需真实浏览器 / GUI）；
 *   - 真实浏览器端到端用例（launch→healthCheck→close）由 AUTOCLAW_REAL_BROWSER=1
 *     控制，默认 skip，确保无头 / 无 GUI 环境 node --test 也绿。
 *
 * 健壮性：若运行环境未安装 playwright（browserSession.js 顶层 require 会抛），
 * 本文件的所有用例以 skip 形式优雅跳过，保证 node --test 仍全绿。
 */

const test = require('node:test');
const assert = require('node:assert');

// 顶层 require browserSession（其内部依赖 playwright）。未安装时优雅降级为 skip。
let BrowserSession = null;
let ERR = null;
let playwrightMissing = false;
try {
  ({ BrowserSession } = require('../core/browserSession'));
  ({ ERR } = require('../core/progressEvent'));
} catch (e) {
  playwrightMissing = true;
}

/**
 * 构造一个 mock BrowserContext，可按需让 newPage / evaluate 抛错或返回非 true。
 * @param {{newPageThrows?:boolean, evaluateThrows?:boolean, evaluateValue?:*}} [opts]
 * @returns {{newPage:function():Promise<{evaluate:function():Promise<*>, close:function():Promise<void>}>}}
 */
function makeMockContext(opts) {
  const o = opts || {};
  return {
    newPage: async () => {
      if (o.newPageThrows) {
        throw new Error('mock newPage failed');
      }
      return {
        evaluate: async () => {
          if (o.evaluateThrows) {
            throw new Error('mock evaluate failed');
          }
          return o.evaluateValue !== undefined ? o.evaluateValue : true;
        },
        close: async () => {},
      };
    },
  };
}

// ---------------------------------------------------------------------------
// healthCheck 失败分支：newPage 抛错 → { ok:false, reason 有值 }
// ---------------------------------------------------------------------------
test(
  'healthCheck returns {ok:false} with reason when newPage throws',
  { skip: playwrightMissing },
  async () => {
    const s = new BrowserSession();
    const res = await s.healthCheck(makeMockContext({ newPageThrows: true }));
    assert.strictEqual(res.ok, false);
    assert.ok(
      typeof res.reason === 'string' && res.reason.length > 0,
      'reason 应为非空字符串'
    );
  }
);

test(
  'healthCheck returns {ok:false} with reason when evaluate throws',
  { skip: playwrightMissing },
  async () => {
    const s = new BrowserSession();
    const res = await s.healthCheck(makeMockContext({ evaluateThrows: true }));
    assert.strictEqual(res.ok, false);
    assert.ok(
      typeof res.reason === 'string' && res.reason.length > 0,
      'reason 应为非空字符串'
    );
  }
);

// ---------------------------------------------------------------------------
// healthCheck 失败分支：探针返回值非 true → { ok:false }
// ---------------------------------------------------------------------------
test(
  'healthCheck returns {ok:false} when probe is not strictly true',
  { skip: playwrightMissing },
  async () => {
    const s = new BrowserSession();
    const res = await s.healthCheck(makeMockContext({ evaluateValue: false }));
    assert.strictEqual(res.ok, false);
    assert.ok(
      typeof res.reason === 'string' && res.reason.length > 0,
      'reason 应为非空字符串'
    );
  }
);

test(
  'healthCheck returns {ok:false} when no context available',
  { skip: playwrightMissing },
  async () => {
    const s = new BrowserSession(); // this.context === null
    const res = await s.healthCheck(); // 不传 ctx → 用 this.context (null)
    assert.strictEqual(res.ok, false);
    assert.ok(
      typeof res.reason === 'string' && res.reason.length > 0,
      'reason 应为非空字符串'
    );
  }
);

// ---------------------------------------------------------------------------
// healthCheck 成功分支
// ---------------------------------------------------------------------------
test(
  'healthCheck returns {ok:true, page} when newPage + evaluate succeed',
  { skip: playwrightMissing },
  async () => {
    const s = new BrowserSession();
    const res = await s.healthCheck(makeMockContext({}));
    assert.strictEqual(res.ok, true);
    assert.ok(res.page, '成功时应交还可复用的 page');
    assert.strictEqual(res.reason, undefined, '成功时不应带 reason');
  }
);

// ---------------------------------------------------------------------------
// launch 失败应抛 ERR_BROWSER_LAUNCH（monkeypatch，无需真实浏览器 / GUI）
// ---------------------------------------------------------------------------
test(
  'launch throws ERR_BROWSER_LAUNCH when chromium launch fails',
  { skip: playwrightMissing },
  async () => {
    const { chromium } = require('playwright');
    const orig = chromium.launchPersistentContext;
    chromium.launchPersistentContext = async () => {
      throw new Error('mock cannot start chromium');
    };
    try {
      const s = new BrowserSession();
      await assert.rejects(
        () => s.launch(),
        (e) => e && e.code === ERR.ERR_BROWSER_LAUNCH
      );
    } finally {
      chromium.launchPersistentContext = orig;
    }
  }
);

// ---------------------------------------------------------------------------
// 真实浏览器端到端（默认 skip，由 AUTOCLAW_REAL_BROWSER=1 开启）
// ---------------------------------------------------------------------------
test(
  'healthCheck with a real browser (AUTOCLAW_REAL_BROWSER=1)',
  { skip: !process.env.AUTOCLAW_REAL_BROWSER },
  async () => {
    const s = new BrowserSession();
    const ctx = await s.launch();
    try {
      const res = await s.healthCheck(ctx);
      assert.strictEqual(res.ok, true, '真实浏览器健康检查应 ok:true');
      assert.ok(res.page, '应拿到可用 page');
    } finally {
      await s.close().catch(() => {});
    }
  }
);
