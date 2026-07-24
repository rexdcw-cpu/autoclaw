'use strict';

/**
 * core/adapters/platformAdapter.js
 * ---------------------------------------------------------------------------
 * 平台适配器抽象基类 + 适配器间复用的匹配/解析工具。
 *
 * 设计说明（与架构类图的小幅务实调整）：
 *   架构类图中 open/search/locateTarget/clickTarget 以 BrowserContext 为单位，
 *   但 Playwright 实际交互发生在 Page 上。因此本基类要求各子类方法统一接收
 *   一个已创建好的 `page`（由 TaskEngine 在每个 round 新建），适配器只负责
 *   「DOM 交互逻辑」，浏览器/页面生命周期归属 TaskEngine + BrowserSession。
 *
 * 子类必须实现：open / search / locateTarget / clickTarget。
 * 基类提供：matchTitle / matchHref / resolveFinalUrl / matchTarget（双匹配与重定向解析）。
 */

// -------------------------------------------------------------------------
// 命中结果「官网首页优先」辅助：路径越浅越像首页（用于 domain-only 兜底时
// 优先点官网根而非深层页面，降低「点错目标」概率）。
// -------------------------------------------------------------------------
function _pathDepth(href) {
  try {
    const u = new URL(href);
    const p = (u.pathname || '/').replace(/^\/+|\/+$/g, '');
    return p ? p.split('/').length : 0;
  } catch (e) {
    return 999; // 异常 URL 视为最不优先
  }
}

// -------------------------------------------------------------------------
// 繁→简归一化（解决「VPN 节点地区导致 Google 结果页用繁体」的匹配失配）
// -------------------------------------------------------------------------
// 不同 VPN 节点（如香港 / 台湾）会让 Google 以繁体中文渲染结果标题，而用户
// 配置的 titleKeywords 通常是简体，导致 matchTitle 的 includes 漏匹配。这里把
// 标题与关键词都统一归一为简体后再比较，消除地区字型差异。
// 依赖 opencc-js（纯 JS，无原生构建）。若环境缺失该依赖则优雅降级为原样比较。
let _cnConverter = null;
function _getCnConverter() {
  if (_cnConverter === null) {
    try {
      // eslint-disable-next-line global-require
      const OpenCC = require('opencc-js');
      const tw = OpenCC.Converter({ from: 'tw', to: 'cn' });
      const hk = OpenCC.Converter({ from: 'hk', to: 'cn' });
      _cnConverter = (s) => hk(tw(s)); // 先 TW 后 HK，覆盖两地繁体变体
    } catch (e) {
      _cnConverter = (s) => s; // 降级：退回旧行为（不归一）
    }
  }
  return _cnConverter;
}

/**
 * @abstract
 */
class PlatformAdapter {
  /**
   * @param {string} name 'baidu' | 'google'
   */
  constructor(name) {
    if (new.target === PlatformAdapter) {
      throw new Error('PlatformAdapter 是抽象类，不可直接实例化');
    }
    this.name = name;
  }

  /**
   * 打开搜索引擎首页。
   * @param {import('playwright').Page} page
   */
  async open(page) {
    throw new Error('open() 未实现');
  }

  /**
   * 在搜索框填入关键词并提交。
   * @param {import('playwright').Page} page
   * @param {string} keyword
   */
  async search(page, keyword) {
    throw new Error('search() 未实现');
  }

  /**
   * 在结果页中双匹配定位目标站点，返回其真实 href；未命中返回 null。
   * @param {import('playwright').Page} page
   * @param {{domain:string,titleKeywords:string[]}} target
   * @returns {Promise<string|null>}
   */
  async locateTarget(page, target) {
    throw new Error('locateTarget() 未实现');
  }

  /**
   * 点击/跳转进入目标站点。
   * @param {import('playwright').Page} page
   * @param {string} href
   */
  async clickTarget(page, href) {
    throw new Error('clickTarget() 未实现');
  }

  // -------------------------------------------------------------------------
  // 共享工具（静态）
  // -------------------------------------------------------------------------

  /**
   * 把文本归一为简体中文（仅用于匹配，不可逆）。
   * 繁体（香港/台湾节点下 Google 渲染的标题）会被转为简体，使简体关键词也能命中；
   * 已是简体的文本保持不变。缺失 opencc-js 依赖时返回原串（优雅降级）。
   * @param {string} text
   * @returns {string}
   */
  static toSimplified(text) {
    if (!text) return text;
    try {
      return _getCnConverter()(text);
    } catch (e) {
      return text;
    }
  }

  /**
   * 标题是否包含任一目标关键词（大小写不敏感；并做繁→简归一，
   * 兼容 VPN 节点地区差异导致的繁体结果标题）。
   * @param {string} title
   * @param {string[]} titleKeywords
   * @returns {boolean}
   */
  static matchTitle(title, titleKeywords) {
    if (!title || !Array.isArray(titleKeywords)) return false;
    const t = PlatformAdapter.toSimplified(title).toLowerCase();
    return titleKeywords.some((kw) => kw && t.includes(PlatformAdapter.toSimplified(kw).toLowerCase()));
  }

  /**
   * href 是否包含目标域名（兼容 www. 等子域名前缀）。
   * @param {string} href
   * @param {string} domain
   * @returns {boolean}
   */
  static matchHref(href, domain) {
    if (!href || !domain) return false;
    return href.toLowerCase().includes(domain.toLowerCase());
  }

  /**
   * 解析 URL 重定向后的真实地址。
   * 用于百度/谷歌结果链接经过自家跳转（如 baidu.com/link?url=）时，
   * 取出落地的真实站点域名用于双匹配。
   * 仅在「标题已命中」的候选上调用，控制网络开销；失败时回退原 href。
   *
   * @param {string} href
   * @param {number} [timeoutMs=3000]
   * @returns {Promise<string>}
   */
  static async resolveFinalUrl(href, timeoutMs = 3000) {
    if (!href || !/^https?:\/\//i.test(href)) return href;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetch(href, {
        method: 'HEAD',
        redirect: 'follow',
        signal: controller.signal,
      });
      return resp.url || href;
    } catch (e) {
      // 解析失败（网络/超时/站点拦截）→ 回退原始 href，由 matchHref 兜底判定
      return href;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 在已切片的搜索结果 items 上做「标题/域名」匹配，定位目标站点（纯函数）。
   *
   * 设计目标：把适配器里「取前 N 条 → 逐条双匹配」的编排逻辑抽成不依赖
   * 浏览器/网络的纯函数，使其可被单测（resolve 由调用方注入 mock）。
   *
   * @param {{title:string, href:string}[]} items
   *        结果列表（调用方通常已切片到 top-N；本函数内部也会再 slice(0, max)）。
   * @param {{domain:string, titleKeywords:string[]}} target
   * @param {object} [opts]
   * @param {(href:string) => (string|Promise<string>)} [opts.resolve]
   *        解析单条 href 为真实 URL（百度/谷歌跳转链接用）。可同步或异步；
   *        默认恒等（直接使用 item.href）；解析抛错时回退原 href。
   * @param {boolean} [opts.strict=true]
   *        true  -> 仅返回「标题 + 域名」双命中者；无则 null。
   *        false -> 收集 score>0 候选并择优返回（见下）。
   * @param {number} [opts.max=10] 仅考察前 max 条。
   * @param {boolean} [opts.titleOnly=false]
   *        strict=false 时是否启用「仅标题命中」兜底。该策略风险高
   *        （标题命中但域名未知/未匹配，URL 未经验证），默认关闭，
   *        仅在调用方明确允许时开启。
   * @returns {Promise<{href:string, score:number, reason:string}|null>}
   *        reason ∈ 'title+domain' | 'domain-only' | 'title-only'；
   *        无任何 score>0 候选时返回 null。
   */
  static async matchTarget(items, target, opts = {}) {
    const { resolve = (h) => h, strict = true, max = 10, titleOnly = false } = opts;
    if (!Array.isArray(items) || !target) return null;

    const slice = items.slice(0, max);
    // 并行解析每条 href（resolve 可同步或异步；解析失败回退原 href）
    const resolvedList = await Promise.all(
      slice.map(async (it) => {
        const href = (it && it.href) || '';
        try {
          return await resolve(href);
        } catch (e) {
          return href;
        }
      })
    );

    const domain = target.domain || '';
    const titleKeywords = Array.isArray(target.titleKeywords) ? target.titleKeywords : [];

    // ── strict 模式：首个「标题 + 域名」双命中 ──
    if (strict) {
      for (let i = 0; i < slice.length; i += 1) {
        const title = (slice[i] && slice[i].title) || '';
        const titleOk = PlatformAdapter.matchTitle(title, titleKeywords);
        const hrefOk = PlatformAdapter.matchHref(resolvedList[i], domain);
        if (titleOk && hrefOk) {
          return { href: resolvedList[i], score: 2, reason: 'title+domain' };
        }
      }
      return null;
    }

    // ── non-strict 模式：收集 score>0 候选，优先 domain 命中 ──
    const domainOnlyCandidates = []; // score 1，域名命中（标题未中）
    let titleOnlyHit = null; // score 1，标题命中（域名未中，风险高）
    for (let i = 0; i < slice.length; i += 1) {
      const title = (slice[i] && slice[i].title) || '';
      const titleOk = PlatformAdapter.matchTitle(title, titleKeywords);
      const hrefOk = PlatformAdapter.matchHref(resolvedList[i], domain);
      // 双命中优先级最高，直接返回
      if (titleOk && hrefOk) {
        return { href: resolvedList[i], score: 2, reason: 'title+domain' };
      }
      // 仅域名命中（标题未包含关键词）：URL 已验证命中目标域名，可安全兜底
      if (hrefOk) {
        domainOnlyCandidates.push({ href: resolvedList[i], score: 1, reason: 'domain-only' });
      }
      // 仅标题命中（域名未匹配）：URL 未经验证、风险高，默认关闭
      if (titleOnly && titleOk && !titleOnlyHit) {
        titleOnlyHit = { href: resolvedList[i], score: 1, reason: 'title-only' };
      }
    }
    // domain-only 兜底：多个同域候选时优先「官网首页（路径最短）」，
    // 避免点进深层页面（如 /news/123）被误判为「点错目标」。
    if (domainOnlyCandidates.length) {
      domainOnlyCandidates.sort(
        (a, b) => _pathDepth(a.href) - _pathDepth(b.href)
      );
      return domainOnlyCandidates[0];
    }
    // title-only 置于 domain-only 之上（前者未验证域名、风险高，默认关闭）
    if (titleOnlyHit) return titleOnlyHit;
    return null;
  }
}

module.exports = { PlatformAdapter };
