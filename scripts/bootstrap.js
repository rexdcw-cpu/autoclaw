'use strict';

/**
 * scripts/bootstrap.js
 * ---------------------------------------------------------------------------
 * autoclaw 一键安装与测试（给「另一台电脑上的 Agent / 新人」用，跨平台）。
 *
 * 做的事：
 *   1) npm install（装依赖，含 playwright 包本身，但不强制下载 Chromium）
 *   2) （可选 --with-browser）npx playwright install chromium —— 仅无头服务器跑服务时需要
 *   3) 跑全量单元测试 `node --test test/*.test.js`
 *      —— 关键：运行测试时**不设置 AUTOCLAW_DB_TYPE**（单测铁律：不设则 db 用例假打 mysql2；
 *         错设 sqlite 会走真实 better-sqlite3 假红）。浏览器相关用例缺环境自动 skip。
 *
 * 设计目标：在「没浏览器、没数据库」的干净机器上也能 install + test 全绿。
 *
 * 用法：
 *   node scripts/bootstrap.js                # 装依赖 + 跑测试
 *   node scripts/bootstrap.js --with-browser # 额外下载 Chromium（无头服务器准备）
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const IS_WIN = process.platform === 'win32';

function log(...args) {
  console.log('\x1b[36m[bootstrap]\x1b[0m', ...args);
}
function step(name) {
  console.log('\n\x1b[33m=== ' + name + ' ===\x1b[0m');
}

/**
 * 跨平台地运行一个命令（用 shell:true，Windows 自动解析 npm/npx 的 .cmd）。
 * @param {string} commandLine 完整命令行字符串
 * @param {{noDbType?:boolean}} [opts]
 * @returns {number|null} exit status
 */
function run(commandLine, opts) {
  opts = opts || {};
  const env = Object.assign({}, process.env);
  // 单测铁律：跑测试时移除 AUTOCLAW_DB_TYPE（若存在），避免 db 用例碰真实 sqlite 假红
  if (opts.noDbType && Object.prototype.hasOwnProperty.call(env, 'AUTOCLAW_DB_TYPE')) {
    delete env.AUTOCLAW_DB_TYPE;
    log('已移除环境变量 AUTOCLAW_DB_TYPE（单测铁律：不设则走 mysql2 mock）');
  }
  const res = spawnSync(commandLine, {
    cwd: ROOT,
    stdio: 'inherit',
    env,
    shell: true,
    windowsHide: true,
  });
  if (res.error) {
    log('命令执行失败:', commandLine, '—', res.error.message);
    return 1;
  }
  return res.status;
}

function npmInstall() {
  step('1) npm install（安装依赖，无需单独下载浏览器）');
  const code = run('npm install');
  if (code !== 0) {
    log('npm install 失败，终止。');
    process.exit(code || 1);
  }
  log('依赖安装完成。');
}

function maybeInstallChromium() {
  if (!process.argv.includes('--with-browser')) {
    log('未传 --with-browser：跳过 Chromium 下载。');
    log('（Windows 跑服务用本机 Chrome，无需 Chromium；测试不依赖浏览器；');
    log('  仅 Linux 无头服务器要真跑服务时才需 --with-browser 或手动 npx playwright install chromium）');
    return;
  }
  step('2) 安装 Playwright Chromium（--with-browser）');
  run('npx playwright install chromium');
}

function collectTestFiles() {
  const dir = path.join(ROOT, 'test');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.test.js'))
    .map((f) => path.join('test', f));
}

function runTests() {
  step('运行单元测试（无需浏览器/数据库；不设 AUTOCLAW_DB_TYPE）');
  const files = collectTestFiles();
  if (files.length === 0) {
    log('未找到 test/*.test.js，跳过。');
    return 0;
  }
  log('测试文件数:', files.length);
  const quoted = files.map((f) => '"' + f + '"').join(' ');
  return run(process.execPath + ' --test ' + quoted, { noDbType: true });
}

function main() {
  console.log('\n\x1b[32mautoclaw 一键安装与测试 (bootstrap)\x1b[0m');
  console.log('平台:', process.platform, '| node:', process.version, '| 仓库:', ROOT);
  console.log('提示: 详细踩坑与配置见仓库根目录 AGENT-SETUP.md\n');

  npmInstall();
  maybeInstallChromium();
  const code = runTests();

  if (code === 0) {
    log('\x1b[32m全部单元测试通过 ✅\x1b[0m');
    log('下一步：Windows 双击 start-win.bat；Linux 无头用');
    log('  AUTOCLAW_DB_TYPE=sqlite AUTOCLAW_HEADLESS=1 node app.js');
    process.exit(0);
  } else {
    log('\x1b[31m部分测试失败 ❌ (exit ' + (code || 1) + ')\x1b[0m');
    process.exit(code || 1);
  }
}

main();
