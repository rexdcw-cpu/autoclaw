'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { TaskManager } = require('../core/taskManager');
const { TaskStatus } = require('../core/progressEvent');
const db = require('../config/db');

// 用桩替换真实 DB 调用，避免触碰 sqlite/mysql
let savedUpdate = null;
let savedQuery = null;
let querySql = null;

test.beforeEach(() => {
  savedUpdate = db.updateTaskStatus;
  savedQuery = db.query;
  db.updateTaskStatus = async () => {};
  db.query = async (sql) => { querySql = sql; return { affectedRows: 2 }; };
});

test.afterEach(() => {
  db.updateTaskStatus = savedUpdate;
  db.query = savedQuery;
  querySql = null;
});

test('看门狗：心跳超时的活跃任务被强杀并标记 FAILED、释放槽位', () => {
  const tm = new TaskManager();
  tm.io = null;
  tm.watchdogMs = 100;
  tm._killedPid = null;
  tm._killWorkerTree = (pid) => { tm._killedPid = pid; };

  const taskId = 'deadbeef-0000-0000-0000-000000000001';
  tm.workers.set(taskId, { pid: 99999 });
  tm.statuses.set(taskId, TaskStatus.RUNNING);
  tm.activeTaskId = taskId;
  tm._lastMsgAt.set(taskId, Date.now() - 600000); // 10 分钟前，远超阈值

  tm._watchdogTick();

  assert.strictEqual(tm.statuses.get(taskId), TaskStatus.FAILED);
  assert.strictEqual(tm._killedPid, 99999, '应连子树强杀 worker');
  assert.strictEqual(tm._lastMsgAt.has(taskId), false, '心跳时间戳应清理');
  assert.strictEqual(tm.activeTaskId, null, '活跃槽位应释放');
  assert.strictEqual(tm.workers.has(taskId), false, 'worker 记录应移除');
});

test('看门狗：心跳新鲜的活跃任务不被误杀', () => {
  const tm = new TaskManager();
  tm.io = null;
  tm.watchdogMs = 100;
  tm._killedPid = null;
  tm._killWorkerTree = (pid) => { tm._killedPid = pid; };

  const taskId = 'deadbeef-0000-0000-0000-000000000002';
  tm.workers.set(taskId, { pid: 88888 });
  tm.statuses.set(taskId, TaskStatus.RUNNING);
  tm.activeTaskId = taskId;
  tm._lastMsgAt.set(taskId, Date.now() - 10); // 刚有心跳

  tm._watchdogTick();

  assert.strictEqual(tm.statuses.get(taskId), TaskStatus.RUNNING, '不应被误杀');
  assert.strictEqual(tm._killedPid, null, '不应调用强杀');
  assert.strictEqual(tm.activeTaskId, taskId);
});

test('看门狗：已结束(非活跃)任务即使超时也不处理', () => {
  const tm = new TaskManager();
  tm.io = null;
  tm.watchdogMs = 100;
  tm._killedPid = null;
  tm._killWorkerTree = (pid) => { tm._killedPid = pid; };

  const taskId = 'deadbeef-0000-0000-0000-000000000003';
  tm.statuses.set(taskId, TaskStatus.COMPLETED);
  tm._lastMsgAt.set(taskId, Date.now() - 600000);

  tm._watchdogTick();

  assert.strictEqual(tm._killedPid, null, '已结束任务不应强杀');
});

test('reapZombieTasks：把 pending/running 残留标记为 FAILED', async () => {
  const tm = new TaskManager();
  await tm.reapZombieTasks();
  assert.ok(/UPDATE task_config SET status = 'FAILED' WHERE status IN \('pending', 'running'\)/.test(querySql),
    '应执行僵尸清理 UPDATE，实际: ' + querySql);
});
