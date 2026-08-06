'use strict';

/**
 * routes/wifiRoutes.js
 * ---------------------------------------------------------------------------
 * /api/wifi/* 路由（均由 app.js 的 A3 鉴权中间件保护）。
 *
 *   GET  /api/wifi/list        列当前可见 WiFi + 当前连接（只读）
 *   POST /api/wifi/connect     { ssid, password, hidden } 切换 WiFi（secured 网络需密码）
 *   GET  /api/wifi/saved       列本机已存配置文件 + 是否已标记隐藏 / 当前是否可见
 *   POST /api/wifi/mark-hidden { ssids:[], hidden } 批量标记隐藏网络（保留原密码）
 *
 * 统一响应信封：{ code:0, data:{}, message:'ok' }，非 0 即错误。
 */

const express = require('express');
const router = express.Router();
const wifi = require('../core/wifiManager');

function fail(res, httpStatus, errCode, message) {
  res.status(httpStatus).json({ code: 1, data: { error: errCode }, message: message });
}

// GET /api/wifi/list
router.get('/list', async (req, res) => {
  try {
    const iface = await wifi.getInterface();
    const [list, current] = await Promise.all([
      wifi.listNetworks(iface),
      wifi.getCurrentSsid(iface),
    ]);
    list.sort((a, b) => b.signal - a.signal);
    return res.json({
      code: 0,
      data: { interface: iface, current: current, list: list },
      message: 'ok',
    });
  } catch (e) {
    return fail(res, 500, 'ERR_WIFI_LIST', '获取 WiFi 列表失败：' + (e.message || e));
  }
});

// GET /api/wifi/info —— 当前连接的 SSID / 本地出口 IP / 公网 IP 与归属地
router.get('/info', async (req, res) => {
  try {
    const info = await wifi.getCurrentInfo();
    return res.json({ code: 0, data: info, message: 'ok' });
  } catch (e) {
    return fail(res, 500, 'ERR_WIFI_INFO', '获取连接信息失败：' + (e.message || e));
  }
});

// POST /api/wifi/connect
router.post('/connect', async (req, res) => {
  const body = req.body || {};
  const ssid = (body.ssid || '').trim();
  const password = body.password || '';
  const hidden = !!body.hidden;
  if (!ssid) {
    return fail(res, 400, 'ERR_INVALID_CONFIG', '缺少 ssid');
  }
  try {
    const result = await wifi.connect(ssid, password, { hidden: hidden });
    if (result.ok) {
      return res.json({ code: 0, data: { ssid: ssid }, message: result.message });
    }
    const http = result.code === 'ERR_WIFI_NEED_PASSWORD' ? 400 : 200;
    return fail(res, http, result.code || 'ERR_WIFI_CONNECT', result.message);
  } catch (e) {
    return fail(res, 200, 'ERR_WIFI_CONNECT', '切换 WiFi 失败：' + (e.message || e));
  }
});

// GET /api/wifi/saved —— 本机已存配置文件及状态（hidden=已标记不广播也连，visible=当前可扫到）
router.get('/saved', async (req, res) => {
  try {
    const list = await wifi.listSavedProfilesDetailed();
    list.sort((a, b) => a.ssid.localeCompare(b.ssid, 'zh-Hans-CN', { numeric: true }));
    return res.json({ code: 0, data: { list: list }, message: 'ok' });
  } catch (e) {
    return fail(res, 500, 'ERR_WIFI_SAVED', '读取已存 WiFi 失败：' + (e.message || e));
  }
});

// POST /api/wifi/mark-hidden —— 批量把已存配置文件标记为隐藏网络（nonBroadcast=true）
router.post('/mark-hidden', async (req, res) => {
  const body = req.body || {};
  const ssids = Array.isArray(body.ssids)
    ? body.ssids.map((s) => String(s || '').trim()).filter(Boolean)
    : [];
  const hidden = body.hidden !== false;
  if (!ssids.length) {
    return fail(res, 400, 'ERR_INVALID_CONFIG', '缺少 ssids');
  }
  try {
    const results = [];
    for (const ssid of ssids) {
      try {
        results.push(await wifi.markProfileHidden(ssid, hidden));
      } catch (e) {
        results.push({
          ok: false,
          ssid: ssid,
          code: 'ERR_WIFI_MARK_FAILED',
          message: '标记失败：' + (e.message || e),
        });
      }
    }
    const okCount = results.filter((r) => r.ok).length;
    return res.json({
      code: 0,
      data: { results: results, ok: okCount, failed: results.length - okCount },
      message: '已处理 ' + results.length + ' 个，成功 ' + okCount + ' 个',
    });
  } catch (e) {
    return fail(res, 200, 'ERR_WIFI_MARK_FAILED', '批量标记失败：' + (e.message || e));
  }
});

module.exports = router;
