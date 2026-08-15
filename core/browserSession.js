'use strict';

/**
 * core/browserSession.js
 * ---------------------------------------------------------------------------
 * Playwright 浏览器生命周期管理（能力层）。
 *
 * - launch：用 launchPersistentContext 启动本机 Chrome（T-D5：headless:false，可见窗口 + 隔离 userDataDir）；UA/视口等在 launch 时一并注入上下文，预留代理注入入口（F-18，V1 不实现）。
 * - newContext：每任务一个 BrowserContext，避免多任务 cookie 串扰，
 *   并设置一个拟真 UA/视口降低被识别概率；预留 Cookie 注入入口。
 * - close：安全关闭 context 与 browser。
 *
 * 页面（Page）的生命周期由 TaskEngine 在每个 round 内管理，
 * 这里只负责「浏览器 / 上下文」层面。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const { chromium } = require('playwright');
const { ERR } = require('./progressEvent');

/**
 * 拟真 UA 池（近期 Windows + 真实 Chrome 版本），每次启动随机取一个，
 * 避免所有任务固定同一个 UA 被关联。与下方 viewport 抖动共同降低指纹稳定性。
 */
// 注意：UA 必须与本机真实 Chrome 大版本一致（不能冻结在 2024 的旧版本，
// 否则 UA 声明版本与浏览器真实能力/TLS 不一致反而更易被识别为伪造）。
// 2026 年中真实 Chrome 已到 13x 代，故池取 137-140。
const REALISTIC_UA_POOL = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
];

/** 反检测初始化脚本：抹除 navigator.webdriver 痕迹，并统一 navigator.languages（与 UA 一致） */
const ANTI_DETECT_INIT_SCRIPT = function () {
  try {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  } catch (e) {
    /* 某些上下文只读，忽略 */
  }
  try {
    Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en'] });
  } catch (e) {
    /* 忽略 */
  }
};

class BrowserSession {
  constructor() {
    /** @type {import('playwright').Browser|null} */
    this.browser = null;
    /** @type {import('playwright').BrowserContext|null} */
    this.context = null;
    /** 当前使用的持久化用户数据目录 */
    this._userDataDir = null;
    /** 是否为临时 profile（默认 true；显式设置 AUTOCLAW_CHROME_USER_DATA 时为 false） */
    this._isTempProfile = false;
  }

  /**
   * 启动浏览器（T-D5：Windows 原生可见窗口）。
   * 使用本机已安装 Chrome（channel:'chrome'），开真实可见窗口、干净隔离 profile；
   * 采用 launchPersistentContext：userDataDir 只能用于持久化上下文，不能放进 browserType.launch。
   * UA / 视口等在 launch 时一并注入上下文；可选 AUTOCLAW_CHROME_PATH 用 executablePath 指定本机 Chrome 路径。
   * @param {{httpProxy?:string}} [proxy] 代理注入入口（V1 不实现具体逻辑）
   * @returns {Promise<import('playwright').BrowserContext>}
   */
  async launch(proxy, opts) {
    // 持久化 profile 优先级：
    //   1) 显式传入 opts.userDataDir（如谷歌阶段复用 data/google-profile 建身份，降验证码）
    //   2) env AUTOCLAW_CHROME_USER_DATA（手动登录百度降验证码场景）
    //   3) 默认每次独立临时目录（避免 profile 锁竞争）
    const overrideUd =
      (opts && typeof opts.userDataDir === 'string' && opts.userDataDir) ||
      process.env.AUTOCLAW_CHROME_USER_DATA ||
      '';
    const userDataDir =
      overrideUd || fs.mkdtempSync(path.join(os.tmpdir(), 'autoclaw-chrome-'));
    this._userDataDir = userDataDir;
    this._isTempProfile = !overrideUd;
    fs.mkdirSync(userDataDir, { recursive: true });

    // 持久化上下文选项：可见窗口 + 拟真 UA / 视口（这些原本在 newContext 中设置，
    // 但持久化上下文在 launch 时直接建好，故合并进此处）。
    // 反检测要点：
    //  - ignoreDefaultArgs 去掉 Playwright 自动加的 --enable-automation 开关（bot 强特征）；
    //  - --disable-blink-features=AutomationControlled 抹除 navigator.webdriver；
    //  - addInitScript 双保险覆盖 webdriver，并统一 navigator.languages；
    //  - 随机 UA（近期真实 Chrome/Win）+ 视口轻微抖动，降低跨任务指纹关联。
    const userAgent = REALISTIC_UA_POOL[Math.floor(Math.random() * REALISTIC_UA_POOL.length)];
    const viewport = {
      width: 1240 + Math.floor(Math.random() * 200), // 1240-1440
      height: 800 + Math.floor(Math.random() * 160), // 800-960
    };
    const contextOptions = {
      // T-D5：默认开本机真实可见窗口（路线 A：Windows 原生 Chrome）。
      // 服务器无桌面环境需设 AUTOCLAW_HEADLESS=1 切无头模式，否则 Chrome 启动失败。
      headless: process.env.AUTOCLAW_HEADLESS === '1' || process.env.AUTOCLAW_HEADLESS === 'true',
      // 降 bot 识别：去掉 AutomationControlled blink 特性，抹除 navigator.webdriver 痕迹
      args: [
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
        // 与 UA / navigator.languages 保持一致的区域语言，避免「中文 Windows UA + 英文 Accept-Language」
        // 的区域不一致指纹（谷歌据此高度怀疑自动化）。--lang 设置浏览器 UI 语言，
        // acceptLanguage 设置请求头，二者同时对齐 zh-CN。
        '--lang=zh-CN',
      ],
      // 移除 Playwright 自动化开关（谷歌等据此高度关联 bot）
      ignoreDefaultArgs: ['--enable-automation'],
      // 拟真 UA，降低无头浏览器被识别概率
      userAgent: userAgent,
      // 请求头 Accept-Language：与 UA / navigator.languages 一致（zh-CN 优先），
      // 填补此前缺失导致的「区域不一致」bot 信号。
      acceptLanguage: 'zh-CN,zh;q=0.9,en;q=0.8',
      viewport: viewport,
    };
    // 服务器无桌面 / root 容器必须以无头 + 关闭沙箱方式启动，否则 Chrome 启动失败
    if (contextOptions.headless) {
      contextOptions.args.push('--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu');
    }

    // 本机 Chrome：优先用 AUTOCLAW_CHROME_PATH 指定路径，否则自动探测 channel:'chrome'
    const chromePath = process.env.AUTOCLAW_CHROME_PATH || '';
    if (chromePath) {
      contextOptions.executablePath = chromePath;
    } else {
      contextOptions.channel = 'chrome';
    }

    // F-18 代理注入入口（预留）：生产环境可在此设置 proxy = { server }
    if (proxy && proxy.httpProxy) {
      contextOptions.proxy = { server: proxy.httpProxy };
    }

    try {
      // 注意：userDataDir 作为第一个参数传入，而非放进 options（否则报
      // "userDataDir option is not supported in browserType.launch"）。
      this.context = await chromium.launchPersistentContext(userDataDir, contextOptions);
      // 反检测：在每个页面加载前注入初始化脚本，抹除 webdriver 痕迹、统一 languages
      try {
        await this.context.addInitScript(ANTI_DETECT_INIT_SCRIPT);
      } catch (e) {
        /* addInitScript 失败不致命，--disable-blink-features 仍生效 */
      }
      // 持久化上下文自带 browser()，供 close() 兜底关闭使用
      this.browser = this.context.browser();
    } catch (e) {
      const err = new Error('浏览器启动失败: ' + e.message);
      err.code = ERR.ERR_BROWSER_LAUNCH;
      throw err;
    }
    return this.context;
  }

  /**
   * 返回当前的浏览器上下文。
   * 由于已使用 launchPersistentContext，上下文在 launch 时即创建完成（含 UA/视口），
   * 这里直接复用，不再调用 browser.newContext（否则会破坏隔离 profile）。
   * 预留 Cookie 注入入口（F-18，V1 不实现）。
   * @returns {Promise<import('playwright').BrowserContext>}
   */
  async newContext() {
    return this.context; // 已经是带 UA/viewport 的持久化上下文
  }

  /**
   * 健康检查（T1 步骤①核心交付）：证明「浏览器能起来 + 能拿到可操作 page」。
   * 判定标准（架构 7.2）：在给定 context 上 `newPage()` 成功 **且** `page.evaluate`
   * 探针可返回。满足则 `{ ok:true, page }`；任一环节失败返回 `{ ok:false, reason }`。
   *
   * 该方法的「可独立测性」等价于 `scripts/smoke-launch.js` 断言：
   * 在脱离桌面会话（nohup/disown）环境下，launch 本身就会抛 ERR_BROWSER_LAUNCH，
   * 调用方据此立刻暴露「连打开浏览器都起不来」的痛点（H-1）。
   *
   * @param {import('playwright').BrowserContext} [ctx] 待检查的上下文（默认用本实例的）
   * @returns {Promise<{ok:boolean, page?:import('playwright').Page, reason?:string}>}
   */
  async healthCheck(ctx) {
    const target = ctx || this.context;
    if (!target) {
      return { ok: false, reason: '健康检查失败：context 为空（浏览器可能未成功启动）' };
    }
    let page = null;
    try {
      // 1) 能拿到可操作的 page
      page = await target.newPage();
      // 2) 探针：page 真能执行 JS（不是空壳）。evaluate 抛错即判定失败。
      const probe = await page.evaluate(() => true);
      if (probe !== true) {
        await page.close().catch(() => {});
        return { ok: false, reason: '健康检查失败：page.evaluate 探针返回非预期值' };
      }
      // 健康检查通过：把可用的 page 交还调用方复用（避免多开一个空白页）
      return { ok: true, page };
    } catch (e) {
      if (page) {
        await page.close().catch(() => {});
      }
      return {
        ok: false,
        reason: '健康检查失败：' + ((e && e.message) ? e.message : String(e)),
      };
    }
  }

  /**
   * 安全关闭 context 与 browser。
   * 关键：对 launchPersistentContext 创建的持久化上下文，直接调 context.close()
   * 会挂起，故统一走 browser.close()；并在其 resolve 后显式强杀 Chrome 进程树，
   * 确保 SingletonLock 一定释放（否则下一次启动会撞 ProcessSingleton 锁错误）。
   * 临时 profile（默认）顺手删除；持久化 profile（AUTOCLAW_CHROME_USER_DATA）保留。
   */
  async close() {
    const tag = '[browserSession.close]';
    // 优先用 browser 引用（browser.close 对持久化上下文安全）；仅当 browser 丢失时
    // 才退回 context.browser()，绝对避免直接 context.close()（持久化上下文会挂起）。
    const b = this.browser || (this.context && this.context.browser && this.context.browser());
    const proc = b && b.process && b.process();
    console.error(tag, '开始关闭 browser=' + (!!b) + ' proc=' + (proc && proc.pid));
    const closePromise = b ? b.close() : Promise.resolve();
    // 主关闭：10s 兜底超时，避免任务 finally 卡死（异步挂起时 race 在 10s 返回）
    try {
      await Promise.race([
        closePromise.catch((e) => console.error(tag, 'browser.close rejected:', (e && e.message) || e)),
        new Promise((resolve) => setTimeout(resolve, 10000)),
      ]);
    } catch (_) {}
    console.error(tag, 'browser.close 阶段完成');
    // 兜底强杀：browser.close() 已返回但 Chrome 进程树可能仍残留并占用 profile 锁，
    // 显式杀进程树确保锁释放。先 SIGKILL（Node 原生，不依赖 taskkill 系统工具），
    // 再 taskkill /T 兜底（加 8s 超时，被策略拦截时抛错被吞，不阻塞）。
    if (proc && !proc.killed) {
      try { proc.kill('SIGKILL'); } catch (_) {}
      try {
        execSync('taskkill /PID ' + proc.pid + ' /F /T', {
          stdio: 'ignore',
          windowsHide: true,
          timeout: 8000,
          killSignal: 'SIGKILL',
        });
      } catch (_) {}
      // 二次确认（taskkill 被策略拦截时靠上面的 SIGKILL 已处理；仍残留则补一刀）
      try { if (proc && !proc.killed) proc.kill('SIGKILL'); } catch (_) {}
    }
    // 临时 profile 清理（持久化 profile 保留，不删）
    if (this._isTempProfile && this._userDataDir) {
      try { require('fs').rmSync(this._userDataDir, { recursive: true, force: true }); } catch (_) {}
    }
    this.context = null;
    this.browser = null;
    this._userDataDir = null;
    console.error(tag, '关闭完成');
  }
}

module.exports = { BrowserSession };
