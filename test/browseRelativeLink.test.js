'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { TaskEngine } = require('../core/taskEngine');

/**
 * 回归测试：_findContactLink 必须能解析相对路径 href（如 about.html）。
 * 背景：manincorp.cn 导航「关于万年」的 HTML 是 <a href="about.html">关于万年</a>，
 * 原实现只处理 / 开头或完整 http(s) URL，导致识别到了锚点但返回 null，
 * 最终 browse 步骤软失败。
 */

function makeEngine(anchor) {
  return new TaskEngine({
    target: {
      domain: 'manincorp.cn',
      browseAnchor: anchor,
    },
  }, () => {});
}

function makeMockPage(links) {
  return {
    url() { return 'https://www.manincorp.cn/index.html'; },
    async $$() {
      return links.map((l) => ({
        async textContent() { return l.text; },
        async getAttribute(name) { return name === 'href' ? l.href : null; },
      }));
    },
  };
}

test('_findContactLink resolves relative href like about.html', async () => {
  const engine = makeEngine('关于万年');
  const page = makeMockPage([
    { text: '首页', href: 'index.html' },
    { text: '香港', href: 'hongkong.html' },
    { text: '关于万年', href: 'about.html' },
  ]);
  const result = await engine._findContactLink(page);
  assert.strictEqual(result, 'https://www.manincorp.cn/about.html');
});

test('_findContactLink resolves absolute-path href', async () => {
  const engine = makeEngine('关于万年');
  const page = makeMockPage([
    { text: '关于万年', href: '/about.html' },
  ]);
  const result = await engine._findContactLink(page);
  assert.strictEqual(result, 'https://www.manincorp.cn/about.html');
});

test('_findContactLink resolves full http URL', async () => {
  const engine = makeEngine('关于万年');
  const page = makeMockPage([
    { text: '关于万年', href: 'http://www.manincorp.cn/about.html' },
  ]);
  const result = await engine._findContactLink(page);
  assert.strictEqual(result, 'http://www.manincorp.cn/about.html');
});

test('_findContactLink ignores # and javascript: pseudo links', async () => {
  const engine = makeEngine('关于万年');
  const page = makeMockPage([
    { text: '关于万年', href: '#section' },
    { text: '关于万年', href: 'javascript:void(0)' },
  ]);
  const result = await engine._findContactLink(page);
  assert.strictEqual(result, null);
});
