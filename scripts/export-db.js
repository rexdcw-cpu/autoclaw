'use strict';

/**
 * scripts/export-db.js
 * ---------------------------------------------------------------------------
 * 把当前 SQLite 数据库导出为**纯文本 SQL dump**，用于换机/重装前的数据备份与迁移。
 *
 * 为什么导出 SQL 而不是直接复制 .db 二进制文件：
 *   - 二进制 db 进 git 后每次变更都会存一份完整副本，仓库会迅速膨胀且无法 diff；
 *   - SQL 是文本，git 压缩率高、可读、可 review，且能跨 SQLite 版本恢复。
 *
 * 用法：
 *   node scripts/export-db.js [输出路径]
 *   默认输出：data/seed/autoclaw-dump.sql
 *
 * 恢复：node scripts/import-db.js （新机器上一条命令还原全部数据）
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DB_PATH = process.env.AUTOCLAW_SQLITE_PATH || path.join(ROOT, 'data', 'autoclaw.db');
const OUT_PATH = process.argv[2] || path.join(ROOT, 'data', 'seed', 'autoclaw-dump.sql');

/** SQL 字面量转义（单引号加倍；NULL 单独处理；Buffer 转 X'' 十六进制） */
function sqlLit(v) {
  if (v === null || v === undefined) return 'NULL';
  if (Buffer.isBuffer(v)) return "X'" + v.toString('hex') + "'";
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  if (typeof v === 'bigint') return String(v);
  return "'" + String(v).replace(/'/g, "''") + "'";
}

function main() {
  if (!fs.existsSync(DB_PATH)) {
    console.error('找不到数据库：' + DB_PATH);
    process.exit(1);
  }
  let Database;
  try {
    Database = require('better-sqlite3');
  } catch (e) {
    console.error('缺少 better-sqlite3，请先 npm install');
    process.exit(1);
  }

  const db = new Database(DB_PATH, { readonly: true, busyTimeout: 8000 });
  const tables = db
    .prepare("SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all();

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  const out = fs.createWriteStream(OUT_PATH, { encoding: 'utf8' });

  const now = new Date().toISOString();
  out.write('-- autoclaw 数据库导出（纯文本 SQL dump）\n');
  out.write('-- 导出时间: ' + now + '\n');
  out.write('-- 来源: ' + path.relative(ROOT, DB_PATH) + '\n');
  out.write('-- 恢复命令: node scripts/import-db.js\n');
  out.write('--\n');
  out.write('-- 本文件由 scripts/export-db.js 生成，请勿手工编辑。\n\n');
  out.write('PRAGMA foreign_keys=OFF;\n');
  out.write('BEGIN TRANSACTION;\n\n');

  let grandTotal = 0;
  const summary = [];

  for (const t of tables) {
    const cols = db.prepare('PRAGMA table_info("' + t.name + '")').all();
    const colNames = cols.map((c) => c.name);

    out.write('-- ---------------------------------------------------------\n');
    out.write('-- 表: ' + t.name + '\n');
    out.write('-- ---------------------------------------------------------\n');
    out.write('DROP TABLE IF EXISTS "' + t.name + '";\n');
    out.write((t.sql || '').trim() + ';\n');

    const rows = db.prepare('SELECT * FROM "' + t.name + '"').all();
    summary.push({ table: t.name, rows: rows.length });
    grandTotal += rows.length;

    if (rows.length === 0) {
      out.write('-- （空表，无数据）\n\n');
      continue;
    }

    // 分批生成 INSERT，避免单条语句过长
    const BATCH = 200;
    for (let i = 0; i < rows.length; i += BATCH) {
      const slice = rows.slice(i, i + BATCH);
      const values = slice.map(
        (r) => '(' + colNames.map((c) => sqlLit(r[c])).join(', ') + ')'
      );
      out.write(
        'INSERT INTO "' + t.name + '" ("' + colNames.join('", "') + '") VALUES\n' +
        values.join(',\n') + ';\n'
      );
    }
    out.write('\n');
  }

  // 索引（数据插入完再建，导入更快）
  const indexes = db
    .prepare("SELECT name, sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL")
    .all();
  if (indexes.length) {
    out.write('-- 索引（数据插完后再建，导入更快）\n');
    for (const ix of indexes) out.write((ix.sql || '').trim() + ';\n');
    out.write('\n');
  }

  out.write('COMMIT;\n');
  out.write('PRAGMA foreign_keys=ON;\n');
  out.end();

  out.on('finish', () => {
    const size = fs.statSync(OUT_PATH).size;
    console.log('\n=== 导出完成 ===');
    console.log('输出: ' + path.relative(ROOT, OUT_PATH));
    console.log('大小: ' + (size / 1024 / 1024).toFixed(2) + ' MB');
    console.log('');
    for (const s of summary) {
      console.log('  ' + s.table.padEnd(24) + String(s.rows).padStart(8) + ' 行');
    }
    console.log('  ' + '-'.repeat(32));
    console.log('  ' + '合计'.padEnd(22) + String(grandTotal).padStart(8) + ' 行');

    // 同时生成 gzip 版：SQL 文本重复度高，压缩率约 6%~7%（15MB → 1MB），
    // 入库用 .sql.gz（未压缩的 .sql 已被 .gitignore 排除）。
    try {
      const zlib = require('zlib');
      const gzPath = OUT_PATH + '.gz';
      fs.writeFileSync(gzPath, zlib.gzipSync(fs.readFileSync(OUT_PATH), { level: 9 }));
      const gzSize = fs.statSync(gzPath).size;
      console.log('\n压缩版: ' + path.relative(ROOT, gzPath) +
        '（' + (gzSize / 1024 / 1024).toFixed(2) + ' MB，压缩至 ' +
        (gzSize / size * 100).toFixed(1) + '%）');
      console.log('提交入库请用这个 .sql.gz 版本。');
    } catch (e) {
      console.log('\n（gzip 生成失败：' + (e && e.message ? e.message : e) + '）');
    }
    console.log('\n新机器恢复: node scripts/import-db.js');
  });

  db.close();
}

main();
