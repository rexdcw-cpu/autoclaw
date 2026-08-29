'use strict';

/**
 * scripts/import-db.js
 * ---------------------------------------------------------------------------
 * 从 data/seed/ 下的 SQL dump 分片恢复数据库（换机/重装后使用）。
 * 配套脚本：scripts/export-db.js（导出）
 *
 * 用法：
 *   node scripts/import-db.js                 # 恢复到 data/autoclaw.db
 *   node scripts/import-db.js --force         # 目标库已存在且非空时仍覆盖
 *   node scripts/import-db.js <dump路径>      # 指定单个 dump 文件（.sql 或 .sql.gz）
 *
 * 分片说明：
 *   导出会生成 autoclaw-dump.part01.sql.gz、part02…（每片几百 KB，便于 git 传输）。
 *   本脚本自动按文件名顺序导入全部分片；若目录下只有单文件 dump，也自动兼容。
 *
 * 安全设计：
 *   - 目标库已存在且非空时默认拒绝，必须显式 --force（防止误覆盖新机器上的数据）；
 *   - 覆盖前自动把旧库重命名为 .bak-<时间戳>，不直接删除；
 *   - 用 db.exec 让 SQLite 自行解析语句边界，避免按分号手工切分被字段内容误伤；
 *   - 结束后跑 integrity_check 并逐表打印记录数，便于与导出时的数字核对。
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');

const args = process.argv.slice(2);
const force = args.includes('--force');
const customPath = args.find((a) => !a.startsWith('--'));

const SEED_DIR = path.join(ROOT, 'data', 'seed');
const DB_PATH = process.env.AUTOCLAW_SQLITE_PATH || path.join(ROOT, 'data', 'autoclaw.db');

/** 在种子目录里找出待导入的 dump 文件（优先分片，其次单文件） */
function findDumps() {
  if (customPath) {
    const p = path.resolve(ROOT, customPath);
    if (fs.existsSync(p)) return [p];
    if (fs.existsSync(p + '.gz')) return [p + '.gz'];
    return [];
  }
  if (!fs.existsSync(SEED_DIR)) return [];
  const parts = fs
    .readdirSync(SEED_DIR)
    .filter((f) => /^autoclaw-dump\.part\d+\.sql(\.gz)?$/.test(f))
    .sort();
  if (parts.length) return parts.map((f) => path.join(SEED_DIR, f));
  for (const cand of ['autoclaw-dump.sql.gz', 'autoclaw-dump.sql']) {
    const p = path.join(SEED_DIR, cand);
    if (fs.existsSync(p)) return [p];
  }
  return [];
}

function main() {
  const dumps = findDumps();
  if (!dumps.length) {
    console.error('找不到 dump 文件。');
    console.error('期望位置: ' + path.relative(ROOT, SEED_DIR) + '/autoclaw-dump.part*.sql.gz');
    console.error('请先 git pull 拉取分片，或指定路径：node scripts/import-db.js <dump路径>');
    process.exit(1);
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

  console.log('待导入分片: ' + dumps.length + ' 个');
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');

  let totalBytes = 0;
  for (let i = 0; i < dumps.length; i++) {
    const f = dumps[i];
    const raw = fs.readFileSync(f);
    const isGz = f.endsWith('.gz');
    const sql = isGz ? zlib.gunzipSync(raw).toString('utf8') : raw.toString('utf8');
    totalBytes += sql.length;
    console.log(
      '  [' + String(i + 1).padStart(2) + '/' + dumps.length + '] ' +
      path.basename(f).padEnd(34) +
      (sql.length / 1024 / 1024).toFixed(2).padStart(7) + ' MB 展开' +
      (isGz ? '（gzip）' : '')
    );
    try {
      db.exec(sql);
    } catch (e) {
      console.error('\n导入失败于 ' + path.basename(f) + '：' + (e && e.message ? e.message : e));
      console.error('已导入 ' + i + ' 个分片，数据库可能处于不完整状态。');
      console.error('建议删除 ' + path.relative(ROOT, DB_PATH) + ' 后重新导入。');
      try { db.close(); } catch (_) { /* ignore */ }
      process.exit(1);
    }
  }

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

  let integrity = 'skipped';
  try {
    integrity = db.pragma('integrity_check', { simple: true });
  } catch (e) {
    integrity = '检查失败: ' + (e.message || e);
  }
  console.log('\n完整性检查: ' + integrity);
  db.close();

  if (integrity !== 'ok' && integrity !== 'skipped') {
    console.error('警告：完整性检查未通过，请检查分片是否完整。');
    process.exit(1);
  }
  console.log('\n数据已恢复。启动服务即可看到全部历史记录。');
}

main();
