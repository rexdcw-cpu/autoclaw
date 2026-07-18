'use strict';

/**
 * config/defaults.js
 * ---------------------------------------------------------------------------
 * 拟人动作（anthropic）与执行策略（strategy）的默认值。
 *
 * - anthropic：控制进入目标站后的「停留 + 站内拟人浏览」参数。
 * - strategy ：控制任务执行顺序、容错与熔断阈值。
 *
 * 所有数值均支持通过 AUTOCLAW_ 前缀的环境变量覆盖（部署侧调参无需改代码）。
 * 表单提交的 payload 中的 anthropic / strategy 会在此默认值基础上做浅合并覆盖。
 */

/**
 * 解析数值型环境变量，缺失或非数字时回退到默认值。
 * @param {string|undefined} raw
 * @param {number} fallback
 * @returns {number}
 */
function num(raw, fallback) {
  const v = Number(raw);
  return Number.isFinite(v) && raw !== '' && raw != null ? v : fallback;
}

const DEFAULT_ANTHROPIC = {
  // 目标页停留秒数（固定值，同任务内每轮相同，运行时加入 ±20% 抖动）
  staySeconds: num(process.env.AUTOCLAW_STAY_SECONDS, 15),
  // 站内上滑次数
  scrollUp: num(process.env.AUTOCLAW_SCROLL_UP, 3),
  // 站内下滑次数
  scrollDown: num(process.env.AUTOCLAW_SCROLL_DOWN, 3),
  // 单次滚动幅度下限（px）
  ampMin: num(process.env.AUTOCLAW_AMP_MIN, 300),
  // 单次滚动幅度上限（px）
  ampMax: num(process.env.AUTOCLAW_AMP_MAX, 800),
  // 两次滚动之间的间隔下限（秒）
  intervalMin: num(process.env.AUTOCLAW_INTERVAL_MIN, 1),
  // 两次滚动之间的间隔上限（秒）
  intervalMax: num(process.env.AUTOCLAW_INTERVAL_MAX, 2),
};

const DEFAULT_STRATEGY = {
  // 多平台调度模式：'serial'（V1 默认，百度跑完再跑谷歌）| 'concurrent'（预留）
  mode: process.env.AUTOCLAW_MODE || 'serial',
  // 整任务失败率阈值（> 该值触发熔断，默认 0.3 = 30%）
  failRateThreshold: num(process.env.AUTOCLAW_FAIL_RATE, 0.3),
  // 单动作最大重试次数（默认 2）
  maxRetry: num(process.env.AUTOCLAW_MAX_RETRY, 2),
  // 单动作超时（毫秒，默认 150000）。
  // 注：baiduAdapter.search() 步骤 D 会在提交后轮询等待结果/验证码（上限 120000ms），
  // 外层需留足余量，否则 search 会在 30s 被 withTimeout 提前干掉、永远到不了验证码轮询逻辑。
  actionTimeoutMs: num(process.env.AUTOCLAW_ACTION_TIMEOUT, 150000),
};

module.exports = {
  DEFAULT_ANTHROPIC,
  DEFAULT_STRATEGY,
};
