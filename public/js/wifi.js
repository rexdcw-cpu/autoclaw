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

  // 「隐藏 WiFi 白名单」：仅记录用户通过「添加隐藏 WiFi」显式添加并连通的 SSID。
  // 轮询时只有这些 SSID 才豁免「必须可见」约束；其余历史 profile（如换地点后
  // 扫不到的旧网络）仍按可见性过滤，避免每轮白白尝试一堆连不上的网络。
  var HIDDEN_KEY = 'autoclaw_wifi_hidden_v1';
  function loadHiddenList() {
    try {
      var v = JSON.parse(localStorage.getItem(HIDDEN_KEY));
      return Array.isArray(v) ? v : [];
    } catch (e) {
      return [];
    }
  }
  function setHidden(ssid, on) {
    var list = loadHiddenList().filter(function (s) {
      return s && s !== ssid;
    });
    if (on) list.push(ssid);
    try {
      localStorage.setItem(HIDDEN_KEY, JSON.stringify(list));
    } catch (e) {
      /* 忽略存储失败，不影响连接 */
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

  // 渲染「当前连接」信息行：WiFi 连接 IP（随切换变化）+ 外网 IP + 中文归属地
  function renderCurrentInfo(i, pending) {
    if (!i || !currentEl) return;
    var parts = [];
    parts.push(i.ssid ? '当前连接：' + i.ssid : '当前未连接');
    // WiFi 连接 IP：锁定 WLAN 网卡，切换 WiFi 后此值会变化（区别于机器默认出口/网线 IP）
    if (i.wifiIp) {
      parts.push('WiFi连接IP：' + i.wifiIp);
    } else if (pending) {
      parts.push('WiFi连接IP：获取中…');
    } else {
      parts.push('WiFi连接IP：未获取');
    }
    // 外网 IP（公网出口，刚连上可能稍后才通）
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
        if (i.wifiIp && i.publicIp) {
          renderCurrentInfo(i, false); // 成功，最终态
        } else if (pending) {
          renderCurrentInfo(i, true); // 还没齐：显示获取中并继续重试
          setTimeout(function () { fetchCurrentInfo(attempt + 1); }, 2500);
        } else {
          renderCurrentInfo(i, false); // 重试耗尽：显示已拿到的值 + 失败原因
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

  // --- 添加隐藏 WiFi（不广播 SSID，直接输名称+密码连接，成功则本地记住）---
  var hiddenSsidEl = document.getElementById('hidden-ssid');
  var hiddenPwEl = document.getElementById('hidden-pw');
  var hiddenBtn = document.getElementById('hidden-add-btn');
  var hiddenMsgEl = document.getElementById('hidden-msg');
  var hiddenRememberedEl = document.getElementById('hidden-remembered');

  function showHiddenMsg(text, isError) {
    if (!hiddenMsgEl) return;
    if (!text) {
      hiddenMsgEl.hidden = true;
      return;
    }
    hiddenMsgEl.textContent = text;
    hiddenMsgEl.hidden = false;
    hiddenMsgEl.className = 'error-text' + (isError ? '' : ' ok');
  }

  // 渲染「已记住的 WiFi」（含隐藏）：来自 localStorage 的密码映射键集合
  function renderRemembered() {
    if (!hiddenRememberedEl) return;
    var map = loadPwMap();
    var keys = Object.keys(map).filter(function (k) {
      return !!k;
    });
    if (!keys.length) {
      hiddenRememberedEl.innerHTML = '';
      return;
    }
    var html =
      '<div class="remembered-title">已记住的 WiFi（含隐藏，可用于轮询）：</div><div class="remembered-chips">';
    var hiddenList = loadHiddenList();
    keys.forEach(function (ssid) {
      var isHidden = hiddenList.indexOf(ssid) !== -1;
      html +=
        '<span class="remembered-chip">' +
        escapeHtml(ssid) +
        (isHidden ? '<span class="chip-tag">隐藏</span>' : '') +
        '<button type="button" class="link-btn small faint" data-forget="' +
        escapeHtml(ssid) +
        '">忘记</button></span>';
    });
    html += '</div>';
    hiddenRememberedEl.innerHTML = html;
    Array.prototype.forEach.call(
      hiddenRememberedEl.querySelectorAll('[data-forget]'),
      function (btn) {
        btn.addEventListener('click', function () {
          var s = btn.getAttribute('data-forget');
          savePw(s, '');
          setHidden(s, false); // 同步移出隐藏白名单
          renderRemembered();
        });
      },
    );
  }

  function addHiddenWifi() {
    if (!hiddenSsidEl || !hiddenPwEl || !hiddenBtn) return;
    showHiddenMsg('', false);
    var ssid = hiddenSsidEl.value.trim();
    var password = hiddenPwEl.value;
    if (!ssid) {
      showHiddenMsg('请填写 WiFi 名称 (SSID)', true);
      return;
    }
    hiddenBtn.disabled = true;
    hiddenBtn.textContent = '连接中…';
    fetch('/api/wifi/connect', {
      method: 'POST',
      headers: tokenHeaders(),
      body: JSON.stringify({ ssid: ssid, password: password, hidden: true }),
    })
      .then(function (r) {
        return r.json().then(function (data) {
          return { status: r.status, data: data };
        });
      })
      .then(function (r) {
        hiddenBtn.disabled = false;
        hiddenBtn.textContent = '添加并连接';
        if (r.data && r.data.code === 0) {
          if (password) savePw(ssid, password); // 连接成功：记住正确密码
          setHidden(ssid, true); // 标记为隐藏网络，轮询时豁免可见性检查
          showHiddenMsg('✅ ' + (r.data.message || '已连接') + '，已本地记住', false);
          hiddenPwEl.value = '';
          renderRemembered();
        } else {
          showHiddenMsg('⚠️ ' + ((r.data && r.data.message) || '连接失败'), true);
        }
      })
      .catch(function (e) {
        hiddenBtn.disabled = false;
        hiddenBtn.textContent = '添加并连接';
        showHiddenMsg('网络错误：' + e.message, true);
      });
  }

  if (hiddenBtn) hiddenBtn.addEventListener('click', addHiddenWifi);
  renderRemembered();

  // --- 本机已存 WiFi：批量标记隐藏网络并纳入轮询 ---
  // 隐藏网络的 Windows 配置文件若缺 nonBroadcast 标记，系统只在扫到广播时才连，
  // 隐藏网永远连不上。这里一键修复 profile 并把 SSID 加入轮询白名单。
  var savedListEl = document.getElementById('saved-list');
  var savedMsgEl = document.getElementById('saved-msg');
  var savedRefreshBtn = document.getElementById('saved-refresh');
  var savedMarkBtn = document.getElementById('saved-mark-btn');
  var savedSelAllBtn = document.getElementById('saved-select-all');
  var savedSelNoneBtn = document.getElementById('saved-select-none');

  function showSavedMsg(text, isError) {
    if (!savedMsgEl) return;
    if (!text) {
      savedMsgEl.hidden = true;
      return;
    }
    savedMsgEl.textContent = text;
    savedMsgEl.hidden = false;
    savedMsgEl.className = 'error-text' + (isError ? '' : ' ok');
  }

  function renderSaved(list) {
    if (!savedListEl) return;
    if (!list || !list.length) {
      savedListEl.innerHTML = '<p class="hint">本机没有已保存的 WiFi 配置文件。</p>';
      return;
    }
    var whitelist = loadHiddenList();
    var html = '<div class="saved-items">';
    list.forEach(function (it) {
      var inPoll = whitelist.indexOf(it.ssid) !== -1;
      var tags = '';
      tags += it.visible
        ? '<span class="chip-tag tag-visible">可见</span>'
        : '<span class="chip-tag tag-invisible">扫不到</span>';
      if (it.hidden) tags += '<span class="chip-tag tag-hidden">隐藏已标记</span>';
      if (inPoll) tags += '<span class="chip-tag tag-poll">已纳入轮询</span>';
      // 默认勾选「扫不到且尚未纳入轮询」的——正是需要修复的隐藏网络
      var needFix = !it.visible && !(it.hidden && inPoll);
      html +=
        '<label class="saved-item"><input type="checkbox" class="saved-cb" value="' +
        escapeHtml(it.ssid) +
        '"' +
        (needFix ? ' checked' : '') +
        ' /><b>' +
        escapeHtml(it.ssid) +
        '</b>' +
        tags +
        '<span class="faint">' +
        escapeHtml(it.auth || '') +
        '</span></label>';
    });
    html += '</div>';
    savedListEl.innerHTML = html;
  }

  function loadSaved() {
    if (!savedRefreshBtn) return;
    savedRefreshBtn.disabled = true;
    savedRefreshBtn.textContent = '扫描中…';
    showSavedMsg('', false);
    fetch('/api/wifi/saved', { headers: tokenHeaders() })
      .then(function (r) {
        return r.json().then(function (data) {
          return { status: r.status, data: data };
        });
      })
      .then(function (r) {
        savedRefreshBtn.disabled = false;
        savedRefreshBtn.textContent = '扫描本机已存 WiFi';
        var d = r.data;
        if (!d || d.code !== 0 || !d.data) {
          showSavedMsg((d && d.message) || '加载失败（HTTP ' + r.status + '）', true);
          return;
        }
        renderSaved(d.data.list || []);
      })
      .catch(function (e) {
        savedRefreshBtn.disabled = false;
        savedRefreshBtn.textContent = '扫描本机已存 WiFi';
        showSavedMsg('网络错误：' + e.message, true);
      });
  }

  function selectedSavedSsids() {
    if (!savedListEl) return [];
    var out = [];
    Array.prototype.forEach.call(savedListEl.querySelectorAll('.saved-cb'), function (cb) {
      if (cb.checked) out.push(cb.value);
    });
    return out;
  }

  function markSelectedHidden() {
    var ssids = selectedSavedSsids();
    if (!ssids.length) {
      showSavedMsg('请先勾选要标记为隐藏的 WiFi', true);
      return;
    }
    savedMarkBtn.disabled = true;
    savedMarkBtn.textContent = '标记中…';
    showSavedMsg('', false);
    fetch('/api/wifi/mark-hidden', {
      method: 'POST',
      headers: tokenHeaders(),
      body: JSON.stringify({ ssids: ssids, hidden: true }),
    })
      .then(function (r) {
        return r.json().then(function (data) {
          return { status: r.status, data: data };
        });
      })
      .then(function (r) {
        savedMarkBtn.disabled = false;
        savedMarkBtn.textContent = '标记为隐藏并纳入轮询';
        var d = r.data;
        if (!d || d.code !== 0 || !d.data) {
          showSavedMsg((d && d.message) || '标记失败（HTTP ' + r.status + '）', true);
          return;
        }
        var results = d.data.results || [];
        var failed = [];
        results.forEach(function (it) {
          if (it.ok) setHidden(it.ssid, true); // 成功者纳入轮询白名单
          else failed.push(it.ssid + '（' + (it.message || '失败') + '）');
        });
        if (failed.length) {
          showSavedMsg(
            '⚠️ 成功 ' + d.data.ok + ' 个，失败 ' + failed.length + ' 个：' + failed.join('；'),
            true,
          );
        } else {
          showSavedMsg('✅ 已标记 ' + d.data.ok + ' 个并纳入 WIFI 轮询序列', false);
        }
        renderRemembered();
        loadSaved();
      })
      .catch(function (e) {
        savedMarkBtn.disabled = false;
        savedMarkBtn.textContent = '标记为隐藏并纳入轮询';
        showSavedMsg('网络错误：' + e.message, true);
      });
  }

  function setAllChecked(on) {
    if (!savedListEl) return;
    Array.prototype.forEach.call(savedListEl.querySelectorAll('.saved-cb'), function (cb) {
      cb.checked = !!on;
    });
  }

  if (savedRefreshBtn) savedRefreshBtn.addEventListener('click', loadSaved);
  if (savedMarkBtn) savedMarkBtn.addEventListener('click', markSelectedHidden);
  if (savedSelAllBtn)
    savedSelAllBtn.addEventListener('click', function () {
      setAllChecked(true);
    });
  if (savedSelNoneBtn)
    savedSelNoneBtn.addEventListener('click', function () {
      setAllChecked(false);
    });
})();
