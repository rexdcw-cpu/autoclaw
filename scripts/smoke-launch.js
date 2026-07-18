'use strict';

/**
 * scripts/smoke-launch.js
 * ---------------------------------------------------------------------------
 * 步骤①最小验证脚本（T1 交付）。不依赖整套服务 / DB / worker / socket，
 * 单独验证「浏览器能起来 + 能拿到可操作的 page」。直接对应历史痛点 H-1：
 * 在 nohup/disown 脱离桌面会话下，launch 会抛 ERR_BROWSER_LAUNCH，脚本立即
 * exit(1) 暴露「连打开浏览器都起不来」的问题，而不必等整任务 failed + 0 日志。
 *
 * 流程：launch → newPage → goto('about:blank') → evaluate(1+1===2) 断言 true → close
 * 任意环节失败：打印错误并 process.exit(1)；全部通过：打印成功并 process.exit(0)。
 *
 * 用法（交互桌面会话，绝不用 nohup & disown）：
 *   node scripts/smoke-launch.js
 */

const { BrowserSession } = require('../core/browserSession');
const { ERR } = require('../core/progressEvent');

let _page = null;
let _session = null;

/**
 * 兜底清理：关闭 page 与浏览器，释放临时 profile / 进程锁。
 * 清理失败不影响主流程的退出码（主错误已记录）。
 */
async function cleanup() {
  try {
    if (_page) await _page.close().catch(() => {});
  } catch (_) {
    /* 忽略清理错误 */
  }
  try {
    if (_session) await _session.close().catch(() => {});
  } catch (_) {
    /* 忽略清理错误 */
  }
}

async function main() {
  _session = new BrowserSession();

  // 1) 启动浏览器，拿到持久化上下文（含 UA/视口/隐身参数）
  const context = await _session.launch();
  if (!context) {
    throw new Error('launch 返回空 context（浏览器可能未成功启动）');
  }

  // 2) 拿到可操作的 page
  _page = await context.newPage();

  // 3) 探针：page 真能执行 JS（不是空壳）
  await _page.goto('about:blank');
  const ok = await _page.evaluate(() => 1 + 1 === 2);
  if (ok !== true) {
    throw new Error('page.evaluate 探针返回非预期值: ' + JSON.stringify(ok));
  }

  console.log('[smoke-launch] OK: 浏览器启动 + 可用 page 探针通过 (1+1===2)');
}

main()
  .then(async () => {
    await cleanup();
    process.exit(0);
  })
  .catch(async (e) => {
    const code = e && e.code ? e.code : 'UNKNOWN';
    console.error(
      '[smoke-launch] FAIL (' +
        code +
        '): ' +
        (e && e.message ? e.message : String(e))
    );
    await cleanup().catch(() => {});
    process.exit(1);
  });
