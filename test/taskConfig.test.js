'use strict';

/**
 * test/taskConfig.test.js
 * ---------------------------------------------------------------------------
 * Unit tests for core/taskConfig.js (NO browser).
 *
 * Covers:
 *   - Keyword / titleKeywords splitting by | 、 , (,)
 *   - RoundPlan[] cross-product generation (platform × keyword)
 *   - Validation: missing platforms / keywords / targetDomain / titleKeywords -> ERR_INVALID_CONFIG
 *   - Valid config produces a uuid taskId + status 'pending'
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  buildTaskConfig,
  orderPlatforms,
  buildRounds,
} = require('../core/taskConfig');
const { ERR, TaskStatus } = require('../core/progressEvent');

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Build a fully-valid payload with optional overrides. */
function validPayload(overrides) {
  return Object.assign(
    {
      platforms: ['baidu', 'google'],
      keywords: '移民',
      targetDomain: 'manincorp.cn',
      titleKeywords: '万年移民',
    },
    overrides || {}
  );
}

// ---------------------------------------------------------------------------
// Keyword splitting
// ---------------------------------------------------------------------------

test('split keywords by pipe |', () => {
  const cfg = buildTaskConfig(validPayload({ keywords: '北京|上海|广州' }));
  assert.deepStrictEqual(cfg.keywords, ['北京', '上海', '广州']);
});

test('split keywords by Chinese enumeration 、', () => {
  const cfg = buildTaskConfig(validPayload({ keywords: '北京、上海、广州' }));
  assert.deepStrictEqual(cfg.keywords, ['北京', '上海', '广州']);
});

test('split keywords by ascii comma ,', () => {
  const cfg = buildTaskConfig(validPayload({ keywords: '北京,上海,广州' }));
  assert.deepStrictEqual(cfg.keywords, ['北京', '上海', '广州']);
});

test('split keywords by mixed delimiters', () => {
  const cfg = buildTaskConfig(validPayload({ keywords: '北京|上海、广州,深圳' }));
  assert.deepStrictEqual(cfg.keywords, ['北京', '上海', '广州', '深圳']);
});

test('trim surrounding whitespace of tokens', () => {
  const cfg = buildTaskConfig(validPayload({ keywords: '  北京 | 上海  | 广州 ' }));
  assert.deepStrictEqual(cfg.keywords, ['北京', '上海', '广州']);
});

test('drop empty tokens (consecutive delimiters)', () => {
  const cfg = buildTaskConfig(validPayload({ keywords: '北京||上海' }));
  assert.deepStrictEqual(cfg.keywords, ['北京', '上海']);
});

test('accept keywords already given as array', () => {
  const cfg = buildTaskConfig(validPayload({ keywords: ['北京', '上海'] }));
  assert.deepStrictEqual(cfg.keywords, ['北京', '上海']);
});

// ---------------------------------------------------------------------------
// titleKeywords splitting (same rules)
// ---------------------------------------------------------------------------

test('split titleKeywords by pipe |', () => {
  const cfg = buildTaskConfig(validPayload({ titleKeywords: '万年移民|海外移民' }));
  assert.deepStrictEqual(cfg.target.titleKeywords, ['万年移民', '海外移民']);
});

test('split titleKeywords by Chinese enumeration 、', () => {
  const cfg = buildTaskConfig(validPayload({ titleKeywords: '万年移民、海外移民' }));
  assert.deepStrictEqual(cfg.target.titleKeywords, ['万年移民', '海外移民']);
});

test('split titleKeywords by ascii comma ,', () => {
  const cfg = buildTaskConfig(validPayload({ titleKeywords: '万年移民,海外移民' }));
  assert.deepStrictEqual(cfg.target.titleKeywords, ['万年移民', '海外移民']);
});

test('titleKeywords trimmed and empty tokens dropped', () => {
  const cfg = buildTaskConfig(validPayload({ titleKeywords: ' 万年移民 | | 海外移民 ' }));
  assert.deepStrictEqual(cfg.target.titleKeywords, ['万年移民', '海外移民']);
});

// ---------------------------------------------------------------------------
// RoundPlan[] generation (cross product)
// ---------------------------------------------------------------------------

test('buildRounds produces platform×keyword cross product', () => {
  const rounds = buildRounds(['baidu', 'google'], ['k1', 'k2']);
  assert.strictEqual(rounds.length, 4); // 2 platforms × 2 keywords
  assert.deepStrictEqual(
    rounds.map((r) => [r.platform, r.keyword]),
    [
      ['baidu', 'k1'],
      ['baidu', 'k2'],
      ['google', 'k1'],
      ['google', 'k2'],
    ]
  );
});

test('each RoundPlan has correct roundIndex / totalRounds', () => {
  const rounds = buildRounds(['baidu', 'google'], ['k1', 'k2']);
  assert.deepStrictEqual(
    rounds.map((r) => r.roundIndex),
    [0, 1, 2, 3]
  );
  for (const r of rounds) {
    assert.strictEqual(r.totalRounds, 4);
  }
});

test('buildTaskConfig RoundPlan count = platforms × keywords', () => {
  const cfg = buildTaskConfig(validPayload({ platforms: ['baidu', 'google'], keywords: 'a|b|c|d' }));
  assert.strictEqual(cfg.platforms.length, 2);
  assert.strictEqual(cfg.keywords.length, 4);
  assert.strictEqual(cfg.rounds.length, 8); // 2 × 4
  assert.strictEqual(cfg.rounds[0].totalRounds, 8);
  assert.strictEqual(cfg.rounds[0].roundIndex, 0);
  assert.strictEqual(cfg.rounds[7].roundIndex, 7);
});

test('platforms preserve baidu->google order regardless of input order', () => {
  const cfg = buildTaskConfig(validPayload({ platforms: ['google', 'baidu'] }));
  assert.deepStrictEqual(cfg.platforms, ['baidu', 'google']);
  assert.strictEqual(cfg.rounds[0].platform, 'baidu');
});

test('orderPlatforms drops invalid platform values', () => {
  assert.deepStrictEqual(orderPlatforms(['baidu', 'bogus', 'google']), ['baidu', 'google']);
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

test('missing platforms -> ERR_INVALID_CONFIG', () => {
  assert.throws(
    () => buildTaskConfig(validPayload({ platforms: undefined })),
    (e) => e && e.code === ERR.ERR_INVALID_CONFIG
  );
});

test('empty platforms array -> ERR_INVALID_CONFIG', () => {
  assert.throws(
    () => buildTaskConfig(validPayload({ platforms: [] })),
    (e) => e && e.code === ERR.ERR_INVALID_CONFIG
  );
});

test('missing keywords -> ERR_INVALID_CONFIG', () => {
  assert.throws(
    () => buildTaskConfig(validPayload({ keywords: undefined })),
    (e) => e && e.code === ERR.ERR_INVALID_CONFIG
  );
});

test('empty keywords -> ERR_INVALID_CONFIG', () => {
  assert.throws(
    () => buildTaskConfig(validPayload({ keywords: '' })),
    (e) => e && e.code === ERR.ERR_INVALID_CONFIG
  );
});

test('missing targetDomain (A1 required) -> ERR_INVALID_CONFIG', () => {
  assert.throws(
    () => buildTaskConfig(validPayload({ targetDomain: undefined })),
    (e) => e && e.code === ERR.ERR_INVALID_CONFIG
  );
});

test('empty targetDomain -> ERR_INVALID_CONFIG', () => {
  assert.throws(
    () => buildTaskConfig(validPayload({ targetDomain: '' })),
    (e) => e && e.code === ERR.ERR_INVALID_CONFIG
  );
});

test('missing titleKeywords -> ERR_INVALID_CONFIG', () => {
  assert.throws(
    () => buildTaskConfig(validPayload({ titleKeywords: undefined })),
    (e) => e && e.code === ERR.ERR_INVALID_CONFIG
  );
});

// ---------------------------------------------------------------------------
// Valid config
// ---------------------------------------------------------------------------

test('valid config produces uuid taskId and status pending', () => {
  const cfg = buildTaskConfig(validPayload());
  assert.match(cfg.taskId, UUID_RE);
  assert.strictEqual(cfg.status, TaskStatus.PENDING);
  assert.strictEqual(cfg.status, 'pending');
  assert.strictEqual(cfg.target.domain, 'manincorp.cn');
  assert.deepStrictEqual(cfg.target.titleKeywords, ['万年移民']);
});

test('valid config carries anthropic + strategy defaults', () => {
  const cfg = buildTaskConfig(validPayload());
  assert.strictEqual(typeof cfg.anthropic.staySeconds, 'number');
  assert.strictEqual(typeof cfg.strategy.mode, 'string');
  assert.strictEqual(cfg.strategy.mode, 'serial');
});
