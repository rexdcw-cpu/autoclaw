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
 * 任务执行在 TaskEngine 内完成；worker 仅负责收发 IPC 与映射终态类型。
 */

const { TaskEngine } = require('../core/taskEngine');
const P = require('../core/progressEvent');
const { EventType, TaskStatus } = P;

/** 向主进程回传一条 IPC 消息（确保父进程存在） */
function send(type, event) {
  if (process.send) {
    process.send({ type: type, event: event || null });
  }
}

let engine = null;

process.on('message', async (msg) => {
  if (!msg || typeof msg !== 'object') return;

  if (msg.type === 'start') {
    const config = msg.config;
    try {
      engine = new TaskEngine(config, (event) => send('progress', event));
      const finalStatus = await engine.run();

      // 将引擎终态映射为对应 IPC 类型
      let ipcType;
      if (finalStatus === TaskStatus.PAUSED) ipcType = 'paused';
      else if (finalStatus === TaskStatus.STOPPED) ipcType = 'stopped';
      else ipcType = 'done'; // completed 或 failed(熔断)

      send(
        ipcType,
        P.makeProgress({
          taskId: config.taskId,
          type: EventType.TASK_END,
          status: finalStatus,
          message: 'worker 结束',
        }),
      );
    } catch (e) {
      send(
        'error',
        P.makeProgress({
          taskId: config && config.taskId,
          type: EventType.TASK_END,
          status: TaskStatus.FAILED,
          message: 'worker 异常：' + (e && e.message ? e.message : String(e)),
        }),
      );
    }
    return;
  }

  if (msg.type === 'control') {
    if (!engine) return;
    if (msg.action === 'pause') engine.setPause();
    else if (msg.action === 'stop') engine.setStop();
  }
});

// 避免未处理 Promise 拒绝导致 worker 静默崩溃
process.on('unhandledRejection', (reason) => {
  // 记录但不退出，交由主进程超时兜底
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
