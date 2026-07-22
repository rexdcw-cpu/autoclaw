'use strict';

/**
 * test/wifiPoll.test.js
 * ---------------------------------------------------------------------------
 * Unit tests for the v0.3.11 WIFI 轮询 outer loop (scripts/worker.js runTask).
 *
 * 不切真网 / 不起 Chrome：通过 runTask(config, emit, { wifi, engineFactory })
 * 注入假 wifi 与假 engine，断言轮询序列构建、WIFI_POLL 事件、切换次数与完成情况。
 */

const test = require('node:test');
const assert = require('node:assert');
const { runTask } = require('../scripts/worker');
const { EventType, TaskStatus } = require('../core/progressEvent');

/** 构造假 wifi 模块：connectable=可见已存凭证列表；current=当前已连；fail=切换失败的 ssid 集合 */
function makeWifi({ connectable, current, fail }) {
  const connectCalls = [];
  return {
    connectCalls,
    getConnectableNetworks: async () => connectable.slice(),
    getCurrentSsid: async () => current,
    connectSaved: async (ssid) => {
      connectCalls.push(ssid);
      if (fail && fail.includes(ssid)) {
        return { ok: false, message: '模拟切换失败' };
      }
      return { ok: true, message: 'ok' };
    },
  };
}

/** 构造假 engine 工厂：记录 run 次数，按 runStatuses 依次返回终态（默认 COMPLETED） */
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

/** 运行一次 runTask 并收集事件（sleep 注入空函数，避免单测真等 5 秒） */
async function runWith(config, wifi, engineFactory) {
  const events = [];
  const status = await runTask(config, (e) => events.push(e), {
    wifi,
    engineFactory: engineFactory ? engineFactory.factory : undefined,
    sleep: async () => {},
  });
  return { status, events };
}

function wifiPollEvents(events) {
  return events.filter((e) => e.type === EventType.WIFI_POLL);
}

// ---------------------------------------------------------------------------
// 1) 非轮询：只跑当前网络一次，不该有任何 WIFI_POLL 事件
// ---------------------------------------------------------------------------
test('非轮询：engine.run 仅调用一次且不会产生 WIFI_POLL 事件', async () => {
  const wifi = makeWifi({ connectable: ['A', 'B'], current: 'ROSNET5' });
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
  const current = 'ROSNET5'; // 已在第 0 位
  const wifi = makeWifi({ connectable, current });
  const ef = makeEngineFactory();
  const cfg = { taskId: 't-poll-0', pollWifi: true };

  const { status, events } = await runWith(cfg, wifi, ef);

  assert.strictEqual(status, TaskStatus.COMPLETED);
  assert.strictEqual(ef.runCalls.length, 3, '应跑 3 个 WIFI，各一次 engine.run');

  const wp = wifiPollEvents(events);
  // 启用事件 + (切换事件*2 仅 rest) + (开始事件*3)
  // enable(1) + connect(2) + start(3) = 6
  assert.strictEqual(wp.length, 6, 'WIFI_POLL 事件数应为 6');

  const enable = wp[0];
  assert.strictEqual(enable.wifiTotal, 3, '启用事件 wifiTotal=3');
  assert.strictEqual(enable.wifiIndex, 0);
  assert.ok(enable.message.includes('ROSNET5'), '启用事件应显示从当前网络 ROSNET5 开始');

  // connectSaved 仅对 rest（ROSNET2, HOME）调用，不切当前
  assert.deepStrictEqual(wifi.connectCalls, ['ROSNET2', 'HOME']);

  // 最后一条开始事件应为 HOME（序列末位）
  const last = wp[wp.length - 1];
  assert.ok(last.message.includes('HOME'), '末位应为 HOME');
});

// ---------------------------------------------------------------------------
// 3) 轮询 + 当前网络在序列中部：应被提到首位
// ---------------------------------------------------------------------------
test('轮询：当前已连在网络中部时移动到序列首位', async () => {
  const connectable = ['ROSNET2', 'HOME', 'ROSNET5'];
  const current = 'ROSNET5'; // 原 index 2，应 unshift 到 0
  const wifi = makeWifi({ connectable, current });
  const ef = makeEngineFactory();
  const cfg = { taskId: 't-poll-mid', pollWifi: true };

  const { events } = await runWith(cfg, wifi, ef);

  const wp = wifiPollEvents(events);
  const enable = wp[0];
  assert.ok(enable.message.includes('ROSNET5'), '启用事件应从 ROSNET5（被置顶）开始');
  // 切换顺序应为 ROSNET2, HOME（ROSNET5 为当前不切）
  assert.deepStrictEqual(wifi.connectCalls, ['ROSNET2', 'HOME']);
});

// ---------------------------------------------------------------------------
// 4) 轮询：某个 WIFI 切换失败 → 跳过该 WIFI 但继续后续，engine.run 不对其调用
// ---------------------------------------------------------------------------
test('轮询：切换失败的 WIFI 被跳过，后续继续，整体仍 COMPLETED', async () => {
  const connectable = ['ROSNET5', 'BAD', 'GOOD'];
  const current = 'ROSNET5';
  const wifi = makeWifi({ connectable, current, fail: ['BAD'] });
  const ef = makeEngineFactory();
  const cfg = { taskId: 't-poll-skip', pollWifi: true };

  const { status, events } = await runWith(cfg, wifi, ef);

  assert.strictEqual(status, TaskStatus.COMPLETED, '跳过失败 WIFI 后整体完成');
  // 三个 WIFI 中只有 ROSNET5/BAD/GOOD；BAD 切换失败被 continue 跳过，不跑 engine
  assert.strictEqual(ef.runCalls.length, 2, 'BAD 切换失败，仅 ROSNET5 与 GOOD 跑流程');
  assert.deepStrictEqual(wifi.connectCalls, ['BAD', 'GOOD']);

  const wp = wifiPollEvents(events);
  const failMsg = wp.find((e) => e.message.includes('切换『BAD』失败'));
  assert.ok(failMsg, '应出现 BAD 切换失败的提示事件');
});

// ---------------------------------------------------------------------------
// 5) 轮询：某次 engine.run 熔断失败 → 整体标记 FAILED 但仍跑完剩余 WIFI
// ---------------------------------------------------------------------------
test('轮询：某 WIFI 流程熔断 FAILED，整体 FAILED 但继续跑完', async () => {
  const connectable = ['ROSNET5', 'ROSNET2', 'HOME'];
  const current = 'ROSNET5';
  const wifi = makeWifi({ connectable, current });
  // 第 2 次 run（ROSNET2）返回 FAILED
  const ef = makeEngineFactory([TaskStatus.COMPLETED, TaskStatus.FAILED, TaskStatus.COMPLETED]);
  const cfg = { taskId: 't-poll-fail', pollWifi: true };

  const { status, events } = await runWith(cfg, wifi, ef);

  assert.strictEqual(status, TaskStatus.FAILED, '存在熔断应整体 FAILED');
  assert.strictEqual(ef.runCalls.length, 3, '仍应跑完全部 3 个 WIFI');
  const wp = wifiPollEvents(events);
  const failEvent = wp.find((e) => e.message.includes('流程熔断失败'));
  assert.ok(failEvent, '应出现流程熔断失败的提示事件');
});

// ---------------------------------------------------------------------------
// 6) 轮询：当前网络不在已存列表中（边界）→ 仍作为首个元素加入序列
// ---------------------------------------------------------------------------
test('轮询：当前已连不在已存列表时仍加入序列首位', async () => {
  const connectable = ['ROSNET2', 'HOME'];
  const current = 'SOME_OTHER'; // 不在 connectable 中
  const wifi = makeWifi({ connectable, current });
  const ef = makeEngineFactory();
  const cfg = { taskId: 't-poll-extra', pollWifi: true };

  const { events } = await runWith(cfg, wifi, ef);

  const enable = wifiPollEvents(events)[0];
  assert.strictEqual(enable.wifiTotal, 3, '总序列应包含当前网络，共 3');
  assert.ok(enable.message.includes('SOME_OTHER'), '启用事件应从当前网络 SOME_OTHER 开始');
  // 切换顺序：ROSNET2, HOME（当前 SOME_OTHER 不切）
  assert.deepStrictEqual(wifi.connectCalls, ['ROSNET2', 'HOME']);
});
