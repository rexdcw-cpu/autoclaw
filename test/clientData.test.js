'use strict';

/**
 * test/clientData.test.js
 * ---------------------------------------------------------------------------
 * V2 客户线数据层集成测试（真实 SQLite，临时库，无浏览器）。
 * 验证：client CRUD、client_id 透传 saveTaskConfig/getHistory、
 * 客户统计聚合、交付报告数据读取、删除防关联任务。
 * 独立进程 + 独立临时库，不影响运行中的 data/autoclaw.db。
 */

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

process.env.AUTOCLAW_DB_TYPE = 'sqlite';
const tmpDb = path.join(os.tmpdir(), 'autoclaw-client-test-' + Date.now() + '.db');
if (fs.existsSync(tmpDb)) fs.unlinkSync(tmpDb);
process.env.AUTOCLAW_SQLITE_PATH = tmpDb;

// 强制以 sqlite 模式重新加载 db 模块（DB_TYPE 在 require 时确定）
delete require.cache[require.resolve('../config/db')];
const db = require('../config/db');
const { buildTaskConfig } = require('../core/taskConfig');

test.after(() => {
  try { if (fs.existsSync(tmpDb)) fs.unlinkSync(tmpDb); } catch (e) { /* ignore */ }
});

test('client CRUD 全链路', async () => {
  const created = await db.createClient({ name: '万年移民', contact: '王', notes: 'Q3' });
  assert.ok(created.clientId, '应生成 clientId');
  assert.strictEqual(created.name, '万年移民');

  const list = await db.listClients();
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].clientId, created.clientId);

  const got = await db.getClient(created.clientId);
  assert.strictEqual(got.contact, '王');

  const updated = await db.updateClient(created.clientId, { name: '万年移民工作室', notes: 'Q4' });
  assert.strictEqual(updated.name, '万年移民工作室');
  assert.strictEqual(updated.notes, 'Q4');

  const missing = await db.updateClient('nope', { name: 'x' });
  assert.strictEqual(missing, null);
});

test('saveTaskConfig 透传 clientId，getHistory 回读', async () => {
  const client = await db.createClient({ name: '客户B' });
  const cfg = buildTaskConfig({
    platforms: ['baidu'],
    keywords: '万年移民',
    targetDomain: 'manincorp.cn',
    titleKeywords: '万年移民',
    clientId: client.clientId,
  });
  assert.strictEqual(cfg.clientId, client.clientId, 'taskConfig 应透传 clientId');

  await db.saveTaskConfig(cfg, 'autoclaw-dev');
  const list = await db.getHistory(10, 0);
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].clientId, client.clientId, 'getHistory 应回读 clientId');
});

test('client_stats 聚合 + 删除防关联任务', async () => {
  const client = await db.createClient({ name: '客户C' });
  const cfg = buildTaskConfig({
    platforms: ['baidu'],
    keywords: '移民公司',
    targetDomain: 'manincorp.cn',
    titleKeywords: '移民',
    clientId: client.clientId,
  });
  await db.saveTaskConfig(cfg, null);
  const taskId = cfg.taskId;

  // 插入运行记录：2 success + 1 failed
  await db.query(
    'INSERT INTO task_run_log (task_id, round, total_rounds, platform, keyword, step, step_status, event_type, message, error, timestamp) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    [taskId, 0, 1, 'baidu', '移民公司', 'search', 'success', 'step', 'ok', null, '2026-07-18 10:00:00'],
  );
  await db.query(
    'INSERT INTO task_run_log (task_id, round, total_rounds, platform, keyword, step, step_status, event_type, message, error, timestamp) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    [taskId, 0, 1, 'baidu', '移民公司', 'locate', 'success', 'step', 'ok', null, '2026-07-18 10:00:01'],
  );
  await db.query(
    'INSERT INTO task_run_log (task_id, round, total_rounds, platform, keyword, step, step_status, event_type, message, error, timestamp) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    [taskId, 0, 1, 'baidu', '移民公司', 'enter', 'failed', 'step', 'no', 'ERR_ADAPTER_FAIL', '2026-07-18 10:00:02'],
  );

  const stats = await db.getClientStats(client.clientId);
  assert.strictEqual(stats.taskCount, 1);
  assert.strictEqual(stats.total, 3);
  assert.strictEqual(stats.success, 2);
  assert.strictEqual(stats.fail, 1);
  assert.ok(Math.abs(stats.successRate - 2 / 3) < 1e-9, 'successRate=2/3');

  const tasks = await db.getClientTasks(client.clientId);
  assert.strictEqual(tasks.length, 1);
  assert.strictEqual(tasks[0].taskId, taskId);

  // 删除应被拒绝（有关联任务）
  await assert.rejects(() => db.deleteClient(client.clientId), /ERR_CLIENT_HAS_TASKS|关联任务/);

  // 清掉任务后可删除
  await db.query('DELETE FROM task_run_log WHERE task_id = ?', [taskId]);
  await db.query('DELETE FROM task_config WHERE task_id = ?', [taskId]);
  const ok = await db.deleteClient(client.clientId);
  assert.strictEqual(ok, true);
  const after = await db.getClient(client.clientId);
  assert.strictEqual(after, null);
});

test('client_delete 无任务可直接删', async () => {
  const c = await db.createClient({ name: '临时客户' });
  const ok = await db.deleteClient(c.clientId);
  assert.strictEqual(ok, true);
});
