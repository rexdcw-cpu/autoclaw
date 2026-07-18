'use strict';

/**
 * core/linkMatcher.js
 * ---------------------------------------------------------------------------
 * 站内链接「目标页面」匹配纯函数（无浏览器依赖，便于单元测试）。
 *
 * 背景：BROWSE 步骤需在目标站内寻找「关于/联系」类页面并点击。原实现用硬编码
 * 正则 /联系|关于|contact|about/i，当用户站点导航文案与默认不符（如导航叫
 * 「关于万年」、站内页叫「关于我们」）时匹配失败，导致只滚动不点（软失败）。
 *
 * 现改为：以可配置锚点 anchor（来自 config.target.browseAnchor，默认「关于我们」）
 * 做子串匹配，并保留两类兜底：
 *   - GENERIC_TEXT_RE：覆盖「联系/contact/about」类通用文案（避免默认仅匹配
 *     「关于我们」时漏掉「联系我们」）。
 *   - PATH_RE：覆盖英文路径 /contact、/about、/about-us。
 */

/** 通用文案兜底：联系类 + 英文 about/contact（关于类交由 anchor 子串匹配） */
const GENERIC_TEXT_RE = /联系|contact|about/i;

/** 英文路径兜底：/contact、/about、/about-us */
const PATH_RE = /\/(contact|about|about-us)\b/i;

/**
 * 判断一个站内链接是否命中「目标页面」锚点。
 *
 * 命中条件（任一成立）：
 *   1) 链接文本包含锚点 anchor（子串匹配，不用正则，避免 anchor 含正则特殊字符崩溃）；
 *   2) 链接文本命中通用兜底 GENERIC_TEXT_RE（联系/contact/about）；
 *   3) 链接路径命中英文路径兜底 PATH_RE（/contact、/about、/about-us）。
 *
 * @param {string} text 链接可见文本（建议已 trim）
 * @param {string} path 归一化后的链接路径（去协议+域名、转小写，含前导 /，如 "/about"）
 * @param {string} [anchor='关于我们'] 可配置锚点（来自 config.target.browseAnchor）
 * @returns {boolean} 命中返回 true
 */
function matchContactLink(text, path, anchor) {
  const safeText = typeof text === 'string' ? text : '';
  const safePath = typeof path === 'string' ? path : '';
  const a = (typeof anchor === 'string' ? anchor : '').trim() || '关于我们';

  // 子串匹配（不用正则）
  const anchorMatch = safeText.includes(a);
  // 通用文案兜底
  const genericMatch = GENERIC_TEXT_RE.test(safeText);
  // 英文路径兜底
  const pathMatch = PATH_RE.test(safePath);

  return anchorMatch || genericMatch || pathMatch;
}

module.exports = {
  matchContactLink,
  GENERIC_TEXT_RE,
  PATH_RE,
};
