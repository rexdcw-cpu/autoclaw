'use strict';

/**
 * routes/clientRoutes.js
 * ---------------------------------------------------------------------------
 * /api/client/* 路由（均由 app.js 的 A3 鉴权中间件保护）。
 *
 *   GET    /api/client/list          列全部客户（created_at DESC）
 *   POST   /api/client/create        新建客户 { name, contact?, notes? }
 *   GET    /api/client/:id           取单个客户
 *   PUT    /api/client/:id           更新客户 { name?, contact?, notes? }
 *   DELETE /api/client/:id           删除客户（有关联任务则 409 ERR_CLIENT_HAS_TASKS）
 *   GET    /api/client/:id/stats     客户维度统计（P0-10）
 *   GET    /api/client/:id/report    交付报告（P0-11）：?format=markdown|csv|html
 *
 * 统一响应信封：{ code:0, data:{}, message:'ok' }，非 0 即错误。
 */

const express = require('express');
const router = express.Router();
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

// ---------------------------------------------------------------------------
// 列表 / 新建
// ---------------------------------------------------------------------------

// GET /api/client/list
router.get('/list', async (req, res) => {
  try {
    const list = await db.listClients();
    return res.json({ code: 0, data: { list: list }, message: 'ok' });
  } catch (e) {
    return fail(res, 500, 'ERR_DB_QUERY', '查询客户列表失败');
  }
});

// POST /api/client/create
router.post('/create', async (req, res) => {
  const body = req.body || {};
  try {
    const client = await db.createClient({
      name: body.name,
      contact: body.contact,
      notes: body.notes,
    });
    return res.json({ code: 0, data: client, message: 'ok' });
  } catch (e) {
    if (e && e.code === 'ERR_INVALID_CONFIG') {
      return fail(res, 400, 'ERR_INVALID_CONFIG', e.message);
    }
    return fail(res, 500, 'ERR_DB_WRITE', '创建客户失败');
  }
});

// ---------------------------------------------------------------------------
// 单条：查询 / 更新 / 删除
// ---------------------------------------------------------------------------

// GET /api/client/:id
router.get('/:id', async (req, res) => {
  const id = req.params.id;
  try {
    const client = await db.getClient(id);
    if (!client) return fail(res, 404, 'ERR_CLIENT_NOT_FOUND', '客户不存在');
    return res.json({ code: 0, data: client, message: 'ok' });
  } catch (e) {
    return fail(res, 500, 'ERR_DB_QUERY', '查询客户失败');
  }
});

// PUT /api/client/:id
router.put('/:id', async (req, res) => {
  const id = req.params.id;
  const body = req.body || {};
  try {
    const updated = await db.updateClient(id, {
      name: body.name,
      contact: body.contact,
      notes: body.notes,
    });
    if (!updated) return fail(res, 404, 'ERR_CLIENT_NOT_FOUND', '客户不存在');
    return res.json({ code: 0, data: updated, message: 'ok' });
  } catch (e) {
    return fail(res, 500, 'ERR_DB_WRITE', '更新客户失败');
  }
});

// DELETE /api/client/:id
router.delete('/:id', async (req, res) => {
  const id = req.params.id;
  try {
    const ok = await db.deleteClient(id);
    if (!ok) return fail(res, 404, 'ERR_CLIENT_NOT_FOUND', '客户不存在');
    return res.json({ code: 0, data: {}, message: 'ok' });
  } catch (e) {
    if (e && e.code === 'ERR_CLIENT_HAS_TASKS') {
      return fail(res, 409, 'ERR_CLIENT_HAS_TASKS', e.message);
    }
    return fail(res, 500, 'ERR_DB_QUERY', '删除客户失败');
  }
});

// ---------------------------------------------------------------------------
// 统计（P0-10）
// ---------------------------------------------------------------------------

// GET /api/client/:id/stats
router.get('/:id/stats', async (req, res) => {
  const id = req.params.id;
  try {
    const client = await db.getClient(id);
    if (!client) return fail(res, 404, 'ERR_CLIENT_NOT_FOUND', '客户不存在');
    const stats = await db.getClientStats(id);
    return res.json({ code: 0, data: { client: client, stats: stats }, message: 'ok' });
  } catch (e) {
    return fail(res, 500, 'ERR_DB_QUERY', '查询客户统计失败');
  }
});

// ---------------------------------------------------------------------------
// 交付报告（P0-11）：日志摘要版（命中截图属 P1）
// ---------------------------------------------------------------------------

/**
 * 把客户信息与任务列表渲染为交付报告字符串。
 * @param {string} format 'markdown' | 'csv' | 'html'
 * @param {object} client
 * @param {object} stats
 * @param {Array<object>} tasks
 * @returns {{contentType:string, body:string}}
 */
function renderReport(format, client, stats, tasks) {
  const sr = stats.successRate == null ? '—' : (stats.successRate * 100).toFixed(1) + '%';
  const lastRun = stats.lastRunAt || '—';

  if (format === 'csv') {
    const header = 'taskId,targetDomain,keywords,status,createdAt';
    const lines = tasks.map((t) =>
      [
        t.taskId,
        t.targetDomain || '',
        (Array.isArray(t.keywords) ? t.keywords.join('|') : t.keywords || ''),
        t.status || '',
        t.createdAt || '',
      ]
        .map((c) => '"' + String(c).replace(/"/g, '""') + '"')
        .join(','),
    );
    const body = [header].concat(lines).join('\r\n');
    return { contentType: 'text/csv; charset=utf-8', body: body };
  }

  if (format === 'html') {
    const rows = tasks
      .map(
        (t) =>
          '<tr><td>' +
          escapeHtml(t.taskId) +
          '</td><td>' +
          escapeHtml(t.targetDomain || '') +
          '</td><td>' +
          escapeHtml(Array.isArray(t.keywords) ? t.keywords.join('|') : t.keywords || '') +
          '</td><td>' +
          escapeHtml(t.status || '') +
          '</td><td>' +
          escapeHtml(t.createdAt || '') +
          '</td></tr>',
      )
      .join('');
    const body =
      '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">' +
      '<title>交付报告 - ' +
      escapeHtml(client.name) +
      '</title></head><body>' +
      '<h1>交付报告：' +
      escapeHtml(client.name) +
      '</h1>' +
      '<p>联系人：' +
      escapeHtml(client.contact || '—') +
      '</p>' +
      '<p>任务数：' +
      stats.taskCount +
      ' ｜ 整体成功率：' +
      sr +
      ' ｜ 最近运行：' +
      escapeHtml(String(lastRun)) +
      '</p>' +
      '<table border="1" cellpadding="6" cellspacing="0"><thead><tr>' +
      '<th>任务ID</th><th>目标域名</th><th>关键词</th><th>状态</th><th>创建时间</th>' +
      '</tr></thead><tbody>' +
      (rows || '<tr><td colspan="5">暂无任务</td></tr>') +
      '</tbody></table></body></html>';
    return { contentType: 'text/html; charset=utf-8', body: body };
  }

  // 默认 markdown
  const lines = [];
  lines.push('# 交付报告：' + client.name);
  lines.push('');
  lines.push('- 联系人：' + (client.contact || '—'));
  if (client.notes) lines.push('- 备注：' + client.notes);
  lines.push('- 任务数：' + stats.taskCount);
  lines.push('- 整体成功率：' + sr);
  lines.push('- 最近运行：' + lastRun);
  lines.push('');
  lines.push('## 任务明细');
  lines.push('');
  if (tasks.length === 0) {
    lines.push('（该客户暂无任务）');
  } else {
    lines.push('| 任务ID | 目标域名 | 关键词 | 状态 | 创建时间 |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const t of tasks) {
      lines.push(
        '| ' +
          t.taskId +
          ' | ' +
          (t.targetDomain || '') +
          ' | ' +
          (Array.isArray(t.keywords) ? t.keywords.join('|') : t.keywords || '') +
          ' | ' +
          (t.status || '') +
          ' | ' +
          (t.createdAt || '') +
          ' |',
      );
    }
  }
  return { contentType: 'text/markdown; charset=utf-8', body: lines.join('\n') };
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// GET /api/client/:id/report?format=markdown|csv|html
router.get('/:id/report', async (req, res) => {
  const id = req.params.id;
  const format = (req.query.format || 'markdown').toLowerCase();
  if (!['markdown', 'csv', 'html'].includes(format)) {
    return fail(res, 400, 'ERR_INVALID_CONFIG', 'format 仅支持 markdown|csv|html');
  }
  try {
    const client = await db.getClient(id);
    if (!client) return fail(res, 404, 'ERR_CLIENT_NOT_FOUND', '客户不存在');
    const [stats, tasks] = await Promise.all([db.getClientStats(id), db.getClientTasks(id)]);
    const { contentType, body } = renderReport(format, client, stats, tasks);
    res.set('Content-Type', contentType);
    res.set('Content-Disposition', 'attachment; filename="client-' + id + '-report.' + format + '"');
    return res.send(body);
  } catch (e) {
    return fail(res, 500, 'ERR_DB_QUERY', '生成交付报告失败');
  }
});

module.exports = router;
