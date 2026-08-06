'use strict';

/**
 * routes/schedulerRoutes.js
 * ---------------------------------------------------------------------------
 * /api/campaign/* 路由（继承 app.js 的 A3 鉴权中间件）。
 *
 *   GET  /api/campaign/list     列出全部 campaign + 当前运行状态
 *   POST /api/campaign/create   新建 campaign { name, scheduleType, scheduleHour,
 *                                      scheduleMinute, intervalHours, enabled,
 *                                      shuffle, platforms(全站默认), pollWifi(全站默认),
 *                                      rememberedWifis, targets:[{
 *                                        name, domain, enabled(默认true),
 *                                        platforms?(单站可单独设['baidu']/['google']/['baidu','google']),
 *                                        keywords, titleKeywords, browseAnchor?,
 *                                        pollWifi?, rememberedWifis?, maxResultPages?,
 *                                        anthropic?, humanize?, clientId? }] }
 *   POST /api/campaign/update   更新字段（同 create 字段，最小集亦可）{ id, ... }
 *   POST /api/campaign/delete   删除 { id }
 *   POST /api/campaign/enable   开关 { id, enabled }
 *   POST /api/campaign/trigger  立即跑一轮 { id }
 *   GET  /api/campaign/state    当前运行状态快照
 */

const express = require('express');
const router = express.Router();
const { scheduler } = require('../core/scheduler');

function ok(res, data) {
  return res.json({ code: 0, data, message: 'ok' });
}
function fail(res, httpStatus, code, message) {
  return res.status(httpStatus).json({ code: 1, data: { error: code }, message });
}

// GET /api/campaign/list
router.get('/list', async (req, res) => {
  try {
    const list = await scheduler.list();
    return ok(res, { list, state: scheduler.getState() });
  } catch (e) {
    return fail(res, 500, 'ERR_CAMPAIGN_LIST', '查询批量任务失败');
  }
});

// POST /api/campaign/create
router.post('/create', async (req, res) => {
  const body = req.body || {};
  if (!Array.isArray(body.targets) || body.targets.length === 0) {
    return fail(res, 400, 'ERR_INVALID_CONFIG', 'targets 不能为空');
  }
  for (const t of body.targets) {
    if (!t.domain || !t.keywords || !t.titleKeywords) {
      return fail(res, 400, 'ERR_INVALID_CONFIG', '每个 target 需包含 domain / keywords / titleKeywords');
    }
  }
  try {
    const c = await scheduler.create(body);
    return ok(res, { campaign: c });
  } catch (e) {
    return fail(res, 500, 'ERR_CAMPAIGN_CREATE', '创建批量任务失败');
  }
});

// POST /api/campaign/update
router.post('/update', async (req, res) => {
  const body = req.body || {};
  const id = body.id;
  if (!id) return fail(res, 400, 'ERR_INVALID_CONFIG', '缺少 id');
  try {
    const c = await scheduler.update(id, body);
    return ok(res, { campaign: c });
  } catch (e) {
    if (e.message === 'CAMPAIGN_NOT_FOUND') return fail(res, 404, 'ERR_NOT_FOUND', '批量任务不存在');
    return fail(res, 500, 'ERR_CAMPAIGN_UPDATE', '更新批量任务失败');
  }
});

// POST /api/campaign/delete
router.post('/delete', async (req, res) => {
  const body = req.body || {};
  const id = body.id;
  if (!id) return fail(res, 400, 'ERR_INVALID_CONFIG', '缺少 id');
  try {
    await scheduler.remove(id);
    return ok(res, {});
  } catch (e) {
    return fail(res, 500, 'ERR_CAMPAIGN_DELETE', '删除批量任务失败');
  }
});

// POST /api/campaign/enable
router.post('/enable', async (req, res) => {
  const body = req.body || {};
  const id = body.id;
  if (!id) return fail(res, 400, 'ERR_INVALID_CONFIG', '缺少 id');
  try {
    await scheduler.setEnabled(id, body.enabled !== false);
    return ok(res, {});
  } catch (e) {
    if (e.message === 'CAMPAIGN_NOT_FOUND') return fail(res, 404, 'ERR_NOT_FOUND', '批量任务不存在');
    return fail(res, 500, 'ERR_CAMPAIGN_ENABLE', '设置开关失败');
  }
});

// POST /api/campaign/trigger
router.post('/trigger', async (req, res) => {
  const body = req.body || {};
  const id = body.id;
  if (!id) return fail(res, 400, 'ERR_INVALID_CONFIG', '缺少 id');
  try {
    const c = await scheduler.trigger(id);
    return ok(res, { campaign: c });
  } catch (e) {
    const map = {
      CAMPAIGN_NOT_FOUND: ['ERR_NOT_FOUND', '批量任务不存在', 404],
      CAMPAIGN_DISABLED: ['ERR_DISABLED', '批量任务已禁用', 400],
      ANOTHER_CAMPAIGN_RUNNING: ['ERR_CAMPAIGN_RUNNING', '已有批量任务在运行', 409],
      TASK_RUNNING: ['ERR_TASK_RUNNING', '已有运行中的任务', 409],
      CAMPAIGN_RUNNING: ['ERR_CAMPAIGN_RUNNING', '该批量任务正在运行', 409],
    };
    const m = map[e.message] || ['ERR_TRIGGER', '触发失败', 500];
    return fail(res, m[2], m[0], m[1]);
  }
});

// GET /api/campaign/state
router.get('/state', (req, res) => {
  return ok(res, scheduler.getState());
});

module.exports = router;
