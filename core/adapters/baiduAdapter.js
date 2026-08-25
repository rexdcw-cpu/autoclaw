'use strict';

/**
 * core/adapters/baiduAdapter.js
 * ---------------------------------------------------------------------------
 * 百度平台适配器：打开 baidu.com → 搜索 → 结果页双匹配定位 → 进入目标站。
 *
 * 双匹配（决策 Q3/A1）：结果前 10 条中，标题包含任一 titleKeyword 且
 * 真实落地地址包含 targetDomain 的条目，取首个匹配。
 *
 * ── BUG 修复说明（search 步骤 30s 超时诊断盲区）─────────────────────────────
 * 原 search 仅用三个连续 await（fill / click / waitForSelector），任意一步卡住
 * 都会让外层 taskEngine 的 withTimeout(30000) 统一抛出「动作超时（30000ms）」，
 * 无法区分到底卡在 fill('#kw') / click('#su') / waitForSelector('#content_left')。
 *
 * 现改为「分步 + 明确中文步骤错误」：open/search 内部每个子动作各自抛出带步骤
 * 名的错误（如「等待搜索框挂载超时」「填写搜索词超时」「提交搜索(表单/按钮)超时」
 * 「等待结果容器 #content_left 超时」），使 run_log.error 能直接显示具体卡点。
 *
 * 子超时设计（方案 a：保证分步错误优先于外层超时抛出）：
 *   等待搜索框 10s + 填词 6s + 提交 6s（步骤A/B/C，最坏 22s）< 外层 150s；
 *   步骤D 改为「轮询等待结果/验证码」：上限 120s（CAPTCHA_WAIT_MS）、间隔 2s，
 *   命中验证码页时打印可操作提示并继续轮询，等待用户在可见窗口手动过码。
 *   外层 action_timeout_ms 已从默认 30s 提到 150s，确保验证码人工等待不被提前干掉。
 *   因此用户报错时看到的是「具体步骤超时」或「ERR_BAIDU_CAPTCHA」，而非笼统动作超时。
 *
 * ── BUG 修复说明（#kw 被解析为 hidden → open/search 卡满 15s）──────────────
 * baidu 在部分布局 / 加载时序下会令 #kw 输入框被判定为 hidden
 * （visibility:hidden / display:none / 0 尺寸），而 Playwright 的
 * waitForSelector(state:'visible')、fill()、press() 均要求元素「可见且可交互」，
 * 于是 open() 的 15s 可见等待直接超时、search() 的 fill/press 也立即失败。
 *
 * 修复策略（attached-wait + evaluate-set-value）：
 *   1) open() 与 search 步骤A 改用 state:'attached'：只等待元素挂载进 DOM，
 *      不再要求其可见，彻底消除 hidden 输入框导致的 15s 卡顿。
 *   2) search 步骤B 改用 page.evaluate：直接调用原生 value setter 写值并派发
 *      input/change 事件，绕开 fill() 对可见性的依赖，同时正确触发百度监听。
 *   3) search 步骤C 改用 page.evaluate：在页面内触发提交（form.requestSubmit()
 *      优先，回退点击 #su），submit 不再依赖 #kw 可见/可聚焦。
 * 以上 evaluate 操作对「可见」与「hidden」两种状态均生效，是 fill/press 的超集。
 */

const { PlatformAdapter } = require('./platformAdapter');

const BAIDU_HOME = 'https://www.baidu.com';
const SEARCH_BOX = '#kw';
const SEARCH_BTN = '#su';
const RESULT_CONTAINER = '#content_left .result, #content_left .c-container';
const TITLE_LINK = 'h3 a';

/**
 * search 步骤 A/B/C 子动作超时（毫秒）。
 * 设计目标：单步超时之和（最坏 10+6+6 = 22s）< 外层 150s（已为验证码人工等待
 * 留出余量），保证任一步骤卡住时，本步骤的「明确错误」能在外层兜底超时之前抛出。
 * （注：步骤B/C 通过 page.evaluate 执行，本身近乎瞬时；此处超时仅作为
 *  waitForSelector('attached') 的兜底上限。步骤D 改为轮询等待结果/验证码，见 search()。）
 */
const STEP_TIMEOUT = {
  /** 步骤A：等待搜索框挂载进 DOM */
  WAIT_BOX: 10000,
  /** 步骤B：填写搜索词（evaluate 写值，受 #kw attached 守卫保护） */
  FILL: 6000,
  /** 步骤C：提交搜索（evaluate 触发 form.requestSubmit / 点击 #su） */
  SUBMIT: 6000,
};

/**
 * 验证码轮询参数（open / search 共用）：上限 120s、间隔 2s。
 * 命中百度安全验证（风控验证码页）时进入轮询，等待用户在可见 Chrome 窗口
 * 手动过码后继续；轮询耗尽则抛出 ERR_BAIDU_CAPTCHA。
 */
// 验证码人工等待上限：Session 0 非交互环境无法手动过码，过长只是卡死；
// 默认 30s 足够判定并放弃当前节点，可用 AUTOCLAW_CAPTCHA_WAIT_MS 覆盖（如需人工过码可设大）。
const CAPTCHA_WAIT_MS = parseInt(process.env.AUTOCLAW_CAPTCHA_WAIT_MS, 10) || 30000;
const CAPTCHA_POLL_INTERVAL = 2000;

/**
 * 定位目标时最多扫描的搜索结果页数（含首页）的硬编码兜底值。
 * 前端/配置可经 locateTarget(page, target, { maxResultPages }) 覆盖，缺省取本值（5）。
 */
const MAX_RESULT_PAGES = 5;

class BaiduAdapter extends PlatformAdapter {
  constructor(opts) {
    super('baidu');
    this._onCaptcha = (opts && opts.onCaptcha) || null;
    // 本轮「是否已上报过验证码事件」的护栏：同一轮内只上报一次，避免轮询里每 2s 重复上报。
    this._captchaNotified = false;
    // 拟人微动作配置：在搜索框输入/提交等关键动作之间插入随机停顿，降低百度风控概率
    this.humanize = (opts && opts.humanize) || null;
    // 中断检查：由 taskEngine 注入 () => this.shouldStop，使验证码等待轮询能在
    // /api/task/stop 到达时（每 2s 轮询点）立即抛错，避免任务卡死无法终止。
    this._shouldAbort = (opts && opts.shouldAbort) || null;
  }

  /**
   * 搜索页关键动作之间的拟人停顿。
   * 停顿期间额外做一次「可信鼠标微动」，让停顿看起来是人在操作而非脚本死等。
   * 任何异常静默吞掉，绝不影响主流程。
   * @param {import('playwright').Page} [page] 可选；传入则附真实鼠标微动
   */
  async _humanDelay(page) {
    const h = this.humanize || {};
    if (h.enabled === false) return;
    const minMs = h.minMs != null ? h.minMs : 800;
    const maxMs = h.maxMs != null ? h.maxMs : 2600;
    const jitterAmp = h.jitterAmp != null ? h.jitterAmp : 400;
    const thinkMs = Math.floor(minMs + Math.random() * (maxMs - minMs)) + (jitterAmp ? Math.floor(Math.random() * jitterAmp) : 0);
    try {
      await new Promise((r) => setTimeout(r, thinkMs));
      // 停顿期间做一次可信鼠标微动：基于视口随机坐标、多步缓动，模拟真人手部微动。
      if (page && typeof page.mouse !== 'undefined') {
        try {
          const vp = page.viewportSize && page.viewportSize();
          if (vp && vp.width && vp.height) {
            const x = Math.floor(Math.random() * vp.width);
            const y = Math.floor(Math.random() * vp.height);
            await page.mouse.move(x, y, { steps: 3 + Math.floor(Math.random() * 5) });
          }
        } catch (e) {
          /* 鼠标微动失败不影响主流程 */
        }
      }
    } catch (e) {
      /* ignore */
    }
  }

  /**
   * 命中百度安全验证（风控验证码页）时上报一次（幂等：同一轮只上报一次）。
   * @param {string} reason 触发原因（验证码页 URL / 文案片段）
   */
  _notifyCaptcha(reason) {
    if (this._captchaNotified) return;
    this._captchaNotified = true;
    if (this._onCaptcha) {
      try {
        this._onCaptcha(reason || '百度安全验证拦截页');
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
   * 包装单个子动作：执行 fn()，若其 reject（含 Playwright 自带 timeout 抛错），
   * 则统一抛出带「步骤名」的明确错误，便于 run_log 精准定位卡点。
   * 注意：本方法不额外挂 race 计时器，超时交由各 Playwright 调用自身的 timeout
   * 选项控制（waitForSelector 支持），避免双计时器竞态。
   * @param {string} _stepName 仅用于注释/可读性的步骤名
   * @param {string} errMsg   失败时抛出的明确中文错误文案
   * @param {() => Promise<void>} fn
   * @returns {Promise<void>}
   */
  async _withStep(_stepName, errMsg, fn) {
    try {
      await fn();
    } catch (e) {
      // 剥离底层 Playwright 长堆栈，仅以步骤名定位卡点
      throw new Error(errMsg);
    }
  }

  /**
   * 是否命中百度安全验证（风控验证码页，wappass.baidu.com）。满足任一即视为被拦截：
   *   - 当前 URL 含 wappass.baidu.com（验证码宿主域名，最可靠）
   *   - 页面 title 含「安全验证」或「验证」
   *   - 页面存在 #captcha / .passMod / .tuxing / input[name=captcha] 校验元素
   * 用于在 search 的轮询中识别「被风控重定向到验证码页」，提示用户手动过码后继续。
   * 各探测均包 try/catch：探测失败（如导航中）一律视为「未拦截」。
   * @param {import('playwright').Page} page
   * @returns {Promise<boolean>}
   */
  async _isCaptchaPage(page) {
    // 1) URL 命中验证码宿主域名（最可靠）
    try {
      const url = page.url() || '';
      if (url.includes('wappass.baidu.com')) return true;
    } catch (e) {}
    // 2) 页面标题命中「安全验证」/「验证」
    try {
      const title = (await page.title()) || '';
      if (title.includes('安全验证') || title.includes('验证')) return true;
    } catch (e) {}
    // 3) DOM 存在验证码相关元素（用 evaluate 判断，避免依赖 page.$ 的可见性）
    try {
      const hit = await page.evaluate(() => {
        return !!document.querySelector('#captcha, .passMod, .tuxing, input[name=captcha]');
      });
      if (hit) return true;
    } catch (e) {}
    return false;
  }

  /**
   * 打开百度首页。
   * BUGFIX（#kw 解析为 hidden → open 卡满 15s）：
   *   改为 state:'attached'：仅等待元素挂载进 DOM，不再要求其可见；
   *   真正写值交给 search() 用 page.evaluate 直接赋值，彻底绕开可见性约束。
   * BUGFIX（多 round 连续搜索触发百度验证码页）：
   *   第一个 round 搜索成功后，同一 Chrome profile 复用、后续 round 打开百度时
   *   可能被反爬重定向到「安全验证/验证码」页（无 #kw）。原 open() 会傻等 #kw
   *   15s 超时并抛 cryptic 错误。现 open() 先 `_isCaptchaPage` 判断：
   *     - 命中验证码页 → 进入轮询（上限 CAPTCHA_WAIT_MS、间隔 CAPTCHA_POLL_INTERVAL），
   *       提示用户在可见 Chrome 窗口手动过码，过码后继续；轮询耗尽抛 ERR_BAIDU_CAPTCHA。
   *     - 未命中 → 走现有 #kw attached 等待（不要求可见）。
   * @param {import('playwright').Page} page
   */
  async open(page) {
    // 百度对自动化/异常 IP 会瞬时限流，goto 偶发 ERR_ABORTED / 超时；
    // 内重试几次（带退避）即可绕过，避免单次失败直接判定搜索步骤失败。
    let lastErr = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        await page.goto(BAIDU_HOME, { waitUntil: 'domcontentloaded', timeout: 20000 });

        // 先判断是否落在百度安全验证（验证码）页：多 round 复用同一 profile 时易触发。
        if (await this._isCaptchaPage(page)) {
          // 命中验证码页：上报一次（供统计），保留可操作提示
          this._notifyCaptcha('百度安全验证拦截页');
          // 轮询等待用户手动过码：上限 CAPTCHA_WAIT_MS、间隔 CAPTCHA_POLL_INTERVAL
          let elapsed = 0;
          while (elapsed < CAPTCHA_WAIT_MS) {
            // 中断检查：stop 信号到达时立即抛错，让 taskEngine.run 在轮次边界快速返回 STOPPED
            if (this._shouldAbort && this._shouldAbort()) {
              throw new Error('百度操作被中断（ABORTED）');
            }
            console.warn(
              '百度安全验证拦截：请在弹出的 Chrome 窗口中手动完成验证，程序将在验证通过后自动继续'
            );
            await page.waitForTimeout(CAPTCHA_POLL_INTERVAL);
            elapsed += CAPTCHA_POLL_INTERVAL;
            // 重新检查：已不再被拦截且搜索框已挂载 → 立即成功返回
            if (!(await this._isCaptchaPage(page))) {
              await page.waitForSelector(SEARCH_BOX, { state: 'attached', timeout: 15000 });
              return;
            }
          }
          // 轮询超时仍被拦截 → 抛出清晰错误码（区别于 #kw 15s 超时）
          throw new Error(
            '打开百度首页被安全验证拦截（ERR_BAIDU_CAPTCHA）：请在可见 Chrome 窗口手动通过验证后重试'
          );
        }

        // 非验证码页：仅等待搜索框挂载到 DOM（不要求可见），避免 hidden 输入框导致 open 超时
        await page.waitForSelector(SEARCH_BOX, { state: 'attached', timeout: 15000 });
        return;
      } catch (e) {
        lastErr = e;
        if (attempt < 3) await page.waitForTimeout(3000);
      }
    }
    throw new Error('打开百度首页失败（重试后仍失败）：' + (lastErr && lastErr.message));
  }

  /**
   * 填入关键词并提交搜索（分步 + 明确中文步骤错误 + attached/evaluate 绕开可见性）。
   * @param {import('playwright').Page} page
   * @param {string} keyword
   */
  async search(page, keyword) {
    // 步骤A：等待搜索框挂载（attached，不再要求可见，规避 #kw hidden 卡 15s）
    await this._withStep('等待搜索框', '等待搜索框挂载超时', async () => {
      await page.waitForSelector(SEARCH_BOX, {
        state: 'attached',
        timeout: STEP_TIMEOUT.WAIT_BOX,
      });
    });

    // 拟人停顿：搜索框出现后、输入关键词前，模拟用户阅读/定位输入框的时间
    await this._humanDelay(page);

    // 步骤B：填写搜索词（拟人化可信键入，关键修复）。
    // 旧实现用 page.evaluate 的 prototype setter 一次性灌满整个关键词，产生的是
    // isTrusted=false 的不可信事件，且值瞬间跳变 —— 这是百度风控最敏感的 bot 特征。
    // 现改为 page.keyboard.type：经 CDP 注入 isTrusted=true 的可信键入事件，逐字符带
    // 随机间隔（typeDelayMin/Max），模拟真人打字节奏。#kw 偶发 hidden 时聚焦/键入可能
    // 失效，故键入后校验实际落入情况，失败则回退原 evaluate setter 保底，确保不卡死。
    await this._withStep('填写搜索词', '填写搜索词超时', async () => {
      const h = this.humanize || {};
      const tMin = h.typeDelayMin != null ? h.typeDelayMin : 60;
      const tMax = h.typeDelayMax != null ? h.typeDelayMax : 200;
      let ok = false;
      try {
        // 聚焦输入框（hidden 时为 no-op，不影响后续校验回退）
        await page.evaluate((sel) => {
          const el = document.querySelector(sel);
          if (el) el.focus();
        }, SEARCH_BOX);
        // 可信逐字符键入：中文经 Input.insertText、ASCII 经真实按键，均为 isTrusted=true
        await page.keyboard.type(keyword, { delay: Math.floor(tMin + Math.random() * (tMax - tMin)) });
        // 校验：至少前半段关键词已落入输入框
        const val = await page.evaluate((sel) => {
          const el = document.querySelector(sel);
          return el ? el.value : '';
        }, SEARCH_BOX);
        const probe = keyword.slice(0, Math.max(1, Math.ceil(keyword.length / 2)));
        if (val && val.indexOf(probe) !== -1) ok = true;
      } catch (e) {
        ok = false;
      }
      if (!ok) {
        // 保底：原 evaluate setter 灌值（兼容 hidden #kw）。出现此 warn 说明可信键入未生效。
        console.warn('[baidu] 可信逐字符键入未生效，已回退 evaluate 灌值（关键词=' + keyword + '）');
        await page.evaluate((kw) => {
          const el = document.querySelector('#kw');
          if (!el) throw new Error('#kw not found');
          const setter = Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype,
            'value'
          ).set;
          setter.call(el, kw);
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }, keyword);
      }
    });

    // 拟人停顿：输入搜索词后、提交前，模拟用户确认/思考的时间
    await this._humanDelay(page);

    // 步骤C：提交搜索。
    // BUGFIX：press(#kw, 'Enter') 同样依赖输入框可见/可聚焦，hidden 时失败。
    // 改用 page.evaluate 在页面内触发提交：优先 form.requestSubmit()，
    // 回退点击「百度一下」按钮 #su（按钮本身可见，不依赖 #kw 可见）。
    await this._withStep('提交搜索', '提交搜索(表单/按钮)超时', async () => {
      await page.evaluate(() => {
        const form =
          document.querySelector('#form') ||
          document.querySelector('form[action*="baidu"]') ||
          document.querySelector('form');
        if (form && typeof form.requestSubmit === 'function') {
          form.requestSubmit();
          return;
        }
        const btn = document.querySelector('#su');
        if (btn) {
          btn.click();
          return;
        }
        throw new Error('search form/button not found');
      });
    });

    // 步骤D（轮询）：提交搜索后百度可能把自动化浏览器重定向到「百度安全验证」验证码页
    // （wappass.baidu.com），此时 #content_left 永不出现。轮询等待：结果出现即成功；
    // 若落在验证码页，打印可操作提示并继续轮询，等待用户在可见窗口手动过码（已登录态极少触发）。
    // 轮询上限 CAPTCHA_WAIT_MS（模块级常量，open/search 共用），超过仍无结果则抛 ERR_BAIDU_CAPTCHA。
    let elapsed = 0;
    while (elapsed < CAPTCHA_WAIT_MS) {
      // 中断检查：stop 信号到达时立即抛错，让 taskEngine.run 在轮次边界快速返回 STOPPED
      if (this._shouldAbort && this._shouldAbort()) {
        throw new Error('百度操作被中断（ABORTED）');
      }
      let hasResults = false;
      try {
        await page.waitForSelector('#content_left', {
          state: 'visible',
          timeout: CAPTCHA_POLL_INTERVAL,
        });
        hasResults = true;
      } catch (e) {
        hasResults = false;
      }
      if (hasResults) break; // 结果页已出现，搜索成功

      if (await this._isCaptchaPage(page)) {
        // 命中验证码页：上报一次（供统计），保留可操作提示
        this._notifyCaptcha('百度安全验证拦截页');
        console.warn(
          '百度安全验证拦截：请在弹出的 Chrome 窗口中手动完成验证，程序将在验证通过后自动继续'
        );
        // 不抛错，继续轮询等待用户过码
      }
      // 否则页面仍在加载，继续轮询
      await page.waitForTimeout(CAPTCHA_POLL_INTERVAL);
      elapsed += CAPTCHA_POLL_INTERVAL;
    }
    if (elapsed >= CAPTCHA_WAIT_MS) {
      throw new Error('百度安全验证未通过或结果未加载（ERR_BAIDU_CAPTCHA）');
    }
  }

  /**
   * 在结果页内查找「下一页」链接的真实地址（百度：#page 分页容器内，优先取文本含
   * 「下一页/Next」的链接，回退到带 pn= 的最后一个链接）。找不到返回 null。
   * @param {import('playwright').Page} page
   * @returns {Promise<string|null>}
   */
  async _findNextPageUrl(page) {
    try {
      return await page.evaluate(() => {
        const pageBox = document.querySelector('#page');
        if (!pageBox) return null;
        const links = Array.from(pageBox.querySelectorAll('a'));
        const next = links.find((a) =>
          /下一页|next/i.test((a.textContent || '') + ' ' + (a.getAttribute('aria-label') || ''))
        );
        if (next && next.getAttribute('href')) return next.getAttribute('href');
        // 回退：带 pn= 的最后一个链接（百度分页用 pn 偏移，下一页 pn 更大）
        const pnLinks = links.filter((a) => /[?&]pn=\d+/.test(a.getAttribute('href') || ''));
        return pnLinks.length ? pnLinks[pnLinks.length - 1].getAttribute('href') : null;
      });
    } catch (e) {
      return null;
    }
  }

  /** 结果页双匹配定位目标站点（扫描本页全部结果 + 翻页；每页全部结果参与双匹配 + 诊断） */
  async locateTarget(page, target, options = {}) {
    // 二次保险：若已落在安全验证页，结果容器不存在，提前抛出明确错误
    if (await this._isCaptchaPage(page)) {
      throw new Error(
        '百度安全验证拦截（ERR_BAIDU_CAPTCHA）：结果页未加载，请在可见窗口手动通过验证后重试'
      );
    }

    // 扫描页数上限：优先用配置（options.maxResultPages），否则回退硬编码 5 页。
    const maxPages =
      options && Number.isFinite(options.maxResultPages) && options.maxResultPages > 0
        ? options.maxResultPages
        : MAX_RESULT_PAGES;

    const allParsed = []; // 跨页累计，仅用于诊断
    let scannedPages = 0;

    // 安全读取元素属性（部分 mock 元素可能未实现 getAttribute）
    const safeAttr = async (el, name) => {
      try {
        if (el && typeof el.getAttribute === 'function') {
          return (await el.getAttribute(name)) || '';
        }
      } catch (e) {}
      return '';
    };

    for (let p = 1; p <= maxPages; p += 1) {
      // 解析本页【全部】结果（不限定前 10 条）：优先容器声明的真实 URL
      // （mu / data-url，百度 c-container 通常带 mu="<真实目标URL>"），拿不到再退回
      // resolveFinalUrl 解析跳转链接（baidu.com/link?url=）。
      const items = await page.$$(RESULT_CONTAINER);
      const parsed = [];
      for (const item of items) {
        const a = await item.$(TITLE_LINK);
        if (!a) continue;
        const title = ((await a.textContent()) || '').toString();
        const href = (await safeAttr(a, 'href')) || '';
        // 真实 URL 声明可能出现在「容器」或「链接」元素上（不同结果布局差异），
        // 多来源取第一个有效 http(s) 作为真实地址，最大限度避免回退到跳转链解析。
        const muItem = (await safeAttr(item, 'mu')) || '';
        const muLink = (await safeAttr(a, 'mu')) || '';
        const dItem = (await safeAttr(item, 'data-url')) || '';
        const dLink = (await safeAttr(a, 'data-url')) || '';
        const realUrl =
          [muItem, muLink, dItem, dLink].find((u) => /^https?:\/\//i.test(u || '')) || '';
        parsed.push({ title, href, realUrl });
      }

      // 并行解析全部候选的真实 URL：容器已声明 mu/data-url 则直接采用（免网络），
      // 否则用 resolveFinalUrl 解析百度跳转链接。用于匹配与失败诊断。
      const resolvedList = await Promise.all(
        parsed.map((it) =>
          it.realUrl && /^https?:\/\//i.test(it.realUrl)
            ? Promise.resolve(it.realUrl)
            : PlatformAdapter.resolveFinalUrl(it.href, 3000)
        )
      );
      const itemsForMatch = parsed.map((it, i) => ({ title: it.title, href: resolvedList[i] }));

      // 调用纯函数做匹配：non-strict 下启用 domain-only 兜底（标题未命中关键词
      // 但域名命中，典型如站点标题「万年县移民局」vs 关键词「万年移民」）。
      // 已解析好的真实 URL 直接喂入，resolve 恒等，避免重复网络解析。
      scannedPages += 1;
      allParsed.push(...itemsForMatch);
      const match = await PlatformAdapter.matchTarget(itemsForMatch, target, {
        resolve: (h) => h,
        max: itemsForMatch.length,
        strict: false,
      });
      if (match) return match.href;

      // 本页未命中 → 找「下一页」继续；无下一页或已到扫描上限则停止翻页
      const nextHref = await this._findNextPageUrl(page);
      if (!nextHref || p >= maxPages) break;
      const nextUrl = /^https?:/i.test(nextHref)
        ? nextHref
        : new URL(nextHref, page.url()).toString();
      // 拟人停顿：翻页前模拟真人「看完本页未命中 → 决定翻页」的思考停顿 + 鼠标微动，
      // 打断连续 goto，避免被百度风控判定为机器人快速翻页（此前翻页无任何停顿）。
      await this._humanDelay(page);
      await page.goto(nextUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page
        .waitForSelector('#content_left', { state: 'visible', timeout: 15000 })
        .catch(() => {});
      // 拟人停顿：翻页后模拟真人浏览新页结果的停顿，进一步拉平请求节奏。
      await this._humanDelay(page);
    }

    // ── 诊断：给出可操作的失败原因，便于快速区分两类问题 ──
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
        : `（${scannedPages} 页均未解析到任何外链，可能结果页结构变化或命中拦截页）`;
      throw new Error(
        `[locateTarget] 目标域名「${target.domain}」未出现在已扫描的 ${scannedPages} 页搜索结果中` +
          seenPart +
          `。可能该站点未真正进入当前节点此关键词的搜索排名；建议：更换更精准的搜索关键词、` +
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
    // BUGFIX：原仅等待 domcontentloaded(30s)。SPA/JS 渲染站或目标站对当前出口 IP 加载慢/被拦时，
    // domcontentloaded 即返回但页面未就绪，或 30s 超时直接 ENTER 失败。
    // 改为：goto 后等待目标站真正可交互（body 含可见文本），并放宽总超时；
    // 超时抛明确错误（含最终落地 URL），便于日志定位「ENTER 跳转目标站超时」。
    let finalUrl = href;
    try {
      await page.goto(href, { waitUntil: 'domcontentloaded', timeout: 45000 });
    } catch (e) {
      try { finalUrl = page.url(); } catch (_) { /* ignore */ }
      throw new Error('ENTER 跳转目标站超时/失败（' + (e && e.message ? String(e.message).split('\n')[0] : e) + '）最终地址=' + finalUrl);
    }
    try { finalUrl = page.url(); } catch (_) { /* ignore */ }
    // 等待页面关键内容就绪（SPA 兜底）：body 出现可见文本即视为落地成功
    await page.waitForFunction(
      () => { const b = document.body; return !!b && b.innerText && b.innerText.trim().length > 0; },
      { timeout: 15000 }
    ).catch(() => { /* 超时仅告警：部分站 body 始终空（纯图/canvas），已落地即算成功 */ });
    return finalUrl;
  }
}

module.exports = { BaiduAdapter };
