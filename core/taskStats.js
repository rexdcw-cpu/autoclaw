'use strict';

/**
 * core/taskStats.js
 * ---------------------------------------------------------------------------
 * 任务完成度统计与分析（v0.3.12 新增）。
 *
 * 负责在「WIFI 轮询 / 单网络」任务跑完后，汇总每个 WIFI（或当前网络）的流程结果：
 *   - 总 WIFI 数、完成数、失败数、跳过数
 *   - 每个 WIFI 的流程尝试次数、重试次数、终态
 *   - 总体完成率、累计重试次数
 * 并提供 save() 把统计 + 分析持久化到磁盘：
 *   - data/task-stats-<taskId>.json      （单次任务结构化数据）
 *   - data/task-stats-<taskId>.md        （单次任务人类可读分析）
 *   - data/task-completion-stats.json    （滚动汇总日志，最多保留 200 条）
 *
 * 数据目录可被环境变量 AUTOCLAW_STATS_DIR 覆盖（便于单测落到临时目录）。
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_DATA_DIR = path.join(__dirname, '..', 'data');

function getDataDir() {
  return process.env.AUTOCLAW_STATS_DIR
    ? path.resolve(process.env.AUTOCLAW_STATS_DIR)
    : DEFAULT_DATA_DIR;
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/**
 * 新建一次统计运行容器。
 * @param {string} taskId
 * @param {{pollWifi?:boolean, startedAt?:string, keyword?:string, clientId?:string}} [meta]
 */
function newRun(taskId, meta) {
  meta = meta || {};
  return {
    taskId: taskId,
    platform: meta.platform || null, // 'baidu' | 'google' | null（分阶段后用于区分两份统计）
    startedAt: meta.startedAt || new Date().toISOString(),
    pollWifi: !!meta.pollWifi,
    keyword: meta.keyword || null,
    keywords: meta.keywords || null,
    clientId: meta.clientId || null,
    wifiSource: meta.wifiSource || null, // 'remembered' | 'fallback' | null
    vpn: null, // 谷歌任务前的 VPN 出口状态：{ availableCount, total, usedNode, proxyUrl, skipped }
    perWifi: [], // { ssid, status:'completed'|'failed'|'skipped', attempts, retriesUsed, error, via:'wifi'|'vpn', startedAt, endedAt, durationMs }
    summary: null,
    endedAt: null, // 本阶段（百度/谷歌）结束时间
    durationMs: null, // 本阶段总耗时（毫秒）
  };
}

/** 毫秒 → 可读时长 */
function fmtDur(ms) {
  if (ms == null) return '-';
  if (ms < 1000) return ms + ' ms';
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return h + '时' + m + '分' + s + '秒';
  if (m > 0) return m + '分' + s + '秒';
  return s + '秒';
}

/**
 * 记录 VPN 出口状态（谷歌任务前探测所得），落到本次运行容器。
 * @param {object} run newRun() 产物
 * @param {{availableCount:number, total:number, usedNode?:string, proxyUrl?:string, skipped?:boolean, error?:string}} vpn
 */
function recordVpn(run, vpn) {
  run.vpn = vpn || null;
}

/**
 * 追加一条单轮（WIFI / VPN 节点）结果记录。
 * @param {object} run newRun() 产物
 * @param {{ssid:?string, status:string, attempts:number, retriesUsed:number, error:?string, via?:string, startedAt?:?string, endedAt?:?string, durationMs?:?number, found?:boolean, landedUrl?:?string}} rec
 *   via: 'wifi'（百度按 WiFi 轮询）| 'vpn'（谷歌按 VPN 节点轮询），缺省 'wifi'
 *   durationMs: 该 WiFi/VPN 节点本轮流程耗时（毫秒），由 worker 在真实运行处打时间戳
 *   found: 该轮是否真正命中并进入目标站（SEO 关键成功信号，区别于「流程没崩」）
 *   landedUrl: ENTER 阶段实际 goto 的真实地址（命中时记录）
 */
function recordWifi(run, rec) {
  run.perWifi.push({
    ssid: rec.ssid != null ? rec.ssid : null,
    status: rec.status || 'skipped',
    attempts: rec.attempts || 0,
    retriesUsed: rec.retriesUsed || 0,
    via: rec.via || 'wifi',
    found: rec.found === true,
    landedUrl: rec.landedUrl || null,
    captcha: rec.captcha === true,
    error: rec.error || null,
    startedAt: rec.startedAt || null,
    endedAt: rec.endedAt || null,
    durationMs: rec.durationMs != null ? rec.durationMs : null,
  });
}

/**
 * 汇总分析。
 * @param {object} run
 * @returns {object} summary
 */
function summarize(run) {
  const total = run.perWifi.length;
  const completed = run.perWifi.filter((w) => w.status === 'completed').length;
  const failed = run.perWifi.filter((w) => w.status === 'failed').length;
  const skipped = run.perWifi.filter((w) => w.status === 'skipped').length;
  const totalAttempts = run.perWifi.reduce((s, w) => s + (w.attempts || 0), 0);
  const totalRetries = run.perWifi.reduce((s, w) => s + (w.retriesUsed || 0), 0);
  // 仅纳入有真实耗时的节点（skipped / 未记录耗时的 durationMs 为 null，不计入平均，避免被当 0 拉低均值）
  const nodeDurations = run.perWifi
    .filter((w) => w.durationMs != null)
    .map((w) => w.durationMs);
  const sumNodeDur = nodeDurations.reduce((s, d) => s + d, 0);
  const avgNodeDur = nodeDurations.length ? Math.round(sumNodeDur / nodeDurations.length) : 0;
  const foundCount = run.perWifi.filter((w) => w.found === true).length;
  const captchaCount = run.perWifi.filter((w) => w.captcha === true).length;

  run.summary = {
    totalWifi: total,
    completedWifi: completed,
    failedWifi: failed,
    skippedWifi: skipped,
    foundWifi: foundCount,
    captchaWifi: captchaCount,
    completionRate: total ? Math.round((completed / total) * 100) : 0,
    foundRate: total ? Math.round((foundCount / total) * 100) : 0,
    totalFlowAttempts: totalAttempts,
    totalRetries: totalRetries,
    totalDurationMs: (run.durationMs != null ? run.durationMs : null),
    avgNodeDurationMs: avgNodeDur,
    // 整体结论改为「完成率驱动」：全部完成且无跳过 → completed；
    // 否则按完成率分档——>=70%（与既有 30% 熔断阈值对齐）视为 partial，避免低失败率
    // （如 1/15≈93%）被旧逻辑「有 failed 即 failed」误判为 failed 而触发熔断；极低完成率 → failed。
    // 修复补跑 / 重试达标场景下整体结论失真的问题。
    overall: (completed === total && skipped === 0)
      ? 'completed'
      : (total > 0 && completed / total >= 0.7 ? 'partial' : 'failed'),
    vpn: run.vpn || null,
  };
  return run.summary;
}

/** 渲染人类可读的 Markdown 分析 */
function renderMarkdown(run) {
  const s = run.summary || summarize(run);
  const lines = [];
  const platformTag = run.platform ? ('（' + (run.platform === 'google' ? '谷歌' : '百度') + '）') : '';
  lines.push('# 任务完成度分析' + platformTag + ' — ' + run.taskId);
  lines.push('');
  lines.push('- 任务模式：' + (run.pollWifi
    ? (run.wifiSource === 'fallback'
        ? 'WIFI 轮询（兜底：可见且本机已存凭证）'
        : 'WIFI 轮询（面板『已存』集合遍历）')
    : '单网络（仅当前网络一次）'));
  const kw = (run.keywords && run.keywords.length)
    ? run.keywords.join('、')
    : (run.keyword || '(未指定)');
  lines.push('- 关键词：' + kw);
  lines.push('- 客户：' + (run.clientId || '(未指定)'));
  lines.push('- 开始时间：' + run.startedAt);
  lines.push('- 结束时间：' + (run.endedAt || (run.savedAt || '-')));
  lines.push('- 总耗时：' + fmtDur(run.durationMs != null ? run.durationMs : (run.startedAt && run.savedAt ? (Date.parse(run.savedAt) - Date.parse(run.startedAt)) : null)));
  lines.push('- 保存时间：' + (run.savedAt || new Date().toISOString()));
  lines.push('');
  lines.push('## 总体统计');
  lines.push('');
  lines.push('| 指标 | 数值 |');
  lines.push('| --- | --- |');
  lines.push('| 总 WIFI / 网络 | ' + s.totalWifi + ' |');
  lines.push('| 完成 | ' + s.completedWifi + ' |');
  lines.push('| 失败 | ' + s.failedWifi + ' |');
  lines.push('| 跳过（切换失败等） | ' + s.skippedWifi + ' |');
  lines.push('| 完成率 | ' + s.completionRate + '% |');
  lines.push('| 命中目标率（找到并进入目标站） | ' + s.foundRate + '%（' + s.foundWifi + '/' + s.totalWifi + '） |');
  if (run.platform === 'google') {
    lines.push('| 触发谷歌机器人验证 / 同意页拦截 | ' + s.captchaWifi + ' 个节点 |');
  }
  lines.push('| 流程总尝试次数 | ' + s.totalFlowAttempts + ' |');
  lines.push('| 累计重试次数 | ' + s.totalRetries + ' |');
  lines.push('| 阶段总耗时 | ' + fmtDur(s.totalDurationMs) + ' |');
  lines.push('| 单节点平均耗时 | ' + fmtDur(s.avgNodeDurationMs) + ' |');
  lines.push('| 整体结论 | ' + s.overall + ' |');
  lines.push('');

  // VPN 出口维度（仅当任务含谷歌且探测过主节点时记录）
  if (run.vpn) {
    const v = run.vpn;
    lines.push('## VPN 出口（谷歌任务）');
    lines.push('');
    if (v.skipped) {
      lines.push('- 状态：**跳过**（VPN 无可用主节点，已剔除超时/不可达项）');
      lines.push('- 主节点总数：' + (v.total != null ? v.total : '未知'));
      if (v.error) lines.push('- 原因：' + v.error);
    } else {
      lines.push('- 状态：已开启并走 VPN 出口');
      lines.push('- 主节点可用：' + (v.availableCount != null ? v.availableCount : '?') + ' / ' + (v.total != null ? v.total : '?'));
      let nodeLabel;
      let triedCount = null;
      if (Array.isArray(v.usedNodes) && v.usedNodes.length) {
        triedCount = v.usedNodes.length;
        nodeLabel = v.usedNodes.length <= 10
          ? v.usedNodes.join('、')
          : v.usedNodes.slice(0, 8).join('、') + ' …等共 ' + v.usedNodes.length + ' 个';
      } else {
        nodeLabel = (v.usedNode || (v.current || '未知'));
      }
      let nodeSuffix = '';
      if (v.usedCount != null && v.targetCount != null) {
        nodeSuffix = '（' + (triedCount != null ? '共尝试 ' + triedCount + ' 个，' : '') +
          '成功 ' + v.usedCount + ' / 目标 ' + v.targetCount + ' 个' +
          (v.usedCount < v.targetCount ? '，部分节点失败已自动换备选补跑' : '') + '）';
      }
      lines.push('- 选用节点：' + nodeLabel + nodeSuffix);
      lines.push('- 代理地址：' + (v.proxyUrl || '（未记录）'));
    }
    lines.push('');
  }

  const detailHeader = run.platform === 'google' ? '## 逐 VPN 节点明细' : '## 逐 WIFI 明细';
  lines.push(detailHeader);
  lines.push('');
  lines.push('| # | 网络 / VPN 节点 | 终态 | 命中目标 | 验证拦截 | 尝试次数 | 重试次数 | 耗时 | 备注 |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  run.perWifi.forEach((w, i) => {
    const name = w.ssid || (w.via === 'vpn' ? '当前节点' : '当前网络');
    const axisTag = w.via === 'vpn' ? '（VPN 节点）' : '';
    const foundMark = w.found ? '✅' : (w.status === 'completed' ? '⚠️未命中' : '—');
    const captchaMark = w.captcha ? '⚠️是' : '—';
    const note = w.error ? w.error : (w.status === 'completed' ? (w.retriesUsed > 0 ? ('含 ' + w.retriesUsed + ' 次重试后成功') : '一次成功') : '');
    const landed = w.landedUrl ? (' → ' + w.landedUrl) : '';
    lines.push('| ' + (i + 1) + ' | ' + name + axisTag + ' | ' + w.status + ' | ' + foundMark + ' | ' + captchaMark + ' | ' + w.attempts + ' | ' + w.retriesUsed + ' | ' + fmtDur(w.durationMs) + ' | ' + note + landed + ' |');
  });
  lines.push('');
  return lines.join('\n');
}

/**
 * 持久化统计与分析到磁盘。
 * @param {object} run
 * @param {string} [fileSuffix] 文件名后缀（分阶段时传 'baidu' / 'google'），避免两份统计互相覆盖
 * @returns {{perFile:string, mdFile:string, rollingFile:string}}
 */
function save(run, fileSuffix) {
  const dir = getDataDir();
  ensureDir(dir);
  // 阶段结束时间 + 总耗时（worker 若已打 endedAt 则沿用，否则以落盘时刻补齐）
  // 必须在 summarize 之前算好，summary.totalDurationMs 才能取到值
  if (!run.endedAt) run.endedAt = new Date().toISOString();
  if (run.durationMs == null && run.startedAt) {
    const parsed = Date.parse(run.endedAt) - Date.parse(run.startedAt);
    run.durationMs = parsed > 0 ? parsed : 0;
  }
  summarize(run);
  run.savedAt = new Date().toISOString();

  const suffix = fileSuffix ? '-' + fileSuffix : '';
  const perFile = path.join(dir, 'task-stats-' + run.taskId + suffix + '.json');
  const mdFile = path.join(dir, 'task-stats-' + run.taskId + suffix + '.md');
  const rollingFile = path.join(dir, 'task-completion-stats.json');

  fs.writeFileSync(perFile, JSON.stringify(run, null, 2), 'utf8');
  fs.writeFileSync(mdFile, renderMarkdown(run), 'utf8');

  let arr = [];
  if (fs.existsSync(rollingFile)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(rollingFile, 'utf8'));
      if (Array.isArray(parsed)) arr = parsed;
    } catch (e) {
      arr = [];
    }
  }
  arr.push({
    taskId: run.taskId,
    platform: run.platform || null,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    savedAt: run.savedAt,
    durationMs: run.durationMs,
    pollWifi: run.pollWifi,
    keyword: run.keyword,
    keywords: run.keywords,
    clientId: run.clientId,
    vpn: run.vpn || null,
    summary: run.summary,
  });
  if (arr.length > 200) arr = arr.slice(-200);
  fs.writeFileSync(rollingFile, JSON.stringify(arr, null, 2), 'utf8');

  return { perFile: perFile, mdFile: mdFile, rollingFile: rollingFile };
}

module.exports = {
  newRun,
  recordWifi,
  recordVpn,
  summarize,
  renderMarkdown,
  save,
  getDataDir,
};
