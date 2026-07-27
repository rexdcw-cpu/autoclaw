'use strict';

/**
 * test/phasedTask.test.js
 * ---------------------------------------------------------------------------
 * 验证 v0.3.20「平台分阶段」任务流程（百度阶段 → 谷歌阶段，两份独立统计）：
 *   - 百度阶段按 WiFi 轮询（不碰 VPN），结束后保存【百度统计】；
 *   - 谷歌阶段先开 VPN、按「可用节点」轮询（本地网线、不切 WiFi），结束后保存【谷歌统计】；
 *   - 无 config.rounds 时回退 legacy 分支（由 test/wifiPoll.test.js 覆盖）。
 *
 * 全部走注入式 fake（不切真网 / 不起 Chrome / 不碰真 VPN）。
 */

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const { runTask } = require('../scripts/worker');
const { EventType, TaskStatus } = require('../core/progressEvent');
const taskStats = require('../core/taskStats');

// 隔离统计落盘
process.env.AUTOCLAW_STATS_DIR = path.join(os.tmpdir(), 'autoclaw-test-phased');

// 假 WiFi：2 个已存、当前 A
function makeWifi(connectable, current, fail) {
  const state = { ssid: current || null };
  const connectCalls = [];
  return {
    connectCalls,
    getConnectableNetworks: async () => connectable.slice(),
    getCurrentSsid: async () => current,
    listNetworks: async () => {
      const set = new Set(connectable);
      if (current) set.add(current);
      return Array.from(set).map((s) => ({ ssid: s }));
    },
    connectSaved: async (ssid) => {
      connectCalls.push(ssid);
      if (fail && fail.includes(ssid)) return { ok: false, message: '模拟切换失败' };
      state.ssid = ssid;
      return { ok: true, message: 'ok' };
    },
  };
}

// 假 engine：记录每次 run 的「平台」（来自 roundsOverride[0].platform）
function makeEngineTracked() {
  const runCalls = [];
  return {
    runCalls,
    factory: (config, emit) => ({
      run: async (roundsOverride) => {
        const platform = (roundsOverride && roundsOverride[0] && roundsOverride[0].platform) ||
          (config.platforms && config.platforms[0]) || 'unknown';
        runCalls.push({ platform, rounds: roundsOverride || config.rounds });
        return TaskStatus.COMPLETED;
      },
      setPause() {},
      setStop() {},
    }),
  };
}

// 假 VPN：返回指定可用节点列表，记录 selectNode 调用
function makeVpn(available) {
  const selectCalls = [];
  return {
    selectCalls,
    getAvailableMainNodes: async () => ({
      available: available.slice(),
      availableDetail: available.map((n, i) => ({ name: n, delay: (i + 1) * 10 })),
      unavailable: [],
      current: available[0] || null,
      total: available.length,
      proxyUrl: 'http://127.0.0.1:7890',
    }),
    selectNode: async (n) => { selectCalls.push(n); return true; },
  };
}

// 假 stats：记录 newRun 的平台 与 save 的 (platform, suffix)
function makeFakeStats() {
  const runs = [];
  const saves = [];
  return {
    runs,
    saves,
    newRun: (taskId, meta) => {
      const r = {
        taskId,
        platform: (meta && meta.platform) || null,
        perWifi: [],
        summary: null,
        startedAt: (meta && meta.startedAt) || '',
        pollWifi: !!(meta && meta.pollWifi),
      };
      runs.push(r);
      return r;
    },
    recordWifi: (run, rec) => run.perWifi.push(rec),
    recordVpn: (run, vpn) => { run.vpn = vpn; },
    summarize: (run) => {
      const total = run.perWifi.length;
      const completed = run.perWifi.filter((w) => w.status === 'completed').length;
      const failed = run.perWifi.filter((w) => w.status === 'failed').length;
      const skipped = run.perWifi.filter((w) => w.status === 'skipped').length;
      run.summary = {
        totalWifi: total, completedWifi: completed, failedWifi: failed, skippedWifi: skipped,
        completionRate: total ? Math.round((completed / total) * 100) : 0,
        totalRetries: run.perWifi.reduce((s, w) => s + (w.retriesUsed || 0), 0),
        overall: failed === 0 && skipped === 0 ? 'completed' : (failed > 0 ? 'failed' : 'partial'),
      };
      return run.summary;
    },
    save: (run, suffix) => {
      taskStats.summarize(run); // 真实 save 会先 summarize，这里保持一致
      saves.push({ platform: run.platform, suffix: suffix || null, run });
      return { perFile: 'x', mdFile: 'y', rollingFile: 'z' };
    },
  };
}

function buildConfig(platforms, rounds, pollWifi, rememberedWifis) {
  return {
    taskId: 't-' + platforms.join('-') + (pollWifi ? '-wifi' : ''),
    platforms: platforms.slice(),
    rounds: rounds,
    keywords: ['k1'],
    pollWifi: !!pollWifi,
    rememberedWifis: rememberedWifis || [],
  };
}

function taskStatsEvents(events) {
  return events.filter((e) => e.type === EventType.TASK_STATS);
}
function alertEvents(events) {
  return events.filter((e) => e.type === EventType.ALERT);
}
function vpnInfoEvents(events) {
  return events.filter((e) => e.type === EventType.VPN_INFO);
}

// 假 VPN 启动器（步骤1 开启VPN）：记录调用次数，默认返回已开
function makeFakeVpnLauncher() {
  const calls = [];
  return {
    calls,
    ensureOn: async () => { calls.push(1); return { ok: true, method: 'fake', error: null }; },
  };
}

// ---------------------------------------------------------------------------
// 1) 百度 + 谷歌，pollWifi：百度先按 WiFi 跑，谷歌再按 VPN 节点跑，顺序正确
// ---------------------------------------------------------------------------
test('分阶段：百度先全跑、谷歌后全跑（顺序），且百度按 WiFi、谷歌按 VPN 节点', async () => {
  const wifi = makeWifi(['A', 'B'], 'A');
  const ef = makeEngineTracked();
  const vpn = makeVpn(['N1', 'N2']);
  const stats = makeFakeStats();
  const vpnLauncher = makeFakeVpnLauncher();
  const rounds = [
    { roundIndex: 0, totalRounds: 2, platform: 'baidu', keyword: 'k1' },
    { roundIndex: 1, totalRounds: 2, platform: 'google', keyword: 'k1' },
  ];
  const cfg = buildConfig(['baidu', 'google'], rounds, true, ['A', 'B']);

  const events = [];
  const status = await runTask(cfg, (e) => events.push(e), {
    wifi, engineFactory: ef.factory, vpn, statsModule: stats, vpnLauncher, sleep: async () => {},
  });

  assert.strictEqual(status, TaskStatus.COMPLETED);
  // 百度 2 个 WiFi + 谷歌 2 个节点 = 4 次 engine.run
  assert.strictEqual(ef.runCalls.length, 4, '应共 4 次 engine.run');
  // 顺序：百度 ×2 → 谷歌 ×2
  const order = ef.runCalls.map((c) => c.platform);
  assert.deepStrictEqual(order, ['baidu', 'baidu', 'google', 'google'], '顺序应为百度先全跑、谷歌后全跑');
  // 谷歌阶段切了 2 个 VPN 节点
  assert.deepStrictEqual(vpn.selectCalls, ['N1', 'N2'], '应逐个 selectNode');
  // 百度阶段切了 1 个 WiFi（B），谷歌阶段不切 WiFi
  assert.deepStrictEqual(wifi.connectCalls, ['B'], '谷歌阶段不应调用 connectSaved');
  // 两份独立统计，平台正确
  assert.strictEqual(stats.saves.length, 2, '应保存两份统计');
  assert.deepStrictEqual(stats.saves.map((s) => s.platform), ['baidu', 'google']);
  assert.deepStrictEqual(stats.saves.map((s) => s.suffix), ['baidu', 'google']);
  // 两条 TASK_STATS 事件，平台顺序正确
  const ts = taskStatsEvents(events);
  assert.strictEqual(ts.length, 2, '应推送两条 TASK_STATS');
  assert.deepStrictEqual(ts.map((e) => e.statsDetail.platform), ['baidu', 'google']);
  // 步骤1 开启VPN 仅在谷歌阶段触发一次
  assert.strictEqual(vpnLauncher.calls.length, 1, '谷歌阶段应调用一次 vpnLauncher.ensureOn');
});

// ---------------------------------------------------------------------------
// 2) 仅百度：只跑百度阶段，谷歌阶段整体跳过（不调 VPN、不出谷歌统计）
// ---------------------------------------------------------------------------
test('分阶段：仅百度时不进入谷歌阶段（不调 VPN、无谷歌统计）', async () => {
  const wifi = makeWifi(['A', 'B'], 'A');
  const ef = makeEngineTracked();
  const vpn = makeVpn(['N1', 'N2']);
  const stats = makeFakeStats();
  const vpnLauncher = makeFakeVpnLauncher();
  const rounds = [{ roundIndex: 0, totalRounds: 1, platform: 'baidu', keyword: 'k1' }];
  const cfg = buildConfig(['baidu'], rounds, true, ['A', 'B']);

  const events = [];
  const status = await runTask(cfg, (e) => events.push(e), {
    wifi, engineFactory: ef.factory, vpn, statsModule: stats, vpnLauncher, sleep: async () => {},
  });

  assert.strictEqual(status, TaskStatus.COMPLETED);
  assert.deepStrictEqual(ef.runCalls.map((c) => c.platform), ['baidu', 'baidu'], '只跑百度');
  assert.strictEqual(vpn.selectCalls.length, 0, '不应调用 VPN selectNode');
  assert.strictEqual(stats.saves.length, 1, '只保存一份百度统计');
  assert.strictEqual(stats.saves[0].platform, 'baidu');
  assert.strictEqual(taskStatsEvents(events).length, 1);
  assert.strictEqual(vpnLauncher.calls.length, 0, '仅百度时不应调用 vpnLauncher');
});

// ---------------------------------------------------------------------------
// 3) 仅谷歌（不切 WiFi）：只跑谷歌阶段，按 VPN 节点轮询；百度阶段跳过
// ---------------------------------------------------------------------------
test('分阶段：仅谷歌时不切 WiFi，直接按 VPN 节点轮询', async () => {
  const wifi = makeWifi(['A', 'B'], 'A');
  const ef = makeEngineTracked();
  const vpn = makeVpn(['N1', 'N2', 'N3']);
  const stats = makeFakeStats();
  const vpnLauncher = makeFakeVpnLauncher();
  const rounds = [{ roundIndex: 0, totalRounds: 1, platform: 'google', keyword: 'k1' }];
  const cfg = buildConfig(['google'], rounds, false, []);

  const events = [];
  const status = await runTask(cfg, (e) => events.push(e), {
    wifi, engineFactory: ef.factory, vpn, statsModule: stats, vpnLauncher, sleep: async () => {},
  });

  assert.strictEqual(status, TaskStatus.COMPLETED);
  assert.deepStrictEqual(ef.runCalls.map((c) => c.platform), ['google', 'google', 'google'], '只跑谷歌，每个节点一次');
  assert.strictEqual(wifi.connectCalls.length, 0, '谷歌阶段不切 WiFi');
  assert.deepStrictEqual(vpn.selectCalls, ['N1', 'N2', 'N3']);
  assert.strictEqual(stats.saves.length, 1);
  assert.strictEqual(stats.saves[0].platform, 'google');
  assert.strictEqual(vpnLauncher.calls.length, 1, '谷歌阶段应调用一次 vpnLauncher');
});

// ---------------------------------------------------------------------------
// 4) 谷歌阶段无可用节点：跳过谷歌（ALERT + VPN_INFO skipped），保存 skipped 统计
// ---------------------------------------------------------------------------
test('分阶段：VPN 无可用节点时谷歌跳过（ALERT + VPN_INFO skipped + 统计 skipped）', async () => {
  const wifi = makeWifi(['A'], 'A');
  const ef = makeEngineTracked();
  const vpn = makeVpn([]); // 无可用节点
  const stats = makeFakeStats();
  const vpnLauncher = makeFakeVpnLauncher();
  const rounds = [
    { roundIndex: 0, totalRounds: 2, platform: 'baidu', keyword: 'k1' },
    { roundIndex: 1, totalRounds: 2, platform: 'google', keyword: 'k1' },
  ];
  const cfg = buildConfig(['baidu', 'google'], rounds, true, ['A']);

  const events = [];
  const status = await runTask(cfg, (e) => events.push(e), {
    wifi, engineFactory: ef.factory, vpn, statsModule: stats, vpnLauncher, sleep: async () => {},
  });

  assert.strictEqual(status, TaskStatus.COMPLETED);
  // 百度照常跑；谷歌引擎不应被创建/运行
  assert.deepStrictEqual(ef.runCalls.map((c) => c.platform), ['baidu'], '谷歌引擎不应运行');
  // 谷歌统计保存为 skipped
  const googleRun = stats.runs.find((r) => r.platform === 'google');
  assert.ok(googleRun, '应有谷歌 run');
  assert.strictEqual(googleRun.perWifi.length, 1, '谷歌应记录 1 条 skipped');
  assert.strictEqual(googleRun.perWifi[0].status, 'skipped');
  assert.strictEqual(googleRun.perWifi[0].via, 'vpn');
  assert.strictEqual(googleRun.vpn.skipped, true);
  assert.ok(alertEvents(events).some((e) => e.message.includes('跳过谷歌')), '应有跳过谷歌的 ALERT');
  assert.ok(vpnInfoEvents(events).some((e) => e.vpn && e.vpn.skipped), '应有 skipped 的 VPN_INFO');
});

// ---------------------------------------------------------------------------
// 5) 轮询轴正确：百度 perWifi.via='wifi'，谷歌 perWifi.via='vpn'
// ---------------------------------------------------------------------------
test('分阶段：百度记录 via=wifi、谷歌记录 via=vpn', async () => {
  const wifi = makeWifi(['A', 'B'], 'A');
  const ef = makeEngineTracked();
  const vpn = makeVpn(['N1']);
  const stats = makeFakeStats();
  const vpnLauncher = makeFakeVpnLauncher();
  const rounds = [
    { roundIndex: 0, totalRounds: 2, platform: 'baidu', keyword: 'k1' },
    { roundIndex: 1, totalRounds: 2, platform: 'google', keyword: 'k1' },
  ];
  const cfg = buildConfig(['baidu', 'google'], rounds, true, ['A', 'B']);

  await runTask(cfg, () => {}, {
    wifi, engineFactory: ef.factory, vpn, statsModule: stats, vpnLauncher, sleep: async () => {},
  });

  const baiduRun = stats.runs.find((r) => r.platform === 'baidu');
  const googleRun = stats.runs.find((r) => r.platform === 'google');
  baiduRun.perWifi.forEach((w) => assert.strictEqual(w.via, 'wifi', '百度应为 wifi'));
  googleRun.perWifi.forEach((w) => assert.strictEqual(w.via, 'vpn', '谷歌应为 vpn'));
  assert.strictEqual(baiduRun.perWifi.length, 2, '百度 2 个 WiFi');
  assert.strictEqual(googleRun.perWifi.length, 1, '谷歌 1 个节点');
});

// ---------------------------------------------------------------------------
// 6) 时长统计：每节点带 durationMs / startedAt / endedAt，阶段 run 带 endedAt
// ---------------------------------------------------------------------------
test('分阶段：时长统计（每节点 durationMs + 阶段 endedAt）', async () => {
  const wifi = makeWifi(['A', 'B'], 'A');
  const ef = makeEngineTracked();
  const vpn = makeVpn(['N1', 'N2']);
  const stats = makeFakeStats();
  const vpnLauncher = makeFakeVpnLauncher();
  const rounds = [
    { roundIndex: 0, totalRounds: 2, platform: 'baidu', keyword: 'k1' },
    { roundIndex: 1, totalRounds: 2, platform: 'google', keyword: 'k1' },
  ];
  const cfg = buildConfig(['baidu', 'google'], rounds, true, ['A', 'B']);

  await runTask(cfg, () => {}, {
    wifi, engineFactory: ef.factory, vpn, statsModule: stats, vpnLauncher, sleep: async () => {},
  });

  const baiduRun = stats.runs.find((r) => r.platform === 'baidu');
  const googleRun = stats.runs.find((r) => r.platform === 'google');

  // 阶段级：worker 在 save 前写入 endedAt，startedAt 为阶段开始时间戳
  assert.ok(typeof baiduRun.startedAt === 'string' && baiduRun.startedAt.length > 0, '百度阶段应有 startedAt');
  assert.ok(typeof baiduRun.endedAt === 'string' && baiduRun.endedAt.length > 0, '百度阶段应有 endedAt');
  assert.ok(typeof googleRun.startedAt === 'string' && googleRun.startedAt.length > 0, '谷歌阶段应有 startedAt');
  assert.ok(typeof googleRun.endedAt === 'string' && googleRun.endedAt.length > 0, '谷歌阶段应有 endedAt');
  assert.ok(Date.parse(googleRun.endedAt) >= Date.parse(baiduRun.endedAt), '谷歌阶段 endedAt 应晚于百度阶段');

  // 节点级：每条 perWifi 带 durationMs（数字≥0）与起止时间戳
  [...baiduRun.perWifi, ...googleRun.perWifi].forEach((w) => {
    assert.strictEqual(typeof w.durationMs, 'number', '节点 durationMs 应为数字');
    assert.ok(w.durationMs >= 0, '节点 durationMs 应 ≥ 0');
    assert.ok(typeof w.startedAt === 'string' && w.startedAt.length > 0, '节点应有 startedAt');
    assert.ok(typeof w.endedAt === 'string' && w.endedAt.length > 0, '节点应有 endedAt');
  });
});

// ---------------------------------------------------------------------------
// 7) 谷歌阶段失败自动换备选节点补跑（v0.3.34）：某节点失败→从剩余池自动补跑直到达标
// ---------------------------------------------------------------------------
test('分阶段：谷歌某节点失败自动换备选节点补跑，最终成功数达标', async () => {
  // 假 engine：指定节点『N1』失败时返回 FAILED，其余成功（模拟 US1 偶发限流）
  const failNodes = new Set(['N1']);
  let made = 0;
  const engineFactory = (config, emit) => ({
    run: async (roundsOverride, opts) => {
      const node = (opts && opts.vpnPreset && opts.vpnPreset.node) || null;
      made += 1;
      if (node && failNodes.has(node)) return TaskStatus.FAILED;
      return TaskStatus.COMPLETED;
    },
    setPause() {},
    setStop() {},
  });
  const wifi = makeWifi(['A'], 'A');
  // 可用节点池 N1(失败) N2 N3 N4：目标跑满 3 个成功 → 期望尝试 N1(fail)→N2→N3→N4
  const vpn = makeVpn(['N1', 'N2', 'N3', 'N4']);
  const stats = makeFakeStats();
  const vpnLauncher = makeFakeVpnLauncher();
  const rounds = [
    { roundIndex: 0, totalRounds: 2, platform: 'baidu', keyword: 'k1' },
    { roundIndex: 1, totalRounds: 2, platform: 'google', keyword: 'k1' },
  ];
  const cfg = buildConfig(['baidu', 'google'], rounds, true, ['A']);

  const events = [];
  const status = await runTask(cfg, (e) => events.push(e), {
    wifi, engineFactory, vpn, statsModule: stats, vpnLauncher, sleep: async () => {},
  });

  const googleRun = stats.runs.find((r) => r.platform === 'google');
  // 目标数 = 全部可用节点（4）；N1 失败后自动补跑 N2/N3/N4，最终成功 3 个
  assert.strictEqual(googleRun.vpn.usedCount, 3, '成功节点数应为 3（不含失败）');
  assert.strictEqual(googleRun.vpn.targetCount, 4, '目标数应为全部可用节点 4');
  assert.strictEqual(googleRun.vpn.usedNode, 'N2', '首个成功节点应为 N2（N1 已失败）');
  // 明细：1 failed + 3 completed = 4 条
  const failed = googleRun.perWifi.filter((w) => w.status === 'failed');
  const completed = googleRun.perWifi.filter((w) => w.status === 'completed');
  assert.strictEqual(failed.length, 1, '应有 1 个失败节点');
  assert.strictEqual(failed[0].ssid, 'N1', '失败节点应为 N1');
  assert.strictEqual(completed.length, 3, '应有 3 个成功节点');
  assert.deepStrictEqual(completed.map((w) => w.ssid), ['N2', 'N3', 'N4'], '成功顺序应为 N2/N3/N4');
  // 整体状态仍 completed（失败节点被补跑替代，不计入失败率）
  assert.strictEqual(status, TaskStatus.COMPLETED);
});

// ---------------------------------------------------------------------------
// 8) 备选池耗尽仍不足目标数：记成功数，不崩溃
// ---------------------------------------------------------------------------
test('分阶段：谷歌所有节点均失败→成功数不足目标、不崩溃、整阶段 FAILED', async () => {
  let made = 0;
  const engineFactory = () => ({
    run: async () => { made += 1; return TaskStatus.FAILED; },
    setPause() {},
    setStop() {},
  });
  const wifi = makeWifi(['A'], 'A');
  const vpn = makeVpn(['N1', 'N2']); // 目标 2，但全失败
  const stats = makeFakeStats();
  const vpnLauncher = makeFakeVpnLauncher();
  const rounds = [
    { roundIndex: 0, totalRounds: 2, platform: 'baidu', keyword: 'k1' },
    { roundIndex: 1, totalRounds: 2, platform: 'google', keyword: 'k1' },
  ];
  const cfg = buildConfig(['baidu', 'google'], rounds, true, ['A']);

  const status = await runTask(cfg, () => {}, {
    wifi, engineFactory, vpn, statsModule: stats, vpnLauncher, sleep: async () => {},
  });

  const googleRun = stats.runs.find((r) => r.platform === 'google');
  assert.strictEqual(googleRun.vpn.usedCount, 0, '成功数应为 0');
  assert.strictEqual(googleRun.perWifi.length, 2, '应尝试完所有 2 个节点');
  assert.strictEqual(googleRun.perWifi.every((w) => w.status === 'failed'), true, '全失败');
  // 谷歌阶段 FAILED（worstStatus），因百度成功，整体非 COMPLETED
  assert.strictEqual(status, TaskStatus.FAILED, '全失败应使谷歌阶段 FAILED');
});

// ---------------------------------------------------------------------------
// 9) AUTOCLAW_GOOGLE_MAX_NODES 限制下，报告 usedNode 为真实首个成功节点（非 available[0]）
// ---------------------------------------------------------------------------
test('分阶段：限制 MAX_NODES 时 usedNode 为首个成功节点而非 available[0]', async () => {
  // 仅第一个节点成功（模拟：若 available[0] 恰好是限流节点，但本轮 available[0] 成功）
  let made = 0;
  const engineFactory = (config, emit) => ({
    run: async () => { made += 1; return TaskStatus.COMPLETED; },
    setPause() {},
    setStop() {},
  });
  const wifi = makeWifi(['A'], 'A');
  const vpn = makeVpn(['N1', 'N2', 'N3', 'N4', 'N5']);
  const stats = makeFakeStats();
  const vpnLauncher = makeFakeVpnLauncher();
  const rounds = [{ roundIndex: 0, totalRounds: 1, platform: 'google', keyword: 'k1' }];
  const cfg = buildConfig(['google'], rounds, false, []);

  // 限制只跑满 2 个成功节点
  const prevEnv = process.env.AUTOCLAW_GOOGLE_MAX_NODES;
  process.env.AUTOCLAW_GOOGLE_MAX_NODES = '2';
  try {
    await runTask(cfg, () => {}, {
      wifi, engineFactory, vpn, statsModule: stats, vpnLauncher, sleep: async () => {},
    });
  } finally {
    if (prevEnv === undefined) delete process.env.AUTOCLAW_GOOGLE_MAX_NODES;
    else process.env.AUTOCLAW_GOOGLE_MAX_NODES = prevEnv;
  }

  const googleRun = stats.runs.find((r) => r.platform === 'google');
  assert.strictEqual(googleRun.vpn.usedCount, 2, '成功节点数=2');
  assert.strictEqual(googleRun.vpn.targetCount, 2, '目标数=2');
  assert.strictEqual(googleRun.vpn.usedNode, 'N1', '首个成功节点应为 N1');
  assert.strictEqual(googleRun.perWifi.length, 2, '明细应 2 条');
});
