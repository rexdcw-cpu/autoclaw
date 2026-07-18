'use strict';

/**
 * test/clientRoutes.test.js
 * ---------------------------------------------------------------------------
 * HTTP-layer tests for /api/client/* (V2 客户线 P0-8 ~ P0-11)。
 * 复用 app.js 的 A3 taskTokenAuth 中间件 + 生产 router；db 单例方法全部 mock
 * （不连真实 DB）。仅内置 http client，无 supertest 依赖。
 */

const test = require('node:test');
const assert = require('node:assert');
const { mock } = require('node:test');
const http = require('http');
const express = require('express');

// 与 app.js 完全一致的 A3 中间件
const EXPECTED_TOKEN = process.env.AUTOCLAW_TOKEN || 'autoclaw-dev';
function taskTokenAuth(req, res, next) {
  const token = req.get('x-autoclaw-token') || (req.query && req.query.token);
  if (!token || token !== EXPECTED_TOKEN) {
    return res.status(401).json({ code: 401, data: { error: 'ERR_UNAUTHORIZED' }, message: '未授权' });
  }
  next();
}

// 阻止真实 mysql 连接
const realMysql = require('mysql2/promise');
realMysql.createPool = () => ({ query: async () => [[], []] });

const db = require('../config/db');
const router = require('../routes/clientRoutes');

const SAMPLE_CLIENT = {
  clientId: 'c1',
  name: '万年移民工作室',
  contact: '王经理',
  notes: 'Q3 交付',
  createdAt: '2026-07-18 10:00:00',
  updatedAt: null,
};
const SAMPLE_STATS = { taskCount: 2, lastRunAt: '2026-07-18 12:00:00', total: 10, success: 7, fail: 3, successRate: 0.7 };
const SAMPLE_TASKS = [
  { taskId: 't1', targetDomain: 'manincorp.cn', keywords: ['万年移民'], titleKeywords: ['万年移民'], status: 'completed', createdAt: '2026-07-18 11:00:00' },
];

// 每个方法的默认实现（beforeEach 还原用）
const DEFAULTS = {
  listClients: async () => [SAMPLE_CLIENT],
  createClient: async (input) => Object.assign({ clientId: 'c1' }, input),
  getClient: async () => SAMPLE_CLIENT,
  updateClient: async () => SAMPLE_CLIENT,
  deleteClient: async () => true,
  getClientStats: async () => SAMPLE_STATS,
  getClientTasks: async () => SAMPLE_TASKS,
};

let server, port;
const mocks = {};

test.before(() => {
  for (const name of Object.keys(DEFAULTS)) {
    mocks[name] = mock.method(db, name, DEFAULTS[name]);
  }
  const app = express();
  app.use(express.json());
  app.use('/api/client', taskTokenAuth, router);
  server = app.listen(0);
  port = server.address().port;
});

test.beforeEach(() => {
  for (const name of Object.keys(mocks)) {
    mocks[name].mock.mockImplementation(DEFAULTS[name]);
    mocks[name].mock.calls.length = 0;
  }
});

test.after(() => {
  if (server) server.close();
  mock.reset();
});

function request(method, path, opts = {}) {
  return new Promise((resolve, reject) => {
    const headers = { Accept: 'application/json' };
    if (opts.token) headers['x-autoclaw-token'] = opts.token;
    if (opts.body) headers['Content-Type'] = 'application/json';
    const req = http.request(
      { host: '127.0.0.1', port, path, method, headers },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(body); } catch (e) { /* raw text */ }
          resolve({ status: res.statusCode, contentType: res.headers['content-type'], json, raw: body });
        });
      },
    );
    req.on('error', reject);
    if (opts.body) req.write(JSON.stringify(opts.body));
    req.end();
  });
}

// ---------------------------------------------------------------------------
// 鉴权
// ---------------------------------------------------------------------------
test('GET /client/list without token -> 401', async () => {
  const r = await request('GET', '/api/client/list');
  assert.strictEqual(r.status, 401);
});

// ---------------------------------------------------------------------------
// list / create
// ---------------------------------------------------------------------------
test('GET /client/list with token -> 200 envelope {list}', async () => {
  const r = await request('GET', '/api/client/list', { token: EXPECTED_TOKEN });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.code, 0);
  assert.strictEqual(r.json.data.list[0].clientId, 'c1');
  assert.strictEqual(mocks.listClients.mock.calls.length, 1);
});

test('POST /client/create missing name -> 400 ERR_INVALID_CONFIG', async () => {
  mocks.createClient.mock.mockImplementation(async () => { throw Object.assign(new Error('名称空'), { code: 'ERR_INVALID_CONFIG' }); });
  const r = await request('POST', '/api/client/create', { token: EXPECTED_TOKEN, body: { name: '' } });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.json.data.error, 'ERR_INVALID_CONFIG');
});

test('POST /client/create valid -> 200 returns created client', async () => {
  const r = await request('POST', '/api/client/create', { token: EXPECTED_TOKEN, body: { name: 'X', contact: 'c', notes: 'n' } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.code, 0);
  assert.strictEqual(r.json.data.name, 'X');
  const calls = mocks.createClient.mock.calls;
  assert.ok(calls.length >= 1, 'createClient 应被调用');
  const last = calls[calls.length - 1];
  assert.strictEqual(last.arguments[0].contact, 'c');
});

// ---------------------------------------------------------------------------
// get / update / delete
// ---------------------------------------------------------------------------
test('GET /client/:id -> 200 client', async () => {
  const r = await request('GET', '/api/client/c1', { token: EXPECTED_TOKEN });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.data.clientId, 'c1');
});

test('GET /client/:id not found -> 404 ERR_CLIENT_NOT_FOUND', async () => {
  mocks.getClient.mock.mockImplementation(async () => null);
  const r = await request('GET', '/api/client/nope', { token: EXPECTED_TOKEN });
  assert.strictEqual(r.status, 404);
  assert.strictEqual(r.json.data.error, 'ERR_CLIENT_NOT_FOUND');
});

test('PUT /client/:id -> 200 updated', async () => {
  const r = await request('PUT', '/api/client/c1', { token: EXPECTED_TOKEN, body: { name: '新名' } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(mocks.updateClient.mock.calls[0].arguments[1].name, '新名');
});

test('DELETE /client/:id with tasks -> 409 ERR_CLIENT_HAS_TASKS', async () => {
  mocks.deleteClient.mock.mockImplementation(async () => { throw Object.assign(new Error('有任务'), { code: 'ERR_CLIENT_HAS_TASKS' }); });
  const r = await request('DELETE', '/api/client/c1', { token: EXPECTED_TOKEN });
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.json.data.error, 'ERR_CLIENT_HAS_TASKS');
});

test('DELETE /client/:id ok -> 200', async () => {
  const r = await request('DELETE', '/api/client/c1', { token: EXPECTED_TOKEN });
  assert.strictEqual(r.status, 200);
});

// ---------------------------------------------------------------------------
// stats / report
// ---------------------------------------------------------------------------
test('GET /client/:id/stats -> 200 {client, stats}', async () => {
  const r = await request('GET', '/api/client/c1/stats', { token: EXPECTED_TOKEN });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.data.stats.taskCount, 2);
  assert.strictEqual(r.json.data.client.clientId, 'c1');
});

test('GET /client/:id/report?format=markdown -> 200 text/markdown with client name', async () => {
  const r = await request('GET', '/api/client/c1/report?format=markdown', { token: EXPECTED_TOKEN });
  assert.strictEqual(r.status, 200);
  assert.match(r.contentType, /text\/markdown/);
  assert.match(r.raw, /万年移民工作室/);
  assert.match(r.raw, /manincorp\.cn/);
});

test('GET /client/:id/report?format=csv -> 200 text/csv', async () => {
  const r = await request('GET', '/api/client/c1/report?format=csv', { token: EXPECTED_TOKEN });
  assert.strictEqual(r.status, 200);
  assert.match(r.contentType, /text\/csv/);
  assert.match(r.raw, /taskId,targetDomain/);
});

test('GET /client/:id/report?format=html -> 200 text/html', async () => {
  const r = await request('GET', '/api/client/c1/report?format=html', { token: EXPECTED_TOKEN });
  assert.strictEqual(r.status, 200);
  assert.match(r.contentType, /text\/html/);
  assert.match(r.raw, /<table/);
});

test('GET /client/:id/report?format=bad -> 400', async () => {
  const r = await request('GET', '/api/client/c1/report?format=xml', { token: EXPECTED_TOKEN });
  assert.strictEqual(r.status, 400);
});
