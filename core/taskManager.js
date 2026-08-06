'use strict';

/**
 * core/taskManager.js
 * ---------------------------------------------------------------------------
 * 主进程任务管理器：负责 fork worker、单活跃任务守卫、暂停/停止、进度快照，
 * 以及把 worker 经 IPC 回传的 ProgressEvent 转发到对应 taskId 的 socket.io 房间。
 *
 * 决策 A2（单活跃任务）：任意时刻仅允许一个活跃任务；运行中收到新提交返回 409。
 * 决策 A3（鉴权）：submit/pause/stop 的 token 校验在边界中间件（app.js）与
 *   socket.io 握手（io.use）完成，此处只消费已通过鉴权的调用。
 * 决策 A4（熔断）：熔断为终态，无恢复逻辑——所有终态（paused/stopped/done/error）
 *   都会释放活跃槽位，允许重新提交。
 */

const { fork } = require('child_process');
const path = require('path');
const P = require('./progressEvent');
const { EventType, TaskStatus, ERR } = P;
const db = require('../config/db');

class TaskManager {
  constructor() {
    /** @type {import('socket.io').Server|null} */
    this.io = null;
    /** taskId -> worker 子进程 */
    this.workers = new Map();
    /** taskId -> 最近一条 ProgressEvent */
    this.latest = new Map();
    /** taskId -> ProgressEvent[] 日志环形缓冲 */
    this.logs = new Map();
    /** taskId -> 任务整体状态 */
    this.statuses = new Map();
    /** taskId -> TaskConfig */
    this.configs = new Map();
    /** 当前活跃任务 id（仅一个） */
    this.activeTaskId = null;
    /** taskId -> 最后收到该任务 worker 消息的时间戳(ms)，看门狗据此判定卡死 */
    this._lastMsgAt = new Map();
    /** 看门狗定时器（unref，不阻止进程退出） */
    this._watchdogTimer = null;
    /** 看门狗阈值(ms)，默认 10 分钟；可用 AUTOCLAW_WATCHDOG_MS 覆盖 */
    this.watchdogMs = Math.max(60000, Number(process.env.AUTOCLAW_WATCHDOG_MS) || 600000);
    /** 日志保留条数 */
    this.maxLog = 500;
  }

  /**
   * 在 Windows 上连子树一起强杀（Chrome 是 worker 子进程，否则会变成占用 profile 锁的孤儿）；
   * 非 Windows 退化为 SIGKILL。
   */
  _killWorkerTree(pid) {
    if (!pid) return;
    if (process.platform === 'win32') {
      try {
        require('child_process').execSync(`taskkill /pid ${pid} /T /F`, { stdio: 'ignore' });
      } catch (e) {
        /* 已退出或权限不足，忽略 */
      }
    } else {
      try {
        process.kill(pid, 'SIGKILL');
      } catch (e) {
        /* ignore */
      }
    }
  }

  /**
   * 启动运行看门狗：定期巡检，若某活跃任务超过 watchdogMs 无任何 worker 消息，
   * 则强杀其 worker（含 Chrome 子树）、标记 FAILED、释放活跃槽位，避免永久卡死。
   * 这是「worker 内部某步无限 await」的唯一兜底（taskManager 本身无法感知 worker 内部状态）。
   */
  startWatchdog() {
    if (this._watchdogTimer) return;
    this._watchdogTimer = setInterval(() => this._watchdogTick(), 30000);
    if (this._watchdogTimer.unref) this._watchdogTimer.unref();
  }

  /** 看门狗单次巡检（可被测试直接调用） */
  _watchdogTick() {
    const now = Date.now();
    for (const [taskId, lastAt] of this._lastMsgAt.entries()) {
      if (now - lastAt <= this.watchdogMs) continue;
      const st = this.statuses.get(taskId);
      if (st !== TaskStatus.RUNNING && st !== TaskStatus.PAUSED) continue;
      const w = this.workers.get(taskId);
      console.error(`[watchdog] 任务 ${taskId} 超过 ${this.watchdogMs}ms 无心跳，强杀并标记失败`);
      if (w && w.pid) this._killWorkerTree(w.pid);
      else if (w) { try { w.kill('SIGKILL'); } catch (e) { /* ignore */ } }
      this.statuses.set(taskId, TaskStatus.FAILED);
      db.updateTaskStatus(taskId, TaskStatus.FAILED).catch(() => {});
      if (this.io) {
        this.io.to(taskId).emit('task:state', { taskId, status: TaskStatus.FAILED });
        this.io.to(taskId).emit('alert', {
          taskId,
          level: 'error',
          message: `任务运行超时（超过 ${Math.round(this.watchdogMs / 1000)}s 无进展），已被看门狗强制终止`,
        });
      }
      this._cleanup(taskId);
    }
  }

  /**
   * 进程启动时清理数据库里的僵尸活跃任务：凡 status 为 pending/running 且无内存 worker
   * 的任务，都是上次进程残留（内存态已丢失），统一标记 FAILED，避免历史列表误导。
   */
  async reapZombieTasks() {
    try {
      const affected = await db.query(
        "UPDATE task_config SET status = 'FAILED' WHERE status IN ('pending', 'running')",
      );
      const n = (affected && affected.affectedRows) || (affected && affected.changes) || 0;
      if (n > 0) console.log(`[reap] 已清理 ${n} 个僵尸活跃任务(pending/running)`);
    } catch (e) {
      console.error('[reap] 清理僵尸任务失败:', e.message);
    }
  }

  /** 注入 socket.io 实例（app.js 启动时调用一次） */
  init(io) {
    this.io = io;
  }

  // -------------------------------------------------------------------------
  // 提交 / 生命周期
  // -------------------------------------------------------------------------

  /**
   * 提交一个新任务，fork worker 执行。
   * @param {object} config TaskConfig
   * @returns {{ok:boolean, code?:string, taskId?:string, status?:string}}
   */
  submit(config) {
    // A2：单活跃任务守卫
    if (this.activeTaskId && this._isActive(this.activeTaskId)) {
      return { ok: false, code: ERR.ERR_TASK_RUNNING };
    }

    const taskId = config.taskId;
    const worker = fork(path.join(__dirname, '..', 'scripts', 'worker.js'), [], {
      silent: false,
      env: process.env,
    });
    worker.on('message', (msg) => this._onWorkerMessage(taskId, msg));
    worker.on('exit', (code, signal) => this._onWorkerExit(taskId, code, signal));

    // 立即发送启动指令（worker 收到 config 后开始运行）
    worker.send({ type: 'start', config });

    this.workers.set(taskId, worker);
    this.configs.set(taskId, config);
    this.activeTaskId = taskId;
    this.statuses.set(taskId, TaskStatus.RUNNING);
    this.logs.set(taskId, []);
    this._lastMsgAt.set(taskId, Date.now());

    if (this.io) this.io.to(taskId).emit('task:state', { taskId, status: TaskStatus.RUNNING });
    return { ok: true, taskId, status: TaskStatus.RUNNING };
  }

  /** 暂停任务（发送 control 指令，引擎在下一轮安全点生效） */
  pause(taskId) {
    const w = this.workers.get(taskId);
    if (w && this._isActive(taskId)) {
      w.send({ type: 'control', action: 'pause' });
    }
  }

  /** 停止任务（发送 control 指令，并兜底强杀避免僵尸） */
  stop(taskId) {
    const w = this.workers.get(taskId);
    if (w && this._isActive(taskId)) {
      w.send({ type: 'control', action: 'stop' });
      // 兜底：若 worker 未及时响应，超时强杀（连 Chrome 子树一起清理）
      setTimeout(() => {
        if (this._isActive(taskId)) {
          if (w && w.pid) this._killWorkerTree(w.pid);
          else if (w) { try { w.kill('SIGKILL'); } catch (e) { /* ignore */ } }
        }
      }, 15000).unref();
    }
  }

  // -------------------------------------------------------------------------
  // 查询
  // -------------------------------------------------------------------------

  /** 是否存在该任务（含已结束的历史任务，便于进度回看） */
  exists(taskId) {
    return this.configs.has(taskId);
  }

  /**
   * 获取任务进度快照（用于 GET /api/task/progress 降级轮询）。
   * @returns {{ok:boolean, code?:string, taskId?:string, status?:string, latest?:object, log?:object[]}}
   */
  getProgress(taskId) {
    if (!this.configs.has(taskId)) {
      return { ok: false, code: ERR.ERR_TASK_NOT_FOUND };
    }
    return {
      ok: true,
      taskId,
      status: this.statuses.get(taskId) || TaskStatus.PENDING,
      latest: this.latest.get(taskId) || null,
      log: this.logs.get(taskId) || [],
    };
  }

  /** 活跃任务概览（GET /api/task/status） */
  getActiveStatus() {
    return {
      activeTaskId: this.activeTaskId,
      status: this.activeTaskId ? this.statuses.get(this.activeTaskId) || null : null,
      tokenRequired: true,
    };
  }

  // -------------------------------------------------------------------------
  // 内部：IPC 处理
  // -------------------------------------------------------------------------

  _onWorkerMessage(taskId, msg) {
    if (!msg) return;
    const event = msg.event || null;

    // 所有带 event 的消息都作为进度推送并写入日志缓冲
    if (event) {
      this._lastMsgAt.set(taskId, Date.now()); // 看门狗心跳
      this.latest.set(taskId, event);
      this._pushLog(taskId, event);
      db.bufferRunLog(event); // T-D2：运行记录异步入队（非阻塞，定时器批量落库）
      if (this.io) this.io.to(taskId).emit('progress', event);
      // 熔断告警：除 progress 外额外推送 alert 事件
      if (event.type === EventType.ALERT && this.io) {
        this.io.to(taskId).emit('alert', {
          taskId,
          level: 'error',
          message: event.message || '任务告警',
        });
      }
      if (event.status) this.statuses.set(taskId, event.status);
    }

    switch (msg.type) {
      case 'paused':
        this._setState(taskId, TaskStatus.PAUSED);
        db.updateTaskStatus(taskId, TaskStatus.PAUSED).catch(() => {}); // T-D2：终态改状态（fire-and-forget）
        this._cleanup(taskId); // A4：暂停即终态，释放活跃槽位
        break;
      case 'stopped':
        this._setState(taskId, TaskStatus.STOPPED);
        db.updateTaskStatus(taskId, TaskStatus.STOPPED).catch(() => {});
        this._cleanup(taskId);
        break;
      case 'done': {
        const finalStatus = (event && event.status) || TaskStatus.COMPLETED;
        this._setState(taskId, finalStatus);
        db.updateTaskStatus(taskId, finalStatus).catch(() => {});
        this._cleanup(taskId);
        break;
      }
      case 'error':
        this._setState(taskId, TaskStatus.FAILED);
        db.updateTaskStatus(taskId, TaskStatus.FAILED).catch(() => {});
        this._cleanup(taskId);
        break;
      default:
        // progress 等仅做转发，不做状态变更
        break;
    }
  }

  _onWorkerExit(taskId, code, signal) {
    // 若因异常退出且仍被记为活跃/运行，则置失败并释放
    const st = this.statuses.get(taskId);
    if (st === TaskStatus.RUNNING || st === TaskStatus.PAUSED) {
      this.statuses.set(taskId, TaskStatus.FAILED);
      db.updateTaskStatus(taskId, TaskStatus.FAILED).catch(() => {});
      if (this.io) this.io.to(taskId).emit('task:state', { taskId, status: TaskStatus.FAILED });
    }
    this._lastMsgAt.delete(taskId);
    this._cleanup(taskId);
  }

  _setState(taskId, status) {
    this.statuses.set(taskId, status);
    if (this.io) this.io.to(taskId).emit('task:state', { taskId, status });
  }

  _pushLog(taskId, event) {
    const arr = this.logs.get(taskId) || [];
    arr.push(event);
    if (arr.length > this.maxLog) arr.splice(0, arr.length - this.maxLog);
    this.logs.set(taskId, arr);
  }

  _cleanup(taskId) {
    this.activeTaskId = null;
    this._lastMsgAt.delete(taskId);
    const w = this.workers.get(taskId);
    if (w) {
      try {
        if (!w.killed) w.kill();
      } catch (e) {
        /* ignore */
      }
      this.workers.delete(taskId);
    }
    // 注意：保留 configs / logs / statuses / latest 供结束后的进度回看
  }

  _isActive(taskId) {
    const st = this.statuses.get(taskId);
    return st === TaskStatus.RUNNING || st === TaskStatus.PAUSED;
  }
}

/** 单例导出（全工程共享同一管理器）；同时导出类本身供单元测试实例化 */
module.exports = new TaskManager();
module.exports.TaskManager = TaskManager;
