'use strict';
// 一次性迁移：对运行中的 data/autoclaw.db 应用客户线 schema（幂等）。
// 仅在本机已生成的库上跑；新库由 config/db.js 自动建表，无需此脚本。
const path = require('path');
const sqlite3 = require(path.join(__dirname, '..', 'node_modules', 'better-sqlite3'));

const dbPath = path.join(__dirname, '..', 'data', 'autoclaw.db');
let dbc;
try {
  dbc = new sqlite3(dbPath);
  dbc.pragma('busy_timeout = 8000');
} catch (e) {
  console.error('打开数据库失败（可能正被占用）:', e.message);
  process.exit(2);
}

try {
  const tcols = dbc.prepare('PRAGMA table_info(task_config)').all().map((c) => c.name);
  if (tcols.length && !tcols.includes('client_id')) {
    dbc.exec('ALTER TABLE task_config ADD COLUMN client_id TEXT NULL');
    console.log('ALTER task_config: 已添加 client_id 列');
  } else {
    console.log('task_config.client_id 已存在，跳过');
  }
} catch (e) {
  console.error('迁移 task_config 失败:', e.message);
}

try {
  const has = dbc.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='client'").get();
  if (!has) {
    dbc.exec(
      'CREATE TABLE IF NOT EXISTS client (' +
      'client_id TEXT NOT NULL, name TEXT NOT NULL, contact TEXT NULL, ' +
      'notes TEXT NULL, created_at TEXT NOT NULL, updated_at TEXT NULL, ' +
      'PRIMARY KEY (client_id))',
    );
    console.log('CREATE client: 已建客户表');
  } else {
    console.log('client 表已存在，跳过');
  }
} catch (e) {
  console.error('迁移 client 表失败:', e.message);
}

dbc.close();
console.log('迁移完成');
