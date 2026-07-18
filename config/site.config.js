'use strict';

/**
 * config/site.config.js
 * ---------------------------------------------------------------------------
 * 部署级配置（DEFAULT_TARGET 作为表单预填默认值）。
 *
 * 决策 A1：目标站点（domain + titleKeywords）是「必填表单字段」，表单为唯一数据源。
 * 本文件的 DEFAULT_TARGET 仅用于预填任务配置表单；真正参与双匹配的是
 * 提交 payload 中的 targetDomain / titleKeywords，适配器读取 config.target。
 *
 * 支持的环境变量覆盖（部署侧无需改代码即可切换目标站点）：
 *   AUTOCLAW_TARGET_DOMAIN     目标域名，默认 manincorp.cn
 *   AUTOCLAW_TITLE_KEYWORDS    标题关键词，可用 | 、 、 , 分隔，默认 万年移民
 */

const { DEFAULT_ANTHROPIC, DEFAULT_STRATEGY } = require('./defaults');

/**
 * 把原始字符串按 | 、 、 ,（含全角逗号 ，）拆成去空白的非空数组。
 * @param {string} raw
 * @returns {string[]}
 */
function splitList(raw) {
  return String(raw || '')
    .split(/[|,，、]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

const DEFAULT_TARGET = {
  domain: (process.env.AUTOCLAW_TARGET_DOMAIN || 'manincorp.cn').trim(),
  titleKeywords: splitList(process.env.AUTOCLAW_TITLE_KEYWORDS || '万年移民'),
};

module.exports = {
  DEFAULT_TARGET,
  // 透出 anthropic / strategy 默认值，便于单一入口引用
  DEFAULT_ANTHROPIC,
  DEFAULT_STRATEGY,
  splitList,
};
