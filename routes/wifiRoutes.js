'use strict';

/**
 * routes/wifiRoutes.js
 * ---------------------------------------------------------------------------
 * /api/wifi/* 路由（均由 app.js 的 A3 鉴权中间件保护）。
 *
 *   GET  /api/wifi/list     列当前可见 WiFi + 当前连接（只读）
 *   POST /api/wifi/connect  { ssid, password } 切换 WiFi（secured 网络需密码）
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
  if (!ssid) {
    return fail(res, 400, 'ERR_INVALID_CONFIG', '缺少 ssid');
  }
  try {
    const result = await wifi.connect(ssid, password);
    if (result.ok) {
      return res.json({ code: 0, data: { ssid: ssid }, message: result.message });
    }
    const http = result.code === 'ERR_WIFI_NEED_PASSWORD' ? 400 : 500;
    return fail(res, http, result.code || 'ERR_WIFI_CONNECT', result.message);
  } catch (e) {
    return fail(res, 500, 'ERR_WIFI_CONNECT', '切换 WiFi 失败：' + (e.message || e));
  }
});

module.exports = router;
