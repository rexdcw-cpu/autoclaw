'use strict';

/**
 * routes/taskRoutes.js
 * ---------------------------------------------------------------------------
 * /api/task/* 路由（均由 app.js 的 A3 鉴权中间件保护）。
 *
 *   POST /api/task/submit   提交并启动任务（单活跃，运行中返回 409 ERR_TASK_RUNNING）
 *   GET  /api/task/progress 轮询进度快照 ?taskId=
 *   POST /api/task/pause    暂停任务 { taskId }
 *   POST /api/task/stop     停止任务 { taskId }
 *   GET  /api/task/status   活跃任务概览
 *   GET  /api/task/history  列历史配置（F-24，created_at DESC）
 *   GET  /api/task/logs     回看某任务运行记录时间线 + 成功率统计（F-25，?taskId=）
 *
 * 统一响应信封（架构 8.4）：{ code:0, data:{}, message:'ok' }，非 0 即错误。
 *
 * 增量（v0.2 / T-D2 / T-D3）：
 *   - submit 在 taskManager.submit 前 await db.saveTaskConfig（失败 500 ERR_DB_WRITE，
 *     保证「提交成功即落库 1 条」契约）。
 *   - 新增 /history、/logs 查询接口（继承 A3 鉴权）。
 */

const express = require('express');
const router = express.Router();
const taskManager = require('../core/taskManager');
const { buildTaskConfig } = require('../core/taskConfig');
const { ERR } = require('../core/progressEvent');
const db = require('../config/db');

/**
 * 统一错误响应。
 * @param {express.Response} res
 * @param {number} httpStatus
 * @param {string} errCode
 * @param {string} message
 */
function fail(res, httpStatus, errCode, message) {
  res.status(httpStatus).json({ code: 1, data: { error: errCode }, message: message });
}

// POST /api/task/submit
router.post('/submit', async (req, res) => {
  let config;
  try {
    config = buildTaskConfig(req.body || {});
  } catch (e) {
    const code = e.code || ERR.ERR_INVALID_CONFIG;
    return fail(res, 400, code, '配置校验失败：' + e.message);
  }

  // T-D2：配置落库（旁路，保证「提交成功即落库 1 条」契约）
  const operator = req.get('x-autoclaw-token') || null;
  try {
    await db.saveTaskConfig(config, operator);
  } catch (e) {
    return fail(res, 500, ERR.ERR_DB_WRITE, '任务配置落库失败');
  }

  const result = taskManager.submit(config);
  if (!result.ok) {
    if (result.code === ERR.ERR_TASK_RUNNING) {
      return fail(res, 409, ERR.ERR_TASK_RUNNING, '已有运行中的任务');
    }
    return fail(res, 400, result.code || ERR.ERR_INVALID_CONFIG, '提交失败');
  }

  return res.json({
    code: 0,
    data: { taskId: result.taskId, status: result.status },
    message: 'ok',
  });
});

// GET /api/task/progress?taskId=
router.get('/progress', (req, res) => {
  const taskId = req.query.taskId;
  if (!taskId) {
    return fail(res, 400, ERR.ERR_TASK_NOT_FOUND, '缺少 taskId 参数');
  }
  const result = taskManager.getProgress(String(taskId));
  if (!result.ok) {
    return fail(res, 404, ERR.ERR_TASK_NOT_FOUND, '任务不存在');
  }
  return res.json({ code: 0, data: result, message: 'ok' });
});

// POST /api/task/pause
router.post('/pause', (req, res) => {
  const body = req.body || {};
  const taskId = body.taskId || req.query.taskId;
  if (!taskId || !taskManager.exists(String(taskId))) {
    return fail(res, 404, ERR.ERR_TASK_NOT_FOUND, '任务不存在');
  }
  taskManager.pause(String(taskId));
  return res.json({ code: 0, data: {}, message: 'ok' });
});

// POST /api/task/stop
router.post('/stop', (req, res) => {
  const body = req.body || {};
  const taskId = body.taskId || req.query.taskId;
  if (!taskId || !taskManager.exists(String(taskId))) {
    return fail(res, 404, ERR.ERR_TASK_NOT_FOUND, '任务不存在');
  }
  taskManager.stop(String(taskId));
  return res.json({ code: 0, data: {}, message: 'ok' });
});

// GET /api/task/status
router.get('/status', (req, res) => {
  const info = taskManager.getActiveStatus();
  return res.json({ code: 0, data: info, message: 'ok' });
});

// GET /api/task/history —— 列历史配置（F-24，created_at DESC）
router.get('/history', async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const offset = Number(req.query.offset) || 0;
  try {
    const list = await db.getHistory(limit, offset);
    return res.json({ code: 0, data: { list: list }, message: 'ok' });
  } catch (e) {
    return fail(res, 500, ERR.ERR_DB_QUERY, '查询历史配置失败');
  }
});

// GET /api/task/logs —— 回看某任务运行记录（F-25）
router.get('/logs', async (req, res) => {
  const taskId = req.query.taskId;
  if (!taskId) {
    return fail(res, 400, ERR.ERR_TASK_NOT_FOUND, '缺少 taskId');
  }
  try {
    const timeline = await db.getRunLogs(String(taskId), Number(req.query.limit) || 500);
    const stats = await db.getRunStats(String(taskId)); // {total, success, fail, failRate}
    return res.json({
      code: 0,
      data: { taskId: String(taskId), timeline: timeline, stats: stats },
      message: 'ok',
    });
  } catch (e) {
    return fail(res, 500, ERR.ERR_DB_QUERY, '查询运行记录失败');
  }
});

module.exports = router;
