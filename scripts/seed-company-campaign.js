#!/usr/bin/env node
'use strict';

/**
 * scripts/seed-company-campaign.js
 * ---------------------------------------------------------------------------
 * 用公司 10 个站点创建 / 更新一个「每日批量任务」。
 *
 * 用法（在 autoclaw 目录下，sqlite 模式）：
 *   AUTOCLAW_DB_TYPE=sqlite node scripts/seed-company-campaign.js
 *
 * 说明：
 *   - 若已存在同名任务「公司全站每日巡检」则更新其站点 / 调度；否则新建。
 *   - 调度：每天 09:00（服务器本地时间）跑一轮，每轮打乱顺序、10 站串行全跑。
 *   - keywords / titleKeywords 为合理默认（品牌词），可随后在「批量任务」页微调。
 *   - 真实浏览器任务仍需服务器常驻 + 重启后生效（见 README 注意事项）。
 */

const { scheduler } = require('../core/scheduler');

// 公司 10 站：domain（按 Master 提供的 URL 原样保留 www）+ 品牌词。
const SITES = [
  { name: '科大万博', domain: 'www.kedawanbo.com', titleKeywords: '科大万博', keywords: '科大万博|kedawanbo' },
  { name: '万年设计', domain: 'manindesign.com', titleKeywords: '万年设计|Manin Design', keywords: '万年设计|manindesign' },
  { name: '萬年商務', domain: 'maninconsultant.com', titleKeywords: '萬年商務|万年商务', keywords: '萬年商務|万年商务|maninconsultant' },
  { name: '地产官网', domain: 'manincap.com', titleKeywords: 'Manin Cap|万年地产', keywords: 'manincap|万年地产' },
  { name: '金門旅遊', domain: 'kammon-travel.com', titleKeywords: '金門旅遊|金门旅游', keywords: '金門旅遊|金门旅游|kammon travel' },
  { name: '移民简体', domain: 'www.maninvisa.com', titleKeywords: '万年移民|Manin Visa', keywords: '万年移民|maninvisa' },
  { name: 'WISH乐队', domain: 'wishmusic.hk', titleKeywords: 'WISH|Wish Music', keywords: 'WISH乐队|wishmusic' },
  { name: '世一娱乐', domain: 'www.hkcenturyone.com', titleKeywords: '世一娱乐|Century One', keywords: '世一娱乐|hkcenturyone' },
  { name: '中港车', domain: 'manincar.com', titleKeywords: '中港车|Manin Car', keywords: '中港车|中港跨境车|manincar' },
  { name: '美思未來', domain: 'www.macy-future.com', titleKeywords: '美思未來|美思未来', keywords: '美思未來|美思未来|macy future' },
];

const NAME = '公司全站每日巡检';

async function main() {
  await scheduler.reload();
  const list = await scheduler.list();
  const existing = list.find((c) => c.name === NAME);

  const spec = {
    name: NAME,
    scheduleType: 'daily',
    scheduleHour: 9,
    scheduleMinute: 0,
    platforms: ['baidu', 'google'],
    shuffle: true,
    pollWifi: false,
    targets: SITES.map((s) => ({
      name: s.name,
      domain: s.domain,
      enabled: true,
      platforms: ['baidu', 'google'],
      titleKeywords: s.titleKeywords,
      keywords: s.keywords,
      browseAnchor: '关于我们',
    })),
  };

  let c;
  if (existing) {
    c = await scheduler.update(existing.id, spec);
    // eslint-disable-next-line no-console
    console.log('已更新批量任务:', c.id);
  } else {
    c = await scheduler.create(spec);
    // eslint-disable-next-line no-console
    console.log('已创建批量任务:', c.id);
  }
  // eslint-disable-next-line no-console
  console.log('调度: 每天 09:00（服务器本地时间），每轮打乱顺序、10 站串行全跑');
  // eslint-disable-next-line no-console
  console.log('下次运行:', new Date(Number(c.nextRunAt)).toLocaleString());
  // eslint-disable-next-line no-console
  console.log('站点数:', c.targets.length);
  process.exit(0);
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});
