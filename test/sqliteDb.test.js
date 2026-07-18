'use strict';

/**
 * test/sqliteDb.test.js
 * ---------------------------------------------------------------------------
 * REAL SQLite integration tests for config/db.js (no mock, no MySQL, no browser).
 *
 * Goal: prove the SQLite backend (AUTOCLAW_DB_TYPE=sqlite) behaves consistently
 * with the assumptions encoded in the mock-based db.test.js. We use a TEMP FILE
 * (not :memory:) so the module-level singleton connection persists across the
 * subtests in this file, exactly like a real bootstrap.
 *
 * Coverage:
 *   a) saveTaskConfig + getHistory: JSON columns (platforms/keywords/
 *      title_keywords) and anthropic scalar columns round-trip correctly.
 *   b) bufferRunLog -> timer flush -> getRunLogs: rows written & fields correct.
 *   c) getRunStats: SUM(CASE WHEN ...) aggregation correct under SQLite.
 *   d) updateTaskStatus: status flips to 'done', updated_at (datetime('now')) written.
 *   e) getHistory: ORDER BY created_at DESC + LIMIT/OFFSET over string timestamps.
 *   3) failure fallback: query errors are surfaced (caller catches); fire-and-forget
 *      helpers (bufferRunLog/flushRunLog) never throw uncaught.
 *
 * NOTE on `anthropic_params`: the brief mentioned an `anthropic_params` JSON
 * column. The actual schema stores anthropic settings as flattened scalar
 * columns (stay_seconds, ... interval_max); getHistory reconstructs the
 * `anthropic` object. So (a) verifies the scalar round-trip, not a JSON blob.
 *
 * Timers: we use REAL setTimeout (waiting > FLUSH_MS=1000) so the module's own
 * unref'd interval actually fires and flushes — exercising the real timer path.
 * (mock.timers is intentionally NOT used: the module's persistent setInterval
 * would otherwise linger as a pending controlled timer and trip the runner.)
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');

// ---------------------------------------------------------------------------
// MUST set env BEFORE requiring db.js (db.js reads AUTOCLAW_DB_TYPE at load)
// ---------------------------------------------------------------------------
const SQLITE_PATH = path.join(os.tmpdir(), 'autoclaw-qa-' + Date.now() + '.db');
process.env.AUTOCLAW_DB_TYPE = 'sqlite';
process.env.AUTOCLAW_SQLITE_PATH = SQLITE_PATH;

const db = require('../config/db');
const { buildTaskConfig } = require('../core/taskConfig');
const { makeStep } = require('../core/progressEvent');

// Guard: if node --test ever shares a process with the mysql-mock files, this
// fails loudly instead of silently hitting the wrong backend.
test('db backend is sqlite (env honored)', () => {
  assert.strictEqual(db.DB_TYPE, 'sqlite');
});

test.beforeEach(async () => {
  // Flush any leftover buffered rows, then clear both tables for a clean slate.
  await db.flushRunLog();
  await db.query('DELETE FROM task_config');
  await db.query('DELETE FROM task_run_log');
});

test.after(() => {
  // Best-effort cleanup of the temp sqlite file. On Windows the connection
  // handle is still open, so unlink may throw EBUSY — ignore it; %TEMP% will
  // be cleaned by the OS. (See QA note about exporting a db.close() for tests.)
  try {
    if (fs.existsSync(SQLITE_PATH)) fs.unlinkSync(SQLITE_PATH);
  } catch (e) {
    /* ignore */
  }
});

// --- helpers ---------------------------------------------------------------

function makeTaskCfg(overrides) {
  return buildTaskConfig(
    Object.assign(
      {
        platforms: ['baidu', 'google'],
        keywords: '移民',
        targetDomain: 'manincorp.cn',
        titleKeywords: '万年移民',
      },
      overrides || {}
    )
  );
}

// Raw config (lets us control createdAt — buildTaskConfig always forces "now").
function rawCfg(taskId, createdAtIso) {
  return {
    taskId: taskId,
    platforms: ['baidu', 'google'],
    keywords: ['移民'],
    target: { domain: 'manincorp.cn', titleKeywords: ['万年移民'] },
    anthropic: {
      staySeconds: 15, scrollUp: 3, scrollDown: 3,
      ampMin: 300, ampMax: 800, intervalMin: 1.0, intervalMax: 2.0,
    },
    strategy: { mode: 'serial', failRateThreshold: 0.3, maxRetry: 2, actionTimeoutMs: 30000 },
    status: 'pending',
    proxy: null,
    createdAt: createdAtIso,
  };
}

// Wait past FLUSH_MS so the module's real (unref'd) interval fires and flushes.
function waitForFlush() {
  return new Promise((resolve) => setTimeout(resolve, 1200));
}

// ---------------------------------------------------------------------------
// a) saveTaskConfig + getHistory round-trip
// ---------------------------------------------------------------------------

test('a) saveTaskConfig persists; getHistory returns row with JSON + anthropic round-tripped', async () => {
  const cfg = makeTaskCfg({
    anthropic: { staySeconds: 42, scrollUp: 7, ampMin: 123, intervalMin: 3.5 },
    strategy: { mode: 'serial' },
    status: 'pending',
  });
  const id = await db.saveTaskConfig(cfg, 'op-qa');
  assert.ok(id !== undefined && id !== null, 'saveTaskConfig should return an id');

  const list = await db.getHistory(50, 0);
  assert.strictEqual(list.length, 1, 'exactly one history row');
  const row = list[0];

  assert.strictEqual(row.taskId, cfg.taskId);
  // JSON columns round-trip (TEXT <-> parsed array)
  assert.deepStrictEqual(row.platforms, ['baidu', 'google']);
  assert.deepStrictEqual(row.keywords, ['移民']);
  assert.strictEqual(row.targetDomain, 'manincorp.cn');
  assert.deepStrictEqual(row.titleKeywords, ['万年移民']);
  // anthropic scalars stored as columns and remapped by getHistory
  assert.strictEqual(row.anthropic.staySeconds, 42);
  assert.strictEqual(row.anthropic.scrollUp, 7);
  assert.strictEqual(row.anthropic.ampMin, 123);
  assert.strictEqual(row.anthropic.intervalMax, 2.0);
  assert.strictEqual(row.runMode, 'serial');
  assert.strictEqual(row.status, 'pending');
  // createdAt stored as 'YYYY-MM-DD HH:MM:SS' (UTC, no ms)
  assert.strictEqual(row.createdAt, cfg.createdAt.slice(0, 19).replace('T', ' '));
});

// ---------------------------------------------------------------------------
// b) bufferRunLog -> flush -> getRunLogs
// ---------------------------------------------------------------------------

test('b) bufferRunLog -> timer flush writes rows; getRunLogs returns them with correct fields', async () => {
  const taskId = 'qa-task-logs-1';
  db.bufferRunLog({
    taskId: taskId, type: 'step',
    round: { roundIndex: 0, totalRounds: 4, platform: 'baidu', keyword: '移民' },
    step: makeStep('search', 'success'),
    timestamp: '2026-07-16T10:00:00.000Z',
  });
  db.bufferRunLog({
    taskId: taskId, type: 'step',
    round: { roundIndex: 1, totalRounds: 4, platform: 'google', keyword: '移民' },
    step: makeStep('locate', 'failed', 'element not found'),
    timestamp: '2026-07-16T10:00:01.000Z',
  });

  // Nothing flushed before the timer fires.
  assert.strictEqual((await db.getRunLogs(taskId)).length, 0, 'no rows before timer');

  await waitForFlush();

  const logs = await db.getRunLogs(taskId);
  assert.strictEqual(logs.length, 2, 'two events flushed to task_run_log');
  const first = logs[0];
  // NOTE: getRunLogs mapping (config/db.js) intentionally omits `taskId`
  // (the /logs route returns taskId at the envelope level). See QA finding.
  assert.strictEqual(first.round, 0);
  assert.strictEqual(first.platform, 'baidu');
  assert.strictEqual(first.keyword, '移民');
  assert.strictEqual(first.step, 'search');
  assert.strictEqual(first.stepStatus, 'success');
  assert.strictEqual(first.eventType, 'step');
  assert.strictEqual(first.error, null);
  assert.strictEqual(first.timestamp, '2026-07-16 10:00:00');

  const second = logs[1];
  assert.strictEqual(second.round, 1);
  assert.strictEqual(second.platform, 'google');
  assert.strictEqual(second.step, 'locate');
  assert.strictEqual(second.stepStatus, 'failed');
  assert.strictEqual(second.error, 'element not found');
  assert.strictEqual(second.timestamp, '2026-07-16 10:00:01');
});

// ---------------------------------------------------------------------------
// c) getRunStats aggregation (SUM(CASE WHEN ...) under SQLite)
// ---------------------------------------------------------------------------

test('c) getRunStats aggregates total/success/fail via SUM(CASE WHEN ...)', async () => {
  const taskId = 'qa-task-stats-1';
  const steps = [
    { round: 0, step: 'search', status: 'success' },
    { round: 1, step: 'locate', status: 'success' },
    { round: 2, step: 'enter', status: 'failed' },
    { round: 3, step: 'stay', status: 'success' },
    { round: 4, step: 'browse', status: 'failed' },
  ];
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    db.bufferRunLog({
      taskId: taskId, type: 'step',
      round: { roundIndex: s.round, totalRounds: 5, platform: 'baidu', keyword: '移民' },
      step: makeStep(s.step, s.status, s.status === 'failed' ? 'boom' : undefined),
      timestamp: '2026-07-16T10:00:0' + i + '.000Z',
    });
  }
  // A non-step event (step IS NULL) must NOT count toward stats.
  db.bufferRunLog({
    taskId: taskId, type: 'round_start',
    round: { roundIndex: 0, totalRounds: 5, platform: 'baidu', keyword: '移民' },
    step: null,
    timestamp: '2026-07-16T10:00:09.000Z',
  });

  await waitForFlush();

  const stats = await db.getRunStats(taskId);
  assert.strictEqual(stats.total, 5, 'only step events counted (5)');
  assert.strictEqual(stats.success, 3);
  assert.strictEqual(stats.fail, 2);
  assert.strictEqual(stats.failRate, 2 / 5);

  // Empty / missing task -> zeros (SUM over empty set is NULL -> safe-coerced)
  assert.deepStrictEqual(await db.getRunStats(''), { total: 0, success: 0, fail: 0, failRate: 0 });
  assert.deepStrictEqual(await db.getRunStats('qa-nonexistent'), { total: 0, success: 0, fail: 0, failRate: 0 });
});

// ---------------------------------------------------------------------------
// d) updateTaskStatus flips status and writes updated_at = datetime('now')
// ---------------------------------------------------------------------------

test("d) updateTaskStatus(taskId,'done') flips status and writes updated_at without error", async () => {
  const cfg = makeTaskCfg({ status: 'pending' });
  await db.saveTaskConfig(cfg, 'op');

  let list = await db.getHistory(50, 0);
  assert.strictEqual(list[0].status, 'pending', 'initial status pending');

  await db.updateTaskStatus(cfg.taskId, 'done');

  list = await db.getHistory(50, 0);
  assert.strictEqual(list[0].status, 'done', 'status updated to done');

  // updated_at (datetime('now')) was written without error
  const rows = await db.query('SELECT updated_at FROM task_config WHERE task_id = ?', [cfg.taskId]);
  assert.ok(rows[0] && rows[0].updated_at && rows[0].updated_at !== '', 'updated_at written');
  assert.match(rows[0].updated_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
});

// ---------------------------------------------------------------------------
// e) getHistory ORDER BY created_at DESC + LIMIT/OFFSET (string timestamps)
// ---------------------------------------------------------------------------

test('e) getHistory orders DESC by created_at and applies LIMIT/OFFSET', async () => {
  const N = 5;
  for (let i = 0; i < N; i++) {
    // distinct, ascending created_at: 10:00, 11:00, ... 14:00
    const cfg = rawCfg('qa-hist-' + i, '2026-07-16T1' + i + ':00:00.000Z');
    await db.saveTaskConfig(cfg, 'op');
  }

  const all = await db.getHistory(50, 0);
  assert.strictEqual(all.length, N);
  assert.deepStrictEqual(
    all.map((r) => r.taskId),
    ['qa-hist-4', 'qa-hist-3', 'qa-hist-2', 'qa-hist-1', 'qa-hist-0'],
    'DESC order by created_at (string timestamps sort correctly)'
  );

  const top2 = await db.getHistory(2, 0);
  assert.strictEqual(top2.length, 2);
  assert.deepStrictEqual(top2.map((r) => r.taskId), ['qa-hist-4', 'qa-hist-3']);

  const next2 = await db.getHistory(2, 2);
  assert.strictEqual(next2.length, 2);
  assert.deepStrictEqual(next2.map((r) => r.taskId), ['qa-hist-2', 'qa-hist-1']);
});

// ---------------------------------------------------------------------------
// 3) failure fallback (real backend)
// ---------------------------------------------------------------------------

test('3) failure fallback: query surfaces errors (caller catches); fire-and-forget never throws uncaught', async () => {
  // Low-level query with invalid SQL -> rejects after console.error (caller must catch).
  await assert.rejects(
    () => db.query('SELECT * FROM nonexistent_table_xyz'),
    /no such table/
  );

  // updateTaskStatus on a missing row: valid SQL, 0 rows -> returns a promise,
  // never throws synchronously (fire-and-forget contract).
  let threw = false;
  let p;
  try {
    p = db.updateTaskStatus('qa-does-not-exist', 'done');
  } catch (e) {
    threw = true;
  }
  assert.strictEqual(threw, false, 'updateTaskStatus must not throw synchronously');
  assert.ok(p && typeof p.then === 'function', 'returns a promise');
  await p; // resolves (UPDATE matched 0 rows)

  // bufferRunLog with a NULL timestamp -> NOT NULL violation on flush, but
  // flushRunLog swallows it internally (console.error) — no uncaught throw.
  // Attach a guard so an unhandledRejection would fail the test loudly.
  let unhandled = null;
  const onReject = (reason) => { unhandled = reason; };
  process.on('unhandledRejection', onReject);
  try {
    assert.doesNotThrow(() => {
      db.bufferRunLog({
        taskId: 'qa-task-fail-1', type: 'step',
        round: { roundIndex: 0, totalRounds: 1, platform: 'baidu', keyword: '移民' },
        step: makeStep('search', 'success'),
        // timestamp omitted -> toMysqlDatetime(null) -> NULL -> NOT NULL violation
      });
    });
    // Let the real interval fire & attempt the (failing) flush.
    await waitForFlush();
    assert.strictEqual(unhandled, null, 'flush error must be swallowed (no unhandledRejection)');
  } finally {
    process.off('unhandledRejection', onReject);
  }
});
