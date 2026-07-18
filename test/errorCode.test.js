'use strict';

/**
 * test/errorCode.test.js
 * ---------------------------------------------------------------------------
 * T0 错误码 / 表结构对齐验证（纯逻辑，不连 DB / 不启浏览器）。
 *
 * 验证（对应 arch §5.2 T0 验收闸口）：
 *   1) ERR.ERR_BAIDU_CAPTCHA 已定义（错误码体系对齐）。
 *   2) StepName.BOOT / OPEN / FILL / WAIT 已定义（步骤拆分预留契约）。
 *   3) config/db.flattenEvent 能从 step.code 取 error_code 写入末尾列，
 *      且 step 无 code 时 error_code 为 null（表结构与映射对齐）。
 *
 * flattenEvent 为纯函数，require('../config/db') 不会触发任何 DB 连接
 * （getPool/getSqliteDb 均为惰性）。因此该文件在任意环境都能稳定运行。
 */

const test = require('node:test');
const assert = require('node:assert');

const { ERR, StepName, makeStep } = require('../core/progressEvent');
const db = require('../config/db');

// ---------------------------------------------------------------------------
// 1) 错误码对齐
// ---------------------------------------------------------------------------

test('ERR.ERR_BAIDU_CAPTCHA is defined with the expected string value', () => {
  assert.strictEqual(ERR.ERR_BAIDU_CAPTCHA, 'ERR_BAIDU_CAPTCHA');
});

// ---------------------------------------------------------------------------
// 2) StepName 拆分预留契约对齐
// ---------------------------------------------------------------------------

test('StepName BOOT/OPEN/FILL/WAIT are defined for step splitting', () => {
  assert.strictEqual(StepName.BOOT, 'boot');
  assert.strictEqual(StepName.OPEN, 'open');
  assert.strictEqual(StepName.FILL, 'fill');
  assert.strictEqual(StepName.WAIT, 'wait');
});

// ---------------------------------------------------------------------------
// 3) flattenEvent 对齐 error_code
// ---------------------------------------------------------------------------

// flattenEvent 返回数组的列顺序（与 db.js flushRunLog 的 cols 一一对应）：
//   0 task_id, 1 round, 2 total_rounds, 3 platform, 4 keyword,
//   5 step, 6 step_status, 7 event_type, 8 message, 9 error,
//   10 timestamp, 11 error_code  ← T0 新增（末尾，不位移既有列）
const IDX_ERROR = 9;
const IDX_TIMESTAMP = 10;
const IDX_ERROR_CODE = 11;

test('flattenEvent reads error_code from step.code (success path: error null, code null)', () => {
  const ev = {
    taskId: 't1',
    type: 'step',
    round: { roundIndex: 0, totalRounds: 4, platform: 'baidu', keyword: '移民' },
    step: makeStep(StepName.SEARCH, 'success', 'found'),
    timestamp: '2026-07-16T10:00:00.000Z',
  };
  const row = db.flattenEvent(ev);
  assert.strictEqual(row.length, 12, '应包含 12 列（含 error_code）');
  // error 列仅在 step 失败 / round.error / ev.message 时填充；成功步为空
  assert.strictEqual(row[IDX_ERROR], null, '成功步 error 列为 null');
  assert.strictEqual(row[IDX_TIMESTAMP], '2026-07-16 10:00:00', 'timestamp 列索引不变（10）');
  assert.strictEqual(row[IDX_ERROR_CODE], null, '无 code 时 error_code 为 null');
});

test('flattenEvent captures error_code = ERR_BAIDU_CAPTCHA from a failed step.code', () => {
  const ev = {
    taskId: 't1',
    type: 'step',
    round: { roundIndex: 1, totalRounds: 4, platform: 'baidu', keyword: '移民' },
    step: {
      step: 'wait',
      status: 'failed',
      code: ERR.ERR_BAIDU_CAPTCHA, // 步骤⑦执行器在 T2 注入；此处模拟
      detail: '百度安全验证未通过（ERR_BAIDU_CAPTCHA）',
    },
    timestamp: '2026-07-16T10:00:01.000Z',
  };
  const row = db.flattenEvent(ev);
  assert.strictEqual(row[IDX_ERROR_CODE], ERR.ERR_BAIDU_CAPTCHA, 'error_code 取 step.code');
  assert.strictEqual(row[IDX_ERROR_CODE], 'ERR_BAIDU_CAPTCHA');
  assert.strictEqual(row[IDX_ERROR], '百度安全验证未通过（ERR_BAIDU_CAPTCHA）', 'detail 仍写入 error 列');
});

test('flattenEvent captures error_code = ERR_BROWSER_LAUNCH for a boot failure', () => {
  const ev = {
    taskId: 't1',
    type: 'step',
    round: { roundIndex: 0, totalRounds: 4, platform: 'baidu', keyword: '移民' },
    step: {
      step: 'boot',
      status: 'failed',
      code: ERR.ERR_BROWSER_LAUNCH,
      detail: '浏览器启动失败',
    },
    timestamp: '2026-07-16T10:00:02.000Z',
  };
  const row = db.flattenEvent(ev);
  assert.strictEqual(row[IDX_ERROR_CODE], ERR.ERR_BROWSER_LAUNCH);
});
