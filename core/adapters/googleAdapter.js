'use strict';

/**
 * core/adapters/googleAdapter.js
 * ---------------------------------------------------------------------------
 * 谷歌平台适配器：打开 google.com → 搜索 → 结果页双匹配定位 → 进入目标站。
 *
 * 双匹配（决策 Q3/A1）：结果前 10 条中，标题包含任一 titleKeyword 且
 * 真实落地地址包含 targetDomain 的条目，取首个匹配（non-strict 模式下启用
 * domain-only 兜底，见 PlatformAdapter.matchTarget）。
 *
 * ── 与百度适配器对齐的成熟度（本文件相对旧版「裸实现」补全的能力）────────────
 * 旧版谷歌适配器只是「fill 搜索框 + Enter + 等 #rso」，在真实环境下面临三类
 * 必然失败的场景，本版全部补齐，对齐 baiduAdapter 的稳健度：
 *
 *  1) Google 同意页（consent.google.com）：
 *     新 IP / 新区域首次访问 google.com，会被重定向到「Before you continue」
 *     同意页（含 Cookie / 隐私条款），此时既无搜索框也无 #rso，旧版会傻等
 *     30s 后抛笼统超时。本版 open()/search() 均先检测同意页并自动点击「同意/
 *     Accept」按钮，等待其离开同意页再继续。
 *
 *  2) 异常流量 / 验证码（google.com/sorry）：
 *     谷歌对自动化 / 异常 IP 极其敏感，搜索后常被重定向到「我们的系统检测到
 *     您的计算机网络中存在异常流量」拦截页（URL 含 google.com/sorry）。旧版
 *     无法识别、#rso 永不出现 → 超时。本版 open()/search() 命中后进入轮询
 *     （上限 CAPTCHA_WAIT_MS、间隔 CAPTCHA_POLL_INTERVAL），提示用户在可见
 *     Chrome 窗口手动过码，过码后自动继续；轮询耗尽抛 ERR_GOOGLE_CAPTCHA。
 *
 *  3) search 步骤「分步 + 明确中文错误」+ evaluate 写值绕开可见性：
 *     旧版 search 用 fill + keyboard.press('Enter')，依赖搜索框可见可聚焦，
 *     且任一步卡住都只抛笼统动作超时。本版改为：
 *       - 步骤A 等待搜索框（state:'attached'，不要求可见）；
 *       - 步骤B 用 page.evaluate 直接对 textarea[name="q"] 赋原生 value 并派发
 *         input/change 事件，绕开可见性约束（对隐藏/可见态均生效）；
 *       - 步骤C 用 page.evaluate 在页面内触发 form.requestSubmit()（回退点击
 *         搜索按钮），不依赖搜索框聚焦；
 *       - 步骤D 轮询等待 #rso，期间识别同意页/验证码并据情处理，给出可操作提示。
 *
 *  4) locateTarget 精准取标题链接 + 复用基类双匹配 + 失败诊断：
 *     旧版遍历结果块内「全部 <a>」（含站点链接/sitelink/页脚噪声），易误匹配；
 *     且未复用基类 matchTarget、无失败诊断。本版：
 *       - 用 `#rso h3 a` 精准取每条结果的标题主链接（排除 sitelink/页脚噪声）；
 *       - 解析 Google 跳转链接（/url?q= 或相对路径）为真实落地地址；
 *       - 复用 PlatformAdapter.matchTarget（strict:false，启用 domain-only 兜底）；
 *       - 未命中时抛出明确中文诊断（域名未进排名 / 标题未中关键词）。
 */

const { PlatformAdapter } = require('./platformAdapter');

const GOOGLE_HOME = 'https://www.google.com';
const SEARCH_BOX = 'textarea[name="q"]';
const RESULT_TITLE_LINK = '#rso h3 a';

/**
 * search / open 子动作超时（毫秒）。设计目标同 baiduAdapter：
 * 单步超时之和（最坏 10+6 = 16s）< 外层 150s，保证任一步骤卡住时本步骤的
 * 「明确错误」能在外层兜底超时之前抛出。
 */
const STEP_TIMEOUT = {
  /** 步骤A：等待搜索框挂载进 DOM（attached，不要求可见） */
  WAIT_BOX: 10000,
  /** 步骤C：提交搜索（evaluate 触发 requestSubmit，近乎瞬时；超时仅作兜底） */
  SUBMIT: 6000,
};

/**
 * 验证码 / 同意页轮询参数（open / search 共用）：上限 120s、间隔 2s。
 * 命中谷歌异常流量拦截（google.com/sorry）时进入轮询，等待用户在可见 Chrome
 * 窗口手动过码；轮询耗尽抛 ERR_GOOGLE_CAPTCHA。
 */
const CAPTCHA_WAIT_MS = 120000;
const CAPTCHA_POLL_INTERVAL = 2000;

/** 同意页点击后等待离开的最长时间（毫秒） */
const CONSENT_LEAVE_MS = 15000;

class GoogleAdapter extends PlatformAdapter {
  constructor() {
    super('google');
  }

  /**
   * 包装单个子动作：执行 fn()，若其 reject，统一抛出带「步骤名」的明确错误，
   * 便于 run_log 精准定位卡点（剥离底层 Playwright 长堆栈）。
   */
  async _withStep(_stepName, errMsg, fn) {
    try {
      await fn();
    } catch (e) {
      // 透传底层真实错误，便于 run_log 精准定位（避免笼统的「超时」掩盖真因）
      const inner = e && e.message ? e.message : String(e);
      throw new Error(errMsg + '（' + inner + '）');
    }
  }

  /**
   * 是否落在 Google 同意页（Cookie / 隐私条款「Before you continue」）。
   * 探测均包 try/catch：失败时一律视为「非同意页」。
   * @param {import('playwright').Page} page
   * @returns {Promise<boolean>}
   */
  async _isConsentPage(page) {
    // 1) URL 命中 consent.google.com（最可靠）
    try {
      if ((page.url() || '').includes('consent.google.com')) return true;
    } catch (e) {}
    // 2) 页面正文命中同意页关键文案
    try {
      const hit = await page.evaluate(() => {
        const t = ((document.body && document.body.innerText) || '').toLowerCase();
        return /before you continue|our privacy|privacy & terms|我们使用 cookie|我们使用「cookie」|隐私权和条款|同意 cookies|your data in search/.test(
          t
        );
      });
      if (hit) return true;
    } catch (e) {}
    return false;
  }

  /**
   * 在页面内查找并点击「同意/Accept」按钮（Google 同意页主操作按钮）。
   * 通过按钮文案匹配，兼容不同语言/UI 变体；找不到返回 false。
   * @param {import('playwright').Page} page
   * @returns {Promise<boolean>}
   */
  async _tryConsent(page) {
    try {
      return await page.evaluate(() => {
        const btns = Array.from(
          document.querySelectorAll('button, input[type="submit"], a[role="button"]')
        );
        const accept = btns.find((b) => {
          const t = (
            (b.textContent || '') + ' ' + (b.value || '') + ' ' + (b.getAttribute('aria-label') || '')
          )
            .trim()
            .toLowerCase();
          return /(agree|accept|同意|接受|确认|接受并继续)/i.test(t);
        });
        if (accept) {
          accept.click();
          return true;
        }
        return false;
      });
    } catch (e) {
      return false;
    }
  }

  /**
   * 处理 Google 同意页：点击「同意/Accept」并等待其离开。
   * 返回 true 表示已成功接受并离开同意页；false 表示未找到按钮或离开超时。
   * 调用方据返回值决定是否抛出 ERR_GOOGLE_CONSENT。
   * @param {import('playwright').Page} page
   * @returns {Promise<boolean>}
   */
  async _handleConsent(page) {
    let clicked = await this._tryConsent(page);
    if (!clicked) {
      // 按钮可能尚未挂载，稍候再试一次
      await page.waitForTimeout(2000);
      clicked = await this._tryConsent(page);
    }
    if (!clicked) return false;

    // 等待离开同意页（URL 不再含 consent.google.com 且正文不再命中同意文案）
    const deadline = Date.now() + CONSENT_LEAVE_MS;
    while (Date.now() < deadline) {
      await page.waitForTimeout(1000);
      if (!(await this._isConsentPage(page))) return true;
    }
    return false;
  }

  /**
   * 是否命中谷歌异常流量验证码（拦截）页。
   *   - URL 含 google.com/sorry / ipv4.google.com/sorry（最可靠）
   *   - 页面正文含 "unusual traffic" / "异常流量" / "please show you're not a robot"
   *     / "confirm you are a human" / "our systems have detected" 等拦截文案
   * 各探测均包 try/catch：探测失败一律视为「未拦截」。
   * @param {import('playwright').Page} page
   * @returns {Promise<boolean>}
   */
  async _isCaptchaPage(page) {
    // 1) URL 命中 sorry 拦截宿主
    try {
      const u = (page.url() || '').toLowerCase();
      if (u.includes('google.com/sorry') || u.includes('ipv4.google.com/sorry')) return true;
    } catch (e) {}
    // 2) 页面正文命中拦截文案
    try {
      const t = await page.evaluate(
        () => ((document.body && document.body.innerText) || '').toLowerCase()
      );
      if (
        /unusual traffic|异常流量|please show you|confirm you are a human|our systems have detected|robot|sorry\/index/.test(
          t
        )
      ) {
        return true;
      }
    } catch (e) {}
    return false;
  }

  /**
   * 验证码轮询：上限 CAPTCHA_WAIT_MS、间隔 CAPTCHA_POLL_INTERVAL。
   * 命中谷歌异常流量拦截后进入轮询，提示用户在可见 Chrome 窗口手动过码；
   * 过码后调用 onSolved 回调（用于补充处理离开拦截后可能再次弹出的同意页），
   * 然后返回。轮询耗尽抛 ERR_GOOGLE_CAPTCHA。
   * @param {import('playwright').Page} page
   * @param {() => Promise<void>} [onSolved]
   */
  async _pollCaptcha(page, onSolved) {
    let elapsed = 0;
    while (elapsed < CAPTCHA_WAIT_MS) {
      console.warn(
        '谷歌异常流量验证拦截：请在弹出的 Chrome 窗口中手动完成验证，程序将在验证通过后自动继续'
      );
      await page.waitForTimeout(CAPTCHA_POLL_INTERVAL);
      elapsed += CAPTCHA_POLL_INTERVAL;
      if (!(await this._isCaptchaPage(page))) {
        if (onSolved) await onSolved();
        return;
      }
    }
    throw new Error(
      '谷歌验证未通过（ERR_GOOGLE_CAPTCHA）：请在可见 Chrome 窗口手动通过验证后重试'
    );
  }

  /**
   * 打开谷歌首页。
   * - 内重试 3 次（带退避）绕过偶发 ERR_ABORTED / 超时；
   * - 命中同意页 → _handleConsent（点击同意并等待离开）；
   * - 命中验证码拦截 → 轮询等待用户手动过码；
   * - 最后等待搜索框挂载（attached，不要求可见）。
   * @param {import('playwright').Page} page
   */
  async open(page) {
    let lastErr = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        await page.goto(GOOGLE_HOME, { waitUntil: 'domcontentloaded', timeout: 20000 });

        // 同意页优先处理（URL 重定向到 consent.google.com 时不出现搜索框）
        if (await this._isConsentPage(page)) {
          if (!(await this._handleConsent(page))) {
            throw new Error('谷歌同意页未通过（ERR_GOOGLE_CONSENT）：请手动点击「同意」后重试');
          }
        }

        // 异常流量验证码拦截（多 round 复用同一 profile 时易触发）
        if (await this._isCaptchaPage(page)) {
          await this._pollCaptcha(page, async () => {
            if (await this._isConsentPage(page)) await this._handleConsent(page);
          });
        }

        // 非拦截态：仅等待搜索框挂载进 DOM（不要求可见，规避某些布局下隐藏态）
        await page.waitForSelector(SEARCH_BOX, { state: 'attached', timeout: 15000 });
        return;
      } catch (e) {
        lastErr = e;
        if (attempt < 3) await page.waitForTimeout(3000);
      }
    }
    throw new Error('打开谷歌首页失败（重试后仍失败）：' + (lastErr && lastErr.message));
  }

  /**
   * 填入关键词并提交搜索（分步 + 明确中文步骤错误 + attached/evaluate 绕开可见性）。
   * @param {import('playwright').Page} page
   * @param {string} keyword
   */
  async search(page, keyword) {
    // 步骤A：等待搜索框挂载（attached，不要求可见）
    await this._withStep('等待搜索框', '等待谷歌搜索框挂载超时', async () => {
      await page.waitForSelector(SEARCH_BOX, {
        state: 'attached',
        timeout: STEP_TIMEOUT.WAIT_BOX,
      });
    });

    // 步骤B：填写搜索词（evaluate 写原生 value + 派发 input/change，绕开可见性）。
    // 注意：谷歌首页搜索框是 <textarea name="q">（不是 <input>），
    // 必须用「元素自身原型」的 value setter，否则对 textarea 调用
    // HTMLInputElement.prototype 的 setter 会抛「Illegal invocation」。
    await this._withStep('填写搜索词', '填写谷歌搜索词超时', async () => {
      await page.evaluate((kw) => {
        const el = document.querySelector('textarea[name="q"]');
        if (!el) throw new Error('google search box (textarea[name="q"]) not found');
        const proto = (el.constructor && el.constructor.prototype) || window.HTMLInputElement.prototype;
        const desc =
          Object.getOwnPropertyDescriptor(proto, 'value') ||
          Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
        if (!desc || typeof desc.set !== 'function') {
          throw new Error('无法获取搜索框 value setter');
        }
        desc.set.call(el, kw);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }, keyword);
    });

    // 步骤C：提交搜索（evaluate 触发 form.requestSubmit，回退点击搜索按钮）
    await this._withStep('提交搜索', '提交谷歌搜索超时', async () => {
      await page.evaluate(() => {
        const form =
          document.querySelector('form[action="/search"]') ||
          document.querySelector('form[role="search"]') ||
          document.querySelector('form');
        if (form && typeof form.requestSubmit === 'function') {
          form.requestSubmit();
          return;
        }
        const btn = document.querySelector(
          'input[name="btnK"], button[aria-label*="Google"], input[value*="Google"]'
        );
        if (btn) {
          btn.click();
          return;
        }
        throw new Error('google search form/button not found');
      });
    });

    // 步骤D（轮询）：提交后可能落到同意页 / 异常流量验证码页，或结果仍在加载。
    // 轮询等待 #rso：结果出现即成功；同意页则点同意；验证码页则提示用户手动过码。
    let elapsed = 0;
    while (elapsed < CAPTCHA_WAIT_MS) {
      let hasResults = false;
      try {
        await page.waitForSelector('#rso', {
          state: 'visible',
          timeout: CAPTCHA_POLL_INTERVAL,
        });
        hasResults = true;
      } catch (e) {
        hasResults = false;
      }
      if (hasResults) return; // 结果页已出现，搜索成功

      if (await this._isConsentPage(page)) {
        // 同意页（提交后被重定向）：点击同意等待离开，继续轮询
        await this._handleConsent(page);
      } else if (await this._isCaptchaPage(page)) {
        // 验证码页：提示用户手动过码，轮询等待其解决
        console.warn(
          '谷歌异常流量验证拦截：请在弹出的 Chrome 窗口中手动完成验证，程序将在验证通过后自动继续'
        );
      }
      // 否则页面仍在加载，继续轮询
      await page.waitForTimeout(CAPTCHA_POLL_INTERVAL);
      elapsed += CAPTCHA_POLL_INTERVAL;
    }
    throw new Error('谷歌结果页未加载或验证未通过（ERR_GOOGLE_CAPTCHA）');
  }

  /** 结果页双匹配定位目标站点（精准取标题主链接 + 复用基类 matchTarget + 诊断） */
  async locateTarget(page, target) {
    // 二次保险：落在验证码 / 同意页时结果容器不存在，提前抛出明确错误
    if (await this._isCaptchaPage(page)) {
      throw new Error(
        '谷歌验证拦截（ERR_GOOGLE_CAPTCHA）：结果页未加载，请在可见窗口手动通过验证后重试'
      );
    }
    if (await this._isConsentPage(page)) {
      throw new Error('谷歌同意页拦截（ERR_GOOGLE_CONSENT）：结果页未加载，请先通过同意页');
    }

    // 精准取每条结果的标题主链接（#rso 内每个 h3 的 a），排除 sitelink / 页脚噪声
    const anchors = await page.$$(RESULT_TITLE_LINK);
    const top = anchors.slice(0, 10);

    // 安全读取元素属性/文本（部分 mock 元素可能未实现对应方法）
    const safeText = async (el) => {
      try {
        if (el && typeof el.textContent === 'function') return (await el.textContent()) || '';
      } catch (e) {}
      return '';
    };
    const safeAttr = async (el, name) => {
      try {
        if (el && typeof el.getAttribute === 'function') return (await el.getAttribute(name)) || '';
      } catch (e) {}
      return '';
    };

    // 解析为 {title, href}：google 跳转链接（/url?q= 或相对路径）解析为真实落地地址；
    // 直接 https 链接沿用，由 matchHref 兜底判定。
    const parsed = [];
    for (const a of top) {
      const title = (await safeText(a)).toString();
      const href = (await safeAttr(a, 'href')) || '';
      if (!/^https?:\/\//i.test(href) && !href.startsWith('/')) continue;
      const realUrl = /^https?:\/\//i.test(href)
        ? href
        : await PlatformAdapter.resolveFinalUrl(href, 3000);
      parsed.push({ title, href: realUrl });
    }

    // 调用纯函数做匹配：non-strict 下启用 domain-only 兜底（标题未命中关键词
    // 但域名命中，典型如站点标题「万年县移民局」vs 关键词「万年移民」）。
    // 已解析好的真实 URL 直接喂入，resolve 恒等，避免重复网络解析。
    const match = await PlatformAdapter.matchTarget(parsed, target, {
      resolve: (h) => h,
      max: 10,
      strict: false,
    });

    if (match) return match.href;

    // ── 诊断：给出可操作的失败原因 ──
    const anyDomain = parsed.some((it) => PlatformAdapter.matchHref(it.href, target.domain));
    if (!anyDomain) {
      throw new Error(
        `[locateTarget] 目标域名「${target.domain}」未出现在前 10 条结果中` +
          `（可能目标站点未真正进入当前关键词的搜索排名）。建议：更换更精准的搜索关键词、` +
          `或更换/确认目标域名后重试。`
      );
    }
    // 防御性分支：domain-only 兜底已覆盖「域名在但标题未中」的情形，正常不会到达此处。
    throw new Error(
      `[locateTarget] 前 10 条结果中存在目标域名「${target.domain}」的条目，` +
        `但其标题均未命中关键词（${target.titleKeywords.join('、')}）。` +
        `可尝试启用 title-only 兜底或更换更贴合站点标题的关键词。`
    );
  }

  /** 跳转进入目标站点 */
  async clickTarget(page, href) {
    await page.goto(href, { waitUntil: 'domcontentloaded', timeout: 30000 });
  }
}

module.exports = { GoogleAdapter };
