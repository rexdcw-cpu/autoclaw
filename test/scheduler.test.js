'use strict';

/**
 * test/scheduler.test.js
 * 调度器核心逻辑单测（注入假 clock / 假 taskManager / 假 db，不触碰真实 DB）。
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  Scheduler,
  computeNextRun,
  shuffleArray,
  normalizeCampaignSpec,
} = require('../core/scheduler');

// ---- 假依赖 ----

function makeFakeTM() {
  const tasks = {};
  let activeId = null;
  return {
    get activeTaskId() { return activeId; },
    getProgress(id) { return { status: tasks[id] || 'UNKNOWN' }; },
    submit(cfg) {
      if (activeId) return { ok: false, code: 'ERR_TASK_RUNNING' };
      const id = cfg.taskId;
      tasks[id] = 'RUNNING';
      activeId = id;
      return { ok: true, taskId: id, status: 'RUNNING' };
    },
    _finish(id, status) {
      tasks[id] = status;
      if (activeId === id) activeId = null;
    },
    _active() { return activeId; },
  };
}

function makeFakeDb() {
  const store = new Map();
  const savedConfigs = [];
  const db = {
    async getCampaigns() { return [...store.values()]; },
    async getCampaign(id) { return store.get(id) || null; },
    async saveCampaign(c) { store.set(c.id, JSON.parse(JSON.stringify(c))); },
    async updateCampaign(id, fields) {
      const c = store.get(id);
      if (!c) return;
      Object.assign(c, fields);
    },
    async deleteCampaign(id) { store.delete(id); },
    // 记录每次站点落库（验证历史任务列表可见性）
    async saveTaskConfig(cfg, operator) { savedConfigs.push({ cfg, operator }); },
    _store: store,
    _savedConfigs: savedConfigs,
  };
  return db;
}

function makeScheduler(extra) {
  const clock = { now: Date.now() };
  const s = new Scheduler(
    Object.assign(
      { db: makeFakeDb(), taskManager: makeFakeTM(), clock: () => clock.now, tickMs: 1000 },
      extra || {},
    ),
  );
  s._clock = clock;
  return s;
}

const TARGETS = [
  { name: 'A', domain: 'a.com', titleKeywords: 'A', keywords: 'A' },
  { name: 'B', domain: 'b.com', titleKeywords: 'B', keywords: 'B' },
  { name: 'C', domain: 'c.com', titleKeywords: 'C', keywords: 'C' },
];

// ---- computeNextRun ----

test('computeNextRun: daily 今天未到点 → 今天', () => {
  const base = new Date();
  base.setHours(8, 0, 0, 0);
  const c = { scheduleType: 'daily', scheduleHour: 9, scheduleMinute: 0 };
  const next = computeNextRun(c, base.getTime());
  const d = new Date(next);
  assert.strictEqual(d.getHours(), 9);
  assert.strictEqual(d.getMinutes(), 0);
  assert.ok(next > base.getTime());
});

test('computeNextRun: daily 今天已过点 → 明天', () => {
  const base = new Date();
  base.setHours(10, 0, 0, 0);
  const c = { scheduleType: 'daily', scheduleHour: 9, scheduleMinute: 0 };
  const next = computeNextRun(c, base.getTime());
  const d = new Date(next);
  assert.strictEqual(d.getHours(), 9);
  // 应为明天
  assert.ok(next - base.getTime() >= 23 * 3600 * 1000);
});

test('computeNextRun: interval', () => {
  const c = { scheduleType: 'interval', intervalHours: 6 };
  const from = 1_000_000_000_000;
  assert.strictEqual(computeNextRun(c, from), from + 6 * 3600 * 1000);
});

// ---- shuffleArray 覆盖全部 ----

test('shuffleArray 覆盖全部下标', () => {
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    const arr = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
    shuffleArray(arr);
    assert.strictEqual(arr.length, 10);
    assert.deepStrictEqual(arr.slice().sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    seen.add(arr.join(','));
  }
  // 200 次里应出现多种排列（非恒定顺序）
  assert.ok(seen.size > 5);
});

// ---- normalizeCampaignSpec ----

test('normalizeCampaignSpec: 默认兜底', () => {
  const c = normalizeCampaignSpec({ name: 't', targets: TARGETS }, 'x', new Date().toISOString());
  assert.strictEqual(c.scheduleType, 'daily');
  assert.strictEqual(c.scheduleHour, 9);
  assert.strictEqual(c.shuffle, true);
  assert.deepStrictEqual(c.platforms, ['baidu', 'google']);
  assert.strictEqual(c.targets.length, 3);
});

// ---- 运行流程：tick 自动启动 + 串行推进 + 完成排程 ----

test('整轮运行：到点启动、串行全部跑完、排下一次', async () => {
  const s = makeScheduler();
  const c = await s.create({
    name: 'daily3',
    scheduleType: 'daily',
    scheduleHour: 9,
    scheduleMinute: 0,
    shuffle: false,
    targets: TARGETS,
  });
  // 强制到期（设为过去）
  c.nextRunAt = s._clock.now - 1000;
  s.campaigns.set(c.id, c);

  // 巡检：应启动第一轮（提交第 1 个目标）
  await s._tick();
  assert.strictEqual(s.currentId, c.id);
  let cur = s.campaigns.get(c.id);
  assert.ok(cur.runState.currentTaskId);
  const order = [cur.runState.currentIndex];
  assert.strictEqual(s.taskManager.activeTaskId, cur.runState.currentTaskId);

  // 逐个完成并推进
  for (let step = 1; step < TARGETS.length; step++) {
    s.taskManager._finish(cur.runState.currentTaskId, 'COMPLETED');
    await s._tick();
    cur = s.campaigns.get(c.id);
    if (cur.runState && cur.runState.currentTaskId) {
      order.push(cur.runState.currentIndex);
      assert.strictEqual(s.taskManager.activeTaskId, cur.runState.currentTaskId);
    }
  }
  // 最后一个完成后，再 tick 一次应触发 _completeRun（提交空 → 完成）
  s.taskManager._finish(cur.runState.currentTaskId, 'COMPLETED');
  await s._tick();
  cur = s.campaigns.get(c.id);
  assert.strictEqual(s.currentId, null);
  assert.strictEqual(cur.runState, null);
  assert.strictEqual(cur.lastRunStatus, 'done');
  assert.strictEqual(order.length, 3);
  assert.deepStrictEqual(order.slice().sort(), [0, 1, 2]);
  // 每个站点都落库（历史任务列表可见），顺序与运行顺序一致
  assert.strictEqual(s.db._savedConfigs.length, 3);
  const savedDomains = s.db._savedConfigs.map((x) => x.cfg.target.domain).sort();
  assert.deepStrictEqual(savedDomains, ['a.com', 'b.com', 'c.com']);
  assert.ok(s.db._savedConfigs.every((x) => x.operator.startsWith('campaign:')));
  // 下一次排程在未来
  assert.ok(cur.nextRunAt > s._clock.now);
});

// ---- 单站失败不阻塞整轮 ----

test('子任务失败仍推进到下一站', async () => {
  const s = makeScheduler();
  const c = await s.create({
    name: 'fail', scheduleType: 'interval', intervalHours: 24, shuffle: false, targets: TARGETS,
  });
  c.nextRunAt = s._clock.now - 1000;
  s.campaigns.set(c.id, c);
  await s._tick();
  let cur = s.campaigns.get(c.id);
  const firstId = cur.runState.currentTaskId;
  // 第一个失败
  s.taskManager._finish(firstId, 'FAILED');
  await s._tick();
  cur = s.campaigns.get(c.id);
  assert.ok(cur.runState.currentTaskId && cur.runState.currentTaskId !== firstId);
  assert.strictEqual(cur.runState.done.length, 1);
});

// ---- trigger 立即跑 ----

test('trigger 立即跑一轮（绕过 nextRunAt）', async () => {
  const s = makeScheduler();
  const c = await s.create({ name: 'trig', scheduleType: 'interval', intervalHours: 24, targets: TARGETS });
  // 设为未来，确保不会因到点自动启动
  c.nextRunAt = s._clock.now + 86400000;
  s.campaigns.set(c.id, c);
  await s.trigger(c.id);
  const cur = s.campaigns.get(c.id);
  assert.strictEqual(s.currentId, c.id);
  assert.ok(cur.runState.currentTaskId);
  // 立即触发应已为首个站点落库（shuffle 默认开，域名取三者之一）
  assert.strictEqual(s.db._savedConfigs.length, 1);
  assert.ok(['a.com', 'b.com', 'c.com'].includes(s.db._savedConfigs[0].cfg.target.domain));
});

test('trigger 在有活跃任务时拒绝', async () => {
  const s = makeScheduler();
  const c = await s.create({ name: 'trig2', scheduleType: 'interval', intervalHours: 24, targets: TARGETS });
  // 占用活跃槽
  s.taskManager.submit({ taskId: 'manual', platforms: ['baidu'], keywords: ['x'], targetDomain: 'z.com', titleKeywords: ['z'] });
  await assert.rejects(() => s.trigger(c.id), /TASK_RUNNING/);
});

// ---- 重启安全：清理残留 run_state ----

test('start() 清理残留运行态', async () => {
  const db = makeFakeDb();
  const s = new Scheduler({ db, taskManager: makeFakeTM(), clock: () => Date.now(), tickMs: 1000 });
  // 预置一个死于运行中的 campaign
  const dead = normalizeCampaignSpec({ name: 'dead', targets: TARGETS }, 'dead', new Date().toISOString());
  dead.runState = { runId: 'r', pending: [1, 2], done: [0], currentIndex: 0, currentTaskId: 't0', startedAt: 1 };
  db._store.set('dead', dead);
  await s.start();
  const after = db._store.get('dead');
  assert.strictEqual(after.runState, null);
  s.stop();
});

// ---- 禁用站点被跳过 ----

test('禁用站点被跳过：仅跑启用站、全部完成后排程', async () => {
  const s = makeScheduler();
  const targets = [
    { name: 'A', domain: 'a.com', titleKeywords: 'A', keywords: 'A', enabled: true },
    { name: 'B', domain: 'b.com', titleKeywords: 'B', keywords: 'B', enabled: false }, // 跳过
    { name: 'C', domain: 'c.com', titleKeywords: 'C', keywords: 'C', enabled: true },
  ];
  const c = await s.create({ name: 'partial', scheduleType: 'interval', intervalHours: 24, shuffle: false, targets });
  c.nextRunAt = s._clock.now - 1000;
  s.campaigns.set(c.id, c);
  await s._tick();
  let cur = s.campaigns.get(c.id);
  assert.ok(cur.runState.currentTaskId);
  // 进度总数应为启用数 2（_publicState.total）
  assert.strictEqual(s.getState().campaign.total, 2);
  // 启动后剩余 1 个待跑（A 已出队）
  assert.strictEqual(cur.runState.pending.length, 1);
  const runOrder = [cur.runState.currentIndex];
  s.taskManager._finish(cur.runState.currentTaskId, 'COMPLETED');
  await s._tick();
  cur = s.campaigns.get(c.id);
  if (cur.runState && cur.runState.currentTaskId) runOrder.push(cur.runState.currentIndex);
  s.taskManager._finish(cur.runState.currentTaskId, 'COMPLETED');
  await s._tick();
  cur = s.campaigns.get(c.id);
  assert.strictEqual(cur.runState, null);
  assert.strictEqual(cur.lastRunStatus, 'done');
  // 只落库 2 条（B 被跳过）
  assert.strictEqual(s.db._savedConfigs.length, 2);
  const doms = s.db._savedConfigs.map((x) => x.cfg.target.domain).sort();
  assert.deepStrictEqual(doms, ['a.com', 'c.com']);
  assert.deepStrictEqual(runOrder.slice().sort(), [0, 2]);
  assert.ok(cur.nextRunAt > s._clock.now);
});

// ---- 每站单独平台生效 ----

test('每站单独平台(仅百度 / 仅谷歌)生效', async () => {
  const s = makeScheduler();
  const targets = [
    { name: 'A', domain: 'a.com', titleKeywords: 'A', keywords: 'A', platforms: ['baidu'] },
    { name: 'B', domain: 'b.com', titleKeywords: 'B', keywords: 'B', platforms: ['google'] },
  ];
  const c = await s.create({ name: 'plat', scheduleType: 'interval', intervalHours: 24, shuffle: false, targets });
  c.nextRunAt = s._clock.now - 1000;
  s.campaigns.set(c.id, c);
  await s._tick();
  let cur = s.campaigns.get(c.id);
  // 首个站点 A 仅百度
  const first = s.db._savedConfigs[0].cfg;
  assert.deepStrictEqual(first.platforms, ['baidu']);
  assert.strictEqual(first.target.domain, 'a.com');
  // 推进到 B（仅谷歌）
  s.taskManager._finish(cur.runState.currentTaskId, 'COMPLETED');
  await s._tick();
  cur = s.campaigns.get(c.id);
  const second = s.db._savedConfigs[1].cfg;
  assert.deepStrictEqual(second.platforms, ['google']);
});
