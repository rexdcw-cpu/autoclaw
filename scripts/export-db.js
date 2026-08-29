'use strict';

/**
 * scripts/export-db.js
 * ---------------------------------------------------------------------------
 * 把当前 SQLite 数据库导出为**分片压缩的纯文本 SQL dump**，用于换机/重装前的数据备份迁移。
 *
 * 设计要点：
 *   1. 为什么是 SQL 文本而不是直接复制 .db 二进制？
 *      二进制进 git 后每次变更都存完整副本，仓库迅速膨胀且无法 diff；SQL 可压缩、可读、可 review。
 *   2. 为什么要分片压缩？
 *      实测本环境单次 HTTPS 推送超过约 1MB 就会被连接重置（curl 55 Send failure），
 *      而整库 dump 展开 15MB、即便 gzip 也有 1MB。故按行分块，每片压到几百 KB 再入库。
 *   3. 分片结构：
 *      part01 = 表结构（DROP/CREATE）+ 除日志外的全部数据（极小）
 *      part02..partNN = task_run_log 按 CHUNK 行分块，仅 INSERT
 *      索引放在最后一片（数据插完再建，导入更快）
 *
 * 用法：
 *   node scripts/export-db.js                     # 默认每片 25000 行
 *   node scripts/export-db.js --chunk 50000        # 自定义每片行数
 *   node scripts/export-db.js --outdir <目录>      # 自定义输出目录
 *
 * 恢复：node scripts/import-db.js（自动按序导入所有分片）
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const DB_PATH = process.env.AUTOCLAW_SQLITE_PATH || path.join(ROOT, 'data', 'autoclaw.db');

const args = process.argv.slice(2);
function argVal(flag, def) {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
}
const CHUNK = parseInt(argVal('--chunk', '25000'), 10) || 25000;
const OUT_DIR = path.resolve(ROOT, argVal('--outdir', path.join('data', 'seed')));
/** 超过该行数的表才分片（日志表）；其余整表放进 part01 */
const SPLIT_MIN_ROWS = 5000;

/** SQL 字面量转义（单引号加倍；NULL 单独处理；Buffer 转 X'hex'） */
function sqlLit(v) {
  if (v === null || v === undefined) return 'NULL';
  if (Buffer.isBuffer(v)) return "X'" + v.toString('hex') + "'";
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  if (typeof v === 'bigint') return String(v);
  return "'" + String(v).replace(/'/g, "''") + "'";
}

function writeGz(filePath, text) {
  fs.writeFileSync(filePath, zlib.gzipSync(Buffer.from(text, 'utf8'), { level: 9 }));
  return fs.statSync(filePath).size;
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

  fs.mkdirSync(OUT_DIR, { recursive: true });
  // 清理旧分片，避免残留历史分片被误导入。
  // 某些沙箱/受管环境会拦截 unlinkSync，这里容错：清理失败不阻断，仅提示手工删除。
  const stale = [];
  for (const f of fs.readdirSync(OUT_DIR)) {
    if (!/^autoclaw-dump\.part\d+\.sql(\.gz)?$/.test(f)) continue;
    try {
      fs.unlinkSync(path.join(OUT_DIR, f));
    } catch (e) {
      stale.push(f);
    }
  }
  if (stale.length) {
    console.log('注意：以下旧分片未能自动删除，请手工删除后再导入，否则会被误恢复：');
    for (const f of stale) console.log('  ' + path.join(path.relative(ROOT, OUT_DIR), f));
  }

  const now = new Date().toISOString();
  const header =
    '-- autoclaw 数据库导出（分片 SQL dump）\n' +
    '-- 导出时间: ' + now + '\n' +
    '-- 来源: ' + path.relative(ROOT, DB_PATH) + '\n' +
    '-- 恢复命令: node scripts/import-db.js\n' +
    '-- 本文件由 scripts/export-db.js 生成，请勿手工编辑。\n\n';

  const summary = [];
  const files = [];
  let partNo = 0;
  let grandTotal = 0;

  function nextPart(label) {
    partNo += 1;
    const name = 'autoclaw-dump.part' + String(partNo).padStart(2, '0') + '.sql.gz';
    files.push({ name: name, label: label });
    return { name: name, buf: [header + '-- 分片 ' + partNo + '：' + label + '\n\n'] };
  }

  // ---- part01：表结构 + 小表数据 ----
  let cur = nextPart('表结构 + 基础数据');
  cur.buf.push('PRAGMA foreign_keys=OFF;\nBEGIN TRANSACTION;\n\n');

  const bigTables = [];
  for (const t of tables) {
    const cnt = db.prepare('SELECT COUNT(*) c FROM "' + t.name + '"').get().c;

    // 表结构一律在 part01 建好（大表也一样）：否则后续分片的 INSERT 会找不到表。
    const cols = db.prepare('PRAGMA table_info("' + t.name + '")').all();
    const colNames = cols.map((c) => c.name);
    cur.buf.push('-- 表: ' + t.name + '\n');
    cur.buf.push('DROP TABLE IF EXISTS "' + t.name + '";\n');
    cur.buf.push((t.sql || '').trim() + ';\n');

    // 大表只建结构，数据分到 part02 及之后
    if (cnt >= SPLIT_MIN_ROWS) {
      bigTables.push({ name: t.name, count: cnt });
      cur.buf.push('-- （该表数据较大，见后续分片）\n\n');
      continue;
    }

    const rows = db.prepare('SELECT * FROM "' + t.name + '"').all();
    summary.push({ table: t.name, rows: rows.length });
    grandTotal += rows.length;
    if (rows.length) {
      const BATCH = 200;
      for (let i = 0; i < rows.length; i += BATCH) {
        const slice = rows.slice(i, i + BATCH);
        cur.buf.push(
          'INSERT INTO "' + t.name + '" ("' + colNames.join('", "') + '") VALUES\n' +
          slice.map((r) => '(' + colNames.map((c) => sqlLit(r[c])).join(', ') + ')').join(',\n') + ';\n'
        );
      }
    }
    cur.buf.push('\n');
  }

  // 提交 part01
  cur.buf.push('COMMIT;\nPRAGMA foreign_keys=ON;\n');
  let size = writeGz(path.join(OUT_DIR, cur.name), cur.buf.join(''));
  files[0].size = size;

  // ---- part02..NN：大表（日志）按行分块 ----
  for (const bt of bigTables) {
    const cols = db.prepare('PRAGMA table_info("' + bt.name + '")').all();
    const colNames = cols.map((c) => c.name);
    const colList = '"' + colNames.join('", "') + '"';
    let logged = 0;

    for (let offset = 0; offset < bt.count; offset += CHUNK) {
      const p = nextPart(bt.name + ' 行 ' + offset + '~' + Math.min(offset + CHUNK, bt.count));
      p.buf.push('BEGIN TRANSACTION;\n');
      const rows = db
        .prepare('SELECT * FROM "' + bt.name + '" ORDER BY id LIMIT ? OFFSET ?')
        .all(CHUNK, offset);
      const BATCH = 200;
      for (let i = 0; i < rows.length; i += BATCH) {
        const slice = rows.slice(i, i + BATCH);
        p.buf.push(
          'INSERT INTO "' + bt.name + '" (' + colList + ') VALUES\n' +
          slice.map((r) => '(' + colNames.map((c) => sqlLit(r[c])).join(', ') + ')').join(',\n') + ';\n'
        );
      }
      p.buf.push('COMMIT;\n');
      const sz = writeGz(path.join(OUT_DIR, p.name), p.buf.join(''));
      files[files.length - 1].size = sz;
      logged += rows.length;
      grandTotal += rows.length;
    }
    summary.push({ table: bt.name, rows: logged });
  }

  // ---- 最后一片追加索引 ----
  if (files.length) {
    const indexes = db
      .prepare("SELECT name, sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL")
      .all();
    if (indexes.length) {
      const last = files[files.length - 1];
      const p = path.join(OUT_DIR, last.name);
      const old = zlib.gunzipSync(fs.readFileSync(p)).toString('utf8');
      const addon = '\n-- 索引（数据插完后再建，导入更快）\n' +
        indexes.map((ix) => (ix.sql || '').trim() + ';').join('\n') + '\n';
      last.size = writeGz(p, old + addon);
    }
  }

  db.close();

  console.log('\n=== 导出完成（分片）===');
  console.log('输出目录: ' + path.relative(ROOT, OUT_DIR));
  console.log('每片行数: ' + CHUNK);
  console.log('');
  for (const s of summary) {
    console.log('  ' + s.table.padEnd(24) + String(s.rows).padStart(8) + ' 行');
  }
  console.log('  ' + '-'.repeat(32));
  console.log('  ' + '合计'.padEnd(22) + String(grandTotal).padStart(8) + ' 行');
  console.log('');
  for (const f of files) {
    console.log('  ' + f.name.padEnd(34) + (f.size / 1024).toFixed(0).padStart(7) + ' KB   ' + f.label);
  }
  console.log('\n新机器恢复: node scripts/import-db.js');
  console.log('（入库请用这些 .sql.gz；未压缩的 .sql 已被 .gitignore 排除）');
}

main();
