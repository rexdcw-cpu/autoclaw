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
  // 定位目标时最多扫描的搜索结果页数（含首页）。目标若排在很靠后，逐页扫描到此
  // 上限即停，避免无限翻页拖慢任务。前端可配置，缺省 5 页。
  maxResultPages: num(process.env.AUTOCLAW_MAX_RESULT_PAGES, 5),
};

/**
 * 拟人微动作（humanize）：在每个关键步骤之间插入「随机思考停顿 + 随机微动作」，
 * 让连续操作更不可预测，降低被搜索引擎风控的概率。
 *
 * - 停顿时长 = randInt(minMs, maxMs) + randInt(0, jitterAmp)，每次随机。
 * - 微动作三选一（概率归一化）：移动鼠标 / 滚轮轻推 / 悬停或按键。
 * - 任何微动作失败都静默忽略，绝不影响主流程。
 */
const DEFAULT_HUMANIZE = {
  // 总开关
  enabled: (process.env.AUTOCLAW_HUMANIZE_ENABLED || 'true').toLowerCase() !== 'false',
  // 随机思考停顿下限（ms）
  minMs: num(process.env.AUTOCLAW_HUMANIZE_MIN, 800),
  // 随机思考停顿上限（ms）
  maxMs: num(process.env.AUTOCLAW_HUMANIZE_MAX, 2600),
  // 在 [minMs,maxMs] 之上再叠加的随机抖动上限（ms），使间隔更不可预测
  jitterAmp: num(process.env.AUTOCLAW_HUMANIZE_JITTER, 400),
  // 三类微动作的触发权重（内部归一化，不必和为 1）
  moveProb: num(process.env.AUTOCLAW_HUMANIZE_MOVE, 0.6),
  scrollProb: num(process.env.AUTOCLAW_HUMANIZE_SCROLL, 0.25),
  hoverProb: num(process.env.AUTOCLAW_HUMANIZE_HOVER, 0.15),
  // 滚轮轻推幅度（px，可正可负）
  wheelAmp: num(process.env.AUTOCLAW_HUMANIZE_WHEEL, 120),
  // 逐字符键入间隔（ms）：模拟真人打字节奏，替代「一次性灌值」的 isTrusted=false bot 特征
  typeDelayMin: num(process.env.AUTOCLAW_HUMANIZE_TYPE_MIN, 60),
  typeDelayMax: num(process.env.AUTOCLAW_HUMANIZE_TYPE_MAX, 200),
};

module.exports = {
  DEFAULT_ANTHROPIC,
  DEFAULT_STRATEGY,
  DEFAULT_HUMANIZE,
};
