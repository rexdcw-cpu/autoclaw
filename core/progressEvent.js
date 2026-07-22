'use strict';

/**
 * core/progressEvent.js
 * ---------------------------------------------------------------------------
 * 全工程统一的事件常量、错误码与 ProgressEvent 构造工具。
 *
 * - 枚举常量（EventType / StepName / StepStatus / TaskStatus / RunMode / RoundStatus）
 *   与架构设计 v0.1 第 3 节「关键类型约定」一致。
 * - 错误码（ERR_*）与架构设计 8.5 一致。
 * - splitTokens：关键词 / 标题关键词分隔（| 、 、 ,），供 taskConfig 与适配器复用。
 * - make*：构造 ProgressEvent / RoundState / StepState / ProgressStats 的纯函数。
 *
 * socket.io 推送的「progress」事件 payload 即本模块构造的 ProgressEvent 对象。
 */

// ---------------------------------------------------------------------------
// 枚举常量
// ---------------------------------------------------------------------------

/** 进度事件类型（EventType） */
const EventType = {
  ROUND_START: 'round_start',
  STEP: 'step',
  ROUND_END: 'round_end',
  TASK_END: 'task_end',
  PAUSED: 'paused',
  STOPPED: 'stopped',
  ALERT: 'alert',
  WIFI_POLL: 'wifi_poll', // WIFI 轮询进度（切换/停留/第几轮）
  TASK_STATS: 'task_stats', // 任务完成度统计与分析（v0.3.12）
};

/** 原子步骤名称（StepName） */
const StepName = {
  BOOT: 'boot', // ① 创建浏览器会话 + 健康检查（T1 新增）
  SEARCH: 'search', // 打开搜索页 + 输入关键词 + 提交
  OPEN: 'open', // ② 导航到搜索页（T3 拆分）
  FILL: 'fill', // ③ 输入并提交搜索词（T3 拆分）
  WAIT: 'wait', // ④ 等待并解析结果页（T4 拆分）
  LOCATE: 'locate', // 结果页双匹配定位目标站点
  ENTER: 'enter', // 点击进入目标站
  STAY: 'stay', // 目标页停留（拟人计时）
  BROWSE: 'browse', // 站内拟人浏览（找联系/关于 + 滚动）
  HUMAN: 'human', // 步骤间拟人微动作（随机停顿 + 随机微动作）
  CLOSE: 'close', // 关闭目标页，进入下一轮
};

/** 步骤状态（StepStatus） */
const StepStatus = {
  PENDING: 'pending',
  RUNNING: 'running',
  SUCCESS: 'success',
  FAILED: 'failed',
};

/** 任务整体状态（TaskStatus） */
const TaskStatus = {
  PENDING: 'pending',
  RUNNING: 'running',
  PAUSED: 'paused',
  STOPPED: 'stopped',
  COMPLETED: 'completed',
  FAILED: 'failed',
};

/** 多平台调度模式（RunMode） */
const RunMode = {
  SERIAL: 'serial',
  CONCURRENT: 'concurrent',
};

/** 单轮状态（RoundStatus） */
const RoundStatus = {
  RUNNING: 'running',
  SUCCESS: 'success',
  FAILED: 'failed',
  SKIPPED: 'skipped',
};

/** 错误码（ERR_*），与架构 8.5 一致 */
const ERR = {
  ERR_INVALID_CONFIG: 'ERR_INVALID_CONFIG',
  ERR_NO_TARGET: 'ERR_NO_TARGET',
  ERR_ADAPTER_FAIL: 'ERR_ADAPTER_FAIL',
  ERR_TIMEOUT: 'ERR_TIMEOUT',
  ERR_RETRY_EXHAUSTED: 'ERR_RETRY_EXHAUSTED',
  ERR_BROWSER_LAUNCH: 'ERR_BROWSER_LAUNCH',
  ERR_BAIDU_CAPTCHA: 'ERR_BAIDU_CAPTCHA', // 百度验证码未过/结果未加载（T0 新增，T4 落地 .code）
  ERR_TASK_NOT_FOUND: 'ERR_TASK_NOT_FOUND',
  ERR_TASK_RUNNING: 'ERR_TASK_RUNNING',
  ERR_DB_WRITE: 'ERR_DB_WRITE',
  ERR_DB_QUERY: 'ERR_DB_QUERY',
  ERR_CLIENT_NOT_FOUND: 'ERR_CLIENT_NOT_FOUND',
  ERR_CLIENT_HAS_TASKS: 'ERR_CLIENT_HAS_TASKS',
};

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

/** 当前 ISO 时间戳 */
function now() {
  return new Date().toISOString();
}

/**
 * 按 | 、 、 ,（含全角逗号 ，）拆分字符串为去空白的非空数组。
 * @param {string|Array<string>} raw
 * @returns {string[]}
 */
function splitTokens(raw) {
  if (Array.isArray(raw)) {
    return raw.map((s) => String(s).trim()).filter((s) => s.length > 0);
  }
  return String(raw || '')
    .split(/[|,，、]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// ---------------------------------------------------------------------------
// 构造器
// ---------------------------------------------------------------------------

/** 构造一条步骤状态（StepState） */
function makeStep(step, status, detail) {
  return {
    step: step,
    status: status,
    detail: detail || '',
    timestamp: now(),
  };
}

/** 构造一轮状态（RoundState） */
function makeRound(taskId, platform, keyword, roundIndex, totalRounds, status) {
  return {
    taskId: taskId,
    roundIndex: roundIndex,
    totalRounds: totalRounds,
    platform: platform,
    keyword: keyword,
    status: status,
    steps: [],
    startedAt: now(),
    finishedAt: null,
    error: null,
  };
}

/** 构造进度统计（ProgressStats） */
function makeStats(totalRounds, currentRound, successCount, failCount) {
  const done = successCount + failCount;
  const failRate = done > 0 ? failCount / done : 0;
  return {
    totalRounds: totalRounds,
    currentRound: currentRound,
    successCount: successCount,
    failCount: failCount,
    failRate: failRate,
  };
}

/**
 * 构造统一的 ProgressEvent。
 * @param {object} o
 * @param {string} o.taskId
 * @param {string} o.type        EventType
 * @param {object} [o.round]     RoundState
 * @param {object} [o.step]      StepState
 * @param {string} [o.message]   人类可读描述
 * @param {object} [o.stats]     ProgressStats
 * @param {string} [o.status]    任务整体终态（任务结束时携带：completed / failed）
 */
function makeProgress(o) {
  return {
    taskId: o.taskId,
    type: o.type,
    round: o.round || null,
    step: o.step || null,
    message: o.message || '',
    stats: o.stats || null,
    status: o.status || undefined,
    // v0.3.11 WIFI 轮询附加字段（透传，避免被裁剪）
    wifiIndex: o.wifiIndex != null ? o.wifiIndex : undefined,
    wifiTotal: o.wifiTotal != null ? o.wifiTotal : undefined,
    ssid: o.ssid || undefined,
    // 错误透传（worker 异常 / 步骤失败携带，供历史回查）
    error: o.error || undefined,
    errorCode: o.errorCode || undefined,
    timestamp: now(),
  };
}

module.exports = {
  EventType,
  StepName,
  StepStatus,
  TaskStatus,
  RunMode,
  RoundStatus,
  ERR,
  now,
  splitTokens,
  makeStep,
  makeRound,
  makeStats,
  makeProgress,
};
