'use strict';

/**
 * core/adapters/googleAdapter.js
 * ---------------------------------------------------------------------------
 * 谷歌平台适配器：打开 google.com → 搜索 → 结果页双匹配定位 → 进入目标站。
 *
 * 双匹配（决策 Q3/A1）：结果前 10 条中，标题包含任一 titleKeyword 且
 * 真实落地地址包含 targetDomain 的条目，取首个匹配。
 */

const { PlatformAdapter } = require('./platformAdapter');

const GOOGLE_HOME = 'https://www.google.com';
const SEARCH_BOX = 'textarea[name="q"]';
const RESULT_BLOCK = '#rso > div, #rso div.g';

class GoogleAdapter extends PlatformAdapter {
  constructor() {
    super('google');
  }

  /** 打开谷歌首页 */
  async open(page) {
    await page.goto(GOOGLE_HOME, { waitUntil: 'domcontentloaded', timeout: 30000 });
  }

  /** 填入关键词并回车搜索 */
  async search(page, keyword) {
    await page.fill(SEARCH_BOX, keyword);
    await page.keyboard.press('Enter');
    await page.waitForSelector('#rso', { timeout: 30000 });
  }

  /** 结果页双匹配定位目标站点 */
  async locateTarget(page, target) {
    const blocks = await page.$$(RESULT_BLOCK);
    const top = blocks.slice(0, 10);
    for (const block of top) {
      const links = await block.$$('a');
      for (const a of links) {
        const href = (await a.getAttribute('href')) || '';
        if (!/^https?:\/\//i.test(href)) continue;
        const title = (await a.textContent()) || '';
        if (!PlatformAdapter.matchTitle(title, target.titleKeywords)) continue;
        if (PlatformAdapter.matchHref(href, target.domain)) return href;
        // 谷歌部分结果经 /url?q= 跳转，解析真实落地地址后双匹配
        const real = await PlatformAdapter.resolveFinalUrl(href, 3000);
        if (PlatformAdapter.matchHref(real, target.domain)) return real;
      }
    }
    return null;
  }

  /** 跳转进入目标站点 */
  async clickTarget(page, href) {
    await page.goto(href, { waitUntil: 'domcontentloaded', timeout: 30000 });
  }
}

module.exports = { GoogleAdapter };
