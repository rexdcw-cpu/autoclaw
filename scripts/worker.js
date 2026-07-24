'use strict';

/**
 * scripts/worker.js
 * ---------------------------------------------------------------------------
 * worker 子进程入口（由 core/taskManager.js 经 child_process.fork 启动）。
 *
 * IPC 协议（与架构 8.6 一致）：
 *   主进程 → worker: { type:'start', config }           启动任务
 *                  { type:'control', action:'pause'|'stop' }  控制指令
 *   worker → 主进程: { type:'progress', event }         单条进度事件
 *                  { type:'paused'|'stopped'|'done'|'error', event }  终态/状态变化
 *
 * --------------------------------------------------------------------------
 * 任务流程（v0.3.20 重构，按用户设计）：
 *
 *   同时勾选「百度 + 谷歌」时，两个平台为【独立阶段】，各自统计一份数据：
 *
 *   阶段一 · 百度：
 *     - 若 pollWifi：按 WiFi 轮询（切换 N 次 WiFi，每次跑一次百度流程）；
 *       否则只跑当前网络一次。百度走【本机真实 IP / 当前 WiFi】，**不碰 VPN**。
 *     - 阶段结束 → 生成并保存【百度完成度统计】+ 推送一条 TASK_STATS。
 *
 *   阶段二 · 谷歌：
 *     - 先开 VPN（vpnController.getAvailableMainNodes 探测「主节点」组，
 *       剔除【超时】/不可达节点），得可用节点列表；
 *     - 按【VPN 可用节点】轮询（每轮 selectNode 切一个节点 + 重拉带代理 Chrome），
 *       跑一次谷歌流程；谷歌走【本地网线 + VPN 节点】，**不切 WiFi**。
 *     - 无可用节点 → ALERT + 跳过谷歌（记录 skipped 统计）。
 *     - 阶段结束 → 生成并保存【谷歌完成度统计】+ 推送一条 TASK_STATS。
 *
 *   两份统计独立（文件名 -baidu / -google），进度页分别弹出「完成度总结」卡片。
 *
 * --------------------------------------------------------------------------
 * 可测试性：runTask(config, emit, opts)，opts 可注入 engineFactory / wifi /
 * vpn / statsModule / sleep，便于单测在不切真网 / 不起 Chrome / 不碰真 VPN 的情况下
 * 验证分阶段与节点轮询逻辑。
 *
 * 向后兼容：当 config.rounds 缺失时（旧调用 / 旧单测），走 runLegacy 分支，
 * 行为与 v0.3.19 完全一致（整段 engine.run 包在 WiFi 轮询外层，一份混合统计）。
 */

const { TaskEngine } = require('../core/taskEngine');
const VpnController = require('../core/vpnController');
const wifi = require('../core/wifiManager');
const taskStats = require('../core/taskStats');
const P = require('../core/progressEvent');
const { EventType, TaskStatus } = P;

/** 向主进程回传一条 IPC 消息（确保父进程存在） */
function send(type, event) {
  if (process.send) {
    process.send({ type: type, event: event || null });
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 失败重试前的短暂停顿（毫秒）；可通过 AUTOCLAW_WIFI_RETRY_GAP_MS 覆盖 */
const RETRY_GAP_MS = parseInt(process.env.AUTOCLAW_WIFI_RETRY_GAP_MS, 10) || 2000;

/** 终态优先级：FAILED > STOPPED/PAUSED > COMPLETED */
function worstStatus(a, b) {
  const rank = {
    [TaskStatus.FAILED]: 3,
    [TaskStatus.STOPPED]: 2,
    [TaskStatus.PAUSED]: 2,
    [TaskStatus.COMPLETED]: 1,
  };
  return (rank[b] != null ? rank[b] : 1) >= (rank[a] != null ? rank[a] : 1) ? b : a;
}

// 模块级控制信号（由 IPC control 消息设置，供阶段循环在安全点检查）
let engine = null;
let abort = false;
let abortStatus = TaskStatus.STOPPED;

/**
 * 构建 WIFI 轮询序列（仅 pollWifi）：优先面板「已存」集合，回退可见且本机已存凭证。
 * 返回 { seq, usedRemembered, sourceDesc }。
 */
async function buildWifiSeq(config, wm) {
  const current = await wm.getCurrentSsid();
  let source;
  let usedRemembered = false;
  if (Array.isArray(config.rememberedWifis) && config.rememberedWifis.length) {
    source = config.rememberedWifis.slice();
    usedRemembered = true;
  } else {
    source = await wm.getConnectableNetworks();
  }
  const visible = await wm.listNetworks();
  const visibleSet = new Set(visible.map((n) => n.ssid));
  const beforeLen = source.length;
  let pool = source.filter((s) => visibleSet.has(s));
  const excludedNotVisible = beforeLen - pool.length;
  if (pool.length === 0) pool = source.slice();
  if (current && !pool.includes(current) && visibleSet.has(current)) {
    pool.unshift(current);
  }
  if (current && pool.includes(current)) {
    const ci = pool.indexOf(current);
    if (ci > 0) {
      const [c] = pool.splice(ci, 1);
      pool.unshift(c);
    }
  }
  const sourceDesc = usedRemembered
    ? ('面板『已存』集合遍历 ' + pool.length + ' 个 WIFI（共 ' + beforeLen + ' 个已存' +
      (excludedNotVisible ? '，已剔除不可见 ' + excludedNotVisible + ' 个' : '') + '）')
    : ('兜底遍历 ' + pool.length + ' 个 WIFI（可见且本机已存凭证，未收到面板已存集合）');
  return { seq: pool, usedRemembered, sourceDesc };
}

// ===========================================================================
// 入口分流
// ===========================================================================
async function runTask(config, emit, opts) {
  opts = opts || {};
  const wm = opts.wifi || wifi;
  const statsMod = opts.statsModule || taskStats;
  const vpn = opts.vpn || VpnController;
  const makeEngine = opts.engineFactory ||
    ((c, e) => new TaskEngine(c, e, { vpn: opts.vpn || VpnController }));

  // legacy：无 rounds（旧调用 / 旧单测）→ 完全沿用 v0.3.19 行为
  if (!Array.isArray(config.rounds) || config.rounds.length === 0) {
    return runLegacy(config, emit, { wm, statsMod, vpn, makeEngine, opts });
  }

  // phased：按平台拆分，独立阶段 + 独立统计
  return runPhased(config, emit, { wm, statsMod, vpn, makeEngine, opts });
}

// ===========================================================================
// 分阶段流程（v0.3.20）
// ===========================================================================
async function runPhased(config, emit, deps) {
  const { wm, statsMod, vpn, makeEngine, opts } = deps;
  const wait = opts.sleep || sleep;
  const retryWait = opts.retrySleep || ((ms) => sleep(ms));
  const MAX_RETRIES = (opts.maxRetries != null)
    ? opts.maxRetries
    : (parseInt(process.env.AUTOCLAW_WIFI_FLOW_RETRIES, 10) || 3);

  const baiduRounds = config.rounds.filter((r) => r.platform === 'baidu');
  const googleRounds = config.rounds.filter((r) => r.platform === 'google');
  const kw0 = (config.keywords && config.keywords.length === 1) ? config.keywords[0] : null;

  let currentRun = null;
  const phasedEmit = (ev) => {
    if (ev && ev.type === EventType.VPN_INFO && ev.vpn) statsMod.recordVpn(currentRun, ev.vpn);
    if (ev && ev.type === EventType.TASK_END) return; // 终态由 worker 在末尾统一发
    emit(ev);
  };

  abort = false;
  abortStatus = TaskStatus.STOPPED;
  let finalStatus = TaskStatus.COMPLETED;

  // ---------------------------------------------------------------------
  // 阶段一 · 百度（WiFi 轮询，不碰 VPN）
  // ---------------------------------------------------------------------
  if (baiduRounds.length) {
    const wifiSeq = config.pollWifi ? await buildWifiSeq(config, wm) : null;
    const seq = wifiSeq ? wifiSeq.seq : [null];
    if (wifiSeq) {
      emit(P.makeProgress({
        taskId: config.taskId,
        type: EventType.WIFI_POLL,
        message: '【百度阶段】WIFI 轮询已启用：按' + wifiSeq.sourceDesc +
          '，从『' + (seq[0] || '当前网络') + '』开始',
        wifiIndex: 0,
        wifiTotal: seq.length,
      }));
    } else {
      emit(P.makeProgress({
        taskId: config.taskId,
        type: EventType.WIFI_POLL,
        message: '【百度阶段】单网络模式（仅当前网络一次，不走 VPN）',
      }));
    }

    const run = statsMod.newRun(config.taskId, {
      platform: 'baidu',
      pollWifi: config.pollWifi,
      startedAt: config.startedAt,
      keyword: kw0,
      keywords: config.keywords || null,
      clientId: config.clientId,
      wifiSource: config.pollWifi ? (wifiSeq && wifiSeq.usedRemembered ? 'remembered' : 'fallback') : null,
    });
    currentRun = run;
    const st = await runBaiduLoop(config, baiduRounds, seq, {
      wm, makeEngine, wait, retryWait, MAX_RETRIES, emit: phasedEmit, run, statsMod,
    });
    finalStatus = worstStatus(finalStatus, st);

    const saved = statsMod.save(run, 'baidu');
    emit(P.makeProgress({
      taskId: config.taskId,
      type: EventType.TASK_STATS,
      message: '【百度】完成度统计已生成（' + run.summary.completedWifi + '/' + run.summary.totalWifi +
        ' 完成，' + run.summary.totalRetries + ' 次重试）—— ' + saved.mdFile,
      stats: run.summary,
      statsDetail: run,
    }));
  }

  // ---------------------------------------------------------------------
  // 阶段二 · 谷歌（本地网线 + VPN 节点轮询）
  // ---------------------------------------------------------------------
  if (googleRounds.length) {
    let diag;
    try {
      diag = await vpn.getAvailableMainNodes();
    } catch (e) {
      diag = { available: [], error: e.message };
    }
    const run = statsMod.newRun(config.taskId, {
      platform: 'google',
      pollWifi: config.pollWifi,
      startedAt: config.startedAt,
      keyword: kw0,
      keywords: config.keywords || null,
      clientId: config.clientId,
      wifiSource: null,
    });
    currentRun = run;

    if (!diag || !diag.available || diag.available.length === 0) {
      // 无可用节点：跳过谷歌（记录 skipped，不计入失败率）
      const skipVpn = {
        availableCount: 0,
        total: diag ? diag.total : 0,
        skipped: true,
        proxyUrl: diag ? diag.proxyUrl : null,
        error: diag ? diag.error : '无可用节点',
      };
      statsMod.recordVpn(run, skipVpn);
      statsMod.recordWifi(run, {
        ssid: null, via: 'vpn', status: 'skipped', attempts: 0, retriesUsed: 0,
        error: 'VPN 无可用主节点（已剔除超时/不可达），跳过谷歌任务',
      });
      emit(P.makeProgress({
        taskId: config.taskId,
        type: EventType.ALERT,
        message: 'VPN 无可用主节点（已剔除超时/不可达），跳过谷歌任务：' + (diag && diag.error ? diag.error : '无可用节点'),
      }));
      emit(P.makeProgress({
        taskId: config.taskId,
        type: EventType.VPN_INFO,
        message: 'VPN 无可用主节点，谷歌任务跳过',
        vpn: skipVpn,
      }));
      finalStatus = worstStatus(finalStatus, TaskStatus.COMPLETED);
    } else {
      emit(P.makeProgress({
        taskId: config.taskId,
        type: EventType.WIFI_POLL,
        message: '【谷歌阶段】VPN 已开启：主节点可用 ' + diag.available.length + '/' + diag.total +
          ' 个（已剔除超时/不可达），将按节点轮询（本地网线，不切 WiFi）',
        wifiIndex: 0,
        wifiTotal: diag.available.length,
      }));

      for (let i = 0; i < diag.available.length; i += 1) {
        const node = diag.available[i];
        if (abort) { finalStatus = worstStatus(finalStatus, abortStatus); break; }
        try {
          await vpn.selectNode(node);
        } catch (e) { /* 切节点失败不阻断，沿用 */ }

        const preset = {
          node: node,
          availableCount: diag.available.length,
          total: diag.total,
          proxyUrl: diag.proxyUrl,
          availableDetail: diag.availableDetail || null,
        };
        const eng = makeEngine(config, phasedEmit);
        engine = eng;
        emit(P.makeProgress({
          taskId: config.taskId,
          type: EventType.WIFI_POLL,
          message: '【谷歌阶段】节点轮询 ' + (i + 1) + '/' + diag.available.length +
            '：切至『' + node + '』开始谷歌流程',
          wifiIndex: i + 1,
          wifiTotal: diag.available.length,
        }));
        const st = await eng.run(googleRounds, { vpnPreset: preset });
        const recStatus = st === TaskStatus.COMPLETED
          ? 'completed'
          : (st === TaskStatus.FAILED ? 'failed' : st);
        statsMod.recordWifi(run, {
          ssid: node, via: 'vpn', status: recStatus,
          attempts: 1, retriesUsed: 0,
          error: st === TaskStatus.COMPLETED ? null : String(st),
        });
        finalStatus = worstStatus(finalStatus, st);
        if (st === TaskStatus.PAUSED || st === TaskStatus.STOPPED) {
          finalStatus = st;
          break;
        }
      }
      statsMod.recordVpn(run, {
        availableCount: diag.available.length,
        total: diag.total,
        usedNode: diag.available[0],
        proxyUrl: diag.proxyUrl,
        availableDetail: diag.availableDetail || null,
        polledBy: 'node',
      });
    }

    const saved = statsMod.save(run, 'google');
    emit(P.makeProgress({
      taskId: config.taskId,
      type: EventType.TASK_STATS,
      message: '【谷歌】完成度统计已生成（' + run.summary.completedWifi + '/' + run.summary.totalWifi +
        ' 完成，' + run.summary.totalRetries + ' 次重试）—— ' + saved.mdFile,
      stats: run.summary,
      statsDetail: run,
    }));
  }

  emit(P.makeProgress({
    taskId: config.taskId,
    type: EventType.TASK_END,
    status: finalStatus,
    message: 'worker 结束（分阶段：百度→谷歌）',
  }));
  return finalStatus;
}

/** 百度阶段：按 WiFi 序列循环跑百度流程（含单 WiFi 内失败重试） */
async function runBaiduLoop(config, baiduRounds, seq, deps) {
  const { wm, makeEngine, wait, retryWait, MAX_RETRIES, emit, run, statsMod } = deps;
  let finalStatus = TaskStatus.COMPLETED;

  for (let i = 0; i < seq.length; i += 1) {
    const ssid = seq[i];
    if (abort) { finalStatus = abortStatus; break; }
    if (i > 0 || (i === 0 && ssid && (await wm.getCurrentSsid()) !== ssid)) {
      if (ssid) {
        const cr = await wm.connectSaved(ssid);
        emit(P.makeProgress({
          taskId: config.taskId,
          type: EventType.WIFI_POLL,
          message: (cr.ok ? '已切换至『' + ssid + '』' : '切换『' + ssid + '』失败：' + cr.message) + '，停留 5 秒',
          wifiIndex: i + 1,
          wifiTotal: seq.length,
          ssid: ssid,
        }));
        if (!cr.ok) {
          statsMod.recordWifi(run, {
            ssid: ssid, via: 'wifi', status: 'skipped', attempts: 0, retriesUsed: 0,
            error: '切换失败：' + cr.message,
          });
          continue;
        }
        await wait(5000);
      }
    }

    if (config.pollWifi) {
      emit(P.makeProgress({
        taskId: config.taskId,
        type: EventType.WIFI_POLL,
        message: '【百度阶段】WIFI 轮询 ' + (i + 1) + '/' + seq.length + '：使用『' + (ssid || '当前网络') + '』开始百度流程',
        wifiIndex: i + 1,
        wifiTotal: seq.length,
        ssid: ssid || '',
      }));
    }

    let attempts = 0;
    let terminal = TaskStatus.FAILED;
    let ok = false;
    let controlBreak = false;
    for (let r = 0; r <= MAX_RETRIES; r += 1) {
      attempts += 1;
      const eng = makeEngine(config, emit);
      engine = eng;
      const st = await eng.run(baiduRounds);
      if (st === TaskStatus.PAUSED || st === TaskStatus.STOPPED) {
        terminal = st; controlBreak = true; break;
      }
      if (st === TaskStatus.COMPLETED) { terminal = st; ok = true; break; }
      terminal = TaskStatus.FAILED;
      if (r < MAX_RETRIES) {
        emit(P.makeProgress({
          taskId: config.taskId, type: EventType.WIFI_POLL,
          message: '『' + (ssid || '当前网络') + '』第 ' + attempts + ' 次流程失败（' + (r + 1) + '/' + MAX_RETRIES + ' 重试），即将重跑',
          wifiIndex: i + 1, wifiTotal: seq.length, ssid: ssid || '',
        }));
        await retryWait(RETRY_GAP_MS);
        continue;
      }
    }

    const recStatus = ok ? 'completed' : (terminal === TaskStatus.FAILED ? 'failed' : terminal);
    statsMod.recordWifi(run, {
      ssid: ssid || null, via: 'wifi', status: recStatus,
      attempts: attempts, retriesUsed: Math.max(0, attempts - 1),
      error: ok ? null : (terminal === TaskStatus.FAILED ? '流程连续失败 ' + attempts + ' 次' : terminal),
    });

    if (controlBreak) { finalStatus = terminal; break; }
    if (!ok && terminal === TaskStatus.FAILED) {
      finalStatus = TaskStatus.FAILED;
      emit(P.makeProgress({
        taskId: config.taskId, type: EventType.WIFI_POLL,
        message: '『' + (ssid || '当前网络') + '』流程连续失败，跳过该 WIFI 并继续下一个',
        wifiIndex: i + 1, wifiTotal: seq.length, ssid: ssid || '',
      }));
    }
  }
  return finalStatus;
}

// ===========================================================================
// Legacy 流程（无 config.rounds 时，行为与 v0.3.19 完全一致）
// ===========================================================================
async function runLegacy(config, emit, deps) {
  const { wm, statsMod, vpn, makeEngine, opts } = deps;
  const wait = opts.sleep || sleep;
  const retryWait = opts.retrySleep || ((ms) => sleep(ms));
  const MAX_RETRIES = (opts.maxRetries != null)
    ? opts.maxRetries
    : (parseInt(process.env.AUTOCLAW_WIFI_FLOW_RETRIES, 10) || 3);

  const engineEmit = (ev) => {
    if (ev && ev.type === EventType.VPN_INFO && ev.vpn) statsMod.recordVpn(run, ev.vpn);
    if (config.pollWifi && ev && ev.type === EventType.TASK_END) {
      emit(P.makeProgress({
        taskId: config.taskId,
        type: EventType.WIFI_POLL,
        message: '【WIFI 子流程结束】' + (ev.message || '本轮流程已结束'),
        stats: ev.stats || null,
      }));
      return;
    }
    emit(ev);
  };

  abort = false;
  abortStatus = TaskStatus.STOPPED;
  let finalStatus = TaskStatus.COMPLETED;

  // ---- 构建 WIFI 轮询序列（仅 pollWifi）----
  let seq = null;
  let usedRemembered = false;
  if (config.pollWifi) {
    const built = await buildWifiSeq(config, wm);
    seq = built.seq;
    usedRemembered = built.usedRemembered;
    emit(P.makeProgress({
      taskId: config.taskId,
      type: EventType.WIFI_POLL,
      message: 'WIFI 轮询已启用：按' + built.sourceDesc + '，从『' + (seq[0] || '当前网络') + '』开始，单个 WIFI 流程失败将重试 ' + MAX_RETRIES + ' 次',
      wifiIndex: 0,
      wifiTotal: seq.length,
    }));
  }

  const order = seq || [null];
  const run = statsMod.newRun(config.taskId, {
    pollWifi: config.pollWifi,
    startedAt: config.startedAt,
    keyword: (config.keywords && config.keywords.length === 1) ? config.keywords[0] : null,
    keywords: config.keywords || null,
    clientId: config.clientId,
    wifiSource: config.pollWifi ? (usedRemembered ? 'remembered' : 'fallback') : null,
  });

  for (let i = 0; i < order.length; i += 1) {
    const ssid = order[i];
    if (i > 0 || (i === 0 && ssid && (await wm.getCurrentSsid()) !== ssid)) {
      if (abort) { finalStatus = abortStatus; break; }
      if (ssid) {
        const cr = await wm.connectSaved(ssid);
        emit(P.makeProgress({
          taskId: config.taskId,
          type: EventType.WIFI_POLL,
          message: (cr.ok ? '已切换至『' + ssid + '』' : '切换『' + ssid + '』失败：' + cr.message) + '，停留 5 秒',
          wifiIndex: i + 1,
          wifiTotal: order.length,
          ssid: ssid,
        }));
        if (!cr.ok) {
          statsMod.recordWifi(run, {
            ssid: ssid, status: 'skipped', attempts: 0, retriesUsed: 0,
            error: '切换失败：' + cr.message,
          });
          continue;
        }
        await wait(5000);
      }
    }

    if (config.pollWifi) {
      emit(P.makeProgress({
        taskId: config.taskId,
        type: EventType.WIFI_POLL,
        message: '【WIFI 轮询 ' + (i + 1) + '/' + order.length + '】使用『' + (ssid || '当前网络') + '』开始第 ' + (i + 1) + ' 轮任务流程',
        wifiIndex: i + 1,
        wifiTotal: order.length,
        ssid: ssid || '',
      }));
    }

    let attempts = 0;
    let terminal = TaskStatus.FAILED;
    let ok = false;
    let controlBreak = false;
    for (let r = 0; r <= MAX_RETRIES; r += 1) {
      attempts += 1;
      engine = makeEngine(config, engineEmit);
      const st = await engine.run();
      if (st === TaskStatus.PAUSED || st === TaskStatus.STOPPED) {
        terminal = st; controlBreak = true; break;
      }
      if (st === TaskStatus.COMPLETED) { terminal = st; ok = true; break; }
      terminal = TaskStatus.FAILED;
      if (r < MAX_RETRIES) {
        emit(P.makeProgress({
          taskId: config.taskId, type: EventType.WIFI_POLL,
          message: '『' + (ssid || '当前网络') + '』第 ' + attempts + ' 次流程失败（' + (r + 1) + '/' + MAX_RETRIES + ' 重试），即将重跑该 WIFI 流程',
          wifiIndex: i + 1, wifiTotal: order.length, ssid: ssid || '',
        }));
        await retryWait(RETRY_GAP_MS);
        continue;
      }
    }

    statsMod.recordWifi(run, {
      ssid: ssid || null,
      status: ok ? 'completed' : (terminal === TaskStatus.FAILED ? 'failed' : terminal),
      attempts: attempts,
      retriesUsed: Math.max(0, attempts - 1),
      error: ok ? null : (terminal === TaskStatus.FAILED ? '流程连续失败 ' + attempts + ' 次（含 ' + MAX_RETRIES + ' 次重试）' : terminal),
    });

    if (controlBreak) { finalStatus = terminal; break; }
    if (!ok && terminal === TaskStatus.FAILED) {
      finalStatus = TaskStatus.FAILED;
      emit(P.makeProgress({
        taskId: config.taskId, type: EventType.WIFI_POLL,
        message: '『' + (ssid || '当前网络') + '』流程连续失败 ' + attempts + ' 次，跳过该 WIFI 并继续下一个',
        wifiIndex: i + 1, wifiTotal: order.length, ssid: ssid || '',
      }));
    }
  }

  if (abort && finalStatus === TaskStatus.COMPLETED) finalStatus = abortStatus;

  const saved = statsMod.save(run);
  emit(P.makeProgress({
    taskId: config.taskId,
    type: EventType.TASK_STATS,
    message: '任务完成度统计已生成并保存（' + run.summary.completedWifi + '/' + run.summary.totalWifi +
      ' 完成，' + run.summary.totalRetries + ' 次重试）—— ' + saved.mdFile,
    stats: run.summary,
    statsDetail: run,
  }));

  return finalStatus;
}

// ===========================================================================
// IPC
// ===========================================================================
process.on('message', async (msg) => {
  if (!msg || typeof msg !== 'object') return;

  if (msg.type === 'start') {
    const config = msg.config;
    try {
      const emit = (event) => send('progress', event);
      const finalStatus = await runTask(config, emit);

      let ipcType;
      if (finalStatus === TaskStatus.PAUSED) ipcType = 'paused';
      else if (finalStatus === TaskStatus.STOPPED) ipcType = 'stopped';
      else ipcType = 'done';

      send(ipcType, P.makeProgress({
        taskId: config && config.taskId,
        type: EventType.TASK_END,
        status: finalStatus,
        message: 'worker 结束',
      }));
    } catch (e) {
      const errMsg = e && e.message ? e.message : String(e);
      send('error', P.makeProgress({
        taskId: config && config.taskId,
        type: EventType.TASK_END,
        status: TaskStatus.FAILED,
        error: errMsg,
        message: 'worker 异常：' + errMsg,
      }));
    }
    return;
  }

  if (msg.type === 'control') {
    if (msg.action === 'pause') {
      abort = true;
      abortStatus = TaskStatus.PAUSED;
      if (engine) engine.setPause();
    } else if (msg.action === 'stop') {
      abort = true;
      abortStatus = TaskStatus.STOPPED;
      if (engine) engine.setStop();
    }
  }
});

process.on('unhandledRejection', (reason) => {
  if (process.send) {
    process.send({
      type: 'error',
      event: P.makeProgress({
        taskId: engine && engine.config && engine.config.taskId,
        type: EventType.TASK_END,
        status: TaskStatus.FAILED,
        message: '未处理的拒绝：' + (reason && reason.message ? reason.message : String(reason)),
      }),
    });
  }
});

module.exports = { runTask, runLegacy, runPhased, buildWifiSeq, sleep };
