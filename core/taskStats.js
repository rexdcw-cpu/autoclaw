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
    startedAt: meta.startedAt || new Date().toISOString(),
    pollWifi: !!meta.pollWifi,
    keyword: meta.keyword || null,
    keywords: meta.keywords || null,
    clientId: meta.clientId || null,
    wifiSource: meta.wifiSource || null, // 'remembered' | 'fallback' | null
    perWifi: [], // { ssid, status:'completed'|'failed'|'skipped', attempts, retriesUsed, error }
    summary: null,
  };
}

/**
 * 追加一条单 WIFI 结果记录。
 * @param {object} run newRun() 产物
 * @param {{ssid:?string, status:string, attempts:number, retriesUsed:number, error:?string}} rec
 */
function recordWifi(run, rec) {
  run.perWifi.push({
    ssid: rec.ssid != null ? rec.ssid : null,
    status: rec.status || 'skipped',
    attempts: rec.attempts || 0,
    retriesUsed: rec.retriesUsed || 0,
    error: rec.error || null,
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

  run.summary = {
    totalWifi: total,
    completedWifi: completed,
    failedWifi: failed,
    skippedWifi: skipped,
    completionRate: total ? Math.round((completed / total) * 100) : 0,
    totalFlowAttempts: totalAttempts,
    totalRetries: totalRetries,
    overall: failed === 0 && skipped === 0 ? 'completed' : (failed > 0 ? 'failed' : 'partial'),
  };
  return run.summary;
}

/** 渲染人类可读的 Markdown 分析 */
function renderMarkdown(run) {
  const s = run.summary || summarize(run);
  const lines = [];
  lines.push('# 任务完成度分析 — ' + run.taskId);
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
  lines.push('| 流程总尝试次数 | ' + s.totalFlowAttempts + ' |');
  lines.push('| 累计重试次数 | ' + s.totalRetries + ' |');
  lines.push('| 整体结论 | ' + s.overall + ' |');
  lines.push('');
  lines.push('## 逐 WIFI 明细');
  lines.push('');
  lines.push('| # | WIFI / 网络 | 终态 | 尝试次数 | 重试次数 | 备注 |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  run.perWifi.forEach((w, i) => {
    const name = w.ssid || '当前网络';
    const note = w.error ? w.error : (w.status === 'completed' ? (w.retriesUsed > 0 ? ('含 ' + w.retriesUsed + ' 次重试后成功') : '一次成功') : '');
    lines.push('| ' + (i + 1) + ' | ' + name + ' | ' + w.status + ' | ' + w.attempts + ' | ' + w.retriesUsed + ' | ' + note + ' |');
  });
  lines.push('');
  return lines.join('\n');
}

/**
 * 持久化统计与分析到磁盘。
 * @param {object} run
 * @returns {{perFile:string, mdFile:string, rollingFile:string}}
 */
function save(run) {
  const dir = getDataDir();
  ensureDir(dir);
  summarize(run);
  run.savedAt = new Date().toISOString();

  const perFile = path.join(dir, 'task-stats-' + run.taskId + '.json');
  const mdFile = path.join(dir, 'task-stats-' + run.taskId + '.md');
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
    startedAt: run.startedAt,
    savedAt: run.savedAt,
    pollWifi: run.pollWifi,
    keyword: run.keyword,
    keywords: run.keywords,
    clientId: run.clientId,
    summary: run.summary,
  });
  if (arr.length > 200) arr = arr.slice(-200);
  fs.writeFileSync(rollingFile, JSON.stringify(arr, null, 2), 'utf8');

  return { perFile: perFile, mdFile: mdFile, rollingFile: rollingFile };
}

module.exports = {
  newRun,
  recordWifi,
  summarize,
  renderMarkdown,
  save,
  getDataDir,
};
