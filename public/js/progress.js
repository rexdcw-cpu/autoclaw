'use strict';

/**
 * public/js/progress.js
 * ---------------------------------------------------------------------------
 * 进度看板逻辑（原生 JS，无构建）。
 *   - socket.io 实时接收 progress / task:state / alert（决策 A3：auth.token 鉴权）。
 *   - connect_error 时降级为每 2s 轮询 GET /api/task/progress（携带 x-autoclaw-token）。
 *   - 渲染头部状态（轮次/状态/失败率）与实时日志。
 *   - 熔断/终态时显示告警横幅与「重新提交」入口；无「继续」按钮（决策 A4）。
 */

(function () {
  var TOKEN_KEY = 'autoclaw_token';
  var POLL_INTERVAL = 2000;

  var taskId = new URLSearchParams(location.search).get('taskId');
  var token = localStorage.getItem(TOKEN_KEY) || 'autoclaw-dev';

  var $status = document.getElementById('status');
  var $round = document.getElementById('round');
  var $platform = document.getElementById('platform');
  var $failrate = document.getElementById('failrate');
  var $log = document.getElementById('log');
  var $alert = document.getElementById('alert-banner');
  var $conn = document.getElementById('conn-state');
  var $taskId = document.getElementById('task-id');
  var $pause = document.getElementById('pause-btn');
  var $stop = document.getElementById('stop-btn');
  var $resubmit = document.getElementById('resubmit-link');
  var $wifiPoll = document.getElementById('wifi-poll');
  var $summary = document.getElementById('task-summary');

  $taskId.textContent = taskId || '—';

  if (!taskId) {
    $conn.textContent = '缺少 taskId';
    return;
  }

  var renderedCount = 0;
  var pollTimer = null;
  // 去重：socket 实时流与初始回填轮询可能短暂重叠，同一事件时间戳唯一
  var seenKeys = {};

  // ----- 头部/状态 -----
  var STEP_LABEL = {
    search: '搜索',
    locate: '定位',
    enter: '进入',
    stay: '停留',
    browse: '浏览',
    human: '拟人',
    close: '关闭',
  };
  var STATUS_LABEL = {
    pending: '等待中',
    running: '运行中',
    paused: '已暂停',
    stopped: '已停止',
    completed: '已完成',
    failed: '已失败(熔断)',
  };

  function isTerminal(status) {
    return status === 'completed' || status === 'failed' || status === 'stopped' || status === 'paused';
  }

  function updateStatus(status) {
    $status.textContent = STATUS_LABEL[status] || status || '—';
    $status.className = 'stat-value status-' + (status || 'pending');
    if (isTerminal(status)) {
      $pause.hidden = true;
      $stop.hidden = true;
      $resubmit.hidden = false;
    } else {
      $pause.hidden = false;
      $stop.hidden = false;
      $resubmit.hidden = true;
    }
  }

  function updateStats(stats) {
    if (!stats) return;
    // 注意：轮次显示由事件自带的 round 驱动（反映进行中的轮次），此处只更新失败率
    var pct = ((stats.failRate || 0) * 100).toFixed(0);
    $failrate.textContent = pct + '% (' + (stats.failCount || 0) + '/' + (stats.successCount + stats.failCount) + ')';
  }

  // ----- 日志渲染 -----
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function stepBadge(status) {
    if (status === 'success') return '<span class="badge ok">OK</span>';
    if (status === 'failed') return '<span class="badge fail">FAIL</span>';
    if (status === 'running') return '<span class="badge run">RUN</span>';
    return '<span class="badge">·</span>';
  }

  function appendLine(html, cls) {
    var div = document.createElement('div');
    div.className = 'log-line' + (cls ? ' ' + cls : '');
    div.innerHTML = html;
    $log.appendChild(div);
    $log.scrollTop = $log.scrollHeight;
  }

  function renderEvent(ev) {
    if (!ev) return;
    // 去重：同一事件（type+timestamp）只渲染一次
    var key = ev.type + '|' + ev.timestamp;
    if (seenKeys[key]) return;
    seenKeys[key] = true;

    var type = ev.type;

    // 头部轮次显示：以事件自带的 round 为准（反映进行中的轮次）
    if (ev.round) {
      $round.textContent = ev.round.roundIndex + 1 + ' / ' + ev.round.totalRounds;
    }

    if (type === 'round_start' && ev.round) {
      var r = ev.round;
      $platform.textContent = r.platform || '—';
      $round.textContent = r.roundIndex + 1 + ' / ' + r.totalRounds;
      appendLine(
        '<span class="t">' + escapeHtml(ev.timestamp) + '</span> ▶ 第 ' +
          (r.roundIndex + 1) + '/' + r.totalRounds + ' 轮 · <b>' + escapeHtml(r.platform) +
          '</b> · 「' + escapeHtml(r.keyword) + '」',
        'line-round',
      );
    } else if (type === 'step' && ev.step) {
      var s = ev.step;
      var label = STEP_LABEL[s.step] || s.step;
      appendLine(
        '<span class="t">' + escapeHtml(ev.timestamp) + '</span> ' +
          stepBadge(s.status) + ' ' + label + (s.detail ? ' · ' + escapeHtml(s.detail) : ''),
        s.status === 'failed' ? 'line-fail' : '',
      );
    } else if (type === 'round_end' && ev.round) {
      var re = ev.round;
      appendLine(
        '<span class="t">' + escapeHtml(ev.timestamp) + '</span> — 第 ' + (re.roundIndex + 1) + '/' +
          re.totalRounds + ' 轮 结束: <b>' + (re.status === 'success' ? '成功' : '失败') + '</b>' +
          (re.error ? ' (' + escapeHtml(re.error) + ')' : ''),
        re.status === 'success' ? 'line-ok' : 'line-fail',
      );
    } else if (type === 'wifi_poll') {
      if ($wifiPoll && ev.wifiTotal) {
        $wifiPoll.textContent = (ev.wifiIndex || 0) + ' / ' + ev.wifiTotal;
      }
      appendLine(
        '<span class="t">' + escapeHtml(ev.timestamp) + '</span> 🔄 ' + escapeHtml(ev.message),
        'line-round',
      );
    } else if (type === 'alert') {
      showAlert(ev.message);
      appendLine('<span class="t">' + escapeHtml(ev.timestamp) + '</span> ⚠ ' + escapeHtml(ev.message), 'line-alert');
    } else if (type === 'task_end') {
      appendLine(
        '<span class="t">' + escapeHtml(ev.timestamp) + '</span> ■ 任务结束: <b>' +
          (STATUS_LABEL[ev.status] || ev.status) + '</b>',
        'line-round',
      );
    } else if (type === 'task_stats') {
      renderSummary(ev);
    }

    // 仅对「逐步成功率」统计更新失败率；task_stats 的 summary 是 WIFI 维度，字段不同，不能误用
    if (ev.stats && ev.stats.failRate != null) updateStats(ev.stats);
  }

  // ----- 任务完成度总结卡片（task_stats 事件触发）-----
  function summaryCell(label, val) {
    return '<div class="summary-cell"><span class="sc-label">' + escapeHtml(label) +
      '</span><span class="sc-val">' + escapeHtml(String(val == null ? '' : val)) + '</span></div>';
  }

  function renderSummary(ev) {
    if (!$summary) return;
    var s = ev.stats || (ev.statsDetail && ev.statsDetail.summary);
    if (!s) return;
    var detail = ev.statsDetail;
    var perWifi = (detail && detail.perWifi) || [];
    var rate = s.completionRate != null ? s.completionRate
      : (s.totalWifi ? Math.round((s.completedWifi / s.totalWifi) * 100) : 0);
    var rows = perWifi.map(function (w, i) {
      var st = w.status === 'completed' ? 'ok' : (w.status === 'failed' ? 'fail' : 'skip');
      var stTxt = w.status === 'completed' ? '完成'
        : (w.status === 'failed' ? '失败' : (w.status === 'skipped' ? '跳过' : (w.status || '—')));
      return '<tr><td>' + (i + 1) + '</td><td>' + escapeHtml(w.ssid) + '</td>' +
        '<td><span class="badge ' + st + '">' + stTxt + '</span></td>' +
        '<td>' + (w.attempts || 1) + '</td><td>' + (w.retriesUsed || 0) + '</td>' +
        (w.error ? '<td class="err">' + escapeHtml(w.error) + '</td>' : '<td class="muted">—</td>') + '</tr>';
    }).join('');
    $summary.hidden = false;
    $summary.innerHTML =
      '<div class="log-head"><h2>📊 任务完成度总结</h2>' +
      '<span class="conn-state">' + (ev.message ? escapeHtml(ev.message) : '') + '</span></div>' +
      '<div class="summary-grid">' +
        summaryCell('轮询 WIFI 总数', s.totalWifi) +
        summaryCell('完成', s.completedWifi) +
        summaryCell('失败', s.failedWifi) +
        summaryCell('跳过', s.skippedWifi) +
        summaryCell('完成率', rate + '%') +
        summaryCell('流程总尝试', s.totalFlowAttempts) +
        summaryCell('累计重试', s.totalRetries) +
        summaryCell('整体结论', s.overall) +
      '</div>' +
      (rows ? '<table class="summary-table"><thead><tr><th>#</th><th>WIFI / 网络</th>' +
        '<th>终态</th><th>尝试</th><th>重试</th><th>备注</th></tr></thead><tbody>' + rows + '</tbody></table>'
        : '<p class="hint">无逐 WIFI 明细</p>');
    $summary.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function showAlert(message) {
    $alert.textContent = '⚠ ' + (message || '任务告警');
    $alert.hidden = false;
  }

  function clearLog() {
    $log.innerHTML = '';
    renderedCount = 0;
  }

  // ----- 轮询降级 -----
  function pollOnce() {
    fetch('/api/task/progress?taskId=' + encodeURIComponent(taskId), {
      headers: { 'x-autoclaw-token': token },
    })
      .then(function (r) {
        return r.json();
      })
      .then(function (d) {
        if (!d || d.code !== 0 || !d.data) return;
        var data = d.data;
        updateStatus(data.status);
        var logArr = data.log || [];
        if (renderedCount > logArr.length) clearLog(); // 缓冲被截断，重渲染
        for (var i = renderedCount; i < logArr.length; i += 1) {
          renderEvent(logArr[i]);
          renderedCount += 1;
        }
        if (data.latest && data.latest.stats) updateStats(data.latest.stats);
        if (isTerminal(data.status) && pollTimer) stopPolling();
      })
      .catch(function () {
        /* 网络错误忽略，下一轮重试 */
      });
  }

  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(pollOnce, POLL_INTERVAL);
    pollOnce();
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  // ----- socket.io（单一连接，既收推送也发控制）-----
  var socket = null;
  if (typeof io === 'undefined') {
    $conn.textContent = '降级轮询中（无 socket 脚本）';
    startPolling();
  } else {
    socket = io({ auth: { token: token }, query: { token: token } });

    socket.on('connect', function () {
      $conn.textContent = '已连接（实时）';
      stopPolling();
      socket.emit('task:join', { taskId: taskId });
      pollOnce(); // 回填空缺的初期日志
    });

    socket.on('connect_error', function () {
      $conn.textContent = '实时连接失败，已降级轮询';
      startPolling();
    });

    socket.on('progress', function (ev) {
      renderEvent(ev);
      renderedCount += 1;
    });

    socket.on('task:state', function (payload) {
      if (payload && payload.taskId === taskId && payload.status) updateStatus(payload.status);
    });

    socket.on('alert', function (payload) {
      if (payload && payload.taskId === taskId) showAlert(payload.message);
    });
  }

  // ----- 控制按钮（暂停/停止经 socket 发送）-----
  if (socket) {
    $pause.addEventListener('click', function () {
      socket.emit('task:pause', { taskId: taskId });
    });
    $stop.addEventListener('click', function () {
      socket.emit('task:stop', { taskId: taskId });
    });
  } else {
    // 无 socket 时禁用控制按钮（纯轮询模式不支持实时控制）
    $pause.disabled = true;
    $stop.disabled = true;
  }

  // ----- 历史回看（T-D4 / F-25）-----
  var $reviewInput = document.getElementById('review-task-id');
  var $reviewBtn = document.getElementById('review-btn');
  var $reviewSummary = document.getElementById('review-summary');
  var $reviewLog = document.getElementById('review-log');

  function renderReview(data) {
    if (!data) return;
    var stats = data.stats || { total: 0, success: 0, fail: 0, failRate: 0 };
    if ($reviewSummary) {
      $reviewSummary.hidden = false;
      $reviewSummary.textContent =
        '成功率统计：总计 ' + (stats.total || 0) + ' 步，成功 ' + (stats.success || 0) +
        '，失败 ' + (stats.fail || 0) + '，失败率 ' + ((stats.failRate || 0) * 100).toFixed(0) + '%';
    }
    if (!$reviewLog) return;
    $reviewLog.innerHTML = '';
    var list = data.timeline || [];
    if (list.length === 0) {
      $reviewLog.innerHTML = '<div class="log-line">无运行记录</div>';
      return;
    }
    list.forEach(function (row) {
      var cls = '';
      if (row.stepStatus === 'failed') cls = 'line-fail';
      else if (row.stepStatus === 'success') cls = 'line-ok';
      var roundTxt = row.round != null ? '第' + (row.round + 1) + '轮 ' : '';
      var stepTxt = row.step ? (STEP_LABEL[row.step] || row.step) + ' ' : '';
      var statusTxt = row.stepStatus ? stepBadge(row.stepStatus) + ' ' : '';
      var msg = row.message ? ' · ' + escapeHtml(row.message) : '';
      var err = row.error ? ' ⚠ ' + escapeHtml(row.error) : '';
      var div = document.createElement('div');
      div.className = 'log-line' + (cls ? ' ' + cls : '');
      div.innerHTML = '<span class="t">' + escapeHtml(row.timestamp) + '</span> ' + roundTxt + statusTxt + stepTxt + msg + err;
      $reviewLog.appendChild(div);
    });
    $reviewLog.scrollTop = $reviewLog.scrollHeight;
  }

  if ($reviewBtn) {
    $reviewBtn.addEventListener('click', function () {
      var rid = ($reviewInput.value || '').trim();
      if (!rid) { alert('请输入要回看的 taskId'); return; }
      fetch('/api/task/logs?taskId=' + encodeURIComponent(rid), { headers: { 'x-autoclaw-token': token } })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (!d || d.code !== 0 || !d.data) {
            if ($reviewSummary) {
              $reviewSummary.hidden = false;
              $reviewSummary.textContent = '查询失败：' + ((d && d.message) || '未知错误');
            }
            return;
          }
          renderReview(d.data);
        })
        .catch(function (e) {
          if ($reviewSummary) {
            $reviewSummary.hidden = false;
            $reviewSummary.textContent = '网络错误：' + e.message;
          }
        });
    });
  }
})();
