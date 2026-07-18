'use strict';

/**
 * test/humanizer.test.js
 * ---------------------------------------------------------------------------
 * 拟人微动作（步骤间随机停顿 + 随机微动作）单元测试。无需真实浏览器。
 *
 * 被测对象：core/taskEngine.js 的 _humanInterstitial / _humanMove / _humanWheel /
 * _humanHoverOrKey / _viewport，以及 core/taskConfig.js 的 humanize 透传。
 *
 * 设计要点：
 *   - 思考停顿 = randInt(minMs,maxMs) + randInt(0,jitterAmp)，每次随机；
 *   - 微动作三选一（move / wheel / hover），权重归一化；
 *   - 任意异常静默吞掉，绝不抛出/拒绝，不影响主流程。
 */

const test = require('node:test');
const assert = require('node:assert');

const { TaskEngine } = require('../core/taskEngine');
const { buildTaskConfig } = require('../core/taskConfig');

// ---------------------------------------------------------------------------
// Mock Playwright Page（记录调用，绝不真正驱动浏览器）
// ---------------------------------------------------------------------------

function makePage(overrides) {
  const calls = { move: 0, wheel: 0, press: 0, query: 0, evaluate: 0 };
  const page = {
    isClosed: () => false,
    viewportSize: () => null, // 强制走 evaluate 回退分支
    mouse: {
      move: function () { calls.move += 1; },
      wheel: function () { calls.wheel += 1; },
    },
    keyboard: { press: function () { calls.press += 1; } },
    $$: async function () { calls.query += 1; return []; },
    evaluate: async function () {
      calls.evaluate += 1;
      return { width: 1280, height: 800 };
    },
    ...overrides,
  };
  return { page, calls };
}

function makeEngine(humanize) {
  const config = {
    taskId: 'test-task',
    rounds: [],
    humanize: Object.assign(
      { enabled: true, minMs: 800, maxMs: 2600, jitterAmp: 400, moveProb: 0.6, scrollProb: 0.25, hoverProb: 0.15, wheelAmp: 120 },
      humanize || {}
    ),
  };
  const engine = new TaskEngine(config, function () {});
  // 单元测试不真的等待：把停顿替换成即时，避免大量随机用例拖慢整文件
  engine._sleep = async function () { return; };
  return engine;
}

// ---------------------------------------------------------------------------
// 随机间隔边界
// ---------------------------------------------------------------------------

test('_humanInterstitial: 随机思考停顿始终落在 [minMs, maxMs+jitterAmp] 内', async () => {
  const engine = makeEngine({ minMs: 500, maxMs: 1000, jitterAmp: 200 });
  const { page } = makePage();
  const lower = 500;
  const upper = 1000 + 200;
  for (let i = 0; i < 200; i += 1) {
    const hu = await engine._humanInterstitial(page);
    assert.ok(hu.thinkMs >= lower - 1, 'thinkMs 不应低于下限: ' + hu.thinkMs);
    assert.ok(hu.thinkMs <= upper + 1, 'thinkMs 不应高于上限: ' + hu.thinkMs);
  }
});

// ---------------------------------------------------------------------------
// 微动作分支（用受控 Math.random 决定走哪条分支）
// ---------------------------------------------------------------------------

test('_humanInterstitial: Math.random=0 触发移动鼠标（move）', async () => {
  const orig = Math.random;
  Math.random = function () { return 0; }; // r=0 < moveP -> move；thinkMs=minMs
  try {
    const engine = makeEngine({ minMs: 500, maxMs: 1000, jitterAmp: 200 });
    const { page, calls } = makePage();
    const hu = await engine._humanInterstitial(page);
    assert.strictEqual(hu.action, 'move');
    assert.strictEqual(hu.thinkMs, 500);
    assert.strictEqual(calls.move, 2); // 分两段 move
    assert.strictEqual(calls.wheel, 0);
    assert.strictEqual(calls.press, 0);
  } finally {
    Math.random = orig;
  }
});

test('_humanInterstitial: 中段随机值触发滚轮轻推（wheel）', async () => {
  const orig = Math.random;
  Math.random = function () { return 0.7; }; // moveP=0.6, scrollP=0.25 => 0.6<=0.7<0.85 -> wheel
  try {
    const engine = makeEngine({ minMs: 500, maxMs: 1000, jitterAmp: 200 });
    const { page, calls } = makePage();
    const hu = await engine._humanInterstitial(page);
    assert.strictEqual(hu.action, 'wheel');
    assert.strictEqual(calls.wheel, 1);
    assert.strictEqual(calls.move, 0);
  } finally {
    Math.random = orig;
  }
});

test('_humanInterstitial: 高段随机值触发悬停/按键（hover）', async () => {
  const orig = Math.random;
  Math.random = function () { return 0.9; }; // >= 0.85 -> hover
  try {
    const engine = makeEngine({ minMs: 500, maxMs: 1000, jitterAmp: 200 });
    const { page, calls } = makePage();
    const hu = await engine._humanInterstitial(page);
    assert.strictEqual(hu.action, 'hover');
    // 悬停分支：random<0.5 走 $$ 悬停，否则按键；此处两次随机都=0.9 -> 按键
    assert.strictEqual(calls.press, 1);
  } finally {
    Math.random = orig;
  }
});

// ---------------------------------------------------------------------------
// 健壮性：关闭的页面 / 方法抛错 都不应影响主流程
// ---------------------------------------------------------------------------

test('_humanInterstitial: 页面已关闭则返回 noop 且不调用任何 page 方法', async () => {
  const engine = makeEngine();
  const { page, calls } = makePage({ isClosed: () => true });
  const hu = await engine._humanInterstitial(page);
  assert.strictEqual(hu.action, 'noop');
  assert.strictEqual(calls.move + calls.wheel + calls.press + calls.query + calls.evaluate, 0);
});

test('_humanInterstitial: page 方法抛错时静默吞掉，返回 failed 且不拒绝', async () => {
  const orig = Math.random;
  Math.random = function () { return 0; }; // 强制走 move 分支，触发会抛的 mouse.move
  try {
    const engine = makeEngine();
    const { page, calls } = makePage({
      mouse: { move: function () { throw new Error('boom'); }, wheel: function () { calls.wheel += 1; } },
    });
    // 不应抛；返回 action=failed
    const hu = await engine._humanInterstitial(page);
    assert.strictEqual(hu.action, 'failed');
    assert.ok(hu.thinkMs >= 0);
  } finally {
    Math.random = orig;
  }
});

// ---------------------------------------------------------------------------
// 开关：enabled=false 早退
// ---------------------------------------------------------------------------

test('_humanInterstitial: enabled=false 直接早退，不调用任何 page 方法', async () => {
  const engine = makeEngine({ enabled: false });
  const { page, calls } = makePage();
  const hu = await engine._humanInterstitial(page);
  assert.strictEqual(hu.action, 'disabled');
  assert.strictEqual(hu.thinkMs, 0);
  assert.strictEqual(calls.move + calls.wheel + calls.press + calls.query + calls.evaluate, 0);
});

// ---------------------------------------------------------------------------
// 随机性覆盖：多次运行三种动作都可能出现
// ---------------------------------------------------------------------------

test('_humanInterstitial: 大量随机运行三种动作均被覆盖', async () => {
  const engine = makeEngine();
  const { page } = makePage();
  const seen = new Set();
  for (let i = 0; i < 300; i += 1) {
    const hu = await engine._humanInterstitial(page);
    if (hu.action === 'move' || hu.action === 'wheel' || hu.action === 'hover') {
      seen.add(hu.action);
    }
  }
  assert.ok(seen.has('move'), '应出现 move');
  assert.ok(seen.has('wheel'), '应出现 wheel');
  assert.ok(seen.has('hover'), '应出现 hover');
});

// ---------------------------------------------------------------------------
// taskConfig 透传
// ---------------------------------------------------------------------------

test('buildTaskConfig: humanize 透传 + 默认值补齐', () => {
  const cfg = buildTaskConfig({
    platforms: ['baidu'],
    keywords: '万年移民',
    targetDomain: 'manincorp.cn',
    titleKeywords: '万年移民',
    humanize: { enabled: false, minMs: 500, maxMs: 1500 },
  });
  assert.strictEqual(cfg.humanize.enabled, false);
  assert.strictEqual(cfg.humanize.minMs, 500);
  assert.strictEqual(cfg.humanize.maxMs, 1500);
  // 未提供的字段回退默认值
  assert.strictEqual(cfg.humanize.jitterAmp, 400);
  assert.strictEqual(cfg.humanize.moveProb, 0.6);
});

test('buildTaskConfig: 无 humanize 时使用默认值', () => {
  const cfg = buildTaskConfig({
    platforms: ['baidu'],
    keywords: '万年移民',
    targetDomain: 'manincorp.cn',
    titleKeywords: '万年移民',
  });
  assert.strictEqual(cfg.humanize.enabled, true);
  assert.strictEqual(cfg.humanize.minMs, 800);
  assert.strictEqual(cfg.humanize.maxMs, 2600);
});
