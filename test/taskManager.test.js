'use strict';

/**
 * test/taskManager.test.js
 * ---------------------------------------------------------------------------
 * Unit tests for core/taskManager.js single-active-task guard (A2). NO browser.
 *
 * The production `submit()` calls child_process.fork(scripts/worker.js), which
 * would launch a Playwright worker. To avoid launching Chromium we STUB
 * child_process.fork (monkeypatched BEFORE requiring taskManager, because the
 * module captures `fork` at load time) with a fake worker object that supports
 * the .on / .send / .kill surface used by TaskManager.
 *
 * We then assert:
 *   - first submit() returns {ok:true, taskId, status:'running'} and marks active
 *   - a second submit() while one is active returns {ok:false, code:ERR_TASK_RUNNING}
 *     (the 409 path)
 *   - after the active task ends (worker 'done' IPC), the slot is released and a
 *     new submit() succeeds
 *   - getProgress() for an unknown task returns ERR_TASK_NOT_FOUND
 */

const test = require('node:test');
const assert = require('node:assert');
const cp = require('child_process');

// --- Stub fork with a controllable fake worker, BEFORE requiring taskManager ---
let fakeWorker = null;

function makeFakeWorker() {
  const listeners = {};
  const w = {
    killed: false,
    on(event, cb) {
      listeners[event] = cb;
      return w;
    },
    send() {
      /* manager sends {type:'start', config}; worker would begin running */
    },
    kill() {
      w.killed = true;
      if (listeners.exit) listeners.exit(0, null);
    },
    // test helper: simulate worker -> manager IPC message
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
const { ERR } = require('../core/progressEvent');

test.after(() => {
  cp.fork = origFork; // restore global after this file
});

function validConfig(overrides) {
  return buildTaskConfig(
    Object.assign(
      {
        platforms: ['baidu'],
        keywords: '移民',
        targetDomain: 'manincorp.cn',
        titleKeywords: '万年移民',
      },
      overrides || {}
    )
  );
}

/** Release any active slot so tests do not leak state into each other. */
function releaseActive() {
  if (tm.activeTaskId && fakeWorker) {
    fakeWorker.emit('message', { type: 'done', event: { status: 'completed' } });
  }
}

// ---------------------------------------------------------------------------
// Single-active guard (A2)
// ---------------------------------------------------------------------------

test('first submit marks task active and returns taskId + running status', () => {
  const cfg = validConfig();
  const res = tm.submit(cfg);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.taskId, cfg.taskId);
  assert.strictEqual(res.status, 'running');
  assert.strictEqual(tm.activeTaskId, cfg.taskId);
  releaseActive();
});

test('second submit while a task is active returns ERR_TASK_RUNNING (409 path)', () => {
  const cfg1 = validConfig({ platforms: ['baidu'] });
  const first = tm.submit(cfg1);
  assert.strictEqual(first.ok, true);

  // a different config / taskId while the first is still active
  const cfg2 = validConfig({ platforms: ['google'] });
  const second = tm.submit(cfg2);
  assert.strictEqual(second.ok, false);
  assert.strictEqual(second.code, ERR.ERR_TASK_RUNNING);

  releaseActive();
});

test('after active task ends the slot is released and a new submit succeeds', () => {
  const cfg1 = validConfig({ platforms: ['baidu'] });
  tm.submit(cfg1);
  // simulate worker finishing -> manager releases the active slot
  fakeWorker.emit('message', { type: 'done', event: { status: 'completed' } });
  assert.strictEqual(tm.activeTaskId, null);

  const cfg2 = validConfig({ platforms: ['google'] });
  const res = tm.submit(cfg2);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.taskId, cfg2.taskId);
  releaseActive();
});

test('getProgress for unknown task returns ERR_TASK_NOT_FOUND', () => {
  const res = tm.getProgress('does-not-exist');
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.code, ERR.ERR_TASK_NOT_FOUND);
});
