'use strict';

/**
 * test/taskManagerDb.test.js
 * ---------------------------------------------------------------------------
 * Integration of DB persistence injected into core/taskManager (T-D2):
 *   - progress IPC -> db.bufferRunLog (buffered, flushed by timer)
 *   - terminal IPC (done/error/stopped/paused) -> db.updateTaskStatus
 *
 * No real worker / browser: child_process.fork is stubbed (same technique as
 * the existing taskManager.test.js). mysql2 is faked by monkeypatching
 * mysql2/promise.createPool; mock.timers drives the flush interval. The read
 * path (getHistory/getRunLogs) is NOT exercised here — see db.test.js.
 */

const test = require('node:test');
const assert = require('node:assert');
const { mock } = require('node:test');
const cp = require('child_process');

const behavior = { fail: false };
const fakeQuery = mock.fn(async (sql, params) => {
  if (behavior.fail) {
    const e = new Error('simulated DB failure');
    e.code = 'ER_SIMULATED';
    throw e;
  }
  return [[], []];
});
const realMysql = require('mysql2/promise');
realMysql.createPool = () => ({ query: fakeQuery });

// --- Stub fork with a controllable fake worker, BEFORE requiring taskManager ---
// (taskManager.js does `const { fork } = require('child_process')` at module
// load, so the patch MUST be installed before the first require of taskManager,
// otherwise the REAL fork — which would launch a Playwright worker — is captured.)
let fakeWorker = null;
function makeFakeWorker() {
  const listeners = {};
  const w = {
    killed: false,
    on(event, cb) {
      listeners[event] = cb;
      return w;
    },
    send() {},
    kill() {
      w.killed = true;
      if (listeners.exit) listeners.exit(0, null);
    },
    emit(event, ...args) {
      if (listeners[event]) listeners[event](...args);
    },
  };
  return w;
}
const origFork = cp.fork;
cp.fork = function stubFork() {
  fakeWorker = makeFakeWorker();
  return fakeWorker;
};

const tm = require('../core/taskManager');
const { buildTaskConfig } = require('../core/taskConfig');

test.before(() => { mock.timers.enable(['setInterval']); });
test.after(() => { cp.fork = origFork; mock.reset(); });
test.beforeEach(() => {
  behavior.fail = false;
  // drain any leftover buffered rows from a prior subtest (keeps pending clean)
  mock.timers.tick(30000);
});
test.afterEach(() => {
  // release the active slot so a failing/cascading subtest never leaks A2 state
  if (tm.activeTaskId && fakeWorker) {
    fakeWorker.emit('message', { type: 'done', event: { status: 'completed' } });
  }
});

function validConfig(overrides) {
  return buildTaskConfig(Object.assign(
    { platforms: ['baidu'], keywords: '移民', targetDomain: 'manincorp.cn', titleKeywords: '万年移民' },
    overrides || {}
  ));
}
function submitTask(overrides) {
  const cfg = validConfig(overrides);
  tm.submit(cfg);
  return { cfg, taskId: cfg.taskId };
}
function lastCallContaining(substr) {
  const calls = fakeQuery.mock.calls.filter((c) => String(c.arguments[0]).includes(substr));
  return calls.length ? calls[calls.length - 1] : null;
}
function allCallsContaining(substr) {
  return fakeQuery.mock.calls.filter((c) => String(c.arguments[0]).includes(substr));
}

// ---------------------------------------------------------------------------
// progress -> bufferRunLog
// ---------------------------------------------------------------------------

test('progress IPC -> db.bufferRunLog buffered, timer flushes batch INSERT', () => {
  const { taskId } = submitTask();
  fakeWorker.emit('message', {
    type: 'progress',
    event: {
      taskId, type: 'step',
      round: { roundIndex: 0, totalRounds: 4, platform: 'baidu', keyword: '移民' },
      step: { step: 'search', status: 'success' },
      timestamp: '2026-07-16T10:00:00.000Z',
    },
  });

  assert.strictEqual(allCallsContaining('INSERT INTO task_run_log').length, 0, 'no flush before timer');

  mock.timers.tick(1000);
  const calls = allCallsContaining('INSERT INTO task_run_log');
  assert.strictEqual(calls.length, 1);
  // query signature: query('INSERT ... VALUES ?', [rows]) -> arguments[1] === [rows]
  //   arguments[1][0]            = rows (array of row tuples)
  //   arguments[1][0][0]         = first row tuple
  //   arguments[1][0][0][0]      = first row's task_id
  assert.strictEqual(calls[0].arguments[1][0][0][0], taskId);

  // release active slot
  fakeWorker.emit('message', { type: 'done', event: { status: 'completed' } });
});

// ---------------------------------------------------------------------------
// terminal -> updateTaskStatus (fire-and-forget)
// ---------------------------------------------------------------------------

test("terminal 'done' IPC -> db.updateTaskStatus(completed)", () => {
  const { taskId } = submitTask();
  fakeWorker.emit('message', { type: 'done', event: { status: 'completed' } });
  const call = lastCallContaining('UPDATE task_config');
  assert.ok(call, 'expected UPDATE task_config');
  assert.strictEqual(call.arguments[1][0], 'completed'); // status
  assert.strictEqual(call.arguments[1][1], taskId);
});

test("terminal 'error' IPC -> db.updateTaskStatus(failed)", () => {
  const { taskId } = submitTask();
  fakeWorker.emit('message', { type: 'error', event: {} });
  const call = lastCallContaining('UPDATE task_config');
  assert.ok(call);
  assert.strictEqual(call.arguments[1][0], 'failed');
  assert.strictEqual(call.arguments[1][1], taskId);
});

test("terminal 'stopped' IPC -> db.updateTaskStatus(stopped)", () => {
  const { taskId } = submitTask();
  fakeWorker.emit('message', { type: 'stopped', event: {} });
  const call = lastCallContaining('UPDATE task_config');
  assert.ok(call);
  assert.strictEqual(call.arguments[1][0], 'stopped');
});

test("terminal 'paused' IPC -> db.updateTaskStatus(paused) is invoked", () => {
  const { taskId } = submitTask();
  fakeWorker.emit('message', { type: 'paused', event: {} });
  const calls = allCallsContaining('UPDATE task_config');
  const statuses = calls.map((c) => c.arguments[1][0]);
  assert.ok(statuses.includes('paused'), 'updateTaskStatus(paused) should be called; got ' + JSON.stringify(statuses));
});

test('terminal IPC with DB failure does not throw (fire-and-forget .catch)', () => {
  behavior.fail = true;
  const { taskId } = submitTask();
  assert.doesNotThrow(() => {
    fakeWorker.emit('message', { type: 'done', event: { status: 'completed' } });
  });
});
