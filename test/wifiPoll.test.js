'use strict';

/**
 * test/wifiPoll.test.js
 * ---------------------------------------------------------------------------
 * Unit tests for the WIFI 轮询 outer loop (scripts/worker.js runTask) + v0.3.12
 * 失败重试与完成度统计。
 *
 * 不切真网 / 不起 Chrome：通过 runTask(config, emit, { wifi, engineFactory, ... })
 * 注入假 wifi 与假 engine，断言轮询序列、WIFI_POLL 事件、切换次数、失败重试次数
 * 与完成度统计。
 */

const test = require('node:test');
const assert = require('node:assert');
const { runTask } = require('../scripts/worker');
const { EventType, TaskStatus } = require('../core/progressEvent');
const taskStats = require('../core/taskStats');

/** 构造假 wifi 模块：connectable=可见已存凭证列表；current=当前已连；fail=切换失败的 ssid 集合。
 *  切换成功后把 state.ssid 更新为当前 WIFI，供假 engine 按 WIFI 区分尝试结果。
 *  listNetworks 默认在 connectable 基础上补上当前已连（契合「已连一定可见」的真实行为）。 */
function makeWifi({ connectable, current, fail }) {
  const state = { ssid: current || null };
  const connectCalls = [];
  const wifi = {
    connectCalls,
    state,
    getConnectableNetworks: async () => connectable.slice(),
    getCurrentSsid: async () => current,
    listNetworks: async () => {
      const set = new Set(connectable);
      if (current) set.add(current);
      return Array.from(set).map((s) => ({ ssid: s }));
    },
    connectSaved: async (ssid) => {
      connectCalls.push(ssid);
      if (fail && fail.includes(ssid)) {
        return { ok: false, message: '模拟切换失败' };
      }
      state.ssid = ssid;
      return { ok: true, message: 'ok' };
    },
  };
  return { wifi, state };
}

/** 构造假 engine 工厂：按 runStatuses 依次返回终态（默认 COMPLETED），全局 idx 递增 */
function makeEngineFactory(runStatuses) {
  const runCalls = [];
  let idx = 0;
  return {
    runCalls,
    factory: (config, emit) => ({
      run: async () => {
        runCalls.push(config);
        const s = runStatuses ? runStatuses[idx] || TaskStatus.COMPLETED : TaskStatus.COMPLETED;
        idx += 1;
        return s;
      },
      setPause() {},
      setStop() {},
    }),
  };
}

/**
 * 按「每个 WIFI」分别控制其多次尝试的终态（用 state.ssid 区分，正确处理提前成功）。
 * @param {Object<string,Array<string>>} perWifi 以 ssid 为键的尝试结果数组（按调用顺序）
 * @param {object} state makeWifi 返回的共享状态对象（含 ssid）
 */
function makeEngineFactoryByWifi(perWifi, state) {
  const runCalls = [];
  const attemptBySsid = {};
  return {
    runCalls,
    factory: () => ({
      run: async () => {
        const key = (state && state.ssid) || 'current';
        const idx = attemptBySsid[key] || 0;
        attemptBySsid[key] = idx + 1;
        const arr = perWifi[key] || [];
        const s = arr[idx] || TaskStatus.COMPLETED;
        runCalls.push({ key, idx });
        return s;
      },
      setPause() {},
      setStop() {},
    }),
  };
}

/** 运行一次 runTask 并收集事件（sleep 注入空函数，避免单测真等 5 秒） */
async function runWith(config, wifi, engineFactory, extraOpts) {
  const events = [];
  const status = await runTask(config, (e) => events.push(e), Object.assign(
    {
      wifi: wifi,
      engineFactory: engineFactory ? engineFactory.factory : undefined,
      sleep: async () => {},
    },
    extraOpts || {},
  ));
  return { status, events };
}

function wifiPollEvents(events) {
  return events.filter((e) => e.type === EventType.WIFI_POLL);
}
function taskStatsEvents(events) {
  return events.filter((e) => e.type === EventType.TASK_STATS);
}

/** 捕获 statsModule.save 的假模块（合约与真实 taskStats 一致） */
function makeFakeStats() {
  const calls = [];
  return {
    calls,
    newRun: (taskId, meta) => ({ taskId, perWifi: [], summary: null, startedAt: (meta && meta.startedAt) || '', pollWifi: !!(meta && meta.pollWifi) }),
    recordWifi: (run, rec) => run.perWifi.push(rec),
    summarize: (run) => taskStats.summarize(run),
    save: (run) => { taskStats.summarize(run); calls.push(run); return { perFile: 'x', mdFile: 'y', rollingFile: 'z' }; },
  };
}

// ---------------------------------------------------------------------------
// 1) 非轮询：只跑当前网络一次，不该有任何 WIFI_POLL 事件
// ---------------------------------------------------------------------------
test('非轮询：engine.run 仅调用一次且不会产生 WIFI_POLL 事件', async () => {
  const { wifi } = makeWifi({ connectable: ['A', 'B'], current: 'ROSNET5' });
  const ef = makeEngineFactory();
  const cfg = { taskId: 't-nonpoll', pollWifi: false };

  const { status, events } = await runWith(cfg, wifi, ef);

  assert.strictEqual(status, TaskStatus.COMPLETED);
  assert.strictEqual(ef.runCalls.length, 1, 'engine.run 应只调用一次');
  assert.strictEqual(wifiPollEvents(events).length, 0, '非轮询不应产生 WIFI_POLL 事件');
  assert.strictEqual(wifi.connectCalls.length, 0, '非轮询不应调用 connectSaved');
});

// ---------------------------------------------------------------------------
// 2) 轮询 + 当前网络已在序列首位：order=[current, ...rest]
// ---------------------------------------------------------------------------
test('轮询：当前已连置顶，每个可用 WIFI 各跑一次完整流程', async () => {
  const connectable = ['ROSNET5', 'ROSNET2', 'HOME'];
  const current = 'ROSNET5';
  const { wifi } = makeWifi({ connectable, current });
  const ef = makeEngineFactory();
  const cfg = { taskId: 't-poll-0', pollWifi: true };

  const { status, events } = await runWith(cfg, wifi, ef);

  assert.strictEqual(status, TaskStatus.COMPLETED);
  assert.strictEqual(ef.runCalls.length, 3, '应跑 3 个 WIFI，各一次 engine.run');

  const wp = wifiPollEvents(events);
  assert.strictEqual(wp.length, 6, 'WIFI_POLL 事件数应为 6');

  const enable = wp[0];
  assert.strictEqual(enable.wifiTotal, 3, '启用事件 wifiTotal=3');
  assert.ok(enable.message.includes('ROSNET5'), '启用事件应显示从当前网络 ROSNET5 开始');

  assert.deepStrictEqual(wifi.connectCalls, ['ROSNET2', 'HOME']);

  const last = wp[wp.length - 1];
  assert.ok(last.message.includes('HOME'), '末位应为 HOME');
});

// ---------------------------------------------------------------------------
// 3) 轮询 + 当前网络在序列中部：应被提到首位
// ---------------------------------------------------------------------------
test('轮询：当前已连在网络中部时移动到序列首位', async () => {
  const connectable = ['ROSNET2', 'HOME', 'ROSNET5'];
  const current = 'ROSNET5';
  const { wifi } = makeWifi({ connectable, current });
  const ef = makeEngineFactory();
  const cfg = { taskId: 't-poll-mid', pollWifi: true };

  const { events } = await runWith(cfg, wifi, ef);

  const wp = wifiPollEvents(events);
  const enable = wp[0];
  assert.ok(enable.message.includes('ROSNET5'), '启用事件应从 ROSNET5（被置顶）开始');
  assert.deepStrictEqual(wifi.connectCalls, ['ROSNET2', 'HOME']);
});

// ---------------------------------------------------------------------------
// 4) 轮询：某个 WIFI 切换失败 → 跳过该 WIFI 但继续后续，engine.run 不对其调用
// ---------------------------------------------------------------------------
test('轮询：切换失败的 WIFI 被跳过，后续继续，整体仍 COMPLETED', async () => {
  const connectable = ['ROSNET5', 'BAD', 'GOOD'];
  const current = 'ROSNET5';
  const { wifi } = makeWifi({ connectable, current, fail: ['BAD'] });
  const ef = makeEngineFactory();
  const cfg = { taskId: 't-poll-skip', pollWifi: true };

  const { status, events } = await runWith(cfg, wifi, ef);

  assert.strictEqual(status, TaskStatus.COMPLETED, '跳过失败 WIFI 后整体完成');
  assert.strictEqual(ef.runCalls.length, 2, 'BAD 切换失败，仅 ROSNET5 与 GOOD 跑流程');
  assert.deepStrictEqual(wifi.connectCalls, ['BAD', 'GOOD']);

  const wp = wifiPollEvents(events);
  const failMsg = wp.find((e) => e.message.includes('切换『BAD』失败'));
  assert.ok(failMsg, '应出现 BAD 切换失败的提示事件');
});

// ---------------------------------------------------------------------------
// 5) v0.3.12 失败重试：某 WIFI 流程连续失败，重试 3 次（共 4 次）后跳过，整体 FAILED
// ---------------------------------------------------------------------------
test('v0.3.12：单个 WIFI 流程失败重试 3 次后仍失败则跳过，整体 FAILED', async () => {
  const connectable = ['ROSNET5', 'ROSNET2', 'HOME'];
  const current = 'ROSNET5';
  const { wifi, state } = makeWifi({ connectable, current });
  // ROSNET5 成功(1次)；ROSNET2 连续失败 4 次(1+3 重试)；HOME 成功(1次)
  const ef = makeEngineFactoryByWifi({
    ROSNET5: [TaskStatus.COMPLETED],
    ROSNET2: [TaskStatus.FAILED, TaskStatus.FAILED, TaskStatus.FAILED, TaskStatus.FAILED],
    HOME: [TaskStatus.COMPLETED],
  }, state);
  const cfg = { taskId: 't-poll-retry-fail', pollWifi: true };

  const { status, events } = await runWith(cfg, wifi, ef, { maxRetries: 3 });

  assert.strictEqual(status, TaskStatus.FAILED, '存在重试耗尽应整体 FAILED');
  // ROSNET5(1) + ROSNET2(4) + HOME(1) = 6
  assert.strictEqual(ef.runCalls.length, 6, 'ROSNET2 应跑满 1+3=4 次');
  const wp = wifiPollEvents(events);
  const retries = wp.filter((e) => e.message.includes('即将重跑该 WIFI 流程'));
  assert.strictEqual(retries.length, 3, 'ROSNET2 应有 3 条重试提示');
  const skip = wp.find((e) => e.message.includes('跳过该 WIFI'));
  assert.ok(skip, '应出现跳过该 WIFI 的提示');
});

// ---------------------------------------------------------------------------
// 6) 轮询：当前网络不在已存列表中（边界）→ 仍作为首个元素加入序列
// ---------------------------------------------------------------------------
test('轮询：当前已连不在已存列表时仍加入序列首位', async () => {
  const connectable = ['ROSNET2', 'HOME'];
  const current = 'SOME_OTHER';
  const { wifi } = makeWifi({ connectable, current });
  const ef = makeEngineFactory();
  const cfg = { taskId: 't-poll-extra', pollWifi: true };

  const { events } = await runWith(cfg, wifi, ef);

  const enable = wifiPollEvents(events)[0];
  assert.strictEqual(enable.wifiTotal, 3, '总序列应包含当前网络，共 3');
  assert.ok(enable.message.includes('SOME_OTHER'), '启用事件应从当前网络 SOME_OTHER 开始');
  assert.deepStrictEqual(wifi.connectCalls, ['ROSNET2', 'HOME']);
});

// ---------------------------------------------------------------------------
// 7) v0.3.12 失败重试成功：某 WIFI 第一次失败，重试第 1 次即成功 → 该 WIFI 完成
// ---------------------------------------------------------------------------
test('v0.3.12：WIFI 首次失败后重试成功，整体 COMPLETED', async () => {
  const connectable = ['ROSNET5', 'ROSNET2', 'HOME'];
  const current = 'ROSNET5';
  const { wifi, state } = makeWifi({ connectable, current });
  const ef = makeEngineFactoryByWifi({
    ROSNET5: [TaskStatus.COMPLETED],
    ROSNET2: [TaskStatus.FAILED, TaskStatus.COMPLETED],
    HOME: [TaskStatus.COMPLETED],
  }, state);
  const cfg = { taskId: 't-poll-retry-ok', pollWifi: true };

  const { status, events } = await runWith(cfg, wifi, ef, { maxRetries: 3 });

  assert.strictEqual(status, TaskStatus.COMPLETED, '重试后全部成功应整体 COMPLETED');
  // ROSNET5(1) + ROSNET2(2) + HOME(1) = 4
  assert.strictEqual(ef.runCalls.length, 4, 'ROSNET2 应跑 1+1=2 次');
  const wp = wifiPollEvents(events);
  assert.strictEqual(wp.filter((e) => e.message.includes('即将重跑该 WIFI 流程')).length, 1, 'ROSNET2 应有 1 条重试提示');
});

// ---------------------------------------------------------------------------
// 8) v0.3.12 完成度统计：轮询成功时 TASK_STATS 事件携带汇总，且 statsModule.save 被调用
// ---------------------------------------------------------------------------
test('v0.3.12：轮询成功时生成完成度统计并保存', async () => {
  const connectable = ['ROSNET5', 'ROSNET2'];
  const current = 'ROSNET5';
  const { wifi } = makeWifi({ connectable, current });
  const ef = makeEngineFactory();
  const fakeStats = makeFakeStats();
  const cfg = { taskId: 't-stats-ok', pollWifi: true };

  const { status, events } = await runWith(cfg, wifi, ef, { statsModule: fakeStats });

  assert.strictEqual(status, TaskStatus.COMPLETED);
  assert.strictEqual(fakeStats.calls.length, 1, 'statsModule.save 应被调用一次');
  const run = fakeStats.calls[0];
  assert.strictEqual(run.perWifi.length, 2, '应记录 2 个 WIFI');
  assert.strictEqual(run.summary.completedWifi, 2);
  assert.strictEqual(run.summary.failedWifi, 0);
  assert.strictEqual(run.summary.totalRetries, 0);
  assert.strictEqual(run.summary.overall, 'completed');
  const ts = taskStatsEvents(events);
  assert.strictEqual(ts.length, 1, '应推送一条 TASK_STATS 事件');
  assert.strictEqual(ts[0].stats.totalWifi, 2);
});

// ---------------------------------------------------------------------------
// 9) v0.3.12 完成度统计：非轮询单网络也记录一条；全部失败则统计为 failed
// ---------------------------------------------------------------------------
test('v0.3.12：非轮询记录单条；全失败统计 failed 且重试计入', async () => {
  // 非轮询单网络，全部失败，maxRetries=2 → attempts=3
  const { wifi, state } = makeWifi({ connectable: ['A'], current: 'A' });
  const ef = makeEngineFactoryByWifi({ A: [TaskStatus.FAILED, TaskStatus.FAILED, TaskStatus.FAILED] }, state);
  const fakeStats = makeFakeStats();
  const cfg = { taskId: 't-stats-fail', pollWifi: false };

  const { status } = await runWith(cfg, wifi, ef, { statsModule: fakeStats, maxRetries: 2 });

  assert.strictEqual(status, TaskStatus.FAILED);
  const run = fakeStats.calls[0];
  assert.strictEqual(run.perWifi.length, 1, '非轮询只记录 1 条');
  assert.strictEqual(run.perWifi[0].attempts, 3, '全失败应跑满 1+2=3 次');
  assert.strictEqual(run.perWifi[0].retriesUsed, 2);
  assert.strictEqual(run.summary.failedWifi, 1);
  assert.strictEqual(run.summary.totalRetries, 2);
  assert.strictEqual(run.summary.overall, 'failed');
});

// ---------------------------------------------------------------------------
// 10) v0.3.13：rememberedWifis 优先——严格只遍历「已存 ∩ 可见」，不回退 getConnectableNetworks
// ---------------------------------------------------------------------------
test('v0.3.13：rememberedWifis 优先，仅遍历已存且可见的 WIFI，不调用兜底', async () => {
  const connectableFallback = ['X', 'Y', 'Z']; // 兜底集，传了 remembered 时不应被使用
  const remembered = ['ROSNET5', 'ROSNET2', 'HOME']; // 面板「已存」集合
  const current = 'ROSNET5';
  const visible = ['ROSNET5', 'HOME']; // ROSNET2 当前不可见（范围内搜不到）
  let fallbackCalled = false;
  const connectCalls = [];
  const wifi = {
    getConnectableNetworks: async () => { fallbackCalled = true; return connectableFallback.slice(); },
    getCurrentSsid: async () => current,
    listNetworks: async () => visible.map((s) => ({ ssid: s })),
    connectSaved: async (ssid) => { connectCalls.push(ssid); return { ok: true, message: 'ok' }; },
  };
  const ef = makeEngineFactory();
  const cfg = { taskId: 't-remembered', pollWifi: true, rememberedWifis: remembered };

  const { status, events } = await runWith(cfg, wifi, ef);

  assert.strictEqual(status, TaskStatus.COMPLETED);
  assert.strictEqual(fallbackCalled, false, '传了 rememberedWifis 不应回退 getConnectableNetworks');
  // ROSNET2 不可见被剔除，只跑 ROSNET5(当前) + HOME
  assert.strictEqual(ef.runCalls.length, 2, '不可见的 ROSNET2 应被剔除');
  assert.deepStrictEqual(connectCalls, ['HOME'], '当前 ROSNET5 不切，仅连 HOME');
  const wp = wifiPollEvents(events);
  assert.ok(wp[0].message.includes('2 个') && wp[0].message.includes('已存'), '启用事件应显示面板已存的 2 个');
  assert.ok(wp[0].message.includes('ROSNET5'), '从 ROSNET5 开始');
});

// ---------------------------------------------------------------------------
// 11) v0.3.13：rememberedWifis 不含当前网络、但当前可见 → 当前被置顶
// ---------------------------------------------------------------------------
test('v0.3.13：当前网络不在 rememberedWifis 但可见时仍置顶', async () => {
  const remembered = ['ROSNET2', 'HOME'];
  const current = 'ROSNET5';
  const visible = ['ROSNET5', 'ROSNET2', 'HOME'];
  const connectCalls = [];
  const wifi = {
    getConnectableNetworks: async () => ['X'],
    getCurrentSsid: async () => current,
    listNetworks: async () => visible.map((s) => ({ ssid: s })),
    connectSaved: async (ssid) => { connectCalls.push(ssid); return { ok: true }; },
  };
  const ef = makeEngineFactory();
  const cfg = { taskId: 't-remembered-cur', pollWifi: true, rememberedWifis: remembered };

  const { events } = await runWith(cfg, wifi, ef);

  const wp = wifiPollEvents(events);
  assert.strictEqual(wp[0].wifiTotal, 3, '总数应为 3（当前 + 2 已存）');
  assert.ok(wp[0].message.includes('ROSNET5'), '当前 ROSNET5 应被置顶');
  assert.deepStrictEqual(connectCalls, ['ROSNET2', 'HOME']);
});
