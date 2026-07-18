'use strict';

/**
 * test/taskRoutesDb.test.js
 * ---------------------------------------------------------------------------
 * HTTP-layer tests for the new routes GET /api/task/history (F-24) and
 * GET /api/task/logs (F-25) plus the A3 token-auth envelope behaviour they
 * inherit.
 *
 * A real express app mounts the SAME A3 taskTokenAuth middleware as app.js
 * (replicated below) + the production router. DB calls are faked by mocking the
 * db singleton's methods (no real MySQL). Built-in http client only — no
 * supertest dependency.
 */

const test = require('node:test');
const assert = require('node:assert');
const { mock } = require('node:test');
const http = require('http');
const express = require('express');

// --- Replicate app.js A3 middleware exactly (routes rely on it) -------------
const EXPECTED_TOKEN = process.env.AUTOCLAW_TOKEN || 'autoclaw-dev';
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

// safety: ensure no real mysql connection is ever opened
const realMysql = require('mysql2/promise');
realMysql.createPool = () => ({ query: async () => [[], []] });

const db = require('../config/db');
const router = require('../routes/taskRoutes');

// Shaped like db.getHistory's OUTPUT (already mapped to camelCase), since the
// route simply forwards what db.getHistory returns.
const SAMPLE_HISTORY = [{
  taskId: 'h1',
  platforms: ['baidu'],
  keywords: ['移民'],
  targetDomain: 'x.com',
  titleKeywords: ['tk'],
  anthropic: { staySeconds: 15, scrollUp: 3, scrollDown: 3, ampMin: 300, ampMax: 800, intervalMin: 1, intervalMax: 2 },
  runMode: 'serial',
  status: 'pending',
  createdAt: '2026-07-16 10:00:00',
}];
const SAMPLE_LOGS = [{
  id: 1, task_id: 't1', round: 0, total_rounds: 4, platform: 'baidu', keyword: '移民',
  step: 'search', step_status: 'success', event_type: 'step', message: 'm', error: null,
  timestamp: '2026-07-16 10:00:00',
}];
const SAMPLE_STATS = { total: 10, success: 7, fail: 3, failRate: 0.3 };

let getHistoryMock, getRunLogsMock, getRunStatsMock, server, port;

test.before(() => {
  getHistoryMock = mock.method(db, 'getHistory', async () => SAMPLE_HISTORY);
  getRunLogsMock = mock.method(db, 'getRunLogs', async () => SAMPLE_LOGS);
  getRunStatsMock = mock.method(db, 'getRunStats', async () => SAMPLE_STATS);

  const app = express();
  app.use(express.json());
  app.use('/api/task', taskTokenAuth, router);
  server = app.listen(0);
  port = server.address().port;
});

test.beforeEach(() => {
  getHistoryMock.mock.mockImplementation(async () => SAMPLE_HISTORY);
  getRunLogsMock.mock.mockImplementation(async () => SAMPLE_LOGS);
  getRunStatsMock.mock.mockImplementation(async () => SAMPLE_STATS);
  // clear recorded calls so per-test assertions are isolated
  getHistoryMock.mock.calls.length = 0;
  getRunLogsMock.mock.calls.length = 0;
  getRunStatsMock.mock.calls.length = 0;
});

test.after(() => {
  if (server) server.close();
  mock.reset();
});

function request(path, opts = {}) {
  return new Promise((resolve, reject) => {
    const headers = { Accept: 'application/json' };
    if (opts.token) headers['x-autoclaw-token'] = opts.token;
    const req = http.request({ host: '127.0.0.1', port, path, method: 'GET', headers }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(body); } catch (e) { /* non-json */ }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Auth (A3) — inherited by the new routes
// ---------------------------------------------------------------------------

test('GET /history without token -> 401 ERR_UNAUTHORIZED', async () => {
  const r = await request('/api/task/history');
  assert.strictEqual(r.status, 401);
  assert.strictEqual(r.json.code, 401);
  assert.strictEqual(r.json.data.error, 'ERR_UNAUTHORIZED');
  assert.strictEqual(getHistoryMock.mock.calls.length, 0, 'db.getHistory must not be called');
});

test('GET /history with wrong token -> 401', async () => {
  const r = await request('/api/task/history', { token: 'wrong-token' });
  assert.strictEqual(r.status, 401);
});

test('GET /logs without token -> 401', async () => {
  const r = await request('/api/task/logs?taskId=t1');
  assert.strictEqual(r.status, 401);
  assert.strictEqual(r.json.data.error, 'ERR_UNAUTHORIZED');
});

// ---------------------------------------------------------------------------
// /history — success + failure envelope
// ---------------------------------------------------------------------------

test('GET /history with valid token -> 200 envelope {code:0,data:{list}} and calls db.getHistory', async () => {
  const r = await request('/api/task/history?limit=10', { token: EXPECTED_TOKEN });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.code, 0);
  assert.ok(Array.isArray(r.json.data.list));
  assert.strictEqual(r.json.data.list.length, 1);
  assert.strictEqual(r.json.data.list[0].taskId, 'h1');
  assert.strictEqual(getHistoryMock.mock.calls.length, 1);
  assert.strictEqual(getHistoryMock.mock.calls[0].arguments[0], 10); // limit forwarded
});

test('GET /history with valid token but DB error -> 500 ERR_DB_QUERY', async () => {
  getHistoryMock.mock.mockImplementation(async () => { throw new Error('db down'); });
  const r = await request('/api/task/history', { token: EXPECTED_TOKEN });
  assert.strictEqual(r.status, 500);
  assert.strictEqual(r.json.code, 1);
  assert.strictEqual(r.json.data.error, 'ERR_DB_QUERY');
});

// ---------------------------------------------------------------------------
// /logs — missing taskId / success / failure envelope
// ---------------------------------------------------------------------------

test('GET /logs with token but no taskId -> 400 ERR_TASK_NOT_FOUND', async () => {
  const r = await request('/api/task/logs', { token: EXPECTED_TOKEN });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.json.data.error, 'ERR_TASK_NOT_FOUND');
  assert.strictEqual(getRunLogsMock.mock.calls.length, 0);
});

test('GET /logs with valid token + taskId -> 200 envelope {timeline, stats} and calls db', async () => {
  const r = await request('/api/task/logs?taskId=t1', { token: EXPECTED_TOKEN });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.code, 0);
  assert.strictEqual(r.json.data.taskId, 't1');
  assert.ok(Array.isArray(r.json.data.timeline));
  assert.strictEqual(r.json.data.timeline[0].id, 1);
  assert.deepStrictEqual(r.json.data.stats, SAMPLE_STATS);
  assert.strictEqual(getRunLogsMock.mock.calls.length, 1);
  assert.strictEqual(getRunStatsMock.mock.calls.length, 1);
  assert.strictEqual(getRunLogsMock.mock.calls[0].arguments[0], 't1');
});

test('GET /logs with valid token but DB error -> 500 ERR_DB_QUERY', async () => {
  getRunLogsMock.mock.mockImplementation(async () => { throw new Error('db down'); });
  const r = await request('/api/task/logs?taskId=t1', { token: EXPECTED_TOKEN });
  assert.strictEqual(r.status, 500);
  assert.strictEqual(r.json.data.error, 'ERR_DB_QUERY');
});
