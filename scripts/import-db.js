'use strict';

/**
 * scripts/import-db.js
 * ---------------------------------------------------------------------------
 * 从 data/seed/autoclaw-dump.sql 恢复数据库（换机/重装后使用）。
 * 配套脚本：scripts/export-db.js（导出）
 *
 * 用法：
 *   node scripts/import-db.js                 # 恢复到 data/autoclaw.db
 *   node scripts/import-db.js --force         # 目标库已存在时仍覆盖
 *   node scripts/import-db.js <dump路径>      # 指定 dump 文件
 *
 * 安全设计：
 *   - 目标库已存在且非空时默认拒绝，必须显式 --force（防止误覆盖新机器上的数据）；
 *   - 覆盖前自动把旧库重命名为 .bak-<时间戳>，不直接删除；
 *   - 导入在事务中执行，任一环节失败则整体回滚，不会留下半截数据；
 *   - 结束后逐表打印记录数，便于与导出时的数字核对。
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');

// 解析参数（支持 --force 与自定义 dump 路径）
const args = process.argv.slice(2);
const force = args.includes('--force');
const customPath = args.find((a) => !a.startsWith('--'));

const DUMP_PATH = customPath
  ? path.resolve(ROOT, customPath)
  : path.join(ROOT, 'data', 'seed', 'autoclaw-dump.sql');
const DB_PATH = process.env.AUTOCLAW_SQLITE_PATH || path.join(ROOT, 'data', 'autoclaw.db');

function main() {
  // 入库的是压缩版 .sql.gz（15MB → 约 1MB，便于 git 传输）；
  // 若本地另有未压缩的 .sql（如刚 export 出来的），优先用它，省一次解压。
  let dumpFile = DUMP_PATH;
  if (!fs.existsSync(dumpFile)) {
    if (fs.existsSync(dumpFile + '.gz')) dumpFile = dumpFile + '.gz';
    else if (customPath) {
      console.error('找不到 dump 文件：' + customPath);
      process.exit(1);
    } else {
      console.error('找不到 dump 文件：' + path.relative(ROOT, DUMP_PATH) + '(.gz)');
      console.error('请先执行 git pull 拉取 data/seed/autoclaw-dump.sql.gz，或指定路径。');
      process.exit(1);
    }
  }

  let Database;
  try {
    Database = require('better-sqlite3');
  } catch (e) {
    console.error('缺少 better-sqlite3，请先 npm install');
    process.exit(1);
  }

  // 目标库已存在时的保护
  if (fs.existsSync(DB_PATH)) {
    const size = fs.statSync(DB_PATH).size;
    if (size > 0 && !force) {
      console.error('目标数据库已存在且非空：' + path.relative(ROOT, DB_PATH) +
        '（' + (size / 1024 / 1024).toFixed(2) + ' MB）');
      console.error('如确认要覆盖，请加 --force：');
      console.error('  node scripts/import-db.js --force');
      console.error('（覆盖前会自动把旧库备份为 .bak-<时间戳>）');
      process.exit(1);
    }
    if (size > 0) {
      const bak = DB_PATH + '.bak-' + Date.now();
      fs.renameSync(DB_PATH, bak);
      console.log('旧库已备份为: ' + path.basename(bak));
    }
  }

  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

  const dumpSize = fs.statSync(dumpFile).size;
  const isGz = dumpFile.endsWith('.gz');
  console.log('读取 dump: ' + path.relative(ROOT, dumpFile) +
    '（' + (dumpSize / 1024 / 1024).toFixed(2) + ' MB' + (isGz ? '，gzip' : '') + '）');

  let sql;
  if (isGz) {
    sql = zlib.gunzipSync(fs.readFileSync(dumpFile)).toString('utf8');
    console.log('解压后: ' + (sql.length / 1024 / 1024).toFixed(2) + ' MB');
  } else {
    sql = fs.readFileSync(dumpFile, 'utf8');
  }

  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');

  console.log('开始导入（事务中，失败将整体回滚）…');
  try {
    // dump 文件自身带 BEGIN TRANSACTION / COMMIT，用 exec 让 SQLite 自行解析语句边界，
    // 避免按 ";" 手工切分被字段内容里的分号误伤。
    db.exec(sql);
  } catch (e) {
    console.error('导入失败：' + (e && e.message ? e.message : e));
    try { db.close(); } catch (_) { /* ignore */ }
    process.exit(1);
  }

  // 核对记录数
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all();
  let total = 0;
  console.log('\n=== 导入完成 ===');
  for (const t of tables) {
    const c = db.prepare('SELECT COUNT(*) c FROM "' + t.name + '"').get().c;
    total += c;
    console.log('  ' + t.name.padEnd(24) + String(c).padStart(8) + ' 行');
  }
  console.log('  ' + '-'.repeat(32));
  console.log('  ' + '合计'.padEnd(22) + String(total).padStart(8) + ' 行');

  // 完整性检查
  let integrity = 'skipped';
  try {
    integrity = db.pragma('integrity_check', { simple: true });
  } catch (e) {
    integrity = '检查失败: ' + (e.message || e);
  }
  console.log('\n完整性检查: ' + integrity);
  db.close();

  if (integrity !== 'ok' && integrity !== 'skipped') {
    console.error('警告：完整性检查未通过，请检查 dump 文件是否完整。');
    process.exit(1);
  }
  console.log('\n数据已恢复。启动服务即可看到全部历史记录。');
}

main();
