'use strict';

/**
 * core/taskEngine.js
 * ---------------------------------------------------------------------------
 * 任务引擎（运行于 worker 子进程内）。负责编排「搜索 → 定位 → 进入 → 停留 →
 * 站内拟人浏览 → 关闭」的轮次循环，并实现容错与熔断。
 *
 * 关键策略（决策 Q5 / Q6 / A4）：
 *   - 默认串行（百度 → 谷歌），同关键词跨平台各跑一遍（顺序由 RoundPlan 决定）。
 *   - 单动作重试 maxRetry(2) 次、超时 actionTimeoutMs(30s)。
 *   - 单轮失败跳过继续（不阻断后续轮次）。
 *   - 整任务失败率 > failRateThreshold(30%) → 自动暂停 + 推送 alert +
 *     任务置为终态（status=failed，原因 circuit-break）。无断点续跑/恢复逻辑（A4）。
 *
 * 拟人动作（决策 Q7）：进入目标站后停留 staySeconds(±20% 抖动)，
 * 站内寻找「联系/关于」页并做上滑/下滑（随机幅度 300–800px、随机间隔 1–2s）。
 */

const { BrowserSession } = require('./browserSession');
const { BaiduAdapter } = require('./adapters/baiduAdapter');
const { GoogleAdapter } = require('./adapters/googleAdapter');
const { matchContactLink } = require('./linkMatcher');
const P = require('./progressEvent');
const {
  EventType,
  StepName,
  StepStatus,
  TaskStatus,
  RoundStatus,
  ERR,
} = P;

/** Promise 超时包装器 */
function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('动作超时（' + ms + 'ms）')), ms);
    Promise.resolve(promise).then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/** sleep */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 随机整数 [min, max] */
function randInt(min, max) {
  return Math.floor(min + Math.random() * (max - min + 1));
}

/** 随机浮点 [min, max] */
function randFloat(min, max) {
  return min + Math.random() * (max - min);
}

/** 拟人微动作的中文描述（用于进度事件 detail） */
const HUMAN_DETAIL = {
  move: '移动鼠标',
  wheel: '滚动滚轮',
  hover: '悬停/按键',
  idle: '随机停顿',
  failed: '随机停顿（动作跳过）',
  disabled: '已禁用',
  noop: '跳过',
};

class TaskEngine {
  /**
   * @param {object} config TaskConfig（来自 core/taskConfig.buildTaskConfig）
   * @param {(event:object)=>void} emit 进度回调，worker 用它经 IPC 回传 ProgressEvent
   */
  constructor(config, emit) {
    this.config = config;
    this.emit = typeof emit === 'function' ? emit : () => {};
    this.adapters = { baidu: new BaiduAdapter(), google: new GoogleAdapter() };
    /** @type {import('playwright').BrowserContext|null} */
    this.ctx = null;

    // 控制信号（由 manager 经 IPC control 消息设置）
    this.shouldPause = false;
    this.shouldStop = false;
    // 熔断标志（失败率超阈值）
    this.circuitPaused = false;

    // 统计
    this.successCount = 0;
    this.failCount = 0;
  }

  /** 请求暂停（在下一轮安全点生效） */
  setPause() {
    this.shouldPause = true;
  }

  /** 请求停止（在下一轮安全点生效） */
  setStop() {
    this.shouldStop = true;
  }

  // -------------------------------------------------------------------------
  // 主循环
  // -------------------------------------------------------------------------

  /**
   * 启动任务主循环。
   * @returns {Promise<string>} 终态 TaskStatus
   */
  async run() {
    const session = new BrowserSession();
    let finalStatus = TaskStatus.COMPLETED;
    try {
      await session.launch(this.config.proxy || null);
      this.ctx = await session.newContext();
    } catch (e) {
      this.emit(
        P.makeProgress({
          taskId: this.config.taskId,
          type: EventType.ALERT,
          message: '浏览器启动失败，任务无法运行：' + e.message,
        }),
      );
      return TaskStatus.FAILED;
    }

    try {
      for (const plan of this.config.rounds) {
        // 在轮次边界检查停止/暂停（安全点）
        if (this.shouldStop) {
          finalStatus = TaskStatus.STOPPED;
          break;
        }
        if (this.shouldPause) {
          finalStatus = TaskStatus.PAUSED;
          break;
        }

        // 拟人：除第一个 round 外，round 之间拉开 8–20s 随机停顿，降低连续搜索触发风控概率
        if (plan.roundIndex > 0) {
          await sleep(randInt(8000, 20000));
        }

        await this.runRound(plan);

        // 熔断检查（决策 A4）
        this._maybeCircuitBreak();
        if (this.circuitPaused) {
          finalStatus = TaskStatus.FAILED;
          break;
        }
      }
    } finally {
      await session.close();
    }

    // 终态推导优先级：熔断 > 停止 > 暂停 > 完成
    if (this.circuitPaused) finalStatus = TaskStatus.FAILED;
    else if (this.shouldStop) finalStatus = TaskStatus.STOPPED;
    else if (this.shouldPause) finalStatus = TaskStatus.PAUSED;
    else finalStatus = TaskStatus.COMPLETED;

    this.emit(
      P.makeProgress({
        taskId: this.config.taskId,
        type: EventType.TASK_END,
        status: finalStatus,
        stats: this._makeStats(),
        message:
          finalStatus === TaskStatus.FAILED
            ? '任务已熔断终止（失败率超阈值）'
            : '任务结束',
      }),
    );
    return finalStatus;
  }

  // -------------------------------------------------------------------------
  // 单轮
  // -------------------------------------------------------------------------

  /**
   * 执行单个轮次（一个平台 × 一个关键词）。
   * 关键步骤（search/locate/enter）失败 → 本轮失败并跳过；
   * 软步骤（stay/browse/close）失败仅记录，不判定本轮失败。
   * @param {{roundIndex:number,totalRounds:number,platform:string,keyword:string}} plan
   */
  async runRound(plan) {
    const taskId = this.config.taskId;
    const page = await this.ctx.newPage();
    const round = P.makeRound(
      taskId,
      plan.platform,
      plan.keyword,
      plan.roundIndex,
      plan.totalRounds,
      RoundStatus.RUNNING,
    );
    let roundSuccess = true;

    this.emit(P.makeProgress({ taskId, type: EventType.ROUND_START, round, stats: this._makeStats() }));

    try {
      // --- 1. SEARCH（打开 + 输入 + 提交）---
      const searchStep = await this._runStep(StepName.SEARCH, async () => {
        const adapter = this.adapters[plan.platform];
        await adapter.open(page);
        await adapter.search(page, plan.keyword);
      });
      this.emit(P.makeProgress({ taskId, type: EventType.STEP, round, step: searchStep, stats: this._makeStats() }));
      if (searchStep.status === StepStatus.FAILED) {
        roundSuccess = false;
        round.error = ERR.ERR_ADAPTER_FAIL;
      }

      // 步骤间拟人微动作（search → locate）
      if (roundSuccess) {
        await this._betweenSteps(page, round, taskId);
      }

      // --- 2. LOCATE（结果页双匹配）---
      let href = null;
      if (roundSuccess) {
        const locateStep = await this._runStep(StepName.LOCATE, async () => {
          const adapter = this.adapters[plan.platform];
          href = await adapter.locateTarget(page, this.config.target);
          if (!href) throw new Error('结果页前 10 条未命中目标站点');
        });
        this.emit(P.makeProgress({ taskId, type: EventType.STEP, round, step: locateStep, stats: this._makeStats() }));
        if (locateStep.status === StepStatus.FAILED) {
          roundSuccess = false;
          round.error = ERR.ERR_NO_TARGET;
        }

        // 步骤间拟人微动作（locate → enter）
        if (roundSuccess) {
          await this._betweenSteps(page, round, taskId);
        }
      }

      // --- 3. ENTER（进入目标站）---
      if (roundSuccess && href) {
        const enterStep = await this._runStep(StepName.ENTER, async () => {
          const adapter = this.adapters[plan.platform];
          await adapter.clickTarget(page, href);
        });
        this.emit(P.makeProgress({ taskId, type: EventType.STEP, round, step: enterStep, stats: this._makeStats() }));
        if (enterStep.status === StepStatus.FAILED) {
          roundSuccess = false;
          round.error = ERR.ERR_ADAPTER_FAIL;
        }

        // 步骤间拟人微动作（enter → stay）
        if (roundSuccess) {
          await this._betweenSteps(page, round, taskId);
        }
      }

      // --- 4. STAY（停留计时，软步骤）---
      if (roundSuccess) {
        const stayStep = await this._softStep(
          StepName.STAY,
          async () => {
            await this._stayDwell(page);
          },
          '目标页已停留',
        );
        this.emit(P.makeProgress({ taskId, type: EventType.STEP, round, step: stayStep, stats: this._makeStats() }));
      }

      // 步骤间拟人微动作（stay → browse）
      if (roundSuccess) {
        await this._betweenSteps(page, round, taskId);
      }

      // --- 5. BROWSE（站内拟人浏览，软步骤）---
      if (roundSuccess) {
        const browseStep = await this._softStep(
          StepName.BROWSE,
          async () => {
            await this._inSiteBrowse(page);
          },
          '站内浏览完成',
        );
        this.emit(P.makeProgress({ taskId, type: EventType.STEP, round, step: browseStep, stats: this._makeStats() }));
      }

      // 步骤间拟人微动作（browse → close，页面仍打开）
      if (roundSuccess) {
        await this._betweenSteps(page, round, taskId);
      }
    } catch (e) {
      // 防御性：未预期异常也判本轮失败
      roundSuccess = false;
      if (!round.error) round.error = ERR.ERR_ADAPTER_FAIL;
    } finally {
      // --- 6. CLOSE（关闭目标页，软步骤）---
      const closeStep = await this._softStep(
        StepName.CLOSE,
        async () => {
          await page.close();
        },
        '目标页已关闭',
      );
      this.emit(P.makeProgress({ taskId, type: EventType.STEP, round, step: closeStep, stats: this._makeStats() }));
    }

    if (roundSuccess) this.successCount += 1;
    else this.failCount += 1;

    const finalRound = Object.assign({}, round, {
      status: roundSuccess ? RoundStatus.SUCCESS : RoundStatus.FAILED,
      finishedAt: P.now(),
    });
    finalRound.steps = finalRound.steps || [];
    this.emit(
      P.makeProgress({ taskId, type: EventType.ROUND_END, round: finalRound, stats: this._makeStats() }),
    );
    return roundSuccess;
  }

  // -------------------------------------------------------------------------
  // 步骤执行（容错 + 超时 + 重试）
  // -------------------------------------------------------------------------

  /**
   * 关键步骤：失败计入本轮失败，带重试与超时。
   * @returns {Promise<object>} StepState
   */
  async _runStep(stepName, fn) {
    const maxRetry = this.config.strategy.maxRetry;
    const timeoutMs = this.config.strategy.actionTimeoutMs;
    let lastErr = null;
    for (let attempt = 0; attempt <= maxRetry; attempt += 1) {
      try {
        await withTimeout(fn(), timeoutMs);
        return P.makeStep(stepName, StepStatus.SUCCESS, attempt > 0 ? '成功（第 ' + attempt + ' 次重试）' : '成功');
      } catch (e) {
        lastErr = e;
        if (attempt < maxRetry) await sleep(500); // 重试前短暂退避
      }
    }
    return P.makeStep(stepName, StepStatus.FAILED, (lastErr && lastErr.message) || '未知错误');
  }

  /**
   * 软步骤（stay/browse/close）：失败仅记录，不判定本轮失败，不重试。
   * @returns {Promise<object>} StepState
   */
  async _softStep(stepName, fn, okDetail) {
    const timeoutMs = this.config.strategy.actionTimeoutMs;
    try {
      await withTimeout(fn(), timeoutMs);
      return P.makeStep(stepName, StepStatus.SUCCESS, okDetail || '成功');
    } catch (e) {
      return P.makeStep(stepName, StepStatus.FAILED, (e && e.message) || '未知错误');
    }
  }

  // -------------------------------------------------------------------------
  // 拟人动作
  // -------------------------------------------------------------------------

  /** 目标页停留（固定值 + 随机抖动） */
  async _stayDwell(page) {
    const a = this.config.anthropic;
    const jitter = 0.8 + Math.random() * 0.4; // ±20%
    const ms = Math.round(a.staySeconds * jitter * 1000);
    await sleep(ms);
  }

  /** 站内拟人浏览：找「联系/关于」页并滚动 */
  async _inSiteBrowse(page) {
    const anchor = ((this.config.target && this.config.target.browseAnchor) || '关于我们').trim() || '关于我们';
    const contactHref = await this._findContactLink(page);
    if (contactHref) {
      await page.goto(contactHref, { waitUntil: 'domcontentloaded', timeout: this.config.strategy.actionTimeoutMs });
    }
    await this._doScroll(page);
    if (!contactHref) {
      // 诊断：收集站内与锚点/关于/联系相关的候选链接，便于排查为何未命中
      const diag = await this._collectLinkDiag(page, anchor);
      const err = new Error(
        '站内未找到目标页（锚点：「' + anchor + '」），已在当前页滚动。候选链接：' + diag
      );
      err.soft = true;
      throw err;
    }
  }

  /** 上滑/下滑随机幅度与间隔的滚动序列 */
  async _doScroll(page) {
    const a = this.config.anthropic;
    const ups = Math.max(0, a.scrollUp | 0);
    const downs = Math.max(0, a.scrollDown | 0);
    const seq = [];
    for (let i = 0; i < ups; i += 1) seq.push(-1);
    for (let i = 0; i < downs; i += 1) seq.push(1);
    for (const dir of seq) {
      const amp = randInt(a.ampMin, a.ampMax);
      await page.mouse.wheel(0, dir * amp);
      const iv = randFloat(a.intervalMin, a.intervalMax);
      await sleep(Math.round(iv * 1000));
    }
  }

  // -------------------------------------------------------------------------
  // 拟人微动作（步骤之间随机停顿 + 随机微动作，降低被风控概率）
  // -------------------------------------------------------------------------

  /** 可被子类/测试覆盖的停顿（默认真实 setTimeout，测试可替换为即时） */
  _sleep(ms) {
    return sleep(ms);
  }

  /**
   * 步骤之间插入一次「拟人微动作」：先随机思考停顿，再随机做一次微动作。
   * 任何异常都静默吞掉，绝不影响主流程。
   * @param {import('playwright').Page} page
   * @returns {Promise<{thinkMs:number, action:string}>}
   *   action: 'move' | 'wheel' | 'hover' | 'idle' | 'failed' | 'disabled' | 'noop'
   */
  async _humanInterstitial(page) {
    const h = this.config.humanize || {};
    if (h.enabled === false) return { thinkMs: 0, action: 'disabled' };
    if (!page || (typeof page.isClosed === 'function' && page.isClosed())) {
      return { thinkMs: 0, action: 'noop' };
    }
    const minMs = h.minMs != null ? h.minMs : 800;
    const maxMs = h.maxMs != null ? h.maxMs : 2600;
    const jitterAmp = h.jitterAmp != null ? h.jitterAmp : 400;
    const thinkMs = randInt(minMs, maxMs) + (jitterAmp ? randInt(0, jitterAmp) : 0);
    let action = 'idle';
    try {
      await this._sleep(thinkMs);
      const moveP = h.moveProb != null ? h.moveProb : 0.6;
      const scrollP = h.scrollProb != null ? h.scrollProb : 0.25;
      const hoverP = h.hoverProb != null ? h.hoverProb : 0.15;
      const total = moveP + scrollP + hoverP;
      if (total <= 0) return { thinkMs, action: 'idle' };
      const r = Math.random() * total;
      if (r < moveP) {
        await this._humanMove(page, h);
        action = 'move';
      } else if (r < moveP + scrollP) {
        await this._humanWheel(page, h);
        action = 'wheel';
      } else {
        await this._humanHoverOrKey(page, h);
        action = 'hover';
      }
    } catch (e) {
      // 拟人动作失败绝不影响主流程
      action = 'failed';
    }
    return { thinkMs, action };
  }

  /**
   * 步骤之间发射一条 HUMAN 进度事件（便于看板观察拟人节奏）。
   * 若 humanize 被禁用则不发射，避免噪音。
   */
  async _betweenSteps(page, round, taskId) {
    const h = this.config.humanize || {};
    if (h.enabled === false) return;
    const hu = await this._humanInterstitial(page);
    const detail = HUMAN_DETAIL[hu.action] || hu.action;
    this.emit(
      P.makeProgress({
        taskId,
        type: EventType.STEP,
        round,
        step: P.makeStep(StepName.HUMAN, StepStatus.SUCCESS, detail + '（停顿 ' + hu.thinkMs + 'ms）'),
        stats: this._makeStats(),
      }),
    );
  }

  /** 取视口尺寸（兼容 headless / 持久化 Chrome；取不到则回退默认值） */
  async _viewport(page) {
    try {
      let vp = typeof page.viewportSize === 'function' ? page.viewportSize() : null;
      if (!vp || !vp.width) {
        vp = await page.evaluate(() => ({
          width: window.innerWidth || 1280,
          height: window.innerHeight || 800,
        }));
      }
      return vp && vp.width ? vp : { width: 1280, height: 800 };
    } catch (e) {
      return { width: 1280, height: 800 };
    }
  }

  /** 拟人：分两段曲线移动鼠标到视口内随机点 */
  async _humanMove(page, h) {
    const vp = await this._viewport(page);
    const x = randInt(0, vp.width);
    const y = randInt(0, vp.height);
    await page.mouse.move(x * 0.3, y * 0.3, { steps: randInt(2, 6) });
    await page.mouse.move(x, y, { steps: randInt(3, 10) });
  }

  /** 拟人：随机方向轻推滚轮 */
  async _humanWheel(page, h) {
    const amp = h.wheelAmp != null ? h.wheelAmp : 120;
    const dy = randInt(-amp, amp);
    await page.mouse.wheel(0, dy);
  }

  /** 拟人：随机悬停一个链接，或随机按一个阅读键（PageDown / ArrowDown / End） */
  async _humanHoverOrKey(page, h) {
    if (Math.random() < 0.5) {
      const els = await page.$$('a');
      if (els && els.length) {
        const el = els[randInt(0, els.length - 1)];
        if (typeof el.hover === 'function') await el.hover();
      }
    } else {
      const keys = ['PageDown', 'ArrowDown', 'End'];
      await page.keyboard.press(keys[randInt(0, keys.length - 1)]);
    }
  }

  /**
   * 站内寻找「联系我们/关于我们」等可点击项（决策 Q4，文本+路径双条件取首个）。
   * 锚点来自 config.target.browseAnchor（可配置，默认「关于我们」），
   * 命中判定交由纯函数 matchContactLink（见 core/linkMatcher.js）。
   * @returns {Promise<string|null>} 命中链接的完整 URL 或 null
   */
  async _findContactLink(page) {
    const anchor = ((this.config.target && this.config.target.browseAnchor) || '关于我们').trim() || '关于我们';
    const links = await page.$$('a[href]');
    const base = new URL(page.url());
    for (const a of links) {
      const text = ((await a.textContent()) || '').trim();
      let href = (await a.getAttribute('href')) || '';
      if (!href) continue;
      // 过滤无意义伪链接：锚点、javascript、mailto、tel、data（这些点了不会跳转到目标页）
      if (/^(#|javascript:|mailto:|tel:|data:)/i.test(href)) continue;
      // 统一解析为绝对 URL：支持 /xxx、相对路径 xxx.html、完整 URL
      let absoluteHref;
      try {
        absoluteHref = new URL(href, base.href).href;
      } catch (e) {
        continue;
      }
      const path = absoluteHref.replace(/^https?:\/\/[^/]+/i, '').toLowerCase();
      if (matchContactLink(text, path, anchor)) {
        if (/^https?:\/\//i.test(absoluteHref)) return absoluteHref;
      }
    }
    return null;
  }

  /** 诊断用：收集站内与锚点/目标页相关的候选链接文本（不抛错） */
  async _collectLinkDiag(page, anchor) {
    try {
      const links = await page.$$('a[href]');
      const items = [];
      const kw = (typeof anchor === 'string' && anchor.trim()) ? anchor.trim() : '关于我们';
      const base = new URL(page.url());
      for (const a of links) {
        const text = ((await a.textContent()) || '').trim();
        if (!text) continue;
        let href = '';
        try { href = new URL((await a.getAttribute('href')) || '', base.href).href; } catch (e) { /* ignore */ }
        if (text.includes(kw) || /关于|联系|contact|about|万年/i.test(text)) {
          items.push(text.slice(0, 30) + (href ? ' → ' + href : ''));
        }
      }
      return items.length
        ? items.join(' | ')
        : '(无匹配候选，站内链接总数 ' + links.length + ')';
    } catch (e) {
      return '(诊断收集失败: ' + (e && e.message ? e.message : String(e)) + ')';
    }
  }

  // -------------------------------------------------------------------------
  // 熔断
  // -------------------------------------------------------------------------

  /** 失败率超阈值 → 熔断：推送 alert 并置熔断标志（决策 A4） */
  _maybeCircuitBreak() {
    const stats = this._makeStats();
    if (stats.failRate > this.config.strategy.failRateThreshold) {
      this.circuitPaused = true;
      this.emit(
        P.makeProgress({
          taskId: this.config.taskId,
          type: EventType.ALERT,
          message:
            '失败率 ' +
            (stats.failRate * 100).toFixed(1) +
            '% 已超过阈值 ' +
            (this.config.strategy.failRateThreshold * 100).toFixed(0) +
            '%，已自动熔断并终止任务',
          stats: stats,
        }),
      );
    }
  }

  /** 组装当前统计快照 */
  _makeStats() {
    const done = this.successCount + this.failCount;
    return P.makeStats(this.config.rounds.length, done, this.successCount, this.failCount);
  }
}

module.exports = { TaskEngine };
