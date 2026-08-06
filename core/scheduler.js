'use strict';

/**
 * core/scheduler.js
 * ---------------------------------------------------------------------------
 * 批量定时任务（campaign）调度器。
 *
 * 设计要点：
 *   1. 一个 campaign = 一组网站目标(targets) + 调度(schedule) + 打乱开关(shuffle)。
 *   2. 每次运行：把 targets 按下标生成顺序（shuffle 时 Fisher-Yates 打乱）后，
 *      串行逐个提交为「普通 task」（复用 TaskManager.submit / 现有引擎 / 历史 / 统计）。
 *   3. 受 TaskManager 单活跃任务限制，campaign 运行期间同一时刻只有一个子任务在跑，
 *      天然契合「每轮所有网站都要执行到」——本轮不结束（pending 非空）就不会排下一轮。
 *   4. 单个子任务成功或失败都算「已处理」，失败不阻塞整轮（失败站点留待下次排程重试）。
 *   5. 调度类型：
 *        - daily：每天本地时间 schedule_hour:schedule_minute 触发；
 *        - interval：每 interval_hours 小时触发一次。
 *   6. 重启安全：进程启动时清理任何残留 run_state（上次死于运行中），避免僵尸态。
 *   7. 手动 trigger 可立即跑一轮（绕过 nextRunAt），便于首次验证。
 *
 * 时间字段统一以 epoch 毫秒存储，规避时区与 DATETIME 解析歧义。
 */

const crypto = require('crypto');
const db = require('../config/db');
const taskManager = require('./taskManager');
const { buildTaskConfig } = require('./taskConfig');
const { TaskStatus } = require('./progressEvent');

/** 注入点：便于单测替换（默认走真实模块） */
let DEPS = { db, taskManager };

/** Fisher-Yates 原地打乱 */
function shuffleArray(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = arr[i];
    arr[i] = arr[j];
    arr[j] = t;
  }
  return arr;
}

/**
 * 计算下一次运行时间（epoch ms）。
 * @param {object} c campaign（需含 scheduleType / scheduleHour / scheduleMinute / intervalHours）
 * @param {number} fromMs 基准时间（通常为 now 或 lastRunAt）
 * @returns {number}
 */
function computeNextRun(c, fromMs) {
  if (c.scheduleType === 'interval') {
    const h = Number(c.intervalHours) > 0 ? Number(c.intervalHours) : 24;
    return fromMs + h * 3600 * 1000;
  }
  // daily（默认）
  const hour = c.scheduleHour != null ? Number(c.scheduleHour) : 9;
  const minute = c.scheduleMinute != null ? Number(c.scheduleMinute) : 0;
  const d = new Date(fromMs);
  d.setHours(hour, minute, 0, 0);
  let t = d.getTime();
  if (t <= fromMs) t += 24 * 3600 * 1000;
  return t;
}

/**
 * 规整外部传入的 campaign 规格为内部对象。
 * @param {object} spec
 * @param {string} id
 * @param {string} nowIso
 * @returns {object}
 */
function normalizeCampaignSpec(spec, id, nowIso) {
  const platforms = Array.isArray(spec.platforms) && spec.platforms.length
    ? spec.platforms
    : ['baidu', 'google'];
  // 每站补默认：enabled（默认勾选）、id（稳定标识，供前端 keying）。
  // 每站可单独覆盖 platforms/pollWifi/browseAnchor/keywords 等；缺省回落 campaign 级。
  const targets = (Array.isArray(spec.targets) ? spec.targets : []).map((t) => ({
    id: t.id || crypto.randomUUID(),
    name: t.name || t.domain || '未命名站点',
    domain: t.domain || '',
    enabled: t.enabled !== false, // 默认 true
    platforms: Array.isArray(t.platforms) && t.platforms.length ? t.platforms : undefined,
    keywords: t.keywords,
    titleKeywords: t.titleKeywords,
    browseAnchor: t.browseAnchor || undefined,
    pollWifi: t.pollWifi != null ? !!t.pollWifi : undefined,
    rememberedWifis: Array.isArray(t.rememberedWifis) && t.rememberedWifis.length ? t.rememberedWifis : undefined,
    maxResultPages: t.maxResultPages != null ? Number(t.maxResultPages) : undefined,
    anthropic: t.anthropic || undefined,
    humanize: t.humanize || undefined,
    clientId: t.clientId || undefined,
  }));
  const scheduleType = spec.scheduleType === 'interval' ? 'interval' : 'daily';
  return {
    id,
    name: String(spec.name || '未命名批量任务'),
    scheduleType,
    scheduleHour: scheduleType === 'daily' ? (spec.scheduleHour != null ? Number(spec.scheduleHour) : 9) : null,
    scheduleMinute: scheduleType === 'daily' ? (spec.scheduleMinute != null ? Number(spec.scheduleMinute) : 0) : null,
    intervalHours: scheduleType === 'interval' ? (spec.intervalHours != null ? Number(spec.intervalHours) : 24) : null,
    enabled: spec.enabled !== false,
    shuffle: spec.shuffle !== false,
    platforms,
    pollWifi: !!spec.pollWifi,
    rememberedWifis: Array.isArray(spec.rememberedWifis) ? spec.rememberedWifis : [],
    targets,
    runState: null,
    lastRunAt: null,
    lastRunStatus: null,
    nextRunAt: null,
    createdAt: spec.createdAt || nowIso,
    updatedAt: nowIso,
  };
}

class Scheduler {
  constructor(opts) {
    opts = opts || {};
    this.db = opts.db || DEPS.db;
    this.taskManager = opts.taskManager || DEPS.taskManager;
    this.io = opts.io || null;
    this.clock = opts.clock || (() => Date.now());
    this.tickMs = opts.tickMs || 30000;
    /** id -> campaign（内存缓存，DB 为权威） */
    this.campaigns = new Map();
    /** 当前正在运行的 campaign id（同时刻仅一个） */
    this.currentId = null;
    this.timer = null;
  }

  setIo(io) { this.io = io; }

  async start() {
    await this.reload();
    // 重启安全：清除任何残留运行态（上次进程死于运行中）
    for (const c of this.campaigns.values()) {
      if (c.runState) {
        c.runState = null;
        // eslint-disable-next-line no-await-in-loop
        await this.db.updateCampaign(c.id, { runState: null });
      }
    }
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => {
      this._tick().catch((e) => console.error('[scheduler] tick 错误:', (e && e.message) ? e.message : e));
    }, this.tickMs);
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async reload() {
    const list = await this.db.getCampaigns();
    this.campaigns.clear();
    for (const c of list) this.campaigns.set(c.id, c);
  }

  _now() { return this.clock(); }

  // -------------------------------------------------------------------------
  // 公开：CRUD
  // -------------------------------------------------------------------------

  async list() { return Array.from(this.campaigns.values()); }

  get(id) { return this.campaigns.get(id) || null; }

  async create(spec) {
    const id = spec.id || crypto.randomUUID();
    const nowIso = new Date().toISOString();
    const c = normalizeCampaignSpec(spec, id, nowIso);
    c.nextRunAt = computeNextRun(c, this._now());
    await this.db.saveCampaign(c);
    this.campaigns.set(id, c);
    return c;
  }

  async update(id, fields) {
    const c = this.campaigns.get(id);
    if (!c) throw new Error('CAMPAIGN_NOT_FOUND');
    // 仅覆盖传入字段
    if (fields.name != null) c.name = String(fields.name);
    if (fields.scheduleType != null) c.scheduleType = fields.scheduleType === 'interval' ? 'interval' : 'daily';
    if (fields.scheduleHour != null) c.scheduleHour = Number(fields.scheduleHour);
    if (fields.scheduleMinute != null) c.scheduleMinute = Number(fields.scheduleMinute);
    if (fields.intervalHours != null) c.intervalHours = Number(fields.intervalHours);
    if (fields.enabled != null) c.enabled = !!fields.enabled;
    if (fields.shuffle != null) c.shuffle = !!fields.shuffle;
    if (fields.platforms != null) c.platforms = fields.platforms;
    if (fields.pollWifi != null) c.pollWifi = !!fields.pollWifi;
    if (fields.rememberedWifis != null) c.rememberedWifis = fields.rememberedWifis;
    if (fields.targets != null) c.targets = fields.targets;
    // 调度字段变化 → 重新排程
    if (
      fields.scheduleType != null || fields.scheduleHour != null ||
      fields.scheduleMinute != null || fields.intervalHours != null
    ) {
      c.nextRunAt = computeNextRun(c, this._now());
    }
    await this.db.saveCampaign(c);
    return c;
  }

  async remove(id) {
    if (this.currentId === id) this.currentId = null;
    this.campaigns.delete(id);
    await this.db.deleteCampaign(id);
  }

  async setEnabled(id, enabled) {
    const c = this.campaigns.get(id);
    if (!c) throw new Error('CAMPAIGN_NOT_FOUND');
    c.enabled = !!enabled;
    await this.db.updateCampaign(id, { enabled: c.enabled });
  }

  /** 立即跑一轮（绕过 nextRunAt）。 */
  async trigger(id) {
    const c = this.campaigns.get(id);
    if (!c) throw new Error('CAMPAIGN_NOT_FOUND');
    if (!c.enabled) throw new Error('CAMPAIGN_DISABLED');
    if (this.currentId) throw new Error('ANOTHER_CAMPAIGN_RUNNING');
    if (this.taskManager.activeTaskId) throw new Error('TASK_RUNNING');
    if (c.runState) throw new Error('CAMPAIGN_RUNNING');
    await this._beginRun(c);
    return c;
  }

  /** 当前运行状态快照（供 API / UI 轮询）。 */
  getState() {
    const c = this.currentId ? this.campaigns.get(this.currentId) : null;
    return {
      currentId: this.currentId,
      activeTaskId: this.taskManager.activeTaskId,
      campaign: c ? this._publicState(c) : null,
      campaigns: Array.from(this.campaigns.values()).map((x) => this._publicState(x)),
    };
  }

  // -------------------------------------------------------------------------
  // 核心：巡检
  // -------------------------------------------------------------------------

  async _tick() {
    const now = this._now();

    // 1) 有 campaign 正在运行 → 检查当前子任务是否结束
    if (this.currentId) {
      const c = this.campaigns.get(this.currentId);
      if (!c || !c.runState) { this.currentId = null; return; }
      const rs = c.runState;
      const activeId = this.taskManager.activeTaskId;
      const stillRunning = activeId && activeId === rs.currentTaskId;
      if (stillRunning) return; // 当前子任务仍在跑

      const st = this._taskStatus(rs.currentTaskId);
      if (st === TaskStatus.PAUSED || st === TaskStatus.STOPPED) {
        // 用户中断 → 终止本轮（剩余目标留待下次排程）
        await this._abortRun(c);
      } else {
        // COMPLETED / FAILED / 未知(丢失) → 推进下一个目标
        await this._advance(c);
      }
      return;
    }

    // 2) 无 campaign 运行 → 找到期且启用的 campaign，且当前无活跃任务
    if (this.taskManager.activeTaskId) return;
    const due = [];
    for (const c of this.campaigns.values()) {
      if (!c.enabled || c.runState) continue;
      if (c.nextRunAt != null && now >= c.nextRunAt) due.push(c);
    }
    if (due.length === 0) return;
    due.sort((a, b) => (a.nextRunAt || 0) - (b.nextRunAt || 0));
    await this._beginRun(due[0]);
  }

  _taskStatus(taskId) {
    if (!taskId) return 'UNKNOWN';
    try {
      const p = this.taskManager.getProgress(taskId);
      return p && p.status ? p.status : 'UNKNOWN';
    } catch (e) {
      return 'UNKNOWN';
    }
  }

  // -------------------------------------------------------------------------
  // 运行态推进
  // -------------------------------------------------------------------------

  async _beginRun(c) {
    // 仅纳入「启用」的站点（enabled !== false）；每轮所有启用站必须跑完。
    const order = [];
    c.targets.forEach((t, i) => {
      if (t.enabled !== false) order.push(i);
    });
    if (c.shuffle) shuffleArray(order);
    c.runState = {
      runId: crypto.randomUUID(),
      pending: order,
      done: [],
      currentIndex: null,
      currentTaskId: null,
      startedAt: this._now(),
    };
    this.currentId = c.id;
    await this.db.updateCampaign(c.id, { runState: c.runState }).catch(() => {});
    this._emitState(c);
    await this._submitNext(c);
  }

  /**
   * 提交下一个目标站点为普通任务。
   * 关键：与路由 /api/task/submit 契约一致——先 db.saveTaskConfig 落库（保证历史任务列表
   * 每条站点执行都有 1 条记录），再 taskManager.submit 启动。worker 终态会通过
   * db.updateTaskStatus 把该记录状态更新为 COMPLETED / FAILED，历史页可直接回看执行情况。
   */
  async _submitNext(c) {
    const rs = c.runState;
    if (!rs || rs.pending.length === 0) {
      await this._completeRun(c);
      return;
    }
    const idx = rs.pending.shift();
    const target = c.targets[idx];
    let cfg;
    try {
      cfg = this._buildTargetConfig(c, target);
    } catch (e) {
      // 目标配置非法 → 不落库、标记已处理并继续下一个
      console.error('[scheduler] 目标配置非法，跳过:', (e && e.message) ? e.message : e);
      rs.currentIndex = idx;
      await this._advance(c).catch(() => {});
      return;
    }
    // 落库：使每个站点在历史任务列表可见（operator 标记来源 campaign）
    try {
      await this.db.saveTaskConfig(cfg, 'campaign:' + c.id);
    } catch (e) {
      console.error('[scheduler] 站点任务落库失败，跳过该站点:', (e && e.message) ? e.message : e);
      rs.currentIndex = idx;
      await this._advance(c).catch(() => {});
      return;
    }
    const res = this.taskManager.submit(cfg);
    if (!res || !res.ok) {
      // 提交失败（极端竞态：活跃任务抢占）→ 终止本轮，下次排程重试
      console.error('[scheduler] 提交子任务失败，终止本轮:', (res && res.code) || 'unknown');
      await this._abortRun(c).catch(() => {});
      return;
    }
    rs.currentIndex = idx;
    rs.currentTaskId = res.taskId;
    await this.db.updateCampaign(c.id, { runState: rs }).catch(() => {});
    this._emitState(c);
  }

  async _advance(c) {
    const rs = c.runState;
    if (!rs) { this.currentId = null; return; }
    if (rs.currentIndex != null) rs.done.push(rs.currentIndex);
    rs.currentIndex = null;
    rs.currentTaskId = null;
    await this.db.updateCampaign(c.id, { runState: rs }).catch(() => {});
    this._emitState(c);
    await this._submitNext(c);
  }

  async _completeRun(c) {
    const now = this._now();
    c.lastRunAt = now;
    c.lastRunStatus = 'done';
    c.nextRunAt = computeNextRun(c, now);
    c.runState = null;
    this.currentId = null;
    await this.db.updateCampaign(c.id, {
      lastRunAt: c.lastRunAt,
      lastRunStatus: c.lastRunStatus,
      nextRunAt: c.nextRunAt,
      runState: null,
    });
    this._emitState(c);
  }

  async _abortRun(c) {
    const now = this._now();
    c.lastRunAt = now;
    c.lastRunStatus = 'aborted';
    c.nextRunAt = computeNextRun(c, now);
    c.runState = null;
    this.currentId = null;
    await this.db.updateCampaign(c.id, {
      lastRunAt: c.lastRunAt,
      lastRunStatus: c.lastRunStatus,
      nextRunAt: c.nextRunAt,
      runState: null,
    });
    this._emitState(c);
  }

  _buildTargetConfig(c, target) {
    // 每站优先用自身配置；缺省回落 campaign 级默认。
    const platforms = (Array.isArray(target.platforms) && target.platforms.length)
      ? target.platforms
      : c.platforms;
    const pollWifi = target.pollWifi != null ? !!target.pollWifi : c.pollWifi;
    const rememberedWifis = (Array.isArray(target.rememberedWifis) && target.rememberedWifis.length)
      ? target.rememberedWifis
      : (c.rememberedWifis || []);
    const cfg = {
      platforms,
      keywords: target.keywords,
      targetDomain: target.domain,
      titleKeywords: target.titleKeywords,
      browseAnchor: target.browseAnchor,
      pollWifi,
      rememberedWifis,
      clientId: target.clientId || null,
      taskId: crypto.randomUUID(),
    };
    if (target.maxResultPages != null) cfg.strategy = { maxResultPages: Number(target.maxResultPages) };
    if (target.anthropic) cfg.anthropic = target.anthropic;
    if (target.humanize) cfg.humanize = target.humanize;
    return buildTaskConfig(cfg);
  }

  // -------------------------------------------------------------------------
  // 推送 / 序列化
  // -------------------------------------------------------------------------

  _emitState(c) {
    if (this.io) {
      this.io.emit('campaign:state', this.getState());
    }
  }

  _publicState(c) {
    const rs = c.runState;
    // 进度总数按「启用站点」数（禁用站不参与本轮）。
    const enabledCount = (c.targets || []).filter((t) => t.enabled !== false).length;
    return {
      id: c.id,
      name: c.name,
      enabled: c.enabled,
      scheduleType: c.scheduleType,
      scheduleHour: c.scheduleHour,
      scheduleMinute: c.scheduleMinute,
      intervalHours: c.intervalHours,
      shuffle: c.shuffle,
      total: enabledCount,
      done: rs ? rs.done.length : 0,
      currentIndex: rs ? rs.currentIndex : null,
      currentTaskId: rs ? rs.currentTaskId : null,
      lastRunAt: c.lastRunAt,
      lastRunStatus: c.lastRunStatus,
      nextRunAt: c.nextRunAt,
    };
  }
}

/** 单例（主进程共享） */
const scheduler = new Scheduler();

module.exports = {
  Scheduler,
  scheduler,
  computeNextRun,
  shuffleArray,
  normalizeCampaignSpec,
  _setDeps: (d) => { DEPS = d; },
};
