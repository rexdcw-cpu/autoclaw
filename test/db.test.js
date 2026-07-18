'use strict';

/**
 * test/db.test.js
 * ---------------------------------------------------------------------------
 * Unit tests for config/db.js persistence layer (NO real MySQL, NO Playwright).
 *
 * Strategy: mysql2 is faked by monkeypatching the *cached* require('mysql2/
 * promise').createPool with a fake pool whose .query is a controllable
 * node:test mock.fn. This exercises the REAL db.js logic (SQL building, param
 * flattening, UTC timestamps, read-path mapping, buffering, batching, cap,
 * failure fallback) without ever opening a connection.
 *
 * Covers:
 *   2a 扁平化映射 : saveTaskConfig SQL+params, UTC datetime, null-safety/
 *                   defaults; getHistory / getRunLogs / getRunStats row→object
 *                   mapping + limit clamping.
 *   2b 失败兜底   : query throws -> saveTaskConfig / getHistory / getRunLogs /
 *                   getRunStats reject (caller catches -> ERR_DB_WRITE /
 *                   ERR_DB_QUERY); updateTaskStatus returns a rejecting promise
 *                   but never throws synchronously (fire-and-forget); bufferRunLog
 *                   never throws and flushRunLog swallows flush errors.
 *   2c 缓冲落库   : bufferRunLog buffers; mock timer triggers batch INSERT;
 *                   BATCH=200 cap; PENDING_CAP=2000 drop-oldest.
 */

const test = require('node:test');
const assert = require('node:assert');
const { mock } = require('node:test');

// ---------------------------------------------------------------------------
// Fake mysql2 (no real connection)
// ---------------------------------------------------------------------------

const behavior = {
  fail: false,
  historyRows: [],
  logRows: [],
  statsRows: [],
};

const fakeQuery = mock.fn(async (sql, params) => {
  if (behavior.fail) {
    const e = new Error('simulated DB failure');
    e.code = 'ER_SIMULATED';
    throw e;
  }
  if (sql.includes('INSERT INTO task_config')) return [[], []];
  if (sql.includes('UPDATE task_config')) return [[], []];
  if (sql.includes('INSERT INTO task_run_log')) return [[], []];
  if (sql.includes('step IS NOT NULL')) return [behavior.statsRows, []]; // getRunStats
  if (sql.includes('FROM task_config')) return [behavior.historyRows, []]; // getHistory
  if (sql.includes('FROM task_run_log')) return [behavior.logRows, []]; // getRunLogs
  return [[], []];
});

// Patch the cached mysql2/promise module BEFORE db.js lazily requires it (only
// at query time, but we patch up front so getPool() picks up the fake pool).
const realMysql = require('mysql2/promise');
realMysql.createPool = () => ({ query: fakeQuery });

const db = require('../config/db');
const { buildTaskConfig } = require('../core/taskConfig');

const HISTORY_ROW = {
  task_id: 't-hist-1',
  platforms: '["baidu","google"]',
  keywords: '["移民","出海"]',
  target_domain: 'example.com',
  title_keywords: '["万年移民"]',
  stay_seconds: 15, scroll_up: 3, scroll_down: 3, amp_min: 300, amp_max: 800,
  interval_min: 1.0, interval_max: 2.0,
  run_mode: 'serial', status: 'pending',
  created_at: '2026-07-16 10:00:00',
};
const LOG_ROW = {
  id: 1, task_id: 't1', round: 0, total_rounds: 4, platform: 'baidu', keyword: '移民',
  step: 'search', step_status: 'success', event_type: 'step', message: 'm', error: null,
  timestamp: '2026-07-16 10:00:00',
};
const STATS_ROW = [{ total: 10, success: 7, fail: 3 }];

test.before(() => {
  // single mocked flush interval for the whole file
  mock.timers.enable(['setInterval']);
});

test.beforeEach(() => {
  behavior.fail = false;
  behavior.historyRows = [];
  behavior.logRows = [];
  behavior.statsRows = [];
  // NOTE: fakeQuery.mock.calls cannot be cleared by `length = 0` (Node mock.fn
  // keeps its own history), and mock.reset() would disable the mocked timers.
  // Instead, every subtest captures a baseline call count and asserts on the
  // DELTA, so accumulation across subtests is harmless.
  // Drain any buffered rows left by a previous buffer subtest (keeps pending clean).
  mock.timers.tick(30000);
});

function lastCallContaining(substr) {
  const calls = fakeQuery.mock.calls.filter((c) => String(c.arguments[0]).includes(substr));
  return calls.length ? calls[calls.length - 1] : null;
}
function allCallsContaining(substr) {
  return fakeQuery.mock.calls.filter((c) => String(c.arguments[0]).includes(substr));
}

// ---------------------------------------------------------------------------
// 2a 扁平化映射 — saveTaskConfig
// ---------------------------------------------------------------------------

test('saveTaskConfig builds correct INSERT sql + flattened params', async () => {
  const cfg = buildTaskConfig({
    platforms: ['baidu', 'google'],
    keywords: '移民',
    targetDomain: 'manincorp.cn',
    titleKeywords: '万年移民',
  });
  await db.saveTaskConfig(cfg, 'op-token-123');

  const call = lastCallContaining('INSERT INTO task_config');
  assert.ok(call, 'expected an INSERT INTO task_config query');
  const [sql, params] = call.arguments;
  for (const col of ['task_id', 'platforms', 'keywords', 'target_domain', 'title_keywords',
    'stay_seconds', 'scroll_up', 'scroll_down', 'amp_min', 'amp_max', 'interval_min',
    'interval_max', 'run_mode', 'fail_rate_threshold', 'max_retry', 'action_timeout_ms',
    'status', 'operator', 'proxy_json', 'client_id', 'created_at']) {
    assert.ok(sql.includes(col), `SQL missing column ${col}`);
  }
  assert.strictEqual(params[0], cfg.taskId);
  assert.strictEqual(params[1], JSON.stringify(cfg.platforms));
  assert.strictEqual(params[2], JSON.stringify(cfg.keywords));
  assert.strictEqual(params[3], cfg.target.domain);
  assert.strictEqual(params[4], JSON.stringify(cfg.target.titleKeywords));
  assert.strictEqual(params[16], 'pending'); // config.status
  assert.strictEqual(params[17], 'op-token-123'); // operator
  assert.strictEqual(params[18], null); // proxy_json (none)
  assert.strictEqual(params[19], null); // client_id (none)
  // UTC datetime 'YYYY-MM-DD HH:MM:SS' (no 'T', not ISO)
  assert.match(params[20], /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  assert.strictEqual(params[20], cfg.createdAt.slice(0, 19).replace('T', ' '));
});

test('saveTaskConfig null-safety: missing nested fields use defaults; operator/proxy/createdAt null', async () => {
  const cfg = { taskId: 't-null', status: 'pending' }; // no anthropic/strategy/target/platforms/keywords/createdAt
  await db.saveTaskConfig(cfg, null);
  const call = lastCallContaining('INSERT INTO task_config');
  const [, params] = call.arguments;
  assert.strictEqual(params[1], '[]'); // platforms default []
  assert.strictEqual(params[2], '[]'); // keywords default []
  assert.strictEqual(params[3], ''); // target.domain default ''
  assert.strictEqual(params[4], '[]'); // titleKeywords default []
  assert.strictEqual(params[5], 15); // staySeconds default
  assert.strictEqual(params[6], 3);
  assert.strictEqual(params[7], 3);
  assert.strictEqual(params[8], 300);
  assert.strictEqual(params[9], 800);
  assert.strictEqual(params[10], 1.0);
  assert.strictEqual(params[11], 2.0);
  assert.strictEqual(params[12], 'serial');
  assert.strictEqual(params[13], 0.3);
  assert.strictEqual(params[14], 2);
  assert.strictEqual(params[15], 30000);
  assert.strictEqual(params[16], 'pending');
  assert.strictEqual(params[17], null); // operator null
  assert.strictEqual(params[18], null); // proxy null
  assert.strictEqual(params[19], null); // client_id null
  assert.strictEqual(params[20], null); // createdAt null -> toMysqlDatetime null
});

// ---------------------------------------------------------------------------
// 2a 扁平化映射 — read paths
// ---------------------------------------------------------------------------

test('getHistory maps rows to camelCase objects (JSON parsed, anthropic nested)', async () => {
  behavior.historyRows = [
    HISTORY_ROW,
    Object.assign({}, HISTORY_ROW, { task_id: 't2', platforms: '["google"]', status: 'completed' }),
  ];
  const list = await db.getHistory(50, 0);
  assert.strictEqual(list.length, 2);
  const a = list[0];
  assert.strictEqual(a.taskId, 't-hist-1');
  assert.deepStrictEqual(a.platforms, ['baidu', 'google']);
  assert.deepStrictEqual(a.keywords, ['移民', '出海']);
  assert.strictEqual(a.targetDomain, 'example.com');
  assert.deepStrictEqual(a.titleKeywords, ['万年移民']);
  assert.strictEqual(a.anthropic.staySeconds, 15);
  assert.strictEqual(a.anthropic.ampMin, 300);
  assert.strictEqual(a.anthropic.intervalMax, 2.0);
  assert.strictEqual(a.runMode, 'serial');
  assert.strictEqual(a.status, 'pending');
  assert.strictEqual(a.createdAt, '2026-07-16 10:00:00');
  assert.strictEqual(list[1].status, 'completed');
});

test('getHistory clamps limit to 200 and defaults offset to 0', async () => {
  behavior.historyRows = [];
  await db.getHistory(500, 0);
  assert.deepStrictEqual(lastCallContaining('FROM task_config').arguments[1], [200, 0]);

  await db.getHistory(undefined, -5);
  assert.deepStrictEqual(lastCallContaining('FROM task_config').arguments[1], [50, 0]);
});

test('getRunLogs maps rows to camelCase objects', async () => {
  behavior.logRows = [LOG_ROW];
  const timeline = await db.getRunLogs('t1', 500);
  assert.strictEqual(timeline.length, 1);
  const r = timeline[0];
  assert.strictEqual(r.id, 1);
  assert.strictEqual(r.round, 0);
  assert.strictEqual(r.totalRounds, 4);
  assert.strictEqual(r.platform, 'baidu');
  assert.strictEqual(r.keyword, '移民');
  assert.strictEqual(r.step, 'search');
  assert.strictEqual(r.stepStatus, 'success');
  assert.strictEqual(r.eventType, 'step');
  assert.strictEqual(r.timestamp, '2026-07-16 10:00:00');
});

test('getRunLogs returns [] for empty taskId without querying', async () => {
  const base = allCallsContaining('FROM task_run_log').length;
  const timeline = await db.getRunLogs('', 500);
  assert.deepStrictEqual(timeline, []);
  assert.strictEqual(allCallsContaining('FROM task_run_log').length - base, 0);
});

test('getRunStats computes failRate from step rows', async () => {
  behavior.statsRows = STATS_ROW;
  const stats = await db.getRunStats('t1');
  assert.deepStrictEqual(stats, { total: 10, success: 7, fail: 3, failRate: 0.3 });
});

test('getRunStats returns zeros for empty/missing taskId or no rows', async () => {
  assert.deepStrictEqual(await db.getRunStats(''), { total: 0, success: 0, fail: 0, failRate: 0 });
  behavior.statsRows = [];
  assert.deepStrictEqual(await db.getRunStats('t1'), { total: 0, success: 0, fail: 0, failRate: 0 });
});

// ---------------------------------------------------------------------------
// 2b 失败兜底
// ---------------------------------------------------------------------------

test('saveTaskConfig rejects when query fails (submit catches -> ERR_DB_WRITE)', async () => {
  behavior.fail = true;
  const cfg = buildTaskConfig({ platforms: ['baidu'], keywords: '移民', targetDomain: 'x.com', titleKeywords: 'tk' });
  await assert.rejects(() => db.saveTaskConfig(cfg, 'op'), /simulated DB failure/);
});

test('updateTaskStatus does not throw synchronously; returns a rejecting promise (caller .catch)', () => {
  behavior.fail = true;
  let threw = false;
  let p;
  try {
    p = db.updateTaskStatus('t1', 'completed');
  } catch (e) {
    threw = true;
  }
  assert.strictEqual(threw, false, 'updateTaskStatus must not throw synchronously');
  assert.ok(p && typeof p.then === 'function', 'returns a promise');
  return assert.rejects(() => p, /simulated DB failure/);
});

test('getHistory/getRunLogs/getRunStats reject on query failure (route catches -> ERR_DB_QUERY)', async () => {
  behavior.fail = true;
  await assert.rejects(() => db.getHistory(), /simulated DB failure/);
  await assert.rejects(() => db.getRunLogs('t1'), /simulated DB failure/);
  await assert.rejects(() => db.getRunStats('t1'), /simulated DB failure/);
});

// ---------------------------------------------------------------------------
// 2c 缓冲落库逻辑
// ---------------------------------------------------------------------------

test('bufferRunLog buffers events; mocked timer triggers a single batched INSERT', () => {
  const before = allCallsContaining('INSERT INTO task_run_log').length;
  db.bufferRunLog({ taskId: 't1', type: 'step', round: { roundIndex: 0, totalRounds: 4, platform: 'baidu', keyword: '移民' }, step: { step: 'search', status: 'success' }, message: 'ok', timestamp: '2026-07-16T10:00:00.000Z' });
  db.bufferRunLog({ taskId: 't1', type: 'step', round: { roundIndex: 1 }, step: { step: 'locate', status: 'success' }, timestamp: '2026-07-16T10:00:01.000Z' });

  assert.strictEqual(allCallsContaining('INSERT INTO task_run_log').length - before, 0, 'no flush before timer fires');

  mock.timers.tick(1000); // FLUSH_MS

  const calls = allCallsContaining('INSERT INTO task_run_log');
  assert.strictEqual(calls.length - before, 1, 'exactly one batch INSERT after tick');
  // query signature: query('INSERT ... VALUES ?', [rows]) -> arguments[1] === [rows]
  const rows = calls[calls.length - 1].arguments[1][0];
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0][0], 't1'); // task_id
  assert.strictEqual(rows[0][1], 0); // round
  assert.strictEqual(rows[0][5], 'search'); // step
  assert.strictEqual(rows[0][6], 'success'); // step_status
  assert.strictEqual(rows[0][7], 'step'); // event_type
  assert.strictEqual(rows[0][10], '2026-07-16 10:00:00'); // timestamp (UTC)
  assert.strictEqual(rows[1][1], 1);
});

test('flush batches at most BATCH=200 rows per INSERT', () => {
  const before = allCallsContaining('INSERT INTO task_run_log').length;
  for (let i = 0; i < 250; i++) {
    db.bufferRunLog({ taskId: 't1', type: 'step', round: { roundIndex: i }, step: { step: 'search', status: 'success' }, timestamp: '2026-07-16T10:00:00.000Z' });
  }
  mock.timers.tick(1000);
  const calls = allCallsContaining('INSERT INTO task_run_log');
  assert.strictEqual(calls.length - before, 1, 'first tick flushes one batch');
  assert.strictEqual(calls[calls.length - 1].arguments[1][0].length, 200, 'first batch capped at 200');

  mock.timers.tick(1000); // flush remaining 50
  const calls2 = allCallsContaining('INSERT INTO task_run_log');
  assert.strictEqual(calls2.length - before, 2, 'second tick flushes remainder');
  assert.strictEqual(calls2[calls2.length - 1].arguments[1][0].length, 50, 'remaining 50 flushed');
});

test('pending buffer caps at PENDING_CAP=2000 and drops the oldest', () => {
  const before = allCallsContaining('INSERT INTO task_run_log').length;
  for (let i = 0; i < 2001; i++) {
    db.bufferRunLog({ taskId: 't1', type: 'step', round: { roundIndex: i }, step: { step: 'search', status: 'success' }, timestamp: '2026-07-16T10:00:00.000Z' });
  }
  for (let k = 0; k < 20; k++) mock.timers.tick(1000); // drain

  const calls = allCallsContaining('INSERT INTO task_run_log');
  const newCalls = calls.slice(before);
  const allRows = newCalls.reduce((acc, c) => acc.concat(c.arguments[1][0]), []);
  assert.strictEqual(allRows.length, 2000, 'only 2000 rows flushed (cap)');
  const rounds = allRows.map((r) => r[1]);
  assert.ok(!rounds.includes(0), 'oldest event (round 0) was dropped');
  assert.ok(rounds.includes(2000), 'newest event (round 2000) retained');
  assert.strictEqual(new Set(rounds).size, 2000);
});

test('bufferRunLog never throws; flush errors are swallowed (fire-and-forget)', () => {
  behavior.fail = true; // query will reject during flush
  assert.doesNotThrow(() => {
    db.bufferRunLog({ taskId: 't1', type: 'step', round: { roundIndex: 0 }, step: { step: 'search', status: 'success' }, timestamp: '2026-07-16T10:00:00.000Z' });
  });
  // ticking triggers flushRunLog -> query rejects -> caught internally
  assert.doesNotThrow(() => { mock.timers.tick(1000); });
});
