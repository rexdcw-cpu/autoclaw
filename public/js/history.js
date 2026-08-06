'use strict';

/**
 * public/js/history.js
 * ---------------------------------------------------------------------------
 * 任务历史页逻辑（原生 JS，无构建）。
 *   - GET /api/task/history-all 拉取「全部执行过的任务」（DB ∪ JSON，去重）。
 *   - 关键词 / 状态筛选。
 *   - 点击「详情」→ GET /api/task/detail 渲染：任务配置、完成度摘要卡片、
 *     逐节点（perWifi）明细表、运行记录时间线、Markdown 报告。
 */

(function () {
  var TOKEN_KEY = 'autoclaw_token';
  var token = localStorage.getItem(TOKEN_KEY) || 'autoclaw-dev';

  var $search = document.getElementById('filter-search');
  var $status = document.getElementById('filter-status');
  var $refresh = document.getElementById('refresh-btn');
  var $count = document.getElementById('list-count');
  var $tbody = document.getElementById('task-tbody');
  var $detail = document.getElementById('detail');
  var $detailTitle = document.getElementById('detail-title');
  var $detailBody = document.getElementById('detail-body');
  var $detailClose = document.getElementById('detail-close');

  var ALL = []; // 全量列表（用于前端筛选）

  // ---- 工具 ----
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  var STATUS_LABEL = {
    pending: '等待中',
    running: '运行中',
    paused: '已暂停',
    stopped: '已停止',
    completed: '已完成',
    failed: '已失败',
  };

  function statusClass(status) {
    return 'status-' + (status || 'pending');
  }

  function fmtDur(ms) {
    if (ms == null) return '—';
    var n = Number(ms);
    if (isNaN(n)) return '—';
    if (n < 1000) return n + 'ms';
    var totalSec = Math.floor(n / 1000);
    var h = Math.floor(totalSec / 3600);
    var m = Math.floor((totalSec % 3600) / 60);
    var s = totalSec % 60;
    if (h > 0) return h + '时' + m + '分' + s + '秒';
    if (m > 0) return m + '分' + s + '秒';
    return s + '秒';
  }

  function fmtSummaryVal(key, v) {
    if (v == null) return '—';
    if (/rate/i.test(key)) {
      // 后端存的是 0–100 整数百分比（taskStats.js: completionRate/foundRate 已 ×100），此处不再乘 100
      var r = Number(v);
      if (isNaN(r)) return v;
      return r.toFixed(0) + '%';
    }
    if (/durationms|duration_ms|ms$/i.test(key)) return fmtDur(v);
    return String(v);
  }

  function fmtSummaryKey(key) {
    var map = {
      totalWifi: '总节点/网络',
      completedWifi: '完成',
      failedWifi: '失败',
      skippedWifi: '跳过',
      foundWifi: '命中',
      captchaWifi: '验证码节点',
      completionRate: '完成率',
      foundRate: '命中率',
      totalFlowAttempts: '总流程尝试',
      totalRetries: '总重试',
      totalDurationMs: '总耗时',
      avgNodeDurationMs: '平均节点耗时',
      overall: '整体',
    };
    return map[key] || key;
  }

  function stepBadge(status) {
    if (status === 'success') return '<span class="badge ok">OK</span>';
    if (status === 'failed') return '<span class="badge fail">FAIL</span>';
    if (status === 'running') return '<span class="badge run">RUN</span>';
    return '<span class="badge">·</span>';
  }

  // ---- 拉取列表 ----
  function fetchHistory() {
    $count.textContent = '加载中…';
    fetch('/api/task/history-all?limit=500', { headers: { 'x-autoclaw-token': token } })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d || d.code !== 0 || !d.data || !d.data.list) {
          $count.textContent = '加载失败：' + ((d && d.message) || '未知错误');
          return;
        }
        ALL = d.data.list || [];
        renderTable();
      })
      .catch(function (e) {
        $count.textContent = '网络错误：' + e.message;
      });
  }

  // ---- 筛选 + 渲染表格 ----
  function renderTable() {
    var q = ($search.value || '').trim().toLowerCase();
    var st = ($status.value || '').trim();
    var rows = ALL.filter(function (it) {
      if (st && (it.status || '') !== st) return false;
      if (!q) return true;
      var hay = [
        it.taskId || '',
        (Array.isArray(it.keywords) ? it.keywords.join(' ') : (it.keywords || '')),
        it.targetDomain || '',
      ].join(' ').toLowerCase();
      return hay.indexOf(q) !== -1;
    });

    $count.textContent = '共 ' + ALL.length + ' 个任务' + (rows.length !== ALL.length ? '，筛选后 ' + rows.length + ' 个' : '');

    if (rows.length === 0) {
      $tbody.innerHTML = '<tr><td colspan="7" class="muted">无匹配任务</td></tr>';
      return;
    }

    var html = '';
    rows.forEach(function (it) {
      var kw = Array.isArray(it.keywords) ? it.keywords.join('|') : (it.keywords || '');
      if (kw.length > 36) kw = kw.slice(0, 36) + '…';
      var platforms = Array.isArray(it.platforms) && it.platforms.length ? it.platforms.join('/') : '—';
      var dom = it.targetDomain || '—';
      var src = it.source === 'json' ? 'JSON' : 'DB';
      html +=
        '<tr data-tid="' + escapeHtml(it.taskId) + '">' +
        '<td>' + escapeHtml((it.createdAt || '').slice(0, 19) || '—') + '</td>' +
        '<td><span class="' + statusClass(it.status) + '">' + escapeHtml(STATUS_LABEL[it.status] || it.status || '—') + '</span></td>' +
        '<td>' + escapeHtml(platforms) + '</td>' +
        '<td>' + escapeHtml(kw) + '</td>' +
        '<td>' + escapeHtml(dom) + '</td>' +
        '<td>' + escapeHtml(src) + '</td>' +
        '<td><button type="button" class="link-btn small" data-detail="' + escapeHtml(it.taskId) + '">详情</button></td>' +
        '</tr>';
    });
    $tbody.innerHTML = html;
  }

  // ---- 拉取并渲染详情 ----
  function fetchDetail(taskId) {
    $detail.hidden = false;
    $detailTitle.textContent = '任务详情 · ' + taskId;
    $detailBody.innerHTML = '<p class="hint">加载中…</p>';
    $detail.scrollIntoView({ behavior: 'smooth', block: 'start' });

    fetch('/api/task/detail?taskId=' + encodeURIComponent(taskId), { headers: { 'x-autoclaw-token': token } })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d || d.code !== 0 || !d.data) {
          $detailBody.innerHTML = '<p class="error-text">查询失败：' + escapeHtml((d && d.message) || '未知错误') + '</p>';
          return;
        }
        renderDetail(d.data);
      })
      .catch(function (e) {
        $detailBody.innerHTML = '<p class="error-text">网络错误：' + escapeHtml(e.message) + '</p>';
      });
  }

  function renderDetail(data) {
    var cfg = data.config || {};
    var parts = [];

    // 头部操作
    var headExtra = '';
    if (cfg.status === 'running' || cfg.status === 'pending') {
      headExtra = '<a class="btn-link" href="/progress.html?taskId=' + encodeURIComponent(data.taskId) + '">查看实时进度 →</a>';
    }

    // 1) 配置
    var kw = Array.isArray(cfg.keywords) ? cfg.keywords.join(' | ') : (cfg.keywords || '—');
    var tk = Array.isArray(cfg.titleKeywords) ? cfg.titleKeywords.join(' | ') : (cfg.titleKeywords || '—');
    var a = cfg.anthropic || {};
    var proxy = cfg.proxy ? (cfg.proxy.httpProxy || cfg.proxy.server || cfg.proxy.proxy || JSON.stringify(cfg.proxy)) : '—';
    var configHtml =
      '<div class="summary-card">' +
      '<div class="summary-card-head"><h3>任务配置</h3>' + headExtra + '</div>' +
      '<div class="summary-grid">' +
      cell('平台', Array.isArray(cfg.platforms) && cfg.platforms.length ? cfg.platforms.join('/') : '—') +
      cell('目标域名', cfg.targetDomain || '—') +
      cell('状态', STATUS_LABEL[cfg.status] || cfg.status || '—') +
      cell('来源', cfg.source === 'json' ? '仅落盘 JSON' : '数据库') +
      cell('客户端', cfg.clientId || '—') +
      cell('创建时间', (cfg.createdAt || '').slice(0, 19) || '—') +
      cell('停留(秒)', a.staySeconds != null ? a.staySeconds : '—') +
      cell('上/下滑', (a.scrollUp != null ? a.scrollUp : '—') + ' / ' + (a.scrollDown != null ? a.scrollDown : '—')) +
      cell('幅度(px)', (a.ampMin != null ? a.ampMin : '—') + '~' + (a.ampMax != null ? a.ampMax : '—')) +
      cell('间隔(秒)', (a.intervalMin != null ? a.intervalMin : '—') + '~' + (a.intervalMax != null ? a.intervalMax : '—')) +
      cell('模式', cfg.runMode || '—') +
      cell('代理', proxy) +
      '</div>' +
      '<p class="hint">关键词：' + escapeHtml(kw) + '</p>' +
      '<p class="hint">标题关键词：' + escapeHtml(tk) + '</p>' +
      '</div>';
    parts.push(configHtml);

    // 2) 完成度摘要（on-disk task-stats）
    var statsFiles = data.statsFiles || [];
    if (statsFiles.length === 0) {
      parts.push('<div class="summary-card"><p class="hint">无落盘完成度摘要（可能是运行中任务，或早期无统计文件）。</p></div>');
    } else {
      statsFiles.forEach(function (sf) {
        var platform = sf.platform || '汇总';
        var j = sf.json || {};
        var summary = j.summary || {};
        var perWifi = j.perWifi || [];
        var summaryCells = '';
        Object.keys(summary).forEach(function (k) {
          if (k === 'vpn') return; // VPN 信息单独处理
          summaryCells += cell(fmtSummaryKey(k), fmtSummaryVal(k, summary[k]));
        });
        var vpnTxt = summary.vpn
          ? ('可用 ' + (summary.vpn.availableCount != null ? summary.vpn.availableCount : '?') + ' / 共 ' + (summary.vpn.total != null ? summary.vpn.total : '?') + '，出口 ' + (summary.vpn.usedNode || '—'))
          : '—';
        summaryCells += cell('VPN 出口', vpnTxt);

        var perHtml = perWifi.length
          ? renderPerWifi(perWifi)
          : '<p class="hint">无逐节点明细。</p>';

        parts.push(
          '<div class="summary-card">' +
          '<div class="summary-card-head"><h3>' + escapeHtml(platform.toUpperCase()) + ' 完成度</h3>' +
          '<span class="summary-card-platform">耗时 ' + fmtDur(j.durationMs) + '</span></div>' +
          '<div class="summary-grid">' + summaryCells + '</div>' +
          perHtml +
          '</div>'
        );
      });
    }

    // 3) 运行记录时间线（task_run_log）
    var runLog = data.runLog || [];
    var stats = data.stats || { total: 0, success: 0, fail: 0, failRate: 0 };
    var logHtml = '<div class="summary-card"><div class="summary-card-head"><h3>运行记录时间线</h3>' +
      '<span class="summary-card-platform">共 ' + (stats.total || 0) + ' · 成功 ' + (stats.success || 0) + ' · 失败 ' + (stats.fail || 0) + ' · 失败率 ' + (((stats.failRate || 0) * 100).toFixed(0)) + '%</span></div>';
    if (runLog.length === 0) {
      logHtml += '<p class="hint">无运行记录时间线（该任务运行于「仅落盘」时期，未写数据库运行日志）。</p>';
    } else {
      logHtml += '<div class="log-area" style="height:320px">';
      runLog.forEach(function (row) {
        var cls = '';
        if (row.stepStatus === 'failed') cls = 'line-fail';
        else if (row.stepStatus === 'success') cls = 'line-ok';
        var roundTxt = row.round != null ? '第' + (row.round + 1) + '轮 ' : '';
        var stepTxt = row.step ? (STEP_LABEL[row.step] || row.step) + ' ' : '';
        var statusTxt = row.stepStatus ? stepBadge(row.stepStatus) + ' ' : '';
        var msg = row.message ? ' · ' + escapeHtml(row.message) : '';
        var err = row.error ? ' ⚠ ' + escapeHtml(row.error) : '';
        logHtml += '<div class="log-line' + (cls ? ' ' + cls : '') + '">' +
          '<span class="t">' + escapeHtml(row.timestamp) + '</span> ' + roundTxt + statusTxt + stepTxt + msg + err + '</div>';
      });
      logHtml += '</div>';
    }
    logHtml += '</div>';
    parts.push(logHtml);

    // 4) Markdown 报告
    var reports = data.reports || [];
    if (reports.length) {
      var repHtml = '<div class="summary-card"><div class="summary-card-head"><h3>执行报告</h3></div>';
      reports.forEach(function (rp) {
        if (rp.platform) repHtml += '<p class="hint">' + escapeHtml(rp.platform.toUpperCase()) + ' 报告</p>';
        repHtml += '<pre class="report-pre">' + escapeHtml(rp.md) + '</pre>';
      });
      repHtml += '</div>';
      parts.push(repHtml);
    }

    $detailBody.innerHTML = parts.join('');
  }

  function cell(label, val) {
    return '<div class="summary-cell"><span class="sc-label">' + escapeHtml(label) + '</span>' +
      '<span class="sc-val">' + escapeHtml(val) + '</span></div>';
  }

  // 逐节点明细表（根据数据自适应列）
  function renderPerWifi(perWifi) {
    if (!perWifi.length) return '';
    var first = perWifi[0] || {};
    var cols = [];
    if ('ssid' in first || 'node' in first) cols.push('node');
    if ('status' in first) cols.push('status');
    if ('found' in first) cols.push('found');
    if ('landedUrl' in first) cols.push('landedUrl');
    if ('captcha' in first) cols.push('captcha');
    if ('via' in first) cols.push('via');
    if ('attempts' in first) cols.push('attempts');
    if ('retriesUsed' in first) cols.push('retriesUsed');
    if ('durationMs' in first) cols.push('durationMs');
    if ('error' in first) cols.push('error');

    var head = '<tr>' + cols.map(function (c) {
      var label = { node: '节点/SSID', status: '状态', found: '命中', landedUrl: '落地URL', captcha: '验证码', via: '出口', attempts: '尝试', retriesUsed: '重试', durationMs: '耗时', error: '错误' }[c] || c;
      return '<th>' + label + '</th>';
    }).join('') + '</tr>';

    var body = perWifi.map(function (row) {
      return '<tr>' + cols.map(function (c) {
        var v = row[c];
        if (c === 'node') v = row.ssid || row.node || '—';
        if (c === 'status') return '<td>' + (v === 'completed' ? '<span class="badge ok">完成</span>' : v === 'failed' ? '<span class="badge fail">失败</span>' : v === 'skipped' ? '<span class="badge skip">跳过</span>' : escapeHtml(v)) + '</td>';
        if (c === 'found') return '<td>' + (v ? '✓' : '—') + '</td>';
        if (c === 'captcha') return '<td>' + (v ? '⚠' : '—') + '</td>';
        if (c === 'durationMs') return '<td>' + fmtDur(v) + '</td>';
        if (c === 'error') return '<td class="err">' + escapeHtml(v || '—') + '</td>';
        return '<td>' + escapeHtml(v == null ? '—' : v) + '</td>';
      }).join('') + '</tr>';
    }).join('');

    return '<table class="summary-table"><thead>' + head + '</thead><tbody>' + body + '</tbody></table>';
  }

  // ---- 事件 ----
  $tbody.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-detail]');
    if (btn) fetchDetail(btn.getAttribute('data-detail'));
  });
  if ($search) $search.addEventListener('input', renderTable);
  if ($status) $status.addEventListener('change', renderTable);
  if ($refresh) $refresh.addEventListener('click', fetchHistory);
  if ($detailClose) $detailClose.addEventListener('click', function () { $detail.hidden = true; });

  // STEP_LABEL（与 progress.js 对齐，用于时间线步骤本地化）
  var STEP_LABEL = {
    search: '搜索',
    locate: '定位',
    enter: '进入',
    stay: '停留',
    browse: '浏览',
    human: '拟人',
    close: '关闭',
    vpn_on: '步骤1·开启VPN',
  };

  fetchHistory();
})();
