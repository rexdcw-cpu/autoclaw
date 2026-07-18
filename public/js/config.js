'use strict';

/**
 * public/js/config.js
 * ---------------------------------------------------------------------------
 * 任务配置表单逻辑（原生 JS，无构建）。
 *   - 读取表单字段，组装提交 payload（关键词/标题关键词由后端拆分）。
 *   - 读取/保存访问令牌到 localStorage（决策 A3）。
 *   - POST /api/task/submit，携带 x-autoclaw-token 头；成功后跳转进度页。
 */

(function () {
  // 令牌本地存储键（与 progress.js 共用）
  var TOKEN_KEY = 'autoclaw_token';

  var form = document.getElementById('task-form');
  var errorEl = document.getElementById('form-error');
  var tokenInput = document.getElementById('token');

  // 预填上次使用的令牌
  var savedToken = localStorage.getItem(TOKEN_KEY);
  if (savedToken) tokenInput.value = savedToken;

  function showError(msg) {
    errorEl.textContent = msg;
    errorEl.hidden = false;
  }

  function getCheckedValues(name) {
    return Array.prototype.slice
      .call(document.querySelectorAll('input[name="' + name + '"]:checked'))
      .map(function (el) {
        return el.value;
      });
  }

  function numOrNull(id) {
    var v = document.getElementById(id).value.trim();
    if (v === '') return undefined;
    var n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    errorEl.hidden = true;

    // --- 令牌（A3）---
    var token = tokenInput.value.trim() || 'autoclaw-dev';
    localStorage.setItem(TOKEN_KEY, token);

    // --- 平台 ---
    var platforms = getCheckedValues('platforms');
    if (platforms.length === 0) {
      showError('请至少选择一个平台（百度 / 谷歌）');
      return;
    }

    // --- 关键词 ---
    var keywords = document.getElementById('keywords').value.trim();
    if (!keywords) {
      showError('搜索关键词不能为空');
      return;
    }

    // --- 目标站点（A1 必填）---
    var targetDomain = document.getElementById('targetDomain').value.trim();
    var titleKeywords = document.getElementById('titleKeywords').value.trim();
    // 目标页面锚点：站内浏览时寻找的页（非必填，空则由后端兜底默认「关于我们」）
    var browseAnchor = document.getElementById('browseAnchor').value.trim() || '关于我们';
    if (!targetDomain) {
      showError('目标域名 targetDomain 为必填项');
      return;
    }
    if (!titleKeywords) {
      showError('标题关键词 titleKeywords 为必填项');
      return;
    }

    // --- 拟人参数（有值才覆盖默认值）---
    var anthropic = {};
    ['staySeconds', 'scrollUp', 'scrollDown', 'ampMin', 'ampMax', 'intervalMin', 'intervalMax'].forEach(
      function (k) {
        var v = numOrNull(k);
        if (v !== undefined) anthropic[k] = v;
      },
    );

    // --- 拟人微动作（步骤间随机停顿+随机动作，有值才覆盖默认值）---
    var humanizeEnabled = document.getElementById('humanize-enabled');
    var humanize = {};
    if (humanizeEnabled && !humanizeEnabled.checked) humanize.enabled = false;
    ['humanize-min', 'humanize-max'].forEach(function (k) {
      var v = numOrNull(k);
      if (v !== undefined) {
        humanize[k === 'humanize-min' ? 'minMs' : 'maxMs'] = v;
      }
    });

    var mode = document.getElementById('mode').value;
    var clientId = document.getElementById('clientId').value.trim();

    var payload = {
      platforms: platforms,
      keywords: keywords,
      targetDomain: targetDomain,
      titleKeywords: titleKeywords,
      browseAnchor: browseAnchor,
      anthropic: anthropic,
      humanize: humanize,
      strategy: { mode: mode },
    };
    if (clientId) payload.clientId = clientId;

    var btn = document.getElementById('submit-btn');
    btn.disabled = true;
    btn.textContent = '提交中…';

    fetch('/api/task/submit', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-autoclaw-token': token,
      },
      body: JSON.stringify(payload),
    })
      .then(function (resp) {
        return resp.json().then(function (data) {
          return { status: resp.status, data: data };
        });
      })
      .then(function (r) {
        if (r.status === 409 && r.data && r.data.data && r.data.data.error === 'ERR_TASK_RUNNING') {
          showError('已有运行中的任务，请稍后或前往进度页处理。');
          btn.disabled = false;
          btn.textContent = '提交并启动任务';
          return;
        }
        if (r.data && r.data.code === 0 && r.data.data && r.data.data.taskId) {
          window.location.href = '/progress.html?taskId=' + encodeURIComponent(r.data.data.taskId);
          return;
        }
        showError('提交失败：' + ((r.data && r.data.message) || '未知错误'));
        btn.disabled = false;
        btn.textContent = '提交并启动任务';
      })
      .catch(function (err) {
        showError('网络错误：' + err.message);
        btn.disabled = false;
        btn.textContent = '提交并启动任务';
      });
  });

  // ----- 历史配置加载与回填（F-24）-----
  var historySel = document.getElementById('history-select');
  var historyCache = {};

  function loadHistory() {
    fetch('/api/task/history?limit=50', { headers: { 'x-autoclaw-token': token } })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d || d.code !== 0 || !d.data || !d.data.list) return;
        populateHistory(d.data.list);
      })
      .catch(function () { /* 忽略：历史加载失败不影响主流程 */ });
  }

  function populateHistory(list) {
    if (!historySel) return;
    historySel.innerHTML = '';
    var ph = document.createElement('option');
    ph.value = '';
    ph.textContent = '— 加载历史配置 —';
    historySel.appendChild(ph);
    list.forEach(function (item) {
      historyCache[item.taskId] = item;
      var o = document.createElement('option');
      o.value = item.taskId || '';
      var dom = item.targetDomain || '';
      var kw = Array.isArray(item.keywords) ? item.keywords.join('|') : (item.keywords || '');
      o.textContent = (item.createdAt || '').slice(0, 19) + ' · ' + dom + ' · ' + kw;
      historySel.appendChild(o);
    });
  }

  function fillFormFromHistory(item) {
    if (!item) return;
    if (Array.isArray(item.platforms)) {
      document.querySelectorAll('input[name="platforms"]').forEach(function (cb) {
        cb.checked = item.platforms.indexOf(cb.value) !== -1;
      });
    }
    if (item.keywords) {
      document.getElementById('keywords').value = Array.isArray(item.keywords) ? item.keywords.join('|') : item.keywords;
    }
    if (item.targetDomain) document.getElementById('targetDomain').value = item.targetDomain;
    if (item.titleKeywords) {
      document.getElementById('titleKeywords').value = Array.isArray(item.titleKeywords) ? item.titleKeywords.join('|') : item.titleKeywords;
    }
    var a = item.anthropic || {};
    ['staySeconds', 'scrollUp', 'scrollDown', 'ampMin', 'ampMax', 'intervalMin', 'intervalMax'].forEach(function (k) {
      if (a[k] != null) { var el = document.getElementById(k); if (el) el.value = a[k]; }
    });
    var hz = item.humanize || {};
    var hzEnabled = document.getElementById('humanize-enabled');
    if (hzEnabled) hzEnabled.checked = hz.enabled !== false;
    if (hz.minMs != null) { var mn = document.getElementById('humanize-min'); if (mn) mn.value = hz.minMs; }
    if (hz.maxMs != null) { var mx = document.getElementById('humanize-max'); if (mx) mx.value = hz.maxMs; }
    if (item.runMode) { var m = document.getElementById('mode'); if (m) m.value = item.runMode; }
    var cb = document.getElementById('clientId');
    if (cb) cb.value = item.clientId || '';
  }

  if (historySel) {
    historySel.addEventListener('change', function () {
      var id = historySel.value;
      if (!id) return;
      fillFormFromHistory(historyCache[id]);
    });
    loadHistory();
  }

  // ----- 客户线（P0-8 / P0-9）-----
  var clientSel = document.getElementById('clientId');
  var clientListEl = document.getElementById('client-list');
  var clientForm = document.getElementById('client-form');
  var clientErrEl = document.getElementById('client-form-error');

  function tokenHeaders(extra) {
    var h = { 'Content-Type': 'application/json' };
    if (token) h['x-autoclaw-token'] = token;
    return Object.assign(h, extra || {});
  }

  function loadClients() {
    fetch('/api/client/list', { headers: tokenHeaders() })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d || d.code !== 0 || !d.data || !d.data.list) {
          renderClientList([]);
          return;
        }
        renderClientList(d.data.list);
      })
      .catch(function () { renderClientList([]); });
  }

  function renderClientList(list) {
    // 下拉（任务归属）
    if (clientSel) {
      var chosen = clientSel.value;
      clientSel.innerHTML = '';
      var ph = document.createElement('option');
      ph.value = '';
      ph.textContent = '— 不关联客户 —';
      clientSel.appendChild(ph);
      list.forEach(function (c) {
        var o = document.createElement('option');
        o.value = c.clientId;
        o.textContent = c.name + (c.contact ? '（' + c.contact + '）' : '');
        clientSel.appendChild(o);
      });
      if (chosen) clientSel.value = chosen;
    }
    // 管理列表
    if (!clientListEl) return;
    if (!list || list.length === 0) {
      clientListEl.innerHTML = '<p class="hint">暂无客户，使用下方表单新增。</p>';
      return;
    }
    clientListEl.innerHTML = '';
    list.forEach(function (c) {
      var row = document.createElement('div');
      row.className = 'client-row';
      var info = document.createElement('div');
      info.className = 'client-info';
      info.innerHTML =
        '<strong>' + escapeHtml(c.name) + '</strong>' +
        (c.contact ? ' · ' + escapeHtml(c.contact) : '') +
        (c.notes ? ' · ' + escapeHtml(c.notes) : '');
      var acts = document.createElement('div');
      acts.className = 'client-actions';
      var statBtn = document.createElement('button');
      statBtn.type = 'button';
      statBtn.className = 'link-btn';
      statBtn.textContent = '统计';
      statBtn.addEventListener('click', function () { window.open('/api/client/' + c.clientId + '/stats', '_blank'); });
      var repBtn = document.createElement('button');
      repBtn.type = 'button';
      repBtn.className = 'link-btn';
      repBtn.textContent = '交付报告';
      repBtn.addEventListener('click', function () { window.open('/api/client/' + c.clientId + '/report?format=markdown', '_blank'); });
      var delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'link-btn danger';
      delBtn.textContent = '删除';
      delBtn.addEventListener('click', function () { removeClient(c.clientId, c.name); });
      acts.appendChild(statBtn);
      acts.appendChild(repBtn);
      acts.appendChild(delBtn);
      row.appendChild(info);
      row.appendChild(acts);
      clientListEl.appendChild(row);
    });
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function showClientError(msg) {
    if (!clientErrEl) return;
    clientErrEl.textContent = msg;
    clientErrEl.hidden = false;
  }

  if (clientForm) {
    clientForm.addEventListener('submit', function (e) {
      e.preventDefault();
      showClientError('');
      var name = document.getElementById('client-name').value.trim();
      if (!name) { showClientError('客户名称不能为空'); return; }
      var contact = document.getElementById('client-contact').value.trim();
      var notes = document.getElementById('client-notes').value.trim();
      var btn = document.getElementById('client-add-btn');
      btn.disabled = true;
      fetch('/api/client/create', {
        method: 'POST',
        headers: tokenHeaders(),
        body: JSON.stringify({ name: name, contact: contact, notes: notes }),
      })
        .then(function (r) { return r.json().then(function (data) { return { status: r.status, data: data }; }); })
        .then(function (r) {
          btn.disabled = false;
          if (r.data && r.data.code === 0) {
            clientForm.reset();
            loadClients();
          } else {
            showClientError('新增失败：' + ((r.data && r.data.message) || '未知错误'));
          }
        })
        .catch(function (err) { btn.disabled = false; showClientError('网络错误：' + err.message); });
    });
  }

  function removeClient(clientId, name) {
    if (!window.confirm('确认删除客户「' + name + '」？若存在关联任务将被拒绝。')) return;
    fetch('/api/client/' + clientId, { method: 'DELETE', headers: tokenHeaders() })
      .then(function (r) { return r.json().then(function (data) { return { status: r.status, data: data }; }); })
      .then(function (r) {
        if (r.status === 409) { showClientError('删除失败：该客户存在关联任务，请先处理任务。'); return; }
        if (r.data && r.data.code === 0) { loadClients(); }
        else { showClientError('删除失败：' + ((r.data && r.data.message) || '未知错误')); }
      })
      .catch(function (err) { showClientError('网络错误：' + err.message); });
  }

  // 令牌就绪后加载客户列表（令牌可能来自 localStorage 或默认值）
  loadClients();
})();
