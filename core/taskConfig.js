'use strict';

/**
 * core/taskConfig.js
 * ---------------------------------------------------------------------------
 * 任务配置解析与校验（TaskConfig）。由 routes/taskRoutes.js 在收到提交后调用。
 *
 * 职责：
 *   1. 解析并校验提交 payload（平台 / 关键词 / 目标站点 / 拟人参数 / 策略）。
 *   2. 关键词按 | 、 、 , 拆分；标题关键词同样拆分（决策 A1：必填，可多组）。
 *   3. 生成 RoundPlan[]（默认串行：百度跑完再跑谷歌，每个关键词各跑一遍）。
 *   4. 通过 crypto.randomUUID() 生成 taskId。
 *
 * 决策 A1：targetDomain + titleKeywords 为必填项；缺失抛 ERR_INVALID_CONFIG。
 * 表单为唯一数据源，DEFAULT_TARGET 仅作预填，不参与此处强校验逻辑。
 */

const crypto = require('crypto');
const { splitTokens, ERR, TaskStatus } = require('./progressEvent');
const { DEFAULT_TARGET, DEFAULT_ANTHROPIC, DEFAULT_STRATEGY, DEFAULT_HUMANIZE } = require('../config/site.config');

/** 平台固定顺序：保证串行时百度先于谷歌 */
const PLATFORM_ORDER = ['baidu', 'google'];
const VALID_PLATFORMS = new Set(PLATFORM_ORDER);

/**
 * 构造一个带 code 字段的配置错误，供路由层区分错误类型。
 * @param {string} message
 * @param {string} code ERR_*
 * @returns {Error}
 */
function configError(message, code) {
  const e = new Error(message);
  e.code = code;
  return e;
}

/**
 * 按固定顺序规整平台列表（去重 + 仅保留合法值 + 保持 baidu→google 顺序）。
 * @param {string[]} platforms
 * @returns {string[]}
 */
function orderPlatforms(platforms) {
  const seen = new Set();
  const ordered = [];
  for (const p of PLATFORM_ORDER) {
    if (platforms.includes(p) && !seen.has(p)) {
      seen.add(p);
      ordered.push(p);
    }
  }
  return ordered;
}

/**
 * 生成轮次计划：默认串行，按「平台 → 关键词」展开。
 * @param {string[]} platforms
 * @param {string[]} keywords
 * @returns {Array<{roundIndex:number,totalRounds:number,platform:string,keyword:string}>}
 */
function buildRounds(platforms, keywords) {
  const total = platforms.length * keywords.length;
  const rounds = [];
  let idx = 0;
  for (const platform of platforms) {
    for (const keyword of keywords) {
      rounds.push({
        roundIndex: idx,
        totalRounds: total,
        platform: platform,
        keyword: keyword,
      });
      idx += 1;
    }
  }
  return rounds;
}

/**
 * 解析并校验提交 payload，返回 TaskConfig。
 * @param {object} payload 前端提交体
 * @returns {object} TaskConfig
 * @throws {Error} 带 .code 的配置错误
 */
function buildTaskConfig(payload) {
  payload = payload || {};

  // --- 平台 ---
  const rawPlatforms = Array.isArray(payload.platforms)
    ? payload.platforms
    : payload.platform
      ? [payload.platform]
      : [];
  const platforms = orderPlatforms(rawPlatforms.filter((p) => VALID_PLATFORMS.has(p)));
  if (platforms.length === 0) {
    throw configError('至少需要选择一个平台（baidu / google）', ERR.ERR_INVALID_CONFIG);
  }

  // --- 关键词（必填，支持 | 、 、 , 分隔）---
  const keywords = splitTokens(payload.keywords);
  if (keywords.length === 0) {
    throw configError('搜索关键词不能为空（支持 | 、 、 , 分隔）', ERR.ERR_INVALID_CONFIG);
  }

  // --- 目标站点（决策 A1：必填）---
  const domain = String(payload.targetDomain || '').trim();
  const titleKeywords = splitTokens(payload.titleKeywords);
  // 目标页面锚点（站内浏览寻找的页）：可配置，缺省兜底「关于我们」
  const browseAnchor = String(payload.browseAnchor || '关于我们').trim() || '关于我们';
  if (!domain) {
    throw configError('targetDomain 为必填项', ERR.ERR_INVALID_CONFIG);
  }
  if (titleKeywords.length === 0) {
    throw configError('titleKeywords 为必填项（支持 | 、 、 , 分隔）', ERR.ERR_INVALID_CONFIG);
  }

  // --- 拟人参数（浅合并默认值，前端可覆盖）---
  const anthropic = Object.assign({}, DEFAULT_ANTHROPIC, sanitizeAnthropic(payload.anthropic));

  // --- 拟人微动作（步骤间随机停顿+随机动作，浅合并默认值）---
  const humanize = Object.assign({}, DEFAULT_HUMANIZE, sanitizeHumanize(payload.humanize));

  // --- 策略参数（浅合并默认值）---
  const strategy = Object.assign({}, DEFAULT_STRATEGY, sanitizeStrategy(payload.strategy));
  if (strategy.mode !== 'concurrent') {
    strategy.mode = 'serial'; // V1 仅支持串行，concurrent 预留
  }

  // --- 代理（F-18 入口落地）：归一化为 { httpProxy } 并校验 ---
  const proxy = sanitizeProxy(payload.proxy);

  // --- 客户归属（P0-9）：可选，缺省不关联 ---
  const clientId = payload.clientId || payload.client_id || null;

  // --- WIFI 轮询（v0.3.11）：勾选后任务跑完一轮流程自动切下一个可用 WIFI ---
  const pollWifi = !!payload.pollWifi;
  // 面板「已存」集合（前端从 localStorage 透传的 rememberedWifis）：
  // 即用户在 WiFi 面板里「记住密码」的 SSID，轮询严格只跑这些，
  // 与 Windows 全部历史已保存配置文件解耦，避免轮询早已搬走/信号外的网络。
  const rememberedWifis = Array.isArray(payload.rememberedWifis)
    ? payload.rememberedWifis.map(String).filter(Boolean)
    : [];
  // 隐藏网络白名单（v0.3.48）：用户在面板「添加隐藏 WiFi」显式加入并连通的 SSID。
  // 隐藏网络不广播 SSID、扫描永远不可见，轮询时需豁免可见性检查；
  // 而其余「已存但扫不到」的历史 profile（换地点后的旧网络）仍应被过滤掉，
  // 否则每轮都会白白尝试一堆连不上的网络（每个约 10s+），拖慢任务并刷屏日志。
  const hiddenWifis = Array.isArray(payload.hiddenWifis)
    ? payload.hiddenWifis.map(String).filter(Boolean)
    : [];

  const taskId = payload.taskId || crypto.randomUUID();
  const rounds = buildRounds(platforms, keywords);

  return {
    taskId: taskId,
    platforms: platforms,
    keywords: keywords,
    target: { domain: domain, titleKeywords: titleKeywords, browseAnchor: browseAnchor },
    anthropic: anthropic,
    humanize: humanize,
    strategy: strategy,
    proxy: proxy,
    clientId: clientId,
    pollWifi: pollWifi,
    rememberedWifis: rememberedWifis,
    hiddenWifis: hiddenWifis,
    createdAt: new Date().toISOString(),
    status: TaskStatus.PENDING,
    rounds: rounds,
  };
}

/** 仅保留合法的拟人数值字段 */
function sanitizeAnthropic(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  const keys = ['staySeconds', 'scrollUp', 'scrollDown', 'ampMin', 'ampMax', 'intervalMin', 'intervalMax'];
  for (const k of keys) {
    const v = Number(raw[k]);
    if (Number.isFinite(v) && raw[k] !== '' && raw[k] != null) out[k] = v;
  }
  return out;
}

/** 仅保留合法的拟人微动作字段（enabled 为布尔，其余为数值权重） */
function sanitizeHumanize(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  if (typeof raw.enabled === 'boolean') out.enabled = raw.enabled;
  const nums = ['minMs', 'maxMs', 'jitterAmp', 'moveProb', 'scrollProb', 'hoverProb', 'wheelAmp'];
  for (const k of nums) {
    const v = Number(raw[k]);
    if (Number.isFinite(v) && raw[k] !== '' && raw[k] != null) out[k] = v;
  }
  return out;
}

/** 仅保留合法的策略字段 */
function sanitizeStrategy(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  if (typeof raw.mode === 'string') out.mode = raw.mode;
  const nums = ['failRateThreshold', 'maxRetry', 'actionTimeoutMs', 'maxResultPages'];
  for (const k of nums) {
    const v = Number(raw[k]);
    if (Number.isFinite(v) && raw[k] !== '' && raw[k] != null) out[k] = v;
  }
  return out;
}

/**
 * 归一化代理配置为统一的 { httpProxy } 形状（供 browserSession.launch 注入）。
 * 兼容多种前端/API 输入写法：
 *   - 字符串 URL：'http://1.2.3.4:8080' → { httpProxy: 'http://1.2.3.4:8080' }
 *   - { httpProxy: '...' }            → 原样保留
 *   - { server: '...' }               → { httpProxy: '...' }（更常见的写法）
 *   - { proxy: '...' }                → { httpProxy: '...' }
 * 校验：必须是 http(s):// 或 socks(5):// 形式，否则抛 ERR_INVALID_CONFIG。
 * 空值（null/undefined/''/{}）返回 null，表示不走代理。
 * @param {string|object|null} raw
 * @returns {{httpProxy:string}|null}
 */
function sanitizeProxy(raw) {
  if (raw == null || raw === '') return null;

  let url = null;
  if (typeof raw === 'string') {
    url = raw.trim();
  } else if (typeof raw === 'object') {
    url = (raw.httpProxy || raw.server || raw.proxy || '').toString().trim();
    // 兼容 { httpProxy: '' } / { server: '' } 等空对象写法 → 视为不配置
    if (!url) return null;
  } else {
    return null;
  }

  if (!/^https?:\/\/.+/i.test(url) && !/^socks(5)?:\/\/.+/i.test(url)) {
    throw configError(
      'proxy 格式非法，需为 http(s):// 或 socks:// 开头的代理地址',
      ERR.ERR_INVALID_CONFIG,
    );
  }
  return { httpProxy: url };
}

module.exports = {
  buildTaskConfig,
  orderPlatforms,
  buildRounds,
  configError,
  DEFAULT_TARGET,
};
