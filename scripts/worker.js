'use strict';

/**
 * scripts/worker.js
 * ---------------------------------------------------------------------------
 * worker 子进程入口（由 core/taskManager.js 经 child_process.fork 启动）。
 *
 * IPC 协议（与架构 8.6 一致）：
 *   主进程 → worker: { type:'start', config }           启动任务
 *                  { type:'control', action:'pause'|'stop' }  控制指令
 *   worker → 主进程: { type:'progress', event }         单条进度事件
 *                  { type:'paused'|'stopped'|'done'|'error', event }  终态/状态变化
 *
 * --------------------------------------------------------------------------
 * 任务流程（v0.3.20 重构，按用户设计）：
 *
 *   同时勾选「百度 + 谷歌」时，两个平台为【独立阶段】，各自统计一份数据：
 *
 *   阶段一 · 百度：
 *     - 若 pollWifi：按 WiFi 轮询（切换 N 次 WiFi，每次跑一次百度流程）；
 *       否则只跑当前网络一次。百度走【本机真实 IP / 当前 WiFi】，**不碰 VPN**。
 *     - 阶段结束 → 生成并保存【百度完成度统计】+ 推送一条 TASK_STATS。
 *
 *   阶段二 · 谷歌：
 *     - 先开 VPN（vpnController.getAvailableMainNodes 探测「主节点」组，
 *       剔除【超时】/不可达节点），得可用节点列表；
 *     - 按【VPN 可用节点】轮询（每轮 selectNode 切一个节点 + 重拉带代理 Chrome），
 *       跑一次谷歌流程；谷歌走【本地网线 + VPN 节点】，**不切 WiFi**。
 *     - 无可用节点 → ALERT + 跳过谷歌（记录 skipped 统计）。
 *     - 阶段结束 → 生成并保存【谷歌完成度统计】+ 推送一条 TASK_STATS。
 *
 *   两份统计独立（文件名 -baidu / -google），进度页分别弹出「完成度总结」卡片。
 *
 * --------------------------------------------------------------------------
 * 可测试性：runTask(config, emit, opts)，opts 可注入 engineFactory / wifi /
 * vpn / statsModule / sleep，便于单测在不切真网 / 不起 Chrome / 不碰真 VPN 的情况下
 * 验证分阶段与节点轮询逻辑。
 *
 * 向后兼容：当 config.rounds 缺失时（旧调用 / 旧单测），走 runLegacy 分支，
 * 行为与 v0.3.19 完全一致（整段 engine.run 包在 WiFi 轮询外层，一份混合统计）。
 */

const fs = require('fs');
const path = require('path');
const { TaskEngine } = require('../core/taskEngine');
const VpnController = require('../core/vpnController');
const wifi = require('../core/wifiManager');
const taskStats = require('../core/taskStats');
const P = require('../core/progressEvent');
const { EventType, TaskStatus } = P;

/** 向主进程回传一条 IPC 消息（确保父进程存在） */
function send(type, event) {
  if (process.send) {
    process.send({ type: type, event: event || null });
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 毫秒格式化为紧凑时长串，如 2m23s / 143s，用于节点级进度日志 */
function fmtDur(ms) {
  const s = Math.max(0, Math.round((ms || 0) / 1000));
  return s >= 60 ? (Math.floor(s / 60) + 'm' + (s % 60) + 's') : (s + 's');
}

/** 失败重试前的短暂停顿（毫秒）；可通过 AUTOCLAW_WIFI_RETRY_GAP_MS 覆盖 */
const RETRY_GAP_MS = parseInt(process.env.AUTOCLAW_WIFI_RETRY_GAP_MS, 10) || 2000;
/** WiFi 切换失败后的应用层重试次数（缓解偶发竞争/瞬时失败，如紧挨切网时 WlanConnect 竞争）；可用 AUTOCLAW_WIFI_SWITCH_RETRY 覆盖 */
const WIFI_SWITCH_MAX_RETRY = parseInt(process.env.AUTOCLAW_WIFI_SWITCH_RETRY, 10) || 3;

/** 终态优先级：FAILED > STOPPED/PAUSED > COMPLETED */
function worstStatus(a, b) {
  const rank = {
    [TaskStatus.FAILED]: 3,
    [TaskStatus.STOPPED]: 2,
    [TaskStatus.PAUSED]: 2,
    [TaskStatus.COMPLETED]: 1,
  };
  return (rank[b] != null ? rank[b] : 1) >= (rank[a] != null ? rank[a] : 1) ? b : a;
}

// 模块级控制信号（由 IPC control 消息设置，供阶段循环在安全点检查）
let engine = null;
let abort = false;
let abortStatus = TaskStatus.STOPPED;

/**
 * 保守 SSID 归一化键：剥离常见路由品牌前缀与频段后缀，用于去重判断。
 * 目的：同物理路由的 2.4G/5G 双频（如 HUAWEI-805 与 HUAWEI-805_5G 与 805_5G）
 * 归一化后相同，只保留一个，避免在百度阶段对同一个网络重复点击目标站。
 * 仅当剥离后完全一致才合并，误并概率极低。
 * @param {string} ssid
 * @returns {string}
 */
function normalizeSsidKey(ssid) {
  if (!ssid) return '';
  let s = String(ssid).trim().toLowerCase();
  s = s.replace(/^(huawei|chinanet|cmcc|tp-link|tenda|mercury|xiaomi|redmi|mi|fast|ruijie|phicomm|honor|asus|netgear|d-link|linksys)[-_]/, '');
  s = s.replace(/[-_ ]?(2\.4|5|5\.8)[gG]$/, '');
  return s;
}

/**
 * 归一化「地域节点偏好」为大写地区码数组（v0.3.59）。
 *
 * 兼容两种落库形态，避免配置来源不同导致偏好静默失效：
 *   - 数组（create 经 normalizeCampaignSpec / taskConfig 规整）：['TW','HK']
 *   - 字符串（update 直接覆盖、或手工改库）：'TW|HK' / 'TW、HK'
 *
 * @param {string|string[]|null} raw
 * @returns {string[]} 空数组＝未配置（不启用偏好排序）
 */
function normalizePrefTokens(raw) {
  if (Array.isArray(raw)) {
    return raw.map((x) => String(x).trim().toUpperCase()).filter(Boolean);
  }
  if (typeof raw === 'string' && raw.trim()) {
    return raw.split(/[|、,，;；\s]+/).map((x) => x.trim().toUpperCase()).filter(Boolean);
  }
  return [];
}

/**
 * 构建 WIFI 轮询序列（仅 pollWifi）：优先面板「已存」集合，回退可见且本机已存凭证。
 * 返回 { seq, usedRemembered, sourceDesc, dedupDropped }。
 */
async function buildWifiSeq(config, wm) {
  const current = await wm.getCurrentSsid();
  let source;
  let usedRemembered = false;
  if (Array.isArray(config.rememberedWifis) && config.rememberedWifis.length) {
    source = config.rememberedWifis.slice();
    usedRemembered = true;
  } else {
    source = await wm.getConnectableNetworks();
  }
  const visible = await wm.listNetworks();
  const visibleSet = new Set(visible.map((n) => n.ssid));
  // 隐藏网络不广播 SSID，扫描里永远看不到；但只要本机存有其凭证（Windows profile）
  // 且该 profile 标了 nonBroadcast，connectSaved 就能凭 profile 名直连。
  //
  // 判据优先级：
  //   1) Windows profile 的 nonBroadcast 标记（权威）——面板「本机已存 WiFi」可一键
  //      标记，隐藏网连接成功时也会自动带上。系统层面已声明「即使不广播也连接」，
  //      说明用户确认这是隐藏网络，扫不到属正常，必须纳入轮询。
  //   2) config.hiddenWifis 前端白名单（补充/兼容，且要求本机确有 profile）。
  //
  // ⚠️ 仍不能一律放行「所有已存 profile」：本机常残留换地点后再也扫不到的旧网络，
  // 全放行会让每轮挨个尝试并失败（每个 10s+ 且刷屏日志），拖慢任务像卡死。
  // 未标隐藏的普通网络仍严格按可见性过滤。
  const hiddenWhitelist = new Set(
    Array.isArray(config.hiddenWifis) ? config.hiddenWifis.filter(Boolean) : [],
  );
  const hiddenProfileSet = new Set();
  if (typeof wm.listSavedProfilesDetailed === 'function') {
    try {
      const detailed = await wm.listSavedProfilesDetailed();
      (detailed || []).forEach((p) => {
        if (p && p.hidden && p.ssid) hiddenProfileSet.add(p.ssid);
      });
    } catch (e) {
      /* 读取失败则退回仅用前端白名单 */
    }
  }
  let savedSet = null;
  if (hiddenWhitelist.size && typeof wm.listSavedProfiles === 'function') {
    try {
      savedSet = await wm.listSavedProfiles();
    } catch (e) {
      savedSet = new Set();
    }
  }
  const isHiddenConnectable = (s) =>
    hiddenProfileSet.has(s) || (hiddenWhitelist.has(s) && (!savedSet || savedSet.has(s)));
  const beforeLen = source.length;
  let pool = source.filter((s) => visibleSet.has(s) || isHiddenConnectable(s));
  const excludedNotVisible = beforeLen - pool.length;
  if (pool.length === 0) pool = source.slice();

  // 归一化去重（保守）：剥离品牌前缀/频段后缀后相同 → 视为同一物理路由，只保留首个。
  // 避免 2.4G/5G 双频或品牌前缀变体被当作不同网络重复跑。
  const seenKeys = new Set();
  const dedupDropped = [];
  const deduped = [];
  for (const s of pool) {
    const key = normalizeSsidKey(s);
    if (seenKeys.has(key)) {
      dedupDropped.push(s);
      continue;
    }
    seenKeys.add(key);
    deduped.push(s);
  }
  pool = deduped;
  if (current && !pool.includes(current) && visibleSet.has(current)) {
    pool.unshift(current);
  }
  if (current && pool.includes(current)) {
    const ci = pool.indexOf(current);
    if (ci > 0) {
      const [c] = pool.splice(ci, 1);
      pool.unshift(c);
    }
  }
  const sourceDesc = usedRemembered
    ? ('面板『已存』集合遍历 ' + pool.length + ' 个 WIFI（共 ' + beforeLen + ' 个已存' +
      (excludedNotVisible ? '，已剔除不可见 ' + excludedNotVisible + ' 个' : '') +
      (dedupDropped.length ? '，已去重 ' + dedupDropped.length + ' 个疑似同路由不同频段（' + dedupDropped.join('、') + '）' : '') + '）')
    : ('兜底遍历 ' + pool.length + ' 个 WIFI（可见且本机已存凭证，未收到面板已存集合' +
      (dedupDropped.length ? '，已去重 ' + dedupDropped.length + ' 个' : '') + '）');
  return { seq: pool, usedRemembered, sourceDesc, dedupDropped };
}

// ===========================================================================
// 入口分流
// ===========================================================================
async function runTask(config, emit, opts) {
  opts = opts || {};
  const wm = opts.wifi || wifi;
  const statsMod = opts.statsModule || taskStats;
  const vpn = opts.vpn || VpnController;
  const vpnLauncher = opts.vpnLauncher || require('../core/vpnLauncher');
  const makeEngine = opts.engineFactory ||
    ((c, e) => new TaskEngine(c, e, { vpn: opts.vpn || VpnController }));

  // legacy：无 rounds（旧调用 / 旧单测）→ 完全沿用 v0.3.19 行为
  if (!Array.isArray(config.rounds) || config.rounds.length === 0) {
    return runLegacy(config, emit, { wm, statsMod, vpn, makeEngine, opts });
  }

  // phased：按平台拆分，独立阶段 + 独立统计
  return runPhased(config, emit, { wm, statsMod, vpn, vpnLauncher, makeEngine, opts });
}

// ===========================================================================
// 分阶段流程（v0.3.20）
// ===========================================================================
async function runPhased(config, emit, deps) {
  const { wm, statsMod, vpn, vpnLauncher, makeEngine, opts } = deps;
  const wait = opts.sleep || sleep;
  const retryWait = opts.retrySleep || ((ms) => sleep(ms));
  const MAX_RETRIES = (opts.maxRetries != null)
    ? opts.maxRetries
    : (parseInt(process.env.AUTOCLAW_WIFI_FLOW_RETRIES, 10) || 3);

  const baiduRounds = config.rounds.filter((r) => r.platform === 'baidu');
  const googleRounds = config.rounds.filter((r) => r.platform === 'google');
  const kw0 = (config.keywords && config.keywords.length === 1) ? config.keywords[0] : null;

  let currentRun = null;
  const phasedEmit = (ev) => {
    if (ev && ev.type === EventType.VPN_INFO && ev.vpn) statsMod.recordVpn(currentRun, ev.vpn);
    if (ev && ev.type === EventType.TASK_END) return; // 终态由 worker 在末尾统一发
    emit(ev);
  };

  abort = false;
  abortStatus = TaskStatus.STOPPED;
  let finalStatus = TaskStatus.COMPLETED;

  // ---------------------------------------------------------------------
  // 阶段一 · 百度（WiFi 轮询，不碰 VPN）
  // ---------------------------------------------------------------------
  if (baiduRounds.length) {
   try {
    const wifiSeq = config.pollWifi ? await buildWifiSeq(config, wm) : null;
    const seq = wifiSeq ? wifiSeq.seq : [null];
    if (wifiSeq) {
      emit(P.makeProgress({
        taskId: config.taskId,
        type: EventType.WIFI_POLL,
        message: '【百度阶段】WIFI 轮询已启用：按' + wifiSeq.sourceDesc +
          '，从『' + (seq[0] || '当前网络') + '』开始',
        wifiIndex: 0,
        wifiTotal: seq.length,
      }));
    } else {
      emit(P.makeProgress({
        taskId: config.taskId,
        type: EventType.WIFI_POLL,
        message: '【百度阶段】单网络模式（仅当前网络一次，不走 VPN）',
      }));
    }

    const run = statsMod.newRun(config.taskId, {
      platform: 'baidu',
      pollWifi: config.pollWifi,
      startedAt: new Date().toISOString(),
      keyword: kw0,
      keywords: config.keywords || null,
      clientId: config.clientId,
      wifiSource: config.pollWifi ? (wifiSeq && wifiSeq.usedRemembered ? 'remembered' : 'fallback') : null,
    });
    currentRun = run;
    const st = await runBaiduLoop(config, baiduRounds, seq, {
      wm, makeEngine, wait, retryWait, MAX_RETRIES, emit: phasedEmit, run, statsMod,
    });
    finalStatus = worstStatus(finalStatus, st);

    run.endedAt = new Date().toISOString();
    const saved = statsMod.save(run, 'baidu');
    emit(P.makeProgress({
      taskId: config.taskId,
      type: EventType.TASK_STATS,
      message: '【百度】完成度统计已生成（' + run.summary.completedWifi + '/' + run.summary.totalWifi +
        ' 完成，' + run.summary.totalRetries + ' 次重试）—— ' + saved.mdFile,
      stats: run.summary,
      statsDetail: run,
    }));
   } catch (baiduErr) {
    // 百度阶段异常：保底落盘部分统计并回传错误，避免像 1617 那样「无完成度文件、进度日志无痕迹」直接判 failed。
    console.error('[worker] 百度阶段异常：', baiduErr && baiduErr.stack ? baiduErr.stack : baiduErr);
    if (currentRun) {
      try {
        currentRun.endedAt = new Date().toISOString();
        statsMod.save(currentRun, 'baidu');
      } catch (_) {}
    }
    emit(P.makeProgress({
      taskId: config.taskId,
      type: EventType.ALERT,
      message: '【百度阶段】异常中断：' + (baiduErr && baiduErr.message ? baiduErr.message : baiduErr),
    }));
    if (finalStatus !== TaskStatus.PAUSED && finalStatus !== TaskStatus.STOPPED) finalStatus = TaskStatus.FAILED;
    reportFatal(baiduErr);
   }
  }

  // ---------------------------------------------------------------------
  // 阶段二 · 谷歌（本地网线 + VPN 节点轮询）
  // ---------------------------------------------------------------------
  if (googleRounds.length) {
    // 步骤1 · 确认 Mihomo 内核可用：autoclaw 的 Chrome 直连 127.0.0.1:7890，
    // 不依赖 Windows 系统代理。故只需确认内核在跑（7890 监听）即可，不可用时尝试拉起。
    emit(P.makeProgress({
      taskId: config.taskId,
      type: EventType.STEP,
      step: { step: 'vpn_on', status: 'running', detail: '正在确认 Mihomo 内核/7890 可用…' },
    }));
    const vpnLaunch = await vpnLauncher.ensureOn({ emit, taskId: config.taskId });
    if (!vpnLaunch.ok) {
      emit(P.makeProgress({
        taskId: config.taskId,
        type: EventType.STEP,
        step: { step: 'vpn_on', status: 'failed', detail: vpnLaunch.error || 'Mihomo 内核未启动（7890 未监听）' },
      }));
    }

    let diag;
    try {
      emit(P.makeProgress({
        taskId: config.taskId,
        type: EventType.VPN_INFO,
        message: '【谷歌阶段】开始探测 VPN 主节点（最多等待 90s，超时则跳过谷歌）…',
      }));
      diag = await vpn.getAvailableMainNodes();
      emit(P.makeProgress({
        taskId: config.taskId,
        type: EventType.VPN_INFO,
        message: '【谷歌阶段】VPN 主节点探测完成：可用 ' + (diag.available ? diag.available.length : 0) + '/' + (diag.total || 0) +
          (diag.error ? '（诊断异常：' + diag.error + '）' : ''),
      }));
    } catch (e) {
      emit(P.makeProgress({
        taskId: config.taskId,
        type: EventType.ALERT,
        message: '【谷歌阶段】VPN 主节点探测异常：' + (e && e.message ? e.message : e) + '，跳过谷歌',
      }));
      diag = { available: [], error: e && e.message ? e.message : String(e) };
    }
    const run = statsMod.newRun(config.taskId, {
      platform: 'google',
      pollWifi: config.pollWifi,
      startedAt: new Date().toISOString(),
      keyword: kw0,
      keywords: config.keywords || null,
      clientId: config.clientId,
      wifiSource: null,
    });
    currentRun = run;

    if (!diag || !diag.available || diag.available.length === 0) {
      // 无可用节点：跳过谷歌（记录 skipped，不计入失败率）
      const skipVpn = {
        availableCount: 0,
        total: diag ? diag.total : 0,
        skipped: true,
        proxyUrl: diag ? diag.proxyUrl : null,
        error: diag ? diag.error : '无可用节点',
      };
      statsMod.recordVpn(run, skipVpn);
      statsMod.recordWifi(run, {
        ssid: null, via: 'vpn', status: 'skipped', attempts: 0, retriesUsed: 0,
        durationMs: 0,
        error: 'VPN 无可用主节点（已剔除超时/不可达），跳过谷歌任务',
      });
      emit(P.makeProgress({
        taskId: config.taskId,
        type: EventType.ALERT,
        message: 'VPN 无可用主节点（已剔除超时/不可达），跳过谷歌任务：' + (diag && diag.error ? diag.error : '无可用节点'),
      }));
      emit(P.makeProgress({
        taskId: config.taskId,
        type: EventType.VPN_INFO,
        message: 'VPN 无可用主节点，谷歌任务跳过',
        vpn: skipVpn,
      }));
      finalStatus = worstStatus(finalStatus, TaskStatus.COMPLETED);
    } else {
      // 单节点上限（默认轮询全部可用节点）：设 AUTOCLAW_GOOGLE_MAX_NODES=N
      // 只跑前 N 个节点。用于「把单个流程跑通」时仅验证一个节点、不轮询全部。
      const nodeCapEnv = Number(process.env.AUTOCLAW_GOOGLE_MAX_NODES) || 0;
      const targetCount = nodeCapEnv > 0
        ? Math.max(1, Math.min(diag.available.length, nodeCapEnv))
        : diag.available.length;
      emit(P.makeProgress({
        taskId: config.taskId,
        type: EventType.WIFI_POLL,
        message: '【谷歌阶段】VPN 已开启：主节点可用 ' + diag.available.length + '/' + diag.total +
          ' 个（已剔除超时/不可达），目标跑满 ' + targetCount + ' 个成功节点（失败自动换备选节点补跑，本地网线，不切 WiFi）' +
          (targetCount < diag.available.length ? '（受 AUTOCLAW_GOOGLE_MAX_NODES=' + targetCount + ' 限制）' : ''),
        wifiIndex: 0,
        wifiTotal: targetCount,
      }));

      // 补跑模型：维护「尚未尝试过的备用节点池」(pool) + 「已用节点」(used)。
      // 逐个取 pool 头节点跑谷歌；成功则计入成功数；失败则记 failed 并自动从 pool 取下一个补跑；
      // 直到成功数达标（targetCount）或 pool 耗尽（不留缺口，有多少成功算多少）。
      try {
      const pool = diag.available.slice();
      // v0.3.59：地域节点偏好前置（campaign/target 配 preferredNodes，如 'TW|HK'）。
      // 背景：搜索结果高度地域化——台湾本地站在日本/美国出口下根本排不上，而通用降权规则
      // （默认 /GPT/i）恰好把港台节点全排到末尾，再叠加「连续 N 个节点定位失败即止损」，
      // 会导致唯一有效的节点一个都没跑到（任务 31b21aae 即此坑：8 个港台节点全被跳过）。
      // 故：命中偏好地区的节点提到最前执行，并豁免下方的高标记降权。
      const preferredNodes = normalizePrefTokens(config.preferredNodes);
      const preferredHit = preferredNodes.length
        ? pool.filter((n) => {
          const up = String(n).toUpperCase();
          return preferredNodes.some((p) => up.indexOf(p) !== -1);
        })
        : [];
      if (preferredHit.length) {
        const rest = pool.filter((n) => preferredHit.indexOf(n) === -1);
        pool.length = 0;
        pool.push(...preferredHit, ...rest);
        emit(P.makeProgress({
          taskId: config.taskId,
          type: EventType.VPN_INFO,
          message: '【谷歌阶段】已按地域偏好（' + preferredNodes.join('/') + '）前置 ' + preferredHit.length +
            ' 个节点：' + preferredHit.join('、'),
        }));
      }
      // v0.3.40：谷歌软降权高标记共享节点（如 [HK]香港直连HK3 GPT 这类热门出口最易被 Google 标记）。
      // 默认开启：把命中模式的节点移到 pool 末尾，优先用低标记节点；若前面成功数已达标，高标记节点不会被使用。
      // 设 AUTOCLAW_GOOGLE_AVOID_HOT_NODES=0 关闭；AUTOCLAW_GOOGLE_AVOID_NODE_PATTERN 可覆盖匹配模式（默认 /GPT/i）。
      // v0.3.59：地域偏好命中的节点豁免降权——地域正确优先于标记风险，否则前置会被降权重新挤到末尾。
      if (process.env.AUTOCLAW_GOOGLE_AVOID_HOT_NODES !== '0') {
        const avoidPat = process.env.AUTOCLAW_GOOGLE_AVOID_NODE_PATTERN
          ? new RegExp(process.env.AUTOCLAW_GOOGLE_AVOID_NODE_PATTERN, 'i')
          : /GPT/i;
        const isPreferred = (n) => preferredHit.indexOf(n) !== -1;
        const hot = pool.filter((n) => avoidPat.test(n) && !isPreferred(n));
        if (hot.length) {
          const head = pool.filter(isPreferred);
          const mid = pool.filter((n) => !avoidPat.test(n) && !isPreferred(n));
          pool.length = 0;
          pool.push(...head, ...mid, ...hot);
          emit(P.makeProgress({
            taskId: config.taskId,
            type: EventType.VPN_INFO,
            message: '【谷歌阶段】已软降权 ' + hot.length + ' 个高标记节点（移至末尾）：' + hot.join('、') +
              (head.length ? '（其中 ' + head.length + ' 个地域偏好节点已豁免降权）' : ''),
          }));
        }
      }
      const usedOrder = [];
      let successCount = 0;
      let firstSuccessNode = null;
      let pollIndex = 0;
      // 谷歌验证码累计止损：累计 N 个「失败且命中验证码」节点即跳剩余 VPN 节点，
      // 避免整轮被验证逐个卡死（百度已有 BAIDU_CAPTCHA_ABORT_THRESHOLD，谷歌此前缺失）。
      let gCaptchaNodeCount = 0;
      // 节点内重试：单个节点 FAILED（动作超时 / VPN 抖动 / 区域化解析失败等瞬时故障）后，
      // 在该节点上重跑 AUTOCLAW_GOOGLE_NODE_RETRIES 次（默认 2，共最多 3 次尝试），任一次成功即计入；
      // 全失败才丢弃，避免 VPN 节点瞬时抖动被直接判死、拉低整体完成率。
      const nodeRetries = Math.max(0, Number(process.env.AUTOCLAW_GOOGLE_NODE_RETRIES) || 2);
      // 谷歌专用单动作超时（默认 60s，远低于全局 150s）：死节点更快超时、更快进入重试，
      // 不影响验证码轮询（谷歌验证码等待用独立 CAPTCHA_POLL_INTERVAL 循环，不依赖 actionTimeoutMs）。
      const googleTimeoutMs = Number(process.env.AUTOCLAW_GOOGLE_ACTION_TIMEOUT) || 60000;
      // 谷歌验证码止损阈值：累计 N 个「失败且命中验证码」节点即跳过剩余（默认 3，env 可配）。
      const GOOGLE_CAPTCHA_ABORT_THRESHOLD = parseInt(process.env.AUTOCLAW_GOOGLE_CAPTCHA_ABORT, 10) || 3;
      // 谷歌「目标排不上」连续失败止损（对齐百度）：连续 N 个节点均因「定位不到目标」失败即放弃，
      // 避免空耗剩余 VPN 节点。env AUTOCLAW_GOOGLE_LOCFAIL_ABORT 可配。
      const GOOGLE_LOCFAIL_ABORT_THRESHOLD = parseInt(process.env.AUTOCLAW_GOOGLE_LOCFAIL_ABORT, 10) || 3;
      let gLocFailCount = 0;

      while (successCount < targetCount && pool.length > 0) {
        const node = pool.shift();
        usedOrder.push(node);
        pollIndex += 1;
        if (abort) { finalStatus = worstStatus(finalStatus, abortStatus); break; }
        // 「目标排不上」连续失败止损（对齐百度）：连续 N 个节点均因「定位不到目标」失败即放弃剩余 VPN 节点。
        if (gLocFailCount >= GOOGLE_LOCFAIL_ABORT_THRESHOLD) {
          emit(P.makeProgress({
            taskId: config.taskId,
            type: EventType.ALERT,
            message: '【谷歌阶段】连续 ' + gLocFailCount + ' 个节点均「定位不到目标域名」（站点未进入搜索排名），放弃剩余 ' + pool.length + ' 个 VPN 节点',
          }));
          break;
        }
        let nodeAttempt = 0, gT0 = 0, gT1 = 0;
        try {
          try {
            await vpn.selectNode(node);
          } catch (e) { /* 切节点失败不阻断，沿用 */ }

          const preset = {
            node: node,
            availableCount: diag.available.length,
            total: diag.total,
            proxyUrl: diag.proxyUrl,
            availableDetail: diag.availableDetail || null,
          };
          // 节点内重试循环：该节点最多尝试 nodeRetries+1 次（含首次），任一次成功即停。
          let st = TaskStatus.FAILED;
          let nodeErr = null;
          let nodeCaptcha = false; // 节点级累积：任一次尝试命中验证码即记 true（修复「验证码在失败重试里触发、成功在另一次尝试」导致漏记）
          while (nodeAttempt <= nodeRetries) {
          nodeAttempt += 1;
          // 给谷歌单独注入更短的单动作超时（不影响百度 150s 验证码余量）。
          const gConfig = Object.assign({}, config, {
            strategy: Object.assign({}, config.strategy, { actionTimeoutMs: googleTimeoutMs }),
            // v0.3.42：钉死平台为 google，确保持久 profile 等平台专属行为命中。
            // 否则 taskEngine 取 config.rounds[0].platform（百度排第一）→ _platform 误判为
            // 'baidu' → _googleProfileDir 始终为 null，AUTOCLAW_GOOGLE_PERSIST_PROFILE 形同虚设。
            platforms: ['google'],
          });
          const eng = makeEngine(gConfig, phasedEmit);
          engine = eng;
          emit(P.makeProgress({
            taskId: config.taskId,
            type: EventType.WIFI_POLL,
            message: '【谷歌阶段】节点轮询 ' + pollIndex + '：切至『' + node + '』开始谷歌流程' +
              (pool.length > 0 ? '（剩余备选 ' + pool.length + ' 个）' : '') +
              (nodeAttempt > 1 ? '（节点内第 ' + nodeAttempt + ' 次尝试）' : ''),
            wifiIndex: pollIndex,
            wifiTotal: targetCount,
          }));
          gT0 = Date.now();
          const stRun = await eng.run(googleRounds, { vpnPreset: preset, disableCircuitBreak: true });
          gT1 = Date.now();
          st = stRun;
          nodeCaptcha = nodeCaptcha || !!(eng && eng.captchaHit);
          nodeErr = (eng && eng.lastErrorDetail) ? eng.lastErrorDetail : String(stRun);
          if (st === TaskStatus.COMPLETED) break;            // 成功即停
          if (st === TaskStatus.PAUSED || st === TaskStatus.STOPPED) break; // 控制态不重试
          if (abort) { finalStatus = worstStatus(finalStatus, abortStatus); break; }
          await retryWait(RETRY_GAP_MS); // 重试前短暂停顿，避免瞬时抖动叠加
        }
        const recStatus = st === TaskStatus.COMPLETED
          ? 'completed'
          : (st === TaskStatus.FAILED ? 'failed' : st);
        statsMod.recordWifi(run, {
          ssid: node, via: 'vpn', status: recStatus,
          attempts: nodeAttempt, retriesUsed: Math.max(0, nodeAttempt - 1),
          startedAt: new Date(gT0).toISOString(), endedAt: new Date(gT1).toISOString(),
          durationMs: Math.max(0, gT1 - gT0),
          found: !!(engine && engine.foundTarget),
          entered: !!(engine && engine.enteredTarget),
          landedUrl: engine ? engine.landedUrl || null : null,
          captcha: nodeCaptcha,
          error: st === TaskStatus.COMPLETED
            ? null
            : nodeErr,
        });
        console.error('[worker][节点] 谷歌 ' + pollIndex + '/' + targetCount + ' 『' + node + '』 ' + recStatus +
          ' 命中' + (st === TaskStatus.COMPLETED ? '✅' : '❌') + ' ' + fmtDur(gT1 - gT0) + ' 尝试' + nodeAttempt +
          ' 验证码' + (nodeCaptcha ? '有' : '无') +
          (st !== TaskStatus.COMPLETED ? ' err=' + nodeErr : ''));
        if (st === TaskStatus.COMPLETED) {
          successCount += 1;
          if (!firstSuccessNode) firstSuccessNode = node;
        }
        // 控制态（暂停/停止）优先，立即跳出整阶段
        if (st === TaskStatus.PAUSED || st === TaskStatus.STOPPED) {
          finalStatus = st;
          break;
        }
        // 谷歌验证码累计止损：累计 N 个「失败且命中验证码」节点即跳剩余 VPN 节点，
        // 避免整轮被验证逐个卡死（百度已有对应阈值，谷歌此前缺失）。
        if (st !== TaskStatus.COMPLETED && nodeCaptcha) gCaptchaNodeCount += 1;
        if (gCaptchaNodeCount >= GOOGLE_CAPTCHA_ABORT_THRESHOLD) {
          emit(P.makeProgress({
            taskId: config.taskId,
            type: EventType.ALERT,
            message: '【谷歌阶段】累计 ' + gCaptchaNodeCount + ' 个节点命中谷歌验证拦截，当前出口 IP 大概率被标记，跳过剩余 ' + pool.length + ' 个 VPN 节点',
          }));
          break; // 跳出外层 while（逐节点补跑循环）
        }
        // 「目标排不上」连续失败计数（对齐百度）：仅当该节点因 locateTarget（目标域名未出现）失败才累计，
        // 成功或瞬时故障清零；连续 N 个即放弃剩余 VPN 节点。
        if (st !== TaskStatus.COMPLETED && nodeErr && /(locateTarget|未出现在|未找到目标|目标域名[」』]?未出现)/.test(String(nodeErr))) {
          gLocFailCount += 1;
        } else {
          gLocFailCount = 0;
        }
        } catch (nodeRunErr) {
          // 单节点执行异常（含浏览器原生崩溃 / 启动失败 / 超时）：记录为失败并继续换下一个备选节点补跑，
          // 不再让单个坏节点拖垮整个谷歌阶段（修复「全 round success 却整任务 failed」的假失败）。
          console.error('[worker] 节点『' + node + '』执行异常：', nodeRunErr && nodeRunErr.stack ? nodeRunErr.stack : nodeRunErr);
          statsMod.recordWifi(run, {
            ssid: node, via: 'vpn', status: 'failed',
            attempts: nodeAttempt, retriesUsed: Math.max(0, nodeAttempt - 1),
            startedAt: new Date(gT0 || Date.now()).toISOString(), endedAt: new Date().toISOString(),
            durationMs: gT0 ? Math.max(0, Date.now() - gT0) : 0,
            found: false, landedUrl: null, captcha: false,
            error: nodeRunErr && nodeRunErr.message ? nodeRunErr.message : String(nodeRunErr),
          });
          console.error('[worker][节点] 谷歌 ' + pollIndex + '/' + targetCount + ' 『' + node + '』 failed 命中❌ ' +
            fmtDur(gT0 ? (Date.now() - gT0) : 0) + ' 尝试' + nodeAttempt + ' 验证码无 err=' +
            (nodeRunErr && nodeRunErr.message ? nodeRunErr.message : String(nodeRunErr)));
          emit(P.makeProgress({
            taskId: config.taskId,
            type: EventType.ALERT,
            message: '【谷歌阶段】节点『' + node + '』执行异常，跳过并补跑下一个：' + (nodeRunErr && nodeRunErr.message ? nodeRunErr.message : nodeRunErr),
          }));
        }
        // 每节点后增量落盘 google 统计，确保中途崩溃也能保留已完成节点的成果
        // 落盘前刷新 endedAt，使快照耗时基于真实墙钟（而非首节点结束时刻），与 taskStats.js 重算逻辑配合
        try { run.endedAt = new Date().toISOString(); statsMod.save(run, 'google'); } catch (_) {}
      }

      // 补跑模型下的整阶段终态判定：
      //   - 只要「尝试节点数达到 targetCount」（失败已被自动补跑填满，无缺口）且至少成功 1 个，
      //     整阶段视为完成；
      //   - 出现真实缺口（可用池不够 targetCount）或「一个都没成功」→ 阶段 FAILED。
      const reachedTarget = usedOrder.length >= targetCount;
      if (!reachedTarget || successCount === 0) {
        if (finalStatus !== TaskStatus.PAUSED && finalStatus !== TaskStatus.STOPPED) {
          emit(P.makeProgress({
            taskId: config.taskId,
            type: EventType.WIFI_POLL,
            message: '【谷歌阶段】未跑满目标：成功 ' + successCount + '/' + targetCount +
              ' 个' + (reachedTarget ? '（节点全失败）' : '，可用池已耗尽，缺口 ' + (targetCount - usedOrder.length) + ' 个'),
          }));
          finalStatus = TaskStatus.FAILED;
        }
      }

      statsMod.recordVpn(run, {
        availableCount: diag.available.length,
        total: diag.total,
        // 真实首个成功节点（取代旧版硬编码 available[0]，避免受限 AUTOCLAW_GOOGLE_MAX_NODES 时显示不准）
        usedNode: firstSuccessNode || (usedOrder.length ? usedOrder[0] : null),
        // 实际尝试过的完整节点列表（按尝试顺序，含成功/失败），用于报告「选用节点」如实展示全部实跑节点
        usedNodes: usedOrder.slice(),
        usedCount: successCount,
        targetCount: targetCount,
        proxyUrl: diag.proxyUrl,
        availableDetail: diag.availableDetail || null,
        polledBy: 'node',
      });
      } catch (phaseErr) {
        console.error('[worker] 谷歌阶段循环异常：', phaseErr && phaseErr.stack ? phaseErr.stack : phaseErr);
        emit(P.makeProgress({
          taskId: config.taskId,
          type: EventType.ALERT,
          message: '【谷歌阶段】循环异常中断：' + (phaseErr && phaseErr.message ? phaseErr.message : phaseErr),
        }));
        if (finalStatus !== TaskStatus.PAUSED && finalStatus !== TaskStatus.STOPPED) finalStatus = TaskStatus.FAILED;
      }

    }

    run.endedAt = new Date().toISOString();
    const saved = statsMod.save(run, 'google');
    emit(P.makeProgress({
      taskId: config.taskId,
      type: EventType.TASK_STATS,
      message: '【谷歌】完成度统计已生成（' + run.summary.completedWifi + '/' + run.summary.totalWifi +
        ' 完成，' + run.summary.totalRetries + ' 次重试）—— ' + saved.mdFile,
      stats: run.summary,
      statsDetail: run,
    }));
  }

  emit(P.makeProgress({
    taskId: config.taskId,
    type: EventType.TASK_END,
    status: finalStatus,
    message: 'worker 结束（分阶段：百度→谷歌）',
  }));
  return finalStatus;
}

/** 百度阶段：按 WiFi 序列循环跑百度流程（含单 WiFi 内失败重试） */
async function runBaiduLoop(config, baiduRounds, seq, deps) {
  const { wm, makeEngine, wait, retryWait, MAX_RETRIES, emit, run, statsMod } = deps;
  // 百度验证码累计止损阈值：同一出口 IP 一旦被百度风控，逐 WIFI 节点轮询必空耗数小时
  // （每个节点失败 4 次 × 120s 验证码轮询）。累计 N 个「失败且命中验证码」的节点即判定
  // 当前网络无望，跳过剩余 WIFI 节点，避免任务长期挂死。可用 env AUTOCLAW_BAIDU_CAPTCHA_ABORT 调整。
  const BAIDU_CAPTCHA_ABORT_THRESHOLD = parseInt(process.env.AUTOCLAW_BAIDU_CAPTCHA_ABORT, 10) || 3;
  // 「目标排不上」连续失败止损：站点根本不在搜索结果里时（err=[locateTarget] 目标域名未出现在…），
  // 逐 WIFI 节点轮询只会无限空耗（30 节点 × ~12min ≈ 6h 纯失败）。连续 N 个节点均因「定位不到目标」失败即
  // 放弃百度阶段、进入谷歌/下一站，避免整轮被单个排不上的站点焊死。env AUTOCLAW_BAIDU_LOCFAIL_ABORT 可配。
  const BAIDU_LOCFAIL_ABORT_THRESHOLD = parseInt(process.env.AUTOCLAW_BAIDU_LOCFAIL_ABORT, 10) || 3;
  let finalStatus = TaskStatus.COMPLETED;
  let captchaNodeCount = 0;
  let consecutiveLocFail = 0;

  for (let i = 0; i < seq.length; i += 1) {
    const ssid = seq[i];
    if (abort) { finalStatus = abortStatus; break; }
    // 百度验证码累计止损：累计 N 个「失败且命中验证码」节点即跳过剩余 WIFI（见阈值常量说明）
    if (captchaNodeCount >= BAIDU_CAPTCHA_ABORT_THRESHOLD) {
      emit(P.makeProgress({
        taskId: config.taskId, type: EventType.WIFI_POLL,
        message: '【百度阶段】累计 ' + captchaNodeCount + ' 个节点命中百度安全验证，当前网络/出口大概率被风控，跳过剩余 ' + (seq.length - i) + ' 个 WIFI 节点',
        wifiIndex: i + 1, wifiTotal: seq.length, ssid: '',
      }));
      break;
    }
    // 「目标排不上」连续失败止损：连续 N 个节点均因「定位不到目标域名」失败（站点未进入搜索排名），
    // 放弃百度阶段、进入谷歌/下一站，避免空耗剩余 WIFI 节点（见阈值常量说明）。
    if (consecutiveLocFail >= BAIDU_LOCFAIL_ABORT_THRESHOLD) {
      emit(P.makeProgress({
        taskId: config.taskId, type: EventType.WIFI_POLL,
        message: '【百度阶段】连续 ' + consecutiveLocFail + ' 个节点均「定位不到目标域名」（站点未进入搜索排名），放弃百度阶段，避免空耗剩余 ' + (seq.length - i) + ' 个 WIFI 节点',
        wifiIndex: i + 1, wifiTotal: seq.length, ssid: '',
      }));
      break;
    }
    if (i > 0 || (i === 0 && ssid && (await wm.getCurrentSsid()) !== ssid)) {
      if (ssid) {
        // 切换 WiFi 带重试：缓解偶发竞争 / 瞬时失败（如 ROSNET19 曾因紧挨上一网切换竞争被直接 skipped）。
        // v0.3.55 的 wlanconnect.ps1 已在 WlanConnect 前断开当前连接，这里再加应用层重试兜底。
        let cr = null;
        for (let sw = 1; sw <= WIFI_SWITCH_MAX_RETRY; sw += 1) {
          cr = await wm.connectSaved(ssid);
          if (cr && cr.ok) break;
          if (sw < WIFI_SWITCH_MAX_RETRY) {
            emit(P.makeProgress({
              taskId: config.taskId, type: EventType.WIFI_POLL,
              message: '切换『' + ssid + '』第 ' + sw + ' 次失败（' + (cr ? cr.message : '无返回') + '），' + RETRY_GAP_MS + 'ms 后重试',
              wifiIndex: i + 1, wifiTotal: seq.length, ssid: ssid,
            }));
            await retryWait(RETRY_GAP_MS);
          }
        }
        emit(P.makeProgress({
          taskId: config.taskId,
          type: EventType.WIFI_POLL,
          message: (cr.ok ? '已切换至『' + ssid + '』' : '切换『' + ssid + '』失败：' + cr.message) + '，停留 5 秒',
          wifiIndex: i + 1,
          wifiTotal: seq.length,
          ssid: ssid,
        }));
        if (!cr.ok) {
          statsMod.recordWifi(run, {
            ssid: ssid, via: 'wifi', status: 'skipped', attempts: 0, retriesUsed: 0,
            durationMs: 0,
            error: '切换失败：' + cr.message,
          });
          console.error('[worker][节点] 百度 ' + (i + 1) + '/' + seq.length + ' 『' + ssid + '』 skipped 命中— 0ms 尝试0 err=切换失败：' + cr.message);
          continue;
        }
        await wait(5000);
      }
    }

    if (config.pollWifi) {
      emit(P.makeProgress({
        taskId: config.taskId,
        type: EventType.WIFI_POLL,
        message: '【百度阶段】WIFI 轮询 ' + (i + 1) + '/' + seq.length + '：使用『' + (ssid || '当前网络') + '』开始百度流程',
        wifiIndex: i + 1,
        wifiTotal: seq.length,
        ssid: ssid || '',
      }));
    }

    let nodeCaptcha = false; // 节点级：任一重试尝试命中验证码即记 true（修复 perWifi.captcha 漏记）
    let attempts = 0;
    let terminal = TaskStatus.FAILED;
    let ok = false;
    let controlBreak = false;
    const attT0 = Date.now();
    for (let r = 0; r <= MAX_RETRIES; r += 1) {
      attempts += 1;
      const eng = makeEngine(config, emit);
      engine = eng;
      const st = await eng.run(baiduRounds, { disableCircuitBreak: true });
      nodeCaptcha = nodeCaptcha || !!(eng && eng.captchaHit);
      if (st === TaskStatus.PAUSED || st === TaskStatus.STOPPED) {
        terminal = st; controlBreak = true; break;
      }
      if (st === TaskStatus.COMPLETED) { terminal = st; ok = true; break; }
      terminal = TaskStatus.FAILED;
      if (r < MAX_RETRIES) {
        emit(P.makeProgress({
          taskId: config.taskId, type: EventType.WIFI_POLL,
          message: '『' + (ssid || '当前网络') + '』第 ' + attempts + ' 次流程失败（' + (r + 1) + '/' + MAX_RETRIES + ' 重试），即将重跑',
          wifiIndex: i + 1, wifiTotal: seq.length, ssid: ssid || '',
        }));
        await retryWait(RETRY_GAP_MS);
        continue;
      }
    }
    const attT1 = Date.now();

    const recStatus = ok ? 'completed' : (terminal === TaskStatus.FAILED ? 'failed' : terminal);
    // 可观测性：优先用引擎记录的最后失败步骤+错误详情（含步骤名，如「ENTER 跳转目标站超时…」），
    // 不再写死「流程连续失败 N 次」，便于日志直接定位卡点。
    const lastErr = (engine && engine.lastErrorDetail) ? String(engine.lastErrorDetail) : null;
    const failedStep = lastErr ? lastErr.split(/[：:]/)[0].slice(0, 48) : null;
    statsMod.recordWifi(run, {
      ssid: ssid || null, via: 'wifi', status: recStatus,
      attempts: attempts, retriesUsed: Math.max(0, attempts - 1),
      startedAt: new Date(attT0).toISOString(), endedAt: new Date(attT1).toISOString(),
      durationMs: Math.max(0, attT1 - attT0),
      found: !!(engine && engine.foundTarget),
      entered: !!(engine && engine.enteredTarget),
      captcha: nodeCaptcha,
      landedUrl: engine ? engine.landedUrl || null : null,
      failedStep: failedStep,
      error: ok ? null : (lastErr || ('流程连续失败 ' + attempts + ' 次')),
    });
    console.error('[worker][节点] 百度 ' + (i + 1) + '/' + seq.length + ' 『' + (ssid || '当前网络') + '』 ' + recStatus +
      ' 命中' + (ok || (engine && engine.foundTarget) ? '✅' : '❌') + ' 落地' + ((engine && engine.enteredTarget) ? '✅' : '❌') + ' ' + fmtDur(attT1 - attT0) + ' 尝试' + attempts +
      (recStatus !== 'completed' ? ' err=' + (lastErr || (terminal === TaskStatus.FAILED ? ('流程连续失败' + attempts + '次') : terminal)) : ''));

    // 仅「失败且命中验证码」的节点计入止损阈值（成功节点即便曾触发验证码也不计入，避免误判）
    if (!ok && nodeCaptcha) captchaNodeCount += 1;
    // 「定位不到目标」连续失败计数：仅当该节点因 locateTarget（目标域名未出现在搜索结果）失败才累计；
    // 成功节点或瞬时故障（超时等）清零，避免误伤「仅在部分网络排得上」的站点。
    if (!ok && lastErr && /(locateTarget|未出现在|未找到目标|目标域名[」』]?未出现)/.test(lastErr)) {
      consecutiveLocFail += 1;
    } else {
      consecutiveLocFail = 0;
    }

    if (controlBreak) { finalStatus = terminal; break; }
    if (!ok && terminal === TaskStatus.FAILED) {
      finalStatus = TaskStatus.FAILED;
      emit(P.makeProgress({
        taskId: config.taskId, type: EventType.WIFI_POLL,
        message: '『' + (ssid || '当前网络') + '』流程连续失败，跳过该 WIFI 并继续下一个',
        wifiIndex: i + 1, wifiTotal: seq.length, ssid: ssid || '',
      }));
    }
  }
  return finalStatus;
}

// ===========================================================================
// Legacy 流程（无 config.rounds 时，行为与 v0.3.19 完全一致）
// ===========================================================================
async function runLegacy(config, emit, deps) {
  const { wm, statsMod, vpn, makeEngine, opts } = deps;
  const wait = opts.sleep || sleep;
  const retryWait = opts.retrySleep || ((ms) => sleep(ms));
  const MAX_RETRIES = (opts.maxRetries != null)
    ? opts.maxRetries
    : (parseInt(process.env.AUTOCLAW_WIFI_FLOW_RETRIES, 10) || 3);

  const engineEmit = (ev) => {
    if (ev && ev.type === EventType.VPN_INFO && ev.vpn) statsMod.recordVpn(run, ev.vpn);
    if (config.pollWifi && ev && ev.type === EventType.TASK_END) {
      emit(P.makeProgress({
        taskId: config.taskId,
        type: EventType.WIFI_POLL,
        message: '【WIFI 子流程结束】' + (ev.message || '本轮流程已结束'),
        stats: ev.stats || null,
      }));
      return;
    }
    emit(ev);
  };

  abort = false;
  abortStatus = TaskStatus.STOPPED;
  let finalStatus = TaskStatus.COMPLETED;

  // ---- 构建 WIFI 轮询序列（仅 pollWifi）----
  let seq = null;
  let usedRemembered = false;
  if (config.pollWifi) {
    const built = await buildWifiSeq(config, wm);
    seq = built.seq;
    usedRemembered = built.usedRemembered;
    emit(P.makeProgress({
      taskId: config.taskId,
      type: EventType.WIFI_POLL,
      message: 'WIFI 轮询已启用：按' + built.sourceDesc + '，从『' + (seq[0] || '当前网络') + '』开始，单个 WIFI 流程失败将重试 ' + MAX_RETRIES + ' 次',
      wifiIndex: 0,
      wifiTotal: seq.length,
    }));
  }

  const order = seq || [null];
  const run = statsMod.newRun(config.taskId, {
    pollWifi: config.pollWifi,
    startedAt: config.startedAt,
    keyword: (config.keywords && config.keywords.length === 1) ? config.keywords[0] : null,
    keywords: config.keywords || null,
    clientId: config.clientId,
    wifiSource: config.pollWifi ? (usedRemembered ? 'remembered' : 'fallback') : null,
  });

  for (let i = 0; i < order.length; i += 1) {
    const ssid = order[i];
    if (i > 0 || (i === 0 && ssid && (await wm.getCurrentSsid()) !== ssid)) {
      if (abort) { finalStatus = abortStatus; break; }
      if (ssid) {
        // 切换 WiFi 带重试：缓解偶发竞争 / 瞬时失败。v0.3.55 的 wlanconnect.ps1 已断开前置，这里再加应用层重试兜底。
        let cr = null;
        for (let sw = 1; sw <= WIFI_SWITCH_MAX_RETRY; sw += 1) {
          cr = await wm.connectSaved(ssid);
          if (cr && cr.ok) break;
          if (sw < WIFI_SWITCH_MAX_RETRY) {
            emit(P.makeProgress({
              taskId: config.taskId, type: EventType.WIFI_POLL,
              message: '切换『' + ssid + '』第 ' + sw + ' 次失败（' + (cr ? cr.message : '无返回') + '），' + RETRY_GAP_MS + 'ms 后重试',
              wifiIndex: i + 1, wifiTotal: order.length, ssid: ssid,
            }));
            await retryWait(RETRY_GAP_MS);
          }
        }
        emit(P.makeProgress({
          taskId: config.taskId,
          type: EventType.WIFI_POLL,
          message: (cr.ok ? '已切换至『' + ssid + '』' : '切换『' + ssid + '』失败：' + cr.message) + '，停留 5 秒',
          wifiIndex: i + 1,
          wifiTotal: order.length,
          ssid: ssid,
        }));
        if (!cr.ok) {
          statsMod.recordWifi(run, {
            ssid: ssid, status: 'skipped', attempts: 0, retriesUsed: 0,
            durationMs: 0,
            error: '切换失败：' + cr.message,
          });
          continue;
        }
        await wait(5000);
      }
    }

    if (config.pollWifi) {
      emit(P.makeProgress({
        taskId: config.taskId,
        type: EventType.WIFI_POLL,
        message: '【WIFI 轮询 ' + (i + 1) + '/' + order.length + '】使用『' + (ssid || '当前网络') + '』开始第 ' + (i + 1) + ' 轮任务流程',
        wifiIndex: i + 1,
        wifiTotal: order.length,
        ssid: ssid || '',
      }));
    }

    let attempts = 0;
    let terminal = TaskStatus.FAILED;
    let ok = false;
    let controlBreak = false;
    const attT0 = Date.now();
    for (let r = 0; r <= MAX_RETRIES; r += 1) {
      attempts += 1;
      engine = makeEngine(config, engineEmit);
      const st = await engine.run();
      if (st === TaskStatus.PAUSED || st === TaskStatus.STOPPED) {
        terminal = st; controlBreak = true; break;
      }
      if (st === TaskStatus.COMPLETED) { terminal = st; ok = true; break; }
      terminal = TaskStatus.FAILED;
      if (r < MAX_RETRIES) {
        emit(P.makeProgress({
          taskId: config.taskId, type: EventType.WIFI_POLL,
          message: '『' + (ssid || '当前网络') + '』第 ' + attempts + ' 次流程失败（' + (r + 1) + '/' + MAX_RETRIES + ' 重试），即将重跑该 WIFI 流程',
          wifiIndex: i + 1, wifiTotal: order.length, ssid: ssid || '',
        }));
        await retryWait(RETRY_GAP_MS);
        continue;
      }
    }
    const attT1 = Date.now();

    const lastErrLegacy = (engine && engine.lastErrorDetail) ? String(engine.lastErrorDetail) : null;
    statsMod.recordWifi(run, {
      ssid: ssid || null,
      status: ok ? 'completed' : (terminal === TaskStatus.FAILED ? 'failed' : terminal),
      attempts: attempts,
      retriesUsed: Math.max(0, attempts - 1),
      startedAt: new Date(attT0).toISOString(), endedAt: new Date(attT1).toISOString(),
      durationMs: Math.max(0, attT1 - attT0),
      found: !!(engine && engine.foundTarget),
      entered: !!(engine && engine.enteredTarget),
      captcha: !!(engine && engine.captchaHit),
      landedUrl: engine ? engine.landedUrl || null : null,
      failedStep: lastErrLegacy ? lastErrLegacy.split(/[：:]/)[0].slice(0, 48) : null,
      error: ok ? null : (lastErrLegacy || (terminal === TaskStatus.FAILED ? '流程连续失败 ' + attempts + ' 次（含 ' + MAX_RETRIES + ' 次重试）' : terminal)),
    });

    if (controlBreak) { finalStatus = terminal; break; }
    if (!ok && terminal === TaskStatus.FAILED) {
      finalStatus = TaskStatus.FAILED;
      emit(P.makeProgress({
        taskId: config.taskId, type: EventType.WIFI_POLL,
        message: '『' + (ssid || '当前网络') + '』流程连续失败 ' + attempts + ' 次，跳过该 WIFI 并继续下一个',
        wifiIndex: i + 1, wifiTotal: order.length, ssid: ssid || '',
      }));
    }
  }

  if (abort && finalStatus === TaskStatus.COMPLETED) finalStatus = abortStatus;

  const saved = statsMod.save(run);
  emit(P.makeProgress({
    taskId: config.taskId,
    type: EventType.TASK_STATS,
    message: '任务完成度统计已生成并保存（' + run.summary.completedWifi + '/' + run.summary.totalWifi +
      ' 完成，' + run.summary.totalRetries + ' 次重试）—— ' + saved.mdFile,
    stats: run.summary,
    statsDetail: run,
  }));

  return finalStatus;
}

// ===========================================================================
// IPC
// ===========================================================================
process.on('message', async (msg) => {
  if (!msg || typeof msg !== 'object') return;

  if (msg.type === 'start') {
    const config = msg.config;
    try {
      const emit = (event) => send('progress', event);
      const finalStatus = await runTask(config, emit);

      let ipcType;
      if (finalStatus === TaskStatus.PAUSED) ipcType = 'paused';
      else if (finalStatus === TaskStatus.STOPPED) ipcType = 'stopped';
      else ipcType = 'done';

      send(ipcType, P.makeProgress({
        taskId: config && config.taskId,
        type: EventType.TASK_END,
        status: finalStatus,
        message: 'worker 结束',
      }));
    } catch (e) {
      const errMsg = e && e.message ? e.message : String(e);
      send('error', P.makeProgress({
        taskId: config && config.taskId,
        type: EventType.TASK_END,
        status: TaskStatus.FAILED,
        error: errMsg,
        message: 'worker 异常：' + errMsg,
      }));
    }
    return;
  }

  if (msg.type === 'control') {
    if (msg.action === 'pause') {
      abort = true;
      abortStatus = TaskStatus.PAUSED;
      if (engine) engine.setPause();
    } else if (msg.action === 'stop') {
      abort = true;
      abortStatus = TaskStatus.STOPPED;
      if (engine) engine.setStop();
    }
  }
});

/** 把崩溃栈持久化到 data/worker-crash-<taskId>-<ts>.log，确保即使 IPC 丢失也能查到原因 */
function persistCrashLog(detail) {
  try {
    const stack = detail && detail.stack ? detail.stack : String(detail);
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const dataDir = path.join(__dirname, '..', 'data');
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    const taskId = (engine && engine.config && engine.config.taskId) || 'unknown';
    const file = path.join(dataDir, 'worker-crash-' + taskId + '-' + ts + '.log');
    fs.writeFileSync(file, '[worker 崩溃] ' + new Date().toISOString() + '\n' + stack + '\n');
  } catch (_) { /* 落盘失败不阻断进程 */ }
}

/** 统一把致命错误经 IPC 回传主进程（确保失败可见、不再静默崩进程丢状态） */
function reportFatal(detail) {
  persistCrashLog(detail);
  const stack = detail && detail.stack ? detail.stack : String(detail);
  if (process.send) {
    process.send({
      type: 'error',
      event: P.makeProgress({
        taskId: engine && engine.config && engine.config.taskId,
        type: EventType.TASK_END,
        status: TaskStatus.FAILED,
        error: stack,
        message: 'worker 致命错误：' + stack,
      }),
    });
  }
}

// 同步未捕获异常：此前未注册，导致谷歌阶段循环里的同步异常直接崩进程、
// 不发任何终态 IPC，任务被 _onWorkerExit 标为 failed 且进度日志无任何错误痕迹。
// 加上后，任何崩溃都会把真实栈回传，便于定位。
process.on('uncaughtException', (err) => {
  console.error('[worker] uncaughtException:', err && err.stack ? err.stack : err);
  reportFatal(err);
});

process.on('unhandledRejection', (reason) => {
  const msg = reason && reason.stack ? reason.stack : (reason && reason.message ? reason.message : String(reason));
  console.error('[worker] unhandledRejection:', msg);
  reportFatal('未处理的拒绝：' + msg);
});

module.exports = { runTask, runLegacy, runPhased, buildWifiSeq, normalizeSsidKey, sleep };
