'use strict';

/**
 * public/js/campaigns.js
 * 批量定时任务管理页：列表 / 新建 / 编辑 / 启用 / 触发 / 删除 + 实时运行进度。
 * 站点目标改为可视化增删改：每行可单独配置「是否参与本轮 / 平台(百度·谷歌) /
 * 关键词 / 标题词 / 站内锚点 / WIFI 轮询 / 扫描页数 / 高级拟人参数」。
 */

const TOKEN = localStorage.getItem('autoclaw_token') || 'autoclaw-dev';
const HEADERS = { 'Content-Type': 'application/json', 'x-autoclaw-token': TOKEN };

// 公司 10 站合理默认：domain（按 Master 提供的 URL 原样保留 www）+ 品牌词（同 seed 脚本）。
const COMPANY_SITES = [
  { name: '科大万博', domain: 'www.kedawanbo.com', titleKeywords: '科大万博', keywords: '科大万博|kedawanbo' },
  { name: '万年设计', domain: 'manindesign.com', titleKeywords: '万年设计|Manin Design', keywords: '万年设计|manindesign' },
  { name: '萬年商務', domain: 'maninconsultant.com', titleKeywords: '萬年商務|万年商务', keywords: '萬年商務|万年商务|maninconsultant' },
  { name: '地产官网', domain: 'manincap.com', titleKeywords: 'Manin Cap|万年地产', keywords: 'manincap|万年地产' },
  { name: '金門旅遊', domain: 'kammon-travel.com', titleKeywords: '金門旅遊|金门旅游', keywords: '金門旅遊|金门旅游|kammon travel' },
  { name: '移民简体', domain: 'www.maninvisa.com', titleKeywords: '万年移民|Manin Visa', keywords: '万年移民|maninvisa' },
  { name: 'WISH乐队', domain: 'wishmusic.hk', titleKeywords: 'WISH|Wish Music', keywords: 'WISH乐队|wishmusic' },
  { name: '世一娱乐', domain: 'www.hkcenturyone.com', titleKeywords: '世一娱乐|Century One', keywords: '世一娱乐|hkcenturyone' },
  { name: '中港车', domain: 'manincar.com', titleKeywords: '中港车|Manin Car', keywords: '中港车|中港跨境车|manincar' },
  { name: '美思未來', domain: 'www.macy-future.com', titleKeywords: '美思未來|美思未来', keywords: '美思未來|美思未来|macy future' },
];

/** 前端内存中的站点列表（与表单双向绑定） */
const state = { sites: [] };

function uuid() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return 's-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
function escAttr(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}
function escText(s) { return escAttr(s); }
function numOrEmpty(n) { return n == null ? '' : n; }

function fmtTime(ms) {
  if (ms == null) return '—';
  const d = new Date(Number(ms));
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function scheduleText(c) {
  if (c.scheduleType === 'interval') return `每 ${c.intervalHours || 24} 小时`;
  return `每天 ${String(c.scheduleHour ?? 9).padStart(2, '0')}:${String(c.scheduleMinute ?? 0).padStart(2, '0')}`;
}

function getPlatforms() {
  return Array.from(document.querySelectorAll('input[name="c-platforms"]:checked')).map((el) => el.value);
}
function setPlatforms(arr) {
  document.querySelectorAll('input[name="c-platforms"]').forEach((el) => { el.checked = arr.includes(el.value); });
}

// ---------------------------------------------------------------------------
// 站点卡片渲染
// ---------------------------------------------------------------------------

function siteCardHtml(site, idx) {
  const platforms = site.platforms || [];
  const anthropic = site.anthropic || {};
  const humanize = site.humanize || {};
  const dis = site.enabled === false ? ' disabled-site' : '';
  return `
  <div class="site-card${dis}" data-card="${idx}">
    <div class="site-head">
      <label class="check"><input type="checkbox" data-idx="${idx}" data-field="enabled" ${site.enabled !== false ? 'checked' : ''}/> 参与本轮</label>
      <input class="si-name" type="text" data-idx="${idx}" data-field="name" value="${escAttr(site.name || '')}" placeholder="站点名称" />
      <button type="button" class="btn-danger act-del" data-idx="${idx}">删除</button>
    </div>
    <div class="site-grid">
      <div class="col">
        <label>域名 domain</label>
        <input type="text" data-idx="${idx}" data-field="domain" value="${escAttr(site.domain || '')}" placeholder="example.com" />
      </div>
      <div class="col" style="grid-column: span 2">
        <label>平台（可单独设：仅百度 / 仅谷歌 / 百度+谷歌）</label>
        <div class="site-platforms">
          <label class="check"><input type="checkbox" data-idx="${idx}" data-field="platforms" value="baidu" ${platforms.includes('baidu') ? 'checked' : ''}/> 百度</label>
          <label class="check"><input type="checkbox" data-idx="${idx}" data-field="platforms" value="google" ${platforms.includes('google') ? 'checked' : ''}/> 谷歌</label>
        </div>
      </div>
      <div class="col" style="grid-column: span 3">
        <label>搜索关键词（| 分隔，可多行）</label>
        <textarea data-idx="${idx}" data-field="keywords" placeholder="万年移民|万年移民公司">${escText(site.keywords || '')}</textarea>
      </div>
      <div class="col">
        <label>标题关键词（| 分隔）</label>
        <input type="text" data-idx="${idx}" data-field="titleKeywords" value="${escAttr(site.titleKeywords || '')}" placeholder="万年移民" />
      </div>
      <div class="col">
        <label>站内锚点 browseAnchor</label>
        <input type="text" data-idx="${idx}" data-field="browseAnchor" value="${escAttr(site.browseAnchor || '')}" placeholder="关于我们" />
      </div>
      <div class="col">
        <label>扫描页数 maxResultPages</label>
        <input type="number" min="1" max="20" data-idx="${idx}" data-field="maxResultPages" value="${numOrEmpty(site.maxResultPages)}" />
      </div>
      <div class="col" style="grid-column: span 3">
        <label class="check"><input type="checkbox" data-idx="${idx}" data-field="pollWifi" ${site.pollWifi ? 'checked' : ''}/> 启用 WIFI 轮询（覆盖全站默认）</label>
      </div>
    </div>
    <details class="adv">
      <summary>高级拟人参数（可选，留空即走全站/后端默认）</summary>
      <div class="site-grid">
        <div class="col"><label>停留(秒)</label><input type="number" data-idx="${idx}" data-field="anthropic.staySeconds" value="${numOrEmpty(anthropic.staySeconds)}"/></div>
        <div class="col"><label>上滑</label><input type="number" data-idx="${idx}" data-field="anthropic.scrollUp" value="${numOrEmpty(anthropic.scrollUp)}"/></div>
        <div class="col"><label>下滑</label><input type="number" data-idx="${idx}" data-field="anthropic.scrollDown" value="${numOrEmpty(anthropic.scrollDown)}"/></div>
        <div class="col"><label>幅度下限(px)</label><input type="number" data-idx="${idx}" data-field="anthropic.ampMin" value="${numOrEmpty(anthropic.ampMin)}"/></div>
        <div class="col"><label>幅度上限(px)</label><input type="number" data-idx="${idx}" data-field="anthropic.ampMax" value="${numOrEmpty(anthropic.ampMax)}"/></div>
        <div class="col"><label>间隔下限(秒)</label><input type="number" data-idx="${idx}" data-field="anthropic.intervalMin" value="${numOrEmpty(anthropic.intervalMin)}"/></div>
        <div class="col"><label>间隔上限(秒)</label><input type="number" data-idx="${idx}" data-field="anthropic.intervalMax" value="${numOrEmpty(anthropic.intervalMax)}"/></div>
        <div class="col"><label>最短停顿(ms)</label><input type="number" data-idx="${idx}" data-field="humanize.minMs" value="${numOrEmpty(humanize.minMs)}"/></div>
        <div class="col"><label>最长停顿(ms)</label><input type="number" data-idx="${idx}" data-field="humanize.maxMs" value="${numOrEmpty(humanize.maxMs)}"/></div>
        <div class="col" style="grid-column: span 3"><label class="check"><input type="checkbox" data-idx="${idx}" data-field="humanize.enabled" ${humanize.enabled ? 'checked' : ''}/> 启用每步拟人微动作</label></div>
      </div>
    </details>
  </div>`;
}

function renderSites() {
  const wrap = document.getElementById('sites');
  wrap.innerHTML = state.sites.map((s, i) => siteCardHtml(s, i)).join('');
  updateCount();
}

function updateCount() {
  const total = state.sites.length;
  const enabled = state.sites.filter((s) => s.enabled !== false).length;
  document.getElementById('sites-count').textContent = `站点目标：${total} 个（启用 ${enabled}）`;
}

function addSite() {
  state.sites.push({
    id: uuid(),
    name: '新站点',
    domain: '',
    enabled: true,
    platforms: getPlatforms(),
    keywords: '',
    titleKeywords: '',
    browseAnchor: '关于我们',
    pollWifi: false,
    maxResultPages: 5,
  });
  renderSites();
}

function prefill() {
  state.sites = COMPANY_SITES.map((s) => ({
    id: uuid(),
    name: s.name,
    domain: s.domain,
    enabled: true,
    platforms: ['baidu', 'google'],
    keywords: s.keywords,
    titleKeywords: s.titleKeywords,
    browseAnchor: '关于我们',
    pollWifi: false,
    maxResultPages: 5,
  }));
  renderSites();
}

function applyDefaults() {
  const plat = getPlatforms();
  const poll = document.getElementById('pollWifi').checked;
  state.sites.forEach((s) => { s.platforms = plat.slice(); s.pollWifi = poll; });
  renderSites();
}

// ---------------------------------------------------------------------------
// 事件：站点卡片内输入 → 写回 state.sites（不重渲染，保持光标）
// ---------------------------------------------------------------------------

const sitesEl = document.getElementById('sites');

function onSiteInput(e) {
  const el = e.target;
  if (!el.dataset || el.dataset.idx == null) return;
  const idx = Number(el.dataset.idx);
  const field = el.dataset.field;
  if (!field) return;
  const site = state.sites[idx];
  if (!site) return;
  if (field === 'enabled') {
    site.enabled = el.checked;
    const card = sitesEl.querySelector(`[data-card="${idx}"]`);
    if (card) card.classList.toggle('disabled-site', !el.checked);
    updateCount();
  } else if (field === 'pollWifi') {
    site.pollWifi = el.checked;
  } else if (field === 'platforms') {
    site.platforms = Array.from(sitesEl.querySelectorAll(`input[data-idx="${idx}"][data-field="platforms"]:checked`)).map((x) => x.value);
  } else if (field.startsWith('anthropic.')) {
    site.anthropic = site.anthropic || {};
    site.anthropic[field.split('.')[1]] = el.value === '' ? '' : Number(el.value);
  } else if (field.startsWith('humanize.')) {
    site.humanize = site.humanize || {};
    const sub = field.split('.')[1];
    site.humanize[sub] = sub === 'enabled' ? el.checked : (el.value === '' ? '' : Number(el.value));
  } else {
    site[field] = el.value;
  }
}
sitesEl.addEventListener('input', onSiteInput);
sitesEl.addEventListener('change', onSiteInput);
sitesEl.addEventListener('click', (e) => {
  const del = e.target.closest('.act-del');
  if (del) {
    state.sites.splice(Number(del.dataset.idx), 1);
    renderSites();
  }
});

// ---------------------------------------------------------------------------
// 表单收集 / 提交 / 回填
// ---------------------------------------------------------------------------

function collectForm() {
  const scheduleType = document.getElementById('scheduleType').value;
  const payload = {
    name: document.getElementById('name').value.trim() || '未命名批量任务',
    scheduleType,
    platforms: getPlatforms(),
    shuffle: document.getElementById('shuffle').checked,
    pollWifi: document.getElementById('pollWifi').checked,
    targets: state.sites.map((s) => {
      const t = {
        id: s.id || uuid(),
        name: s.name || s.domain || '未命名站点',
        domain: s.domain,
        enabled: s.enabled !== false,
        platforms: (s.platforms && s.platforms.length) ? s.platforms : getPlatforms(),
        keywords: s.keywords,
        titleKeywords: s.titleKeywords,
        browseAnchor: s.browseAnchor || '关于我们',
        pollWifi: !!s.pollWifi,
        rememberedWifis: s.rememberedWifis || [],
        maxResultPages: s.maxResultPages != null ? Number(s.maxResultPages) : 5,
      };
      if (s.anthropic) t.anthropic = s.anthropic;
      if (s.humanize) t.humanize = s.humanize;
      if (s.clientId) t.clientId = s.clientId;
      return t;
    }),
  };
  if (scheduleType === 'daily') {
    payload.scheduleHour = Number(document.getElementById('scheduleHour').value);
    payload.scheduleMinute = Number(document.getElementById('scheduleMinute').value);
  } else {
    payload.intervalHours = Number(document.getElementById('intervalHours').value);
  }
  const id = document.getElementById('campaign-id').value;
  if (id) payload.id = id;
  return payload;
}

function resetForm() {
  document.getElementById('campaign-form').reset();
  document.getElementById('campaign-id').value = '';
  document.getElementById('form-title').textContent = '新建批量任务';
  document.getElementById('cancel-edit').hidden = true;
  document.getElementById('save-btn').textContent = '保存';
  document.getElementById('form-msg').textContent = '';
  setPlatforms(['baidu', 'google']);
  document.getElementById('scheduleType').dispatchEvent(new Event('change'));
  state.sites = [];
  renderSites();
}

function fillForm(c) {
  document.getElementById('campaign-id').value = c.id;
  document.getElementById('name').value = c.name;
  document.getElementById('scheduleType').value = c.scheduleType;
  document.getElementById('scheduleType').dispatchEvent(new Event('change'));
  if (c.scheduleType === 'daily') {
    document.getElementById('scheduleHour').value = c.scheduleHour ?? 9;
    document.getElementById('scheduleMinute').value = c.scheduleMinute ?? 0;
  } else {
    document.getElementById('intervalHours').value = c.intervalHours ?? 24;
  }
  setPlatforms(c.platforms && c.platforms.length ? c.platforms : ['baidu', 'google']);
  document.getElementById('shuffle').checked = c.shuffle !== false;
  document.getElementById('pollWifi').checked = !!c.pollWifi;
  // 载入每站配置
  state.sites = (c.targets || []).map((t) => ({
    id: t.id || uuid(),
    name: t.name,
    domain: t.domain,
    enabled: t.enabled !== false,
    platforms: (t.platforms && t.platforms.length) ? t.platforms : (c.platforms && c.platforms.length ? c.platforms : ['baidu', 'google']),
    keywords: t.keywords,
    titleKeywords: t.titleKeywords,
    browseAnchor: t.browseAnchor || '关于我们',
    pollWifi: t.pollWifi != null ? t.pollWifi : c.pollWifi,
    rememberedWifis: t.rememberedWifis || [],
    maxResultPages: t.maxResultPages != null ? t.maxResultPages : 5,
    anthropic: t.anthropic || undefined,
    humanize: t.humanize || undefined,
    clientId: t.clientId || undefined,
  }));
  renderSites();
  document.getElementById('form-title').textContent = '编辑批量任务';
  document.getElementById('cancel-edit').hidden = false;
  document.getElementById('save-btn').textContent = '更新';
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ---------------------------------------------------------------------------
// API / 列表 / 实时
// ---------------------------------------------------------------------------

async function api(path, method, body) {
  const res = await fetch(path, { method, headers: HEADERS, body: body ? JSON.stringify(body) : undefined });
  const j = await res.json();
  if (j.code !== 0) throw new Error(j.message || j.data?.error || '请求失败');
  return j.data;
}

async function loadList() {
  const data = await api('/api/campaign/list', 'GET');
  renderList(data.list || []);
  renderLive(data.state || {});
}

function renderList(list) {
  const wrap = document.getElementById('campaign-list');
  const empty = document.getElementById('list-empty');
  if (!list.length) {
    empty.hidden = false;
    wrap.innerHTML = '';
    return;
  }
  empty.hidden = true;
  wrap.innerHTML = list
    .map((c) => {
      const running = c.runState != null;
      const total = c.targets ? c.targets.length : 0;
      const enabledCount = c.total != null ? c.total : c.targets.filter((t) => t.enabled !== false).length;
      const progress = running ? `${c.runState.done.length}/${c.total != null ? c.total : enabledCount}` : '—';
      return `
      <div class="campaign-item" data-id="${c.id}">
        <div class="ci-head">
          <strong>${escAttr(c.name)}</strong>
          <span class="badge">${c.enabled ? '已启用' : '已停用'}</span>
          ${running ? '<span class="badge run">运行中 ' + progress + '</span>' : ''}
        </div>
        <div class="ci-meta">
          ${scheduleText(c)} · 平台 ${c.platforms.join('/')} · 站点 ${total} 个（启用 ${enabledCount}）
          · 打乱 ${c.shuffle ? '开' : '关'} · WIFI轮询 ${c.pollWifi ? '开' : '关'}
        </div>
        <div class="ci-meta">
          上次运行 ${fmtTime(c.lastRunAt)} ${c.lastRunStatus ? '(' + c.lastRunStatus + ')' : ''}
          · 下次 ${fmtTime(c.nextRunAt)}
        </div>
        <div class="ci-actions">
          <button class="btn-small act-trigger" data-id="${c.id}">立即跑一轮</button>
          <button class="btn-small act-edit" data-id="${c.id}">编辑</button>
          <button class="btn-small act-enable" data-id="${c.id}" data-enabled="${c.enabled}">${c.enabled ? '停用' : '启用'}</button>
          <button class="btn-small act-delete" data-id="${c.id}">删除</button>
        </div>
      </div>`;
    })
    .join('');
}

function renderLive(state) {
  const empty = document.getElementById('live-empty');
  const body = document.getElementById('live-body');
  const c = state.campaign;
  if (!c || c.runState == null) {
    empty.hidden = false;
    body.hidden = true;
    return;
  }
  empty.hidden = true;
  body.hidden = false;
  document.getElementById('live-name').textContent = c.name;
  document.getElementById('live-progress').textContent = `已跑 ${c.done}/${c.total}`;
  const pct = c.total ? Math.round((c.done / c.total) * 100) : 0;
  document.getElementById('live-bar').style.width = pct + '%';
  const cur = c.currentIndex != null && c.targets ? c.targets[c.currentIndex] : null;
  document.getElementById('live-current').textContent = cur ? `正在跑：${cur.name} (${cur.domain})` : '准备中…';
}

// ---- 事件绑定 ----

document.getElementById('scheduleType').addEventListener('change', (e) => {
  const isDaily = e.target.value === 'daily';
  document.getElementById('daily-fields').hidden = !isDaily;
  document.getElementById('interval-fields').hidden = isDaily;
});

document.getElementById('add-site').addEventListener('click', addSite);
document.getElementById('prefill').addEventListener('click', prefill);
document.getElementById('apply-defaults').addEventListener('click', applyDefaults);

document.getElementById('campaign-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = document.getElementById('form-msg');
  msg.style.color = '';
  // 基本校验
  if (state.sites.length === 0) {
    msg.style.color = 'crimson';
    msg.textContent = '请至少添加一个站点。';
    return;
  }
  for (const s of state.sites) {
    if (!s.domain || !s.keywords || !s.titleKeywords) {
      msg.style.color = 'crimson';
      msg.textContent = `站点「${s.name || s.domain || '未命名'}」需填写 域名 / 关键词 / 标题关键词。`;
      return;
    }
  }
  let payload;
  try {
    payload = collectForm();
  } catch (err) {
    msg.style.color = 'crimson';
    msg.textContent = '表单解析失败：' + err.message;
    return;
  }
  try {
    if (payload.id) await api('/api/campaign/update', 'POST', payload);
    else await api('/api/campaign/create', 'POST', payload);
    msg.textContent = '已保存。';
    resetForm();
    await loadList();
  } catch (err) {
    msg.style.color = 'crimson';
    msg.textContent = '保存失败：' + err.message;
  }
});

document.getElementById('cancel-edit').addEventListener('click', resetForm);

document.getElementById('campaign-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  const id = btn.dataset.id;
  try {
    if (btn.classList.contains('act-trigger')) {
      await api('/api/campaign/trigger', 'POST', { id });
      await loadList();
    } else if (btn.classList.contains('act-edit')) {
      const data = await api('/api/campaign/list', 'GET');
      const c = (data.list || []).find((x) => x.id === id);
      if (c) fillForm(c);
    } else if (btn.classList.contains('act-enable')) {
      await api('/api/campaign/enable', 'POST', { id, enabled: btn.dataset.enabled !== 'true' });
      await loadList();
    } else if (btn.classList.contains('act-delete')) {
      if (!confirm('确认删除该批量任务？')) return;
      await api('/api/campaign/delete', 'POST', { id });
      await loadList();
    }
  } catch (err) {
    alert('操作失败：' + err.message);
  }
});

if (window.io) {
  const socket = window.io({ auth: { token: TOKEN }, query: { token: TOKEN } });
  socket.on('campaign:state', (state) => renderLive(state));
}

setInterval(() => {
  api('/api/campaign/state', 'GET').then(renderLive).catch(() => {});
}, 5000);

resetForm();
loadList().catch((e) => {
  document.getElementById('list-empty').textContent = '加载失败：' + e.message;
});
