'use strict';

/**
 * core/adapters/googleAdapter.js
 * ---------------------------------------------------------------------------
 * 谷歌平台适配器：打开 google.com → 搜索 → 结果页双匹配定位 → 进入目标站。
 *
 * 双匹配（决策 Q3/A1）：扫描结果页【全部】结果（不再限前 10 条，并触发懒加载
 * 追加靠后的结果块），标题包含任一 titleKeyword 且真实落地地址包含 targetDomain
 * 的条目取首个匹配；本页未命中则自动翻「下一页」继续，最多扫描 MAX_RESULT_PAGES
 * 页。non-strict 模式下启用 domain-only 兜底（见 PlatformAdapter.matchTarget）。
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
 *       - 用结果主链接选择器精准取每条结果的标题链接（排除 sitelink/页脚噪声）；
 *         2026-07:25 确认 Google SERP 已从 <h3><a> 结构迁移到 <a data-ved> 容器，
 *         选择器同步更新为 #rso .MjjYud > div > a[data-ved]（兼容新旧布局）。
 *       - 解析 Google 跳转链接（/url?q= 或相对路径）为真实落地地址；
 *       - 复用 PlatformAdapter.matchTarget（strict:false，启用 domain-only 兜底）；
 *       - 未命中时抛出明确中文诊断（域名未进排名 / 标题未中关键词）。
 */

const { PlatformAdapter } = require('./platformAdapter');

/**
 * 拟人随机整数 [min, max]，用于打字节奏 / 滚动 / 停顿的抖动。
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function randInt(min, max) {
  return Math.floor(min + Math.random() * (max - min + 1));
}


const GOOGLE_HOME = 'https://www.google.com';
const SEARCH_BOX = 'textarea[name="q"]';
/**
 * 结果标题主链接选择器（Google SERP 2026 新结构）。
 * 优先匹配新版 <a data-ved> 容器（#rso .MjjYud 内），回退旧版 #rso h3 a。
 * @see _parseResultAnchors（实际取并集，不依赖单一常量）
 */
const RESULT_TITLE_LINK_NEW = '#rso .MjjYud > div > a[data-ved], #rso a[data-ved]';
const RESULT_TITLE_LINK_OLD = '#rso h3 a';

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

/**
 * 定位目标时最多扫描的搜索结果页数（含首页）的硬编码兜底值。
 * 前端/配置可经 locateTarget(page, target, { maxResultPages }) 覆盖，缺省取本值（5）。
 */
const MAX_RESULT_PAGES = 5;

/**
 * 从 Google 结果跳转链接中直接解出真实落地地址，避免依赖网络往返解析。
 *
 * Google 有机结果的主链接通常是跳转包装：
 *   绝对：https://www.google.com/url?q=<编码后的真实地址>&sa=...&ved=...
 *   相对：/url?q=<编码后的真实地址>&...
 * 直接取 `q` 参数并 URL 解码即可得到真实地址（如 https://mzsw.gov.cn/...）。
 *
 * 为什么要这样做（而非用 resolveFinalUrl 发 HEAD 请求）：
 *   - Node 端对 google.com/url?q= 发 HEAD 请求，Google 常对自动化客户端返回
 *     拦截页 / 不跟随重定向，导致解析失败回退成原始包装链接；
 *   - 若把包装链接交给 clickTarget 再去 goto，Google 可能弹「Before you continue」
 *     或重定向确认页，最终无法落到真实目标站（即用户反馈的「无法正确点击目标」）。
 * 直接解 `q` 参数既能拿到真实地址、又零网络开销、且稳定。
 *
 * 解析失败（无 q/url 参数 / 解出非 http(s)）一律回退原 href，由调用方兜底。
 * @param {string} href
 * @returns {string}
 */
function _decodeGoogleRedirect(href) {  if (!href || typeof href !== 'string') return href;
  try {
    // Google 跳转链接的包装参数历史上用 q=，新版部分布局改用 url=，二者都尝试。
    const m = href.match(/[?&](?:q|url)=([^&#]+)/);
    if (m) {
      const decoded = decodeURIComponent(m[1]);
      if (/^https?:\/\//i.test(decoded)) return decoded;
    }
  } catch (e) {
    /* 解码失败回退原 href */
  }
  return href;
}

class GoogleAdapter extends PlatformAdapter {
  /**
   * @param {{onCaptcha?: (detail:string)=>void}} [opts]
   *   onCaptcha：命中谷歌异常流量/验证码拦截时回调（即使随后自动恢复也回调一次），
   *   供 taskEngine 如实记入 perWifi.captcha，避免「拦截页闪现又恢复」被统计漏记。
   */
  constructor(opts) {
    super('google');
    this._onCaptcha = (opts && opts.onCaptcha) || null;
    // 本轮「是否已上报过验证码事件」的护栏：同一轮内只上报一次，避免轮询里每 2s 重复上报。
    this._captchaNotified = false;
  }

  /**
   * 命中验证码/异常流量拦截时上报一次（幂等：同一轮只上报一次）。
   * @param {string} reason 触发原因（sorry URL / 拦截文案片段）
   */
  _notifyCaptcha(reason) {
    if (this._captchaNotified) return;
    this._captchaNotified = true;
    if (this._onCaptcha) {
      try {
        this._onCaptcha(reason || 'google.com/sorry');
      } catch (e) {
        /* 回调异常不影响主流程 */
      }
    }
  }

  /** 每轮开始时由调用方（taskEngine）调用，重置上报护栏 */
  resetCaptchaNotify() {
    this._captchaNotified = false;
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
      // 注意：特意「不」匹配裸词 robot（正常结果页 snippet 可能含 "robot" 造成误判），
      // 只匹配谷歌拦截页特有短语，降低误报导致的虚假验证码事件。
      if (
        /unusual traffic|异常流量|please show you|confirm you are a human|our systems have detected|sorry\/index/.test(
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
    // 进入验证码等待即上报一次（即使随后自动恢复也记一笔，供统计如实反映真实频次）
    this._notifyCaptcha('google.com/sorry 拦截页');
    let elapsed = 0;
    let lastPrompt = -30000; // 首次立即提示，之后每 30s 提醒一次（不再每 2s 刷屏）
    while (elapsed < CAPTCHA_WAIT_MS) {
      if (elapsed - lastPrompt >= 30000) {
        console.warn(
          '谷歌异常流量验证拦截：请在弹出的 Chrome 窗口中手动完成验证，程序将在验证通过后自动继续'
        );
        lastPrompt = elapsed;
      }
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

    // 步骤B：拟人逐字输入（真实键盘事件，触发 Google 自动补全与 caret，
    // 避免一次性赋值被识别为脚本注入）。可见/隐藏异常态时回退 evaluate 原生赋值（健壮性）。
    // 注意：步骤A 已等待搜索框挂载；此处直接聚焦输入。谷歌首页搜索框是
    // <textarea name="q">（不是 <input>），evaluate 回退路径必须用「元素自身原型」
    // 的 value setter，否则对 textarea 调用 HTMLInputElement.prototype 的 setter 会抛「Illegal invocation」。
    await this._withStep('填写搜索词', '填写谷歌搜索词超时', async () => {
      try {
        // 真实聚焦 + 逐字输入，每字带随机抖动延迟（40-130ms），模拟真人打字节奏
        await page.focus(SEARCH_BOX);
        for (const ch of keyword) {
          await page.keyboard.type(ch, { delay: randInt(40, 130) });
        }
      } catch (e) {
        // 键盘输入失败（极少数隐藏/异常态）→ 回退原生赋值 + 派发 input/change
        await page.evaluate((kw) => {
          const el = document.querySelector('textarea[name="q"]');
          if (!el) throw new Error('google search box (textarea[name="q"]) not found');
          const proto =
            (el.constructor && el.constructor.prototype) || window.HTMLInputElement.prototype;
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
      }
      // 真实「思考」停顿（300-900ms）再提交，避免「打完即点」的机械感
      await page.waitForTimeout(randInt(300, 900));
    });

    // 步骤C：拟人提交搜索——优先真实鼠标移动+点击「谷歌搜索」按钮（最自然），
    // 其次按 Enter（搜索框已聚焦），最终回退 evaluate 触发 requestSubmit（兜底极端态）。
    await this._withStep('提交搜索', '提交谷歌搜索超时', async () => {
      let submitted = false;

      // 1) 真实鼠标点击搜索按钮（带移动轨迹，最接近真人）
      try {
        const box = await page.evaluate(() => {
          const btn =
            document.querySelector('input[name="btnK"]') ||
            document.querySelector('button[aria-label*="Google 搜索"]') ||
            document.querySelector('button[aria-label*="Google Search"]') ||
            document.querySelector('center input[type="submit"]');
          if (!btn) return null;
          const r = btn.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) return null;
          return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
        });
        if (box) {
          await page.mouse.move(box.x, box.y, { steps: randInt(6, 14) });
          await page.waitForTimeout(randInt(80, 220));
          await page.mouse.click(box.x, box.y);
          submitted = true;
        }
      } catch (e) {
        submitted = false;
      }

      // 2) 没点到按钮 → 按 Enter（基于已聚焦的搜索框，最自然的提交方式）
      if (!submitted) {
        try {
          await page.keyboard.press('Enter');
          submitted = true;
        } catch (e) {
          submitted = false;
        }
      }

      // 3) 兜底：evaluate 触发 requestSubmit（覆盖极端态）
      if (!submitted) {
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
      }
    });

    // 步骤D（轮询）：提交后可能落到同意页 / 异常流量验证码页，或结果仍在加载。
    // 轮询等待 #rso：结果出现即成功；同意页则点同意；验证码页则提示用户手动过码。
    let elapsed = 0;
    let captchaPrompted = false; // 同一轮内验证码提示只打印一次，避免每 2s 刷屏
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
        // 验证码页：上报一次（供统计）+ 仅首次打印可操作提示，轮询等待其解决
        this._notifyCaptcha('提交搜索后命中 google.com/sorry 拦截页');
        if (!captchaPrompted) {
          captchaPrompted = true;
          console.warn(
            '谷歌异常流量验证拦截：请在弹出的 Chrome 窗口中手动完成验证，程序将在验证通过后自动继续'
          );
        }
      }
      // 否则页面仍在加载，继续轮询
      await page.waitForTimeout(CAPTCHA_POLL_INTERVAL);
      elapsed += CAPTCHA_POLL_INTERVAL;
    }
    throw new Error('谷歌结果页未加载或验证未通过（ERR_GOOGLE_CAPTCHA）');
  }

  /**
   * 渐进式滚到页面底部，触发 Google 的「懒加载更多结果」；包裹 try/catch 容错。
   * 分 3-6 段、每段间 150-400ms 停顿，模拟真人分段下滚，而非一次性瞬移到底。
   * Google 在滚动到底部时会追加本页靠后的结果块（位置 11 及之后），
   * 这正是「正确页面在页面最低端」却被旧版限制在前 10 条而漏匹配的根因。
   * @param {import('playwright').Page} page
   */
  async _scrollToBottom(page) {
    try {
      const steps = randInt(3, 6);
      for (let i = 0; i < steps; i += 1) {
        await page.evaluate((frac) => {
          const h = (document.body && document.body.scrollHeight) || 0;
          window.scrollTo(0, Math.round(h * frac));
        }, (i + 1) / steps);
        await page.waitForTimeout(randInt(150, 400));
      }
      // 最后滚到真正底部，确保懒加载触发
      await page.evaluate(() => {
        const h = (document.body && document.body.scrollHeight) || 0;
        window.scrollTo(0, h);
      });
      await page.waitForTimeout(randInt(600, 1100)); // 等待懒加载追加的结果块挂载
    } catch (e) {
      /* 滚动失败不致命：沿用已渲染的结果 */
    }
  }

  /**
   * 在结果页内查找「下一页」链接的真实地址（Google: a#pnnext，回退到带
   * aria-label 下一页/Next 的 start= 链接）。找不到返回 null。
   * @param {import('playwright').Page} page
   * @returns {Promise<string|null>}
   */
  async _findNextPageUrl(page) {
    try {
      return await page.evaluate(() => {
        const next = document.querySelector('a#pnnext');
        if (next && next.getAttribute('href')) return next.getAttribute('href');
        const links = Array.from(document.querySelectorAll('a[href*="start="]'));
        const byLabel = links.find((a) =>
          /next|下一页/i.test(
            (a.getAttribute('aria-label') || '') + ' ' + (a.textContent || '')
          )
        );
        return byLabel ? byLabel.getAttribute('href') : null;
      });
    } catch (e) {
      return null;
    }
  }

  /**
   * 把结果页标题主链接解析为 {title, href} 列表：
   * Google SERP 2026 新结构：结果链接为 <a data-ved> 容器，标题在内部
   * [role="heading"] / h3 子元素中（不再直接是 <a> 的 textContent）。
   * 旧结构 <h3><a> 作为回退兼容。google 跳转链接（/url?q= 或相对路径）
   * 解析为真实落地地址；直接 https 链接沿用。
   * @param {import('playwright').Page} page
   * @returns {Promise<{title:string,href:string}[]>}
   */
  async _parseResultAnchors(page) {
    // 优先新版选择器（2026 Google SERP <a data-ved> 容器），回退旧版 #rso h3 a
    let anchors = await page.$$(RESULT_TITLE_LINK_NEW);
    if (!anchors || anchors.length === 0) {
      anchors = await page.$$(RESULT_TITLE_LINK_OLD);
    }
    // 第三层兜底（v0.3.37）：兼容区域化 / 未完全加载的 SERP —— NEW/OLD 选择器均未匹配时，
    // 直接从 #rso 提取所有带 href 的 <a>，后续由 href 解析 + matchTarget 域名匹配过滤噪声。
    if (!anchors || anchors.length === 0) {
      anchors = await page.$$('#rso a[href]');
    }

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

    // 新版标题提取：从 [role="heading"] / h3 子元素取（不再直接用 <a> 的 textContent）
    const extractTitle = async (anchorEl) => {
      try {
        // 1. 优先取内部 heading 元素
        const heading = await anchorEl.$('[role="heading"], h3, [data-attrid="title"]');
        if (heading) {
          const t = await heading.textContent();
          if (t && t.trim()) return t.trim();
        }
        // 2. 回退：取第一个有实质文本的子 div/span
        const directText = await anchorEl.evaluate((el) => {
          for (const child of el.children) {
            const t = (child.textContent || '').trim();
            if (t && t.length > 4 && !/^\s*$/.test(t)) return t;
          }
          return '';
        });
        if (directText) return directText;
      } catch (e) { /* fall through */ }
      // 3. 最终回退：整个 anchor 的 textContent
      return (await safeText(anchorEl)).toString();
    };

    const parsed = [];
    for (const a of anchors) {
      const title = await extractTitle(a);
      const href = (await safeAttr(a, 'href')) || '';
      if (!/^https?:\/\//i.test(href) && !href.startsWith('/')) continue;
      // 优先从 Google 跳转链接的 q/url 参数直接解出真实地址（零网络、稳定）；
      const decoded = _decodeGoogleRedirect(href);
      let realUrl = decoded;
      if (!/^https?:\/\//i.test(decoded)) {
        realUrl = /^https?:\/\//i.test(href)
          ? await PlatformAdapter.resolveFinalUrl(href, 3000)
          : href;
      }
      parsed.push({ title, href: realUrl });
    }
    return parsed;
  }

  /** 结果页双匹配定位目标站点（扫描本页全部结果 + 翻页；精准取标题主链接 + 复用基类 matchTarget + 诊断） */
  async locateTarget(page, target, options = {}) {
    // 二次保险：落在验证码 / 同意页时结果容器不存在，提前抛出明确错误
    if (await this._isCaptchaPage(page)) {
      throw new Error(
        '谷歌验证拦截（ERR_GOOGLE_CAPTCHA）：结果页未加载，请在可见窗口手动通过验证后重试'
      );
    }
    if (await this._isConsentPage(page)) {
      throw new Error('谷歌同意页拦截（ERR_GOOGLE_CONSENT）：结果页未加载，请先通过同意页');
    }

    const allParsed = []; // 跨页累计，仅用于诊断
    let scannedPages = 0;

    // 扫描页数上限：优先用配置（options.maxResultPages），否则回退硬编码 5 页。
    const maxPages =
      options && Number.isFinite(options.maxResultPages) && options.maxResultPages > 0
        ? options.maxResultPages
        : MAX_RESULT_PAGES;

    for (let p = 1; p <= maxPages; p += 1) {
      // 触发懒加载：滚到底，让 Google 追加本页靠后的结果块（位置 11 及之后）
      await this._scrollToBottom(page);

      // 解析本页【全部】结果标题链接（不再 slice 前 10）
      const parsed = await this._parseResultAnchors(page);
      scannedPages += 1;
      allParsed.push(...parsed);

      // 复用基类 matchTarget：本页全部结果参与双匹配（non-strict 启用 domain-only 兜底）
      const match = await PlatformAdapter.matchTarget(parsed, target, {
        resolve: (h) => h,
        max: parsed.length,
        strict: false,
      });
      if (match) return match.href;

      // 本页未命中 → 找「下一页」继续；无下一页或已到扫描上限则停止翻页
      const nextHref = await this._findNextPageUrl(page);
      if (!nextHref || p >= maxPages) break;
      const nextUrl = /^https?:/i.test(nextHref)
        ? nextHref
        : new URL(nextHref, page.url()).toString();
      await page.goto(nextUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page
        .waitForSelector('#rso', { state: 'visible', timeout: 15000 })
        .catch(() => {});
      // 翻页后可能落到验证/同意页：重新检测并抛出明确错误，避免被误判为「0 外链」
      if (await this._isCaptchaPage(page)) {
        throw new Error('谷歌验证拦截（ERR_GOOGLE_CAPTCHA）：翻页后命中异常流量验证页，结果页未加载');
      }
      if (await this._isConsentPage(page)) {
        throw new Error('谷歌同意页拦截（ERR_GOOGLE_CONSENT）：翻页后落到同意页，结果页未加载');
      }
    }

    // ── 诊断：给出可操作的失败原因（并附实际看到的域名 / 当前页态，便于确认是排名问题还是拦截）──
    let url = '';
    try { url = page.url() || ''; } catch (e) {}
    let snippet = '';
    try {
      snippet = (await page.evaluate(() =>
        ((document.body && document.body.innerText) || '').slice(0, 200)
      )) || '';
    } catch (e) {}
    const seenDomains = [
      ...new Set(
        allParsed
          .map((it) => {
            try {
              return new URL(it.href).hostname;
            } catch (e) {
              return null;
            }
          })
          .filter(Boolean)
      ),
    ];
    const anyDomain = allParsed.some((it) => PlatformAdapter.matchHref(it.href, target.domain));
    if (!anyDomain) {
      const seenPart = seenDomains.length
        ? `。已扫描 ${scannedPages} 页实际看到的域名（前 20）：${seenDomains.slice(0, 20).join('、')}`
        : `（${scannedPages} 页均未解析到任何外链；当前页 URL=${url}；页面片段="${snippet.replace(/\s+/g, ' ').slice(0, 120)}"——可能该节点出口 IP 区域下 Google 返回零结果 / 受限结果页或拦截页）`;
      throw new Error(
        `[locateTarget] 目标域名「${target.domain}」未出现在已扫描的 ${scannedPages} 页搜索结果中` +
          seenPart +
          `。可能该站点未真正进入当前节点此关键词的搜索排名；建议：更换更精准的关键词、` +
          `或换/确认目标域名后重试。`
      );
    }
    // 防御性分支：domain-only 兜底已覆盖「域名在但标题未中」的情形，正常不会到达此处。
    throw new Error(
      `[locateTarget] 已扫描 ${scannedPages} 页结果中存在目标域名「${target.domain}」的条目，` +
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
