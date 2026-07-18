'use strict';

/**
 * app.js
 * ---------------------------------------------------------------------------
 * autoclaw 主进程入口：Express + socket.io。集成 TaskManager 与 /api/task 路由，
 * 挂载 WebSocket 实时推送，并实现 A3 简单 token 鉴权。
 *
 * 鉴权（决策 A3）：
 *   - HTTP：所有 /api/task/* 路由经 taskTokenAuth 中间件校验
 *          请求头 x-autoclaw-token 或 query ?token=，对照 AUTOCLAW_TOKEN（默认 autoclaw-dev）。
 *   - WebSocket：io.use 在握手阶段校验 socket.handshake.auth.token 或 query.token。
 *   - /api/status 健康检查不鉴权。
 */

const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const taskRoutes = require('./routes/taskRoutes');
const clientRoutes = require('./routes/clientRoutes');
const taskManager = require('./core/taskManager');

const app = express();
app.use(express.json({ limit: '1mb' }));

const server = http.createServer(app);
const io = new Server(server);

// 期望令牌（部署侧通过环境变量设定，默认 autoclaw-dev）
const EXPECTED_TOKEN = process.env.AUTOCLAW_TOKEN || 'autoclaw-dev';

// ---------------------------------------------------------------------------
// A3：HTTP 鉴权中间件（保护 /api/task/*）
// ---------------------------------------------------------------------------
function taskTokenAuth(req, res, next) {
  const token = req.get('x-autoclaw-token') || (req.query && req.query.token);
  if (!token || token !== EXPECTED_TOKEN) {
    return res.status(401).json({
      code: 401,
      data: { error: 'ERR_UNAUTHORIZED' },
      message: '未授权：缺少或错误的访问令牌',
    });
  }
  next();
}

// ---------------------------------------------------------------------------
// A3：WebSocket 握手鉴权（保护 task:join / task:pause / task:stop）
// ---------------------------------------------------------------------------
io.use((socket, next) => {
  const token =
    (socket.handshake.auth && socket.handshake.auth.token) ||
    (socket.handshake.query && socket.handshake.query.token);
  if (!token || token !== EXPECTED_TOKEN) {
    return next(new Error('unauthorized'));
  }
  next();
});

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------

// /api/task/* 全部经鉴权中间件保护
app.use('/api/task', taskTokenAuth, taskRoutes);

// /api/client/* 全部经鉴权中间件保护（V2 客户线）
app.use('/api/client', taskTokenAuth, clientRoutes);

// 健康检查（不鉴权，供 Nginx/监控探活）
app.get('/api/status', (req, res) => {
  const active = taskManager.getActiveStatus();
  res.json({
    code: 0,
    data: {
      service: 'autoclaw',
      version: '0.1.0',
      uptime: process.uptime(),
      activeTaskId: active.activeTaskId,
      status: active.status,
    },
    message: 'ok',
  });
});

// 前端静态资源
app.use(express.static(path.join(__dirname, 'public')));

// 友好的页面别名（UI 文案为 /task-config、/task-progress）
app.get('/task-config', (req, res) => res.redirect('/'));
app.get('/task-progress', (req, res) => res.redirect('/progress.html'));

// 兜底 404（JSON 风格，便于前端统一处理）
app.use((req, res) => {
  res.status(404).json({ code: 404, data: {}, message: 'Not Found' });
});

// ---------------------------------------------------------------------------
// socket.io 事件
// ---------------------------------------------------------------------------

io.on('connection', (socket) => {
  // 客户端加入任务房间，仅接收该 taskId 的进度推送
  socket.on('task:join', (payload) => {
    const taskId = payload && payload.taskId;
    if (taskId) socket.join(taskId);
  });

  // 暂停 / 停止仅转发给 manager（manager 已通过 io.use 完成鉴权）
  socket.on('task:pause', (payload) => {
    const taskId = payload && payload.taskId;
    if (taskId) taskManager.pause(String(taskId));
  });

  socket.on('task:stop', (payload) => {
    const taskId = payload && payload.taskId;
    if (taskId) taskManager.stop(String(taskId));
  });
});

// 注入 socket.io 实例，使 manager 能把 IPC 事件转发到对应房间
taskManager.init(io);

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

const PORT = Number(process.env.PORT) || 7788;
server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log('[autoclaw] 服务已启动: http://0.0.0.0:' + PORT + '  (token=' + EXPECTED_TOKEN + ')');
});

module.exports = { app, server, io };
