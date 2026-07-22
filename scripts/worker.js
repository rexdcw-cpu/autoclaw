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
 * v0.3.11 新增 WIFI 轮询（config.pollWifi=true）：
 *   任务每跑完一次完整流程（engine.run()），自动切换下一个「可用 WIFI」，
 *   停留 5 秒后重跑，直到所有可用 WIFI 都跑过一遍才算任务完成。
 *   可用 WIFI = 本机已保存凭证、可无密码直连的网络（getConnectableNetworks）。
 *
 * v0.3.12 变更：
 *   - 失败重试：某个 WIFI 的一次流程熔断（engine.run 返回 FAILED）时，不立即跳过，
 *     而是在「该 WIFI 内」重跑，最多重试 AUTOCLAW_WIFI_FLOW_RETRIES 次（默认 3，
 *     即该 WIFI 最多跑 1+3=4 次）；全部尝试仍失败才标记该 WIFI 失败并跳过。
 *   - 完成度统计：每个 WIFI/网络的尝试次数、重试次数、终态都被记录，任务结束后
 *     汇总成完成度分析并持久化（core/taskStats），并推一条 TASK_STATS 进度事件。
 *
 * 可测试性：轮询主体抽成 runTask(config, emit, opts)，opts 可注入 engineFactory
 * 与 wifi 模块，便于单测在「不切真网 / 不起 Chrome」的情况下验证轮询逻辑。
 */

const { TaskEngine } = require('../core/taskEngine');
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

/** 失败重试前的短暂停顿（毫秒），避免立即重跑把同一故障放大；
 *  可通过 AUTOCLAW_WIFI_RETRY_GAP_MS 覆盖。流程本身耗时，默认 2 秒足矣。 */
const RETRY_GAP_MS = parseInt(process.env.AUTOCLAW_WIFI_RETRY_GAP_MS, 10) || 2000;

let engine = null;
let abort = false;
let abortStatus = TaskStatus.STOPPED;

/**
 * 运行一次任务（含 WIFI 轮询外层循环）。
 * @param {object} config TaskConfig（buildTaskConfig 产物，含 pollWifi）
 * @param {(event:object)=>void} emit 进度事件回调
 * @param {{engineFactory?:Function, wifi?:object, sleep?:Function, statsModule?:object, maxRetries?:number, retrySleep?:Function}} [opts] 测试注入
 *   - engineFactory(c, e)：构造一次 engine.run() 的实例，默认 new TaskEngine
 *   - wifi：WIFI 管理模块，默认本文件顶部的 wifi（真实 netsh 调用）
 *   - sleep(ms)：切换后停留等待，默认 5000ms；单测可注入空函数加速
 *   - statsModule：统计模块，默认 core/taskStats；单测可注入假对象
 *   - maxRetries：每个 WIFI 流程失败后的最大重试次数，默认读 AUTOCLAW_WIFI_FLOW_RETRIES（3）
 *   - retrySleep(ms)：重试前的短暂停顿，默认空（流程本身耗时，无需额外等待）
 * @returns {Promise<string>} 终态 TaskStatus（COMPLETED / FAILED / PAUSED / STOPPED）
 */
async function runTask(config, emit, opts) {
  opts = opts || {};
  const makeEngine = opts.engineFactory || ((c, e) => new TaskEngine(c, e));
  const wm = opts.wifi || wifi;
  const wait = opts.sleep || sleep;
  const statsMod = opts.statsModule || taskStats;
  const retryWait = opts.retrySleep || (() => Promise.resolve());
  const MAX_RETRIES = (opts.maxRetries != null)
    ? opts.maxRetries
    : (parseInt(process.env.AUTOCLAW_WIFI_FLOW_RETRIES, 10) || 3);

  abort = false;
  abortStatus = TaskStatus.STOPPED;
  let finalStatus = TaskStatus.COMPLETED;

  // ---- 构建 WIFI 轮询序列（仅 pollWifi）----
  let seq = null;
  if (config.pollWifi) {
    const list = await wm.getConnectableNetworks(); // 可见且已存凭证，顺序同前端
    const current = await wm.getCurrentSsid();
    seq = list.slice();
    const ci = current ? seq.indexOf(current) : -1;
    if (ci > 0) {
      const [c] = seq.splice(ci, 1);
      seq.unshift(c);
    } else if (ci === -1 && current) {
      seq.unshift(current);
    }
    emit(P.makeProgress({
      taskId: config.taskId,
      type: EventType.WIFI_POLL,
      message: 'WIFI 轮询已启用，共 ' + seq.length + ' 个可用 WIFI（从『' + (seq[0] || current || '当前网络') + '』开始），单个 WIFI 流程失败将重试 ' + MAX_RETRIES + ' 次',
      wifiIndex: 0,
      wifiTotal: seq.length,
    }));
  }

  // ---- 轮询外层：每个 WIFI 跑一次（失败的在该 WIFI 内重试）完整流程 ----
  const order = seq || [null]; // 非轮询：只跑当前网络一次
  const run = statsMod.newRun(config.taskId, {
    pollWifi: config.pollWifi,
    startedAt: config.startedAt,
    keyword: config.keyword,
    clientId: config.clientId,
  });

  for (let i = 0; i < order.length; i += 1) {
    const ssid = order[i];

    // 第 0 个用当前已连（不切）；其余（及首个非当前）先切换
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
            ssid: ssid,
            status: 'skipped',
            attempts: 0,
            retriesUsed: 0,
            error: '切换失败：' + cr.message,
          });
          continue; // 跳过该 WIFI，尝试下一个
        }
        await wait(5000); // 停留 5 秒
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

    // ---- 流程运行 + 失败重试（仅在该 WIFI 内）----
    let attempts = 0;
    let terminal = TaskStatus.FAILED;
    let ok = false;
    let controlBreak = false;
    for (let r = 0; r <= MAX_RETRIES; r += 1) {
      attempts += 1;
      engine = makeEngine(config, emit);
      const st = await engine.run();

      if (st === TaskStatus.PAUSED || st === TaskStatus.STOPPED) {
        terminal = st;
        controlBreak = true;
        break; // 受控中断，不再重试
      }
      if (st === TaskStatus.COMPLETED) {
        terminal = st;
        ok = true;
        break;
      }
      // FAILED：重试（除非已是最后一次尝试）
      terminal = TaskStatus.FAILED;
      if (r < MAX_RETRIES) {
        emit(P.makeProgress({
          taskId: config.taskId,
          type: EventType.WIFI_POLL,
          message: '『' + (ssid || '当前网络') + '』第 ' + attempts + ' 次流程失败（' + (r + 1) + '/' + MAX_RETRIES + ' 重试），即将重跑该 WIFI 流程',
          wifiIndex: i + 1,
          wifiTotal: order.length,
          ssid: ssid || '',
        }));
        await retryWait(RETRY_GAP_MS);
        continue;
      }
    }

    // 记录该 WIFI 的完成度
    const recStatus = ok
      ? 'completed'
      : (terminal === TaskStatus.FAILED ? 'failed' : terminal);
    statsMod.recordWifi(run, {
      ssid: ssid || null,
      status: recStatus,
      attempts: attempts,
      retriesUsed: Math.max(0, attempts - 1),
      error: ok ? null : (terminal === TaskStatus.FAILED ? '流程连续失败 ' + attempts + ' 次（含 ' + MAX_RETRIES + ' 次重试）' : terminal),
    });

    if (controlBreak) {
      finalStatus = terminal; // 暂停/停止，跳出外层
      break;
    }
    if (!ok && terminal === TaskStatus.FAILED) {
      finalStatus = TaskStatus.FAILED; // 有失败则整体标记失败，但继续跑完剩余 WIFI
      emit(P.makeProgress({
        taskId: config.taskId,
        type: EventType.WIFI_POLL,
        message: '『' + (ssid || '当前网络') + '』流程连续失败 ' + attempts + ' 次，跳过该 WIFI 并继续下一个',
        wifiIndex: i + 1,
        wifiTotal: order.length,
        ssid: ssid || '',
      }));
    }
  }

  if (abort && finalStatus === TaskStatus.COMPLETED) finalStatus = abortStatus;

  // ---- 完成度统计与分析持久化 ----
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
        taskId: config.taskId,
        type: EventType.TASK_END,
        status: finalStatus,
        message: 'worker 结束' + (config.pollWifi ? '（WIFI 轮询模式）' : ''),
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

module.exports = { runTask, sleep };
