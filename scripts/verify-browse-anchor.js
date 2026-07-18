'use strict';
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');
const { matchContactLink } = require('../core/linkMatcher');

(async () => {
  const userDataDir = path.join(os.tmpdir(), 'autoclaw-verify-profile');
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chrome',
    headless: false,
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const page = await context.newPage();
  await page.goto('https://www.manincorp.cn/index.html', { waitUntil: 'domcontentloaded', timeout: 60000 });

  const links = await page.$$('a[href]');
  const base = new URL(page.url());
  const anchor = '关于万年';
  const hits = [];
  for (const a of links) {
    const text = ((await a.textContent()) || '').trim();
    let href = (await a.getAttribute('href')) || '';
    if (!href) continue;
    if (/^(#|javascript:|mailto:|tel:|data:)/i.test(href)) continue;
    let absoluteHref;
    try { absoluteHref = new URL(href, base.href).href; } catch (e) { continue; }
    const p = absoluteHref.replace(/^https?:\/\/[^/]+/i, '').toLowerCase();
    if (matchContactLink(text, p, anchor)) {
      hits.push({ text, resolved: absoluteHref });
    }
  }
  console.log('ANCHOR=' + anchor);
  console.log('HITS=' + JSON.stringify(hits, null, 2));
  await context.close();
})().catch((e) => { console.error('VERIFY_ERR', e && e.message ? e.message : e); process.exit(1); });
