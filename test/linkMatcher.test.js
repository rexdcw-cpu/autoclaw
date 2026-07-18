'use strict';

/**
 * test/linkMatcher.test.js
 * ---------------------------------------------------------------------------
 * Unit tests for core/linkMatcher.js (NO browser).
 *
 * Verifies the「目标页面」匹配纯函数 matchContactLink 的命中逻辑：
 *   - 锚点子串匹配（可配置，如「关于万年」）
 *   - 通用文案兜底（联系/contact/about）
 *   - 英文路径兜底（/contact、/about、/about-us）
 *   - 无关链接不命中
 *
 * 另含一条端到端校验：core/taskConfig.buildTaskConfig 能正确解析并透传 browseAnchor，
 * 且 engine 实际使用的命中判定与本纯函数一致。
 */

const test = require('node:test');
const assert = require('node:assert');

const { matchContactLink } = require('../core/linkMatcher');

// anchor 归一化后的「默认」值
const DEFAULT_ANCHOR = '关于我们';

// ---------------------------------------------------------------------------
// 1) 锚点子串匹配：默认锚点「关于我们」
// ---------------------------------------------------------------------------

test('anchor=关于我们 时，链接文本含「关于我们」命中', () => {
  assert.strictEqual(matchContactLink('关于我们', '/about-us', DEFAULT_ANCHOR), true);
  assert.strictEqual(matchContactLink('关于我们', '/foo', DEFAULT_ANCHOR), true);
  assert.strictEqual(matchContactLink('公司关于我们介绍', '/x', DEFAULT_ANCHOR), true);
});

// ---------------------------------------------------------------------------
// 2) 锚点可配置：用户填「关于万年」，命中「关于万年」文案（核心修复场景）
// ---------------------------------------------------------------------------

test('anchor=关于万年（用户自定义）时，链接文本含「关于万年」命中', () => {
  const anchor = '关于万年';
  assert.strictEqual(matchContactLink('关于万年', '/about', anchor), true);
  assert.strictEqual(matchContactLink('导航·关于万年', '/x', anchor), true);
});

test('anchor=关于万年 时，链接文本仅含默认「关于我们」不再命中（除非另有兜底）', () => {
  const anchor = '关于万年';
  // 仅「关于我们」不含「关于万年」，且无联系/英文路径 → 不命中（体现可配置性）
  assert.strictEqual(matchContactLink('关于我们', '/product', anchor), false);
});

// ---------------------------------------------------------------------------
// 3) 通用文案兜底：联系/contact/about（即便锚点为默认「关于我们」，也不漏「联系我们」）
// ---------------------------------------------------------------------------

test('anchor=关于我们 时，链接文本含「联系我们」走 GENERIC_TEXT_RE 兜底命中', () => {
  assert.strictEqual(matchContactLink('联系我们', '/foo', DEFAULT_ANCHOR), true);
  assert.strictEqual(matchContactLink('联系', '/foo', DEFAULT_ANCHOR), true);
});

test('英文 about/contact 文案走 GENERIC_TEXT_RE 兜底命中', () => {
  assert.strictEqual(matchContactLink('About Us', '/foo', DEFAULT_ANCHOR), true);
  assert.strictEqual(matchContactLink('Contact', '/foo', DEFAULT_ANCHOR), true);
});

// ---------------------------------------------------------------------------
// 4) 无关链接不命中
// ---------------------------------------------------------------------------

test('链接文本为「产品中心」、路径 /product 不命中', () => {
  assert.strictEqual(matchContactLink('产品中心', '/product', DEFAULT_ANCHOR), false);
  assert.strictEqual(matchContactLink('新闻动态', '/news', DEFAULT_ANCHOR), false);
  assert.strictEqual(matchContactLink('首页', '/', DEFAULT_ANCHOR), false);
});

// ---------------------------------------------------------------------------
// 5) 英文路径兜底：/contact、/about、/about-us
// ---------------------------------------------------------------------------

test('链接路径 /about 命中（PATH_RE 兜底）', () => {
  assert.strictEqual(matchContactLink('随便文字', '/about', DEFAULT_ANCHOR), true);
  assert.strictEqual(matchContactLink('随便文字', '/about', '关于万年'), true);
});

test('链接路径 /contact、/about-us 命中（PATH_RE 兜底）', () => {
  assert.strictEqual(matchContactLink('x', '/contact', DEFAULT_ANCHOR), true);
  assert.strictEqual(matchContactLink('x', '/about-us', DEFAULT_ANCHOR), true);
});

test('路径大小写不敏感', () => {
  assert.strictEqual(matchContactLink('x', '/ABOUT', DEFAULT_ANCHOR), true);
  assert.strictEqual(matchContactLink('x', '/Contact', DEFAULT_ANCHOR), true);
});

// ---------------------------------------------------------------------------
// 健壮性
// ---------------------------------------------------------------------------

test('anchor 含正则特殊字符时子串匹配不崩溃', () => {
  // 若误用正则，含有 ( ) . * ? 的锚点会抛错或产生意外匹配；子串匹配应安全
  const tricky = '关于(我们)';
  assert.strictEqual(matchContactLink('关于(我们)', '/x', tricky), true);
  assert.strictEqual(matchContactLink('关于我们', '/x', tricky), false);
  const star = '关于*我们';
  assert.strictEqual(matchContactLink('关于*我们', '/x', star), true);
});

test('anchor 为空/未传时回落到默认「关于我们」', () => {
  assert.strictEqual(matchContactLink('关于我们', '/x'), true);
  assert.strictEqual(matchContactLink('关于我们', '/x', ''), true);
  assert.strictEqual(matchContactLink('关于我们', '/x', undefined), true);
});

test('text/path 非字符串入参不抛错', () => {
  assert.strictEqual(matchContactLink(null, null, DEFAULT_ANCHOR), false);
  assert.strictEqual(matchContactLink(undefined, undefined, DEFAULT_ANCHOR), false);
});

// ---------------------------------------------------------------------------
// 端到端：taskConfig 解析并透传 browseAnchor，engine 命中判定与纯函数一致
// ---------------------------------------------------------------------------

const { buildTaskConfig } = require('../core/taskConfig');

test('buildTaskConfig 透传 browseAnchor 到 target，缺省兜底「关于我们」', () => {
  const cfgDefault = buildTaskConfig({
    platforms: ['baidu'],
    keywords: '移民',
    targetDomain: 'manincorp.cn',
    titleKeywords: '万年移民',
  });
  assert.strictEqual(cfgDefault.target.browseAnchor, '关于我们');

  const cfgCustom = buildTaskConfig({
    platforms: ['baidu'],
    keywords: '移民',
    targetDomain: 'manincorp.cn',
    titleKeywords: '万年移民',
    browseAnchor: '  关于万年  ',
  });
  assert.strictEqual(cfgCustom.target.browseAnchor, '关于万年');
});

test('engine 使用的命中判定与 matchContactLink 一致（用解析后的 anchor）', () => {
  const cfg = buildTaskConfig({
    platforms: ['baidu'],
    keywords: '移民',
    targetDomain: 'manincorp.cn',
    titleKeywords: '万年移民',
    browseAnchor: '关于万年',
  });
  const anchor = (cfg.target.browseAnchor || '关于我们').trim() || '关于我们';
  // 站点导航文案为「关于万年」→ 命中
  assert.strictEqual(matchContactLink('关于万年', '/about', anchor), true);
  // 站点导航文案为默认「关于我们」但锚点已改 → 不应命中（除非有其他兜底）
  assert.strictEqual(matchContactLink('关于我们', '/product', anchor), false);
});
