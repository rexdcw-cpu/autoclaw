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
  var $pollLabel = document.getElementById('poll-label');
  var $summary = document.getElementById('task-summary');

  function shortCode(id) {
    if (!id) return '—';
    return id.length > 8 ? id.slice(0, 8) : id;
  }

  // 可读编号：优先显示「T-<seq>」（数据库自增列），无 seq 时回退 taskId 短码。
  // seq 由后端分配，进度页打开时可能尚未落库，故先显示短码，再异步拉取覆盖。
  $taskId.textContent = shortCode(taskId);

  function fetchSeq() {
    if (!taskId) return;
    fetch('/api/task/detail?taskId=' + encodeURIComponent(taskId), {
      headers: { 'x-autoclaw-token': token },
    })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        var seq = j && j.data && j.data.config && j.data.config.seq;
        if (seq != null) $taskId.textContent = 'T-' + seq;
      })
      .catch(function () { /* 忽略：保持短码显示 */ });
  }

  if (!taskId) {
    // 由 campaigns.html 触发打开时，taskId 可能还没生成；自己轮询拿当前运行任务的 taskId 后刷新
    $conn.textContent = '等待任务启动…';
    var waitTries = 0;
    var waitMax = 30;
    var waitTimer = setInterval(function () {
      waitTries++;
      fetch('/api/campaign/state', { headers: { 'x-autoclaw-token': token } })
        .then(function (r) { return r.json(); })
        .then(function (j) {
          var tid = j && j.data && (j.data.currentTaskId || j.data.activeTaskId);
          if (tid) {
            clearInterval(waitTimer);
            location.href = '/progress.html?taskId=' + encodeURIComponent(tid);
          } else if (waitTries >= waitMax) {
            clearInterval(waitTimer);
            $conn.textContent = '等待超时：未检测到运行中的任务';
          }
        })
        .catch(function () {
          if (waitTries >= waitMax) {
            clearInterval(waitTimer);
            $conn.textContent = '等待超时：未检测到运行中的任务';
          }
        });
    }, 1000);
    return;
  }

  // 拉取可读编号（T-<seq>）覆盖短码显示
  fetchSeq();

  var renderedCount = 0;
  var pollTimer = null;
  // 去重：socket 实时流与初始回填轮询可能短暂重叠，同一事件时间戳唯一
  var seenKeys = {};
  // 当前平台（google/baidu），用于决定轮询标签显示「VPN节点」还是「WIFI轮询」
  var currentPlatform = null;

  // ----- 头部/状态 -----
  var STEP_LABEL = {
    search: '搜索',
    locate: '定位',
    enter: '进入',
    stay: '停留',
    browse: '浏览',
    human: '拟人',
    close: '关闭',
    vpn_on: '步骤1 · 开启VPN',
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

  // UTC ISO 字符串 → 浏览器本地时区显示（后端统一存 UTC，前端按本机时区展示）
  // UTC 时间 → 浏览器本地时区显示（后端统一存 UTC，前端按本机时区展示）
  // 支持：毫秒时间戳、带 Z/offset 的 ISO 字符串、'YYYY-MM-DD HH:MM:SS' 等无偏移格式。
  // 关键：无 Z/offset 的字符串会被 JS 当成本地时间，导致时差未转；这里强制补 Z 按 UTC 解析。
  function toLocal(iso) {
    if (!iso) return '—';
    var s = String(iso).trim();
    var d;
    if (/^\d+$/.test(s)) {
      d = new Date(Number(s));
    } else {
      var normalized = s;
      if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(s)) {
        normalized = s.replace(' ', 'T') + 'Z';
      }
      d = new Date(normalized);
    }
    if (isNaN(d.getTime())) return String(iso);
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
      ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
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
      if (ev.round.platform) currentPlatform = ev.round.platform;
    }

    if (type === 'round_start' && ev.round) {
      var r = ev.round;
      $platform.textContent = r.platform || '—';
      $round.textContent = r.roundIndex + 1 + ' / ' + r.totalRounds;
      appendLine(
        '<span class="t">' + escapeHtml(toLocal(ev.timestamp)) + '</span> ▶ 第 ' +
          (r.roundIndex + 1) + '/' + r.totalRounds + ' 轮 · <b>' + escapeHtml(r.platform) +
          '</b> · 「' + escapeHtml(r.keyword) + '」',
        'line-round',
      );
    } else if (type === 'step' && ev.step) {
      var s = ev.step;
      var label = STEP_LABEL[s.step] || s.step;
      appendLine(
        '<span class="t">' + escapeHtml(toLocal(ev.timestamp)) + '</span> ' +
          stepBadge(s.status) + ' ' + label + (s.detail ? ' · ' + escapeHtml(s.detail) : ''),
        s.status === 'failed' ? 'line-fail' : '',
      );
    } else if (type === 'round_end' && ev.round) {
      var re = ev.round;
      appendLine(
        '<span class="t">' + escapeHtml(toLocal(ev.timestamp)) + '</span> — 第 ' + (re.roundIndex + 1) + '/' +
          re.totalRounds + ' 轮 结束: <b>' + (re.status === 'success' ? '成功' : '失败') + '</b>' +
          (re.error ? ' (' + escapeHtml(re.error) + ')' : ''),
        re.status === 'success' ? 'line-ok' : 'line-fail',
      );
    } else if (type === 'wifi_poll') {
      if ($wifiPoll && ev.wifiTotal) {
        $wifiPoll.textContent = (ev.wifiIndex || 0) + ' / ' + ev.wifiTotal;
      }
      if ($pollLabel) {
        $pollLabel.textContent = currentPlatform === 'google' ? 'VPN 节点' : 'WIFI 轮询';
      }
      appendLine(
        '<span class="t">' + escapeHtml(toLocal(ev.timestamp)) + '</span> 🔄 ' + escapeHtml(ev.message),
        'line-round',
      );
    } else if (type === 'alert') {
      showAlert(ev.message);
      appendLine('<span class="t">' + escapeHtml(toLocal(ev.timestamp)) + '</span> ⚠ ' + escapeHtml(ev.message), 'line-alert');
    } else if (type === 'vpn_info') {
      var vm = ev.vpn || {};
      var vtxt = vm.skipped
        ? '⚠ VPN 无可用主节点，谷歌任务跳过'
        : '🔐 VPN 已开启：主节点可用 ' + (vm.availableCount != null ? vm.availableCount : '?') + '/' +
          (vm.total != null ? vm.total : '?') + '，已切至『' + escapeHtml(vm.usedNode || vm.current || '—') + '』' +
          (vm.proxyUrl ? '（' + escapeHtml(vm.proxyUrl) + '）' : '');
      appendLine('<span class="t">' + escapeHtml(toLocal(ev.timestamp)) + '</span> ' + vtxt, 'line-round');
    } else if (type === 'task_end') {
    } else if (type === 'task_end') {
      appendLine(
        '<span class="t">' + escapeHtml(toLocal(ev.timestamp)) + '</span> ■ 任务结束: <b>' +
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
  // 每个平台（百度/谷歌）一张独立卡片，累计追加；不整段覆盖，避免后到的阶段把先到的清掉。
  var renderedSummaryPlatforms = {}; // 去重：同一平台只渲染一次（重连/轮询回填可能重复收到）

  function platformLabel(platform) {
    if (platform === 'baidu') return '百度';
    if (platform === 'google') return '谷歌';
    return platform || '未知平台';
  }

  function summaryCell(label, val) {
    return '<div class="summary-cell"><span class="sc-label">' + escapeHtml(label) +
      '</span><span class="sc-val">' + escapeHtml(String(val == null ? '' : val)) + '</span></div>';
  }

  function renderSummary(ev) {
    if (!$summary) return;
    var s = ev.stats || (ev.statsDetail && ev.statsDetail.summary);
    if (!s) return;
    var detail = ev.statsDetail;
    var platform = (detail && detail.platform) || (s.platform) || '未知平台';

    // 去重：同一平台只渲染一次
    if (renderedSummaryPlatforms[platform]) return;
    renderedSummaryPlatforms[platform] = true;

    var perWifi = (detail && detail.perWifi) || [];
    var rate = s.completionRate != null ? s.completionRate
      : (s.totalWifi ? Math.round((s.completedWifi / s.totalWifi) * 100) : 0);
    var rows = perWifi.map(function (w, i) {
      var st = w.status === 'completed' ? 'ok' : (w.status === 'failed' ? 'fail' : 'skip');
      var stTxt = w.status === 'completed' ? '完成'
        : (w.status === 'failed' ? '失败' : (w.status === 'skipped' ? '跳过' : (w.status || '—')));
      var found = w.found ? ' ✅' : (w.status === 'completed' ? ' ⚠️未命中' : '');
      var captchaMark = w.captcha ? '<span class="badge warn">⚠️是</span>' : '—';
      return '<tr><td>' + (i + 1) + '</td><td>' + escapeHtml(w.ssid) + '</td>' +
        '<td><span class="badge ' + st + '">' + stTxt + '</span></td>' +
        '<td>' + (w.found ? '✅' : '—') + '</td>' +
        '<td>' + captchaMark + '</td>' +
        '<td>' + (w.attempts || 1) + '</td><td>' + (w.retriesUsed || 0) + '</td>' +
        (w.error ? '<td class="err">' + escapeHtml(w.error) + '</td>' : '<td class="muted">—' + found + '</td>') + '</tr>';
    }).join('');

    // 首次渲染时清空旧内容并加总标题；之后每平台追加一张卡片
    if ($summary.hidden) {
      $summary.innerHTML = '<div class="log-head"><h2>📊 任务完成度总结</h2>' +
        '<span class="conn-state">' + (ev.message ? escapeHtml(ev.message) : '') + '</span></div>';
      $summary.hidden = false;
    }
    var card = document.createElement('div');
    card.className = 'summary-card summary-card-' + escapeHtml(platform);
    card.innerHTML =
      '<div class="summary-card-head"><h3>📌 ' + escapeHtml(platformLabel(platform)) + ' 阶段</h3>' +
        '<span class="summary-card-platform">' + escapeHtml(platform) + '</span></div>' +
      '<div class="summary-grid">' +
        summaryCell('WIFI/节点总数', s.totalWifi) +
        summaryCell('完成', s.completedWifi) +
        summaryCell('失败', s.failedWifi) +
        summaryCell('跳过', s.skippedWifi) +
        summaryCell('完成率', rate + '%') +
        summaryCell('命中目标率', (s.foundRate != null ? s.foundRate : '—') + '%') +
        (platform === 'google' ? summaryCell('触发验证', (s.captchaWifi != null ? s.captchaWifi : 0) + ' 节点') : '') +
        summaryCell('流程总尝试', s.totalFlowAttempts) +
        summaryCell('累计重试', s.totalRetries) +
        summaryCell('整体结论', s.overall) +
      '</div>' +
      (rows ? '<table class="summary-table"><thead><tr><th>#</th><th>WIFI / 网络</th>' +
        '<th>终态</th><th>命中</th><th>验证拦截</th><th>尝试</th><th>重试</th><th>备注</th></tr></thead><tbody>' + rows + '</tbody></table>'
        : '<p class="hint">无逐 WIFI 明细</p>');
    $summary.appendChild(card);
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
      div.innerHTML = '<span class="t">' + escapeHtml(toLocal(row.timestamp)) + '</span> ' + roundTxt + statusTxt + stepTxt + msg + err;
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
