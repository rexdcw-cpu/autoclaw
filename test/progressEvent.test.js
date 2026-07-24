'use strict';

/**
 * test/progressEvent.test.js
 * ---------------------------------------------------------------------------
 * Unit tests for core/progressEvent.js (NO browser).
 *
 * Covers:
 *   - Enum constants presence + representative values (EventType / StepName /
 *     StepStatus / TaskStatus / RunMode / RoundStatus)
 *   - All 13 ERR_* constants present
 *   - splitTokens (keyword/titleKeyword delimiter splitting)
 *   - makeProgress / makeStep / makeRound / makeStats builders (shape + logic)
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  EventType,
  StepName,
  StepStatus,
  TaskStatus,
  RunMode,
  RoundStatus,
  ERR,
  splitTokens,
  makeStep,
  makeRound,
  makeStats,
  makeProgress,
} = require('../core/progressEvent');

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

// ---------------------------------------------------------------------------
// Enum constants
// ---------------------------------------------------------------------------

test('EventType has all required values', () => {
  assert.strictEqual(EventType.ROUND_START, 'round_start');
  assert.strictEqual(EventType.STEP, 'step');
  assert.strictEqual(EventType.ROUND_END, 'round_end');
  assert.strictEqual(EventType.TASK_END, 'task_end');
  assert.strictEqual(EventType.PAUSED, 'paused');
  assert.strictEqual(EventType.STOPPED, 'stopped');
  assert.strictEqual(EventType.ALERT, 'alert');
});

test('StepName has all required values', () => {
  assert.strictEqual(StepName.BOOT, 'boot');
  assert.strictEqual(StepName.SEARCH, 'search');
  assert.strictEqual(StepName.OPEN, 'open');
  assert.strictEqual(StepName.FILL, 'fill');
  assert.strictEqual(StepName.WAIT, 'wait');
  assert.strictEqual(StepName.LOCATE, 'locate');
  assert.strictEqual(StepName.ENTER, 'enter');
  assert.strictEqual(StepName.STAY, 'stay');
  assert.strictEqual(StepName.BROWSE, 'browse');
  assert.strictEqual(StepName.CLOSE, 'close');
});

test('StepStatus has all required values', () => {
  assert.deepStrictEqual(Object.values(StepStatus).sort(), ['failed', 'pending', 'running', 'success']);
});

test('TaskStatus has all required values', () => {
  assert.deepStrictEqual(
    Object.values(TaskStatus).sort(),
    ['completed', 'failed', 'paused', 'pending', 'running', 'stopped']
  );
});

test('RunMode has serial + concurrent', () => {
  assert.strictEqual(RunMode.SERIAL, 'serial');
  assert.strictEqual(RunMode.CONCURRENT, 'concurrent');
});

test('RoundStatus has all required values', () => {
  assert.deepStrictEqual(
    Object.values(RoundStatus).sort(),
    ['failed', 'running', 'skipped', 'success']
  );
});

// ---------------------------------------------------------------------------
// ERR_* constants (all 8)
// ---------------------------------------------------------------------------

test('all 14 ERR_ constants are present with expected string values', () => {
  // v0.2 (T-D1~T-D5) added ERR_DB_WRITE + ERR_DB_QUERY to the original 8.
  // T0 added ERR_BAIDU_CAPTCHA (11 total).
  // V2 客户线 added ERR_CLIENT_NOT_FOUND + ERR_CLIENT_HAS_TASKS (13 total).
  // v0.3.18 谷歌走 VPN 新增 ERR_VPN_UNAVAILABLE（14 total）。
  const expected = [
    'ERR_INVALID_CONFIG',
    'ERR_NO_TARGET',
    'ERR_ADAPTER_FAIL',
    'ERR_TIMEOUT',
    'ERR_RETRY_EXHAUSTED',
    'ERR_BROWSER_LAUNCH',
    'ERR_BAIDU_CAPTCHA',
    'ERR_TASK_NOT_FOUND',
    'ERR_TASK_RUNNING',
    'ERR_DB_WRITE',
    'ERR_DB_QUERY',
    'ERR_CLIENT_NOT_FOUND',
    'ERR_CLIENT_HAS_TASKS',
    'ERR_VPN_UNAVAILABLE',
  ];
  for (const code of expected) {
    assert.ok(ERR[code], `missing ERR.${code}`);
    assert.strictEqual(ERR[code], code);
  }
  assert.strictEqual(Object.keys(ERR).length, 14);
});

// ---------------------------------------------------------------------------
// splitTokens
// ---------------------------------------------------------------------------

test('splitTokens splits by | , 、 and fullwidth comma', () => {
  assert.deepStrictEqual(splitTokens('a|b、c，d'), ['a', 'b', 'c', 'd']);
  assert.deepStrictEqual(splitTokens('a,b,c'), ['a', 'b', 'c']);
});

test('splitTokens trims whitespace and drops empties', () => {
  assert.deepStrictEqual(splitTokens('  a | | b  '), ['a', 'b']);
});

test('splitTokens on array input', () => {
  assert.deepStrictEqual(splitTokens(['a', ' b ', '']), ['a', 'b']);
});

test('splitTokens returns [] for empty/undefined', () => {
  assert.deepStrictEqual(splitTokens(''), []);
  assert.deepStrictEqual(splitTokens(undefined), []);
  assert.deepStrictEqual(splitTokens(null), []);
});

// ---------------------------------------------------------------------------
// makeStep
// ---------------------------------------------------------------------------

test('makeStep returns correct shape with default detail', () => {
  const s = makeStep(StepName.SEARCH, StepStatus.RUNNING);
  assert.strictEqual(s.step, 'search');
  assert.strictEqual(s.status, 'running');
  assert.strictEqual(s.detail, '');
  assert.match(s.timestamp, ISO_RE);
});

test('makeStep honors provided detail', () => {
  const s = makeStep(StepName.LOCATE, StepStatus.SUCCESS, 'found target');
  assert.strictEqual(s.detail, 'found target');
});

// ---------------------------------------------------------------------------
// makeRound
// ---------------------------------------------------------------------------

test('makeRound returns correct shape', () => {
  const r = makeRound('t1', 'baidu', '移民', 0, 4, RoundStatus.RUNNING);
  assert.strictEqual(r.taskId, 't1');
  assert.strictEqual(r.roundIndex, 0);
  assert.strictEqual(r.totalRounds, 4);
  assert.strictEqual(r.platform, 'baidu');
  assert.strictEqual(r.keyword, '移民');
  assert.strictEqual(r.status, 'running');
  assert.deepStrictEqual(r.steps, []);
  assert.match(r.startedAt, ISO_RE);
  assert.strictEqual(r.finishedAt, null);
  assert.strictEqual(r.error, null);
});

// ---------------------------------------------------------------------------
// makeStats
// ---------------------------------------------------------------------------

test('makeStats computes failRate = fail / (success+fail)', () => {
  const st = makeStats(10, 1, 7, 3);
  assert.strictEqual(st.totalRounds, 10);
  assert.strictEqual(st.currentRound, 1);
  assert.strictEqual(st.successCount, 7);
  assert.strictEqual(st.failCount, 3);
  assert.strictEqual(st.failRate, 0.3);
});

test('makeStats failRate is 0 when nothing done yet', () => {
  const st = makeStats(4, 0, 0, 0);
  assert.strictEqual(st.failRate, 0);
});

// ---------------------------------------------------------------------------
// makeProgress
// ---------------------------------------------------------------------------

test('makeProgress returns correct shape with defaults', () => {
  const ev = makeProgress({ taskId: 't1', type: EventType.STEP });
  assert.strictEqual(ev.taskId, 't1');
  assert.strictEqual(ev.type, 'step');
  assert.strictEqual(ev.round, null);
  assert.strictEqual(ev.step, null);
  assert.strictEqual(ev.message, '');
  assert.strictEqual(ev.stats, null);
  assert.strictEqual(ev.status, undefined);
  assert.match(ev.timestamp, ISO_RE);
});

test('makeProgress reflects provided round/step/stats/status', () => {
  const step = makeStep(StepName.SEARCH, StepStatus.RUNNING);
  const round = makeRound('t1', 'baidu', '移民', 0, 4, RoundStatus.RUNNING);
  const stats = makeStats(4, 0, 0, 0);
  const ev = makeProgress({
    taskId: 't1',
    type: EventType.TASK_END,
    round,
    step,
    message: 'done',
    stats,
    status: TaskStatus.COMPLETED,
  });
  assert.strictEqual(ev.round, round);
  assert.strictEqual(ev.step, step);
  assert.strictEqual(ev.message, 'done');
  assert.strictEqual(ev.stats, stats);
  assert.strictEqual(ev.status, 'completed');
});
