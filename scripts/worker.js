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
 * 可测试性：轮询主体抽成 runTask(config, emit, opts)，opts 可注入 engineFactory
 * 与 wifi 模块，便于单测在「不切真网 / 不起 Chrome」的情况下验证轮询逻辑。
 */

const { TaskEngine } = require('../core/taskEngine');
const wifi = require('../core/wifiManager');
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

let engine = null;
let abort = false;
let abortStatus = TaskStatus.STOPPED;

/**
 * 运行一次任务（含 WIFI 轮询外层循环）。
 * @param {object} config TaskConfig（buildTaskConfig 产物，含 pollWifi）
 * @param {(event:object)=>void} emit 进度事件回调
 * @param {{engineFactory?:Function, wifi?:object, sleep?:Function}} [opts] 测试注入
 *   - engineFactory(c, e)：构造一次 engine.run() 的实例，默认 new TaskEngine
 *   - wifi：WIFI 管理模块，默认本文件顶部的 wifi（真实 netsh 调用）
 *   - sleep(ms)：切换后停留等待，默认 5000ms；单测可注入空函数加速
 * @returns {Promise<string>} 终态 TaskStatus（COMPLETED / FAILED / PAUSED / STOPPED）
 */
async function runTask(config, emit, opts) {
  opts = opts || {};
  const makeEngine = opts.engineFactory || ((c, e) => new TaskEngine(c, e));
  const wm = opts.wifi || wifi;
  const wait = opts.sleep || sleep;

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
      message: 'WIFI 轮询已启用，共 ' + seq.length + ' 个可用 WIFI（从『' + (seq[0] || current || '当前网络') + '』开始）',
      wifiIndex: 0,
      wifiTotal: seq.length,
    }));
  }

  // ---- 轮询外层：每个 WIFI 跑一次完整流程 ----
  const order = seq || [null]; // 非轮询：只跑当前网络一次
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
        if (!cr.ok) continue; // 跳过该 WIFI，尝试下一个
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

    engine = makeEngine(config, emit);
    const st = await engine.run();
    if (st === TaskStatus.FAILED) {
      emit(P.makeProgress({
        taskId: config.taskId,
        type: EventType.WIFI_POLL,
        message: '『' + (ssid || '当前网络') + '』流程熔断失败，跳过并继续下一个 WIFI',
        wifiIndex: i + 1,
        wifiTotal: order.length,
        ssid: ssid || '',
      }));
      finalStatus = TaskStatus.FAILED; // 有失败则整体标记失败，但继续跑完剩余 WIFI
    }
  }

  if (abort && finalStatus === TaskStatus.COMPLETED) finalStatus = abortStatus;
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
