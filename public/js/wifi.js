'use strict';

/**
 * public/js/wifi.js
 * ---------------------------------------------------------------------------
 * WiFi 切换面板逻辑（原生 JS，无构建）。
 *   - 拉取 /api/wifi/list 渲染可见网络列表 + 当前连接。
 *   - secured 网络显示密码输入框，点击「连接」调用 /api/wifi/connect。
 *   - 复用 localStorage 中的访问令牌（与 config.js 共用键 autoclaw_token）。
 */

(function () {
  var TOKEN_KEY = 'autoclaw_token';
  var listEl = document.getElementById('wifi-list');
  var currentEl = document.getElementById('wifi-current');
  var msgEl = document.getElementById('wifi-msg');
  var refreshBtn = document.getElementById('wifi-refresh');
  var currentSsid = '';

  function token() {
    return localStorage.getItem(TOKEN_KEY) || 'autoclaw-dev';
  }
  function tokenHeaders(extra) {
    var h = { 'Content-Type': 'application/json' };
    h['x-autoclaw-token'] = token();
    return Object.assign(h, extra || {});
  }
  function showMsg(msg, isError) {
    if (!msgEl) return;
    msgEl.textContent = msg;
    msgEl.hidden = false;
    msgEl.style.color = isError ? '' : '#1a7f37';
  }
  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // --- 密码记忆（按 SSID 存于 localStorage，明文存储，仅本地浏览器）---
  // 注意：WiFi 密码以明文保存在浏览器 localStorage，方便「连接成功一次后不再重复输入」。
  // 若介意明文落盘，可点行内「忘记」链接清除该 SSID 的保存密码。
  var PW_KEY = 'autoclaw_wifi_pw_v1';
  function loadPwMap() {
    try {
      return JSON.parse(localStorage.getItem(PW_KEY)) || {};
    } catch (e) {
      return {};
    }
  }
  function getPw(ssid) {
    return loadPwMap()[ssid] || '';
  }
  function savePw(ssid, pw) {
    var m = loadPwMap();
    if (pw) m[ssid] = pw;
    else delete m[ssid];
    try {
      localStorage.setItem(PW_KEY, JSON.stringify(m));
    } catch (e) {
      /* 隐私模式 / 配额满则忽略，不影响连接 */
    }
  }

  function setRefreshing(on) {
    if (!refreshBtn) return;
    refreshBtn.disabled = !!on;
    refreshBtn.textContent = on ? '刷新中…' : '刷新 WiFi 列表';
  }

  function loadList() {
    setRefreshing(true);
    fetch('/api/wifi/list', { headers: tokenHeaders() })
      .then(function (r) {
        return r.json().then(function (data) {
          return { status: r.status, data: data };
        });
      })
      .then(function (r) {
        var d = r.data;
        if (!d || d.code !== 0 || !d.data) {
          // 后端返回错误：把原因显示出来，而不是静默留空
          showMsg((d && d.message) || ('加载失败（HTTP ' + r.status + '）'), true);
          renderList([]);
          return;
        }
        if (msgEl) msgEl.hidden = true; // 成功则清掉上次的错误提示
        currentSsid = d.data.current || '';
        currentEl.textContent = currentSsid
          ? '当前连接：' + currentSsid + '（接口 ' + d.data.interface + '）'
          : '当前未连接（接口 ' + d.data.interface + '）';
        renderList(d.data.list || []);
        loadCurrentInfo(); // 异步补充 本地IP / 公网IP / 地区
      })
      .catch(function (e) {
        renderList([]);
        showMsg('加载失败：' + e.message + '（请确认服务已用新版本重启）', true);
      })
      .finally(function () {
        setRefreshing(false);
      });
  }

  // 是否为「优先置顶」网络：当前已连接，或曾连接成功并记住了密码
  function isPinned(n) {
    return n.ssid === currentSsid || !!getPw(n.ssid);
  }

  // 渲染「当前连接」信息行（外网 IP + 中文归属地）
  function renderCurrentInfo(i, pending) {
    if (!i || !currentEl) return;
    var parts = [];
    parts.push(i.ssid ? '当前连接：' + i.ssid : '当前未连接');
    // 只显示外网 IP（内网 IP 不展示）
    if (i.publicIp) {
      parts.push('外网IP：' + i.publicIp);
    } else if (pending) {
      parts.push('外网IP：获取中…');
    } else {
      parts.push('外网IP：获取失败' + (i.geoError ? '（' + i.geoError + '）' : ''));
    }
    var region = [i.country, i.region, i.city].filter(Boolean).join('/');
    if (region) {
      parts.push('地区：' + region + (i.org ? '（' + i.org + '）' : ''));
    } else if (pending) {
      parts.push('地区：获取中…');
    } else if (i.geoError) {
      parts.push('地区：获取失败（' + i.geoError + '）');
    }
    currentEl.textContent = parts.join(' ｜ ');
  }

  // 异步获取当前连接的 IP 与归属地。
  // 刚连上 WiFi 时外网往往还没通，单次请求拿不到公网 IP/地区就会「看不到信息」，
  // 因此：若取不到则按退避重试（最多 INFO_MAX_RETRY 次），期间显示「获取中…」。
  var INFO_MAX_RETRY = 6;
  function fetchCurrentInfo(attempt) {
    attempt = attempt || 0;
    var pending = attempt < INFO_MAX_RETRY;
    fetch('/api/wifi/info', { headers: tokenHeaders() })
      .then(function (r) {
        return r.json();
      })
      .then(function (d) {
        if (!d || d.code !== 0 || !d.data) {
          if (pending) setTimeout(function () { fetchCurrentInfo(attempt + 1); }, 2500);
          return;
        }
        var i = d.data;
        if (i.publicIp) {
          renderCurrentInfo(i, false); // 成功，最终态
        } else if (pending) {
          renderCurrentInfo(i, true); // 外网还没通：显示获取中并继续重试
          setTimeout(function () { fetchCurrentInfo(attempt + 1); }, 2500);
        } else {
          renderCurrentInfo(i, false); // 重试耗尽：显示失败原因
        }
      })
      .catch(function () {
        // 网络级错误：仍在重试窗口内则静默重试
        if (pending) setTimeout(function () { fetchCurrentInfo(attempt + 1); }, 3000);
      });
  }

  function loadCurrentInfo() {
    fetchCurrentInfo(0);
  }

  function renderList(list) {
    if (!listEl) return;
    if (!list || list.length === 0) {
      listEl.innerHTML = '<p class="hint">未发现可见 WiFi（请确认无线已开启）。</p>';
      return;
    }
    // 已连接 / 已存密码的网络置顶，组内按信号降序
    list = list.slice().sort(function (a, b) {
      var pa = isPinned(a) ? 1 : 0;
      var pb = isPinned(b) ? 1 : 0;
      if (pa !== pb) return pb - pa;
      return (b.signal || 0) - (a.signal || 0);
    });
    listEl.innerHTML = '';
    list.forEach(function (n) {
      var row = document.createElement('div');
      row.className = 'wifi-row' + (n.ssid === currentSsid ? ' wifi-row-current' : '');

      var info = document.createElement('div');
      info.className = 'wifi-info';
      var lock = n.secured ? '🔒' : '🔓';
      var badge = '';
      if (n.ssid === currentSsid) badge = '<span class="wifi-badge cur">● 当前</span> ';
      else if (getPw(n.ssid)) badge = '<span class="wifi-badge saved">🔑 已存</span> ';
      info.innerHTML =
        badge +
        '<strong>' +
        escapeHtml(n.ssid) +
        '</strong> ' +
        lock +
        ' 信号 ' +
        (n.signal || 0) +
        '%  [' +
        escapeHtml(n.auth) +
        ']';

      var acts = document.createElement('div');
      acts.className = 'wifi-actions';

      var pw = null;
      if (n.secured) {
        pw = document.createElement('input');
        pw.type = 'password';
        pw.placeholder = '密码';
        pw.className = 'wifi-pw';
        pw.autocomplete = 'off';
        pw.value = getPw(n.ssid); // 成功连过则预填，免去重复输入
        acts.appendChild(pw);
        if (getPw(n.ssid)) {
          var forget = document.createElement('button');
          forget.type = 'button';
          forget.className = 'link-btn small faint';
          forget.textContent = '忘记';
          forget.title = '清除该 WiFi 已保存的密码';
          forget.addEventListener('click', function () {
            savePw(n.ssid, '');
            loadList();
          });
          acts.appendChild(forget);
        }
      }

      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'link-btn';
      btn.textContent = '连接';
      btn.addEventListener('click', function () {
        var pwd = n.secured && pw ? pw.value : '';
        connect(n.ssid, pwd, btn);
      });
      acts.appendChild(btn);

      row.appendChild(info);
      row.appendChild(acts);
      listEl.appendChild(row);
    });
  }

  function connect(ssid, password, btn) {
    showMsg('', false);
    if (btn) {
      btn.disabled = true;
      btn.textContent = '连接中…';
    }
    fetch('/api/wifi/connect', {
      method: 'POST',
      headers: tokenHeaders(),
      body: JSON.stringify({ ssid: ssid, password: password }),
    })
      .then(function (r) {
        return r.json().then(function (data) {
          return { status: r.status, data: data };
        });
      })
      .then(function (r) {
        if (r.data && r.data.code === 0) {
          if (password) savePw(ssid, password); // 连接成功：记住正确密码
          showMsg('✅ ' + (r.data.message || '已连接'), false);
          loadList();
        } else {
          showMsg('⚠️ ' + ((r.data && r.data.message) || '连接失败'), true);
          if (btn) {
            btn.disabled = false;
            btn.textContent = '连接';
          }
        }
      })
      .catch(function (e) {
        showMsg('网络错误：' + e.message, true);
        if (btn) {
          btn.disabled = false;
          btn.textContent = '连接';
        }
      });
  }

  if (refreshBtn) refreshBtn.addEventListener('click', loadList);
  loadList();
})();
