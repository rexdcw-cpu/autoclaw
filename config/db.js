'use strict';

/**
 * config/db.js
 * ---------------------------------------------------------------------------
 * 持久化层（双后端：MySQL / SQLite，由 AUTOCLAW_DB_TYPE 决定，默认 'mysql'）。
 * 仅主进程引入；worker 子进程不连 DB。
 *
 * 职责（增量架构 v0.2 §2）：
 *   - getPool()：惰性创建并返回 mysql2 连接池单例（首次 query 时才真正建连）。
 *   - query(sql, params)：统一查询适配层，兼容两种后端：
 *       * mysql：pool.query，返回 rows（[rows] 形式）。
 *       * sqlite：better-sqlite3 同步执行，SELECT 用 prepare(sql).all，
 *         INSERT/UPDATE 用 prepare(sql).run；INSERT 后取 info.lastInsertRowid。
 *   - saveTaskConfig(config, operator)：INSERT task_config（submit 阶段 await）。
 *   - updateTaskStatus(taskId, status)：UPDATE task_config.status（fire-and-forget）。
 *   - bufferRunLog(event)：同步把运行记录压入内存缓冲（非阻塞），定时器批量 INSERT。
 *   - getHistory / getRunLogs / getRunStats：历史配置与运行记录查询（/history、/logs）。
 *
 * 设计要点（最小变更 / 双后端）：
 *   - 所有公开助手（saveTaskConfig 等）的「签名 + 扁平化映射」与 MySQL 版完全一致，
 *     taskManager / routes 零改动。仅内部改走统一的 query() 适配层。
 *   - sqlite 初始化：db 文件路径 = AUTOCLAW_SQLITE_PATH ||
 *     path.join(__dirname,'..','data','autoclaw.db')；自动 mkdir 目录并幂等建表
 *     （scripts/schema.sqlite.sql，免去手动建库）。mysql 路径保持手动 schema.sql。
 *   - 两个驱动均懒 require：未安装对应驱动时仅真正用到时才报错，不影响模块加载，
 *     便于降级（DB 不可用时不影响主流程）。
 *   - 连接信息全部走环境变量（AUTOCLAW_DB_*），绝不硬编码（§2.2）。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// mysql2 懒加载（本机未安装时不阻塞模块加载）
let mysql = null;
let pool = null;

// better-sqlite3 懒加载（sqlite 模式才用到）
let sqlite3 = null;
let sqliteDb = null;

/**
 * 后端类型：默认 'mysql'（保持现有单测 mock mysql2 路径不变）；
 * 仅当 AUTOCLAW_DB_TYPE === 'sqlite' 时走 sqlite。
 * @type {'mysql'|'sqlite'}
 */
const DB_TYPE = (() => {
  const t = (process.env.AUTOCLAW_DB_TYPE || 'mysql').toLowerCase().trim();
  return t === 'sqlite' ? 'sqlite' : 'mysql';
})();

/** PENDING 缓冲上限：超出则丢弃最旧条目，防止内存膨胀（§8.2） */
const PENDING_CAP = 2000;
/** 每次批量落库最大条数 */
const BATCH = 200;
/** 批量落库定时器间隔（ms） */
const FLUSH_MS = 1000;

/** 运行日志内存缓冲（同步入队，定时器消费） */
const pending = [];
let timerStarted = false;

// ---------------------------------------------------------------------------
// MySQL 连接池（AUTOCLAW_DB_TYPE 非 sqlite 时使用）
// ---------------------------------------------------------------------------

/**
 * 惰性返回 mysql2 连接池单例。
 * 首次调用才创建；若 mysql2 未安装会在此抛出（仅真正用到 DB 时失败）。
 * @returns {import('mysql2/promise').Pool}
 */
function getPool() {
  if (!pool) {
    if (!mysql) {
      // 懒 require：未安装时抛错由 query 的 try/catch 捕获
      mysql = require('mysql2/promise');
    }
    pool = mysql.createPool({
      host: process.env.AUTOCLAW_DB_HOST || '127.0.0.1',
      port: Number(process.env.AUTOCLAW_DB_PORT || 3306),
      user: process.env.AUTOCLAW_DB_USER || 'root',
      password: process.env.AUTOCLAW_DB_PASSWORD || '',
      database: process.env.AUTOCLAW_DB_NAME || 'autoclaw',
      connectionLimit: Number(process.env.AUTOCLAW_DB_LIMIT || 10),
      waitForConnections: true,
      charset: 'utf8mb4',
      // 关键：DATETIME 以原始字符串返回（我们显式存 UTC 'YYYY-MM-DD HH:MM:SS'），
      // 避免 mysql2 把无时区 DATETIME 当本地时间构造 Date 造成偏移。
      dateStrings: true,
    });
  }
  return pool;
}

// ---------------------------------------------------------------------------
// SQLite 连接（AUTOCLAW_DB_TYPE === 'sqlite' 时使用，懒开 + 自动建表）
// ---------------------------------------------------------------------------

/**
 * 惰性返回 better-sqlite3 数据库单例。
 * 首次调用才打开文件并幂等执行 scripts/schema.sqlite.sql 建表。
 * @returns {import('better-sqlite3').Database}
 */
function getSqliteDb() {
  if (!sqliteDb) {
    if (!sqlite3) {
      // 懒 require：仅 sqlite 模式才需要 better-sqlite3
      sqlite3 = require('better-sqlite3');
    }
    const dbPath =
      process.env.AUTOCLAW_SQLITE_PATH ||
      path.join(__dirname, '..', 'data', 'autoclaw.db');
    const dataDir = path.dirname(dbPath);
    try {
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }
    } catch (e) {
      // 目录创建失败仅记日志，真正打开时再上抛
      // eslint-disable-next-line no-console
      console.error('[autoclaw-db] 创建 SQLite 数据目录失败:', (e && e.message) ? e.message : e);
    }

    sqliteDb = new sqlite3(dbPath);

    // 幂等建表：免去手动建库（mysql 路径仍走 scripts/schema.sql）
    try {
      const schemaPath = path.join(__dirname, '..', 'scripts', 'schema.sqlite.sql');
      const schemaSql = fs.readFileSync(schemaPath, 'utf8');
      sqliteDb.exec(schemaSql);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[autoclaw-db] SQLite 建表失败:', (e && e.message) ? e.message : e);
      throw e;
    }

    // 幂等迁移（T0 对齐）：老旧库（建表时尚未含 error_code 列）补列，
    // 避免 flushRunLog 因缺列而报错。CREATE TABLE IF NOT EXISTS 不会给已存在的
    // 表追加列，故这里显式 ALTER（SQLite 不支持 ADD COLUMN IF NOT EXISTS）。
    try {
      const cols = sqliteDb
        .prepare('PRAGMA table_info(task_run_log)')
        .all()
        .map((c) => c.name);
      if (cols.length && !cols.includes('error_code')) {
        sqliteDb.exec('ALTER TABLE task_run_log ADD COLUMN error_code TEXT NULL');
      }
    } catch (e) {
      // 迁移失败仅记日志（不影响主流程；最坏缺列时写入会被上层捕获）
      // eslint-disable-next-line no-console
      console.error('[autoclaw-db] 迁移 task_run_log.error_code 列失败:', (e && e.message) ? e.message : e);
    }

    // 幂等迁移（V2 客户线）：老旧库补 client_id 列 + 创建 client 表。
    // 说明：schema.sqlite.sql 已含 client 表与 client_id 列，但旧库首次 open
    // 时尚未执行该版本 schema，故这里兜底补齐；SQLite 不支持 ADD COLUMN IF NOT EXISTS。
    try {
      const tcols = sqliteDb
        .prepare('PRAGMA table_info(task_config)')
        .all()
        .map((c) => c.name);
      if (tcols.length && !tcols.includes('client_id')) {
        sqliteDb.exec('ALTER TABLE task_config ADD COLUMN client_id TEXT NULL');
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[autoclaw-db] 迁移 task_config.client_id 列失败:', (e && e.message) ? e.message : e);
    }
    try {
      const hasClient = sqliteDb
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='client'")
        .get();
      if (!hasClient) {
        sqliteDb.exec(
          'CREATE TABLE IF NOT EXISTS client (' +
          'client_id TEXT NOT NULL, name TEXT NOT NULL, contact TEXT NULL, ' +
          'notes TEXT NULL, created_at TEXT NOT NULL, updated_at TEXT NULL, ' +
          'PRIMARY KEY (client_id))',
        );
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[autoclaw-db] 创建 client 表失败:', (e && e.message) ? e.message : e);
    }
  }
  return sqliteDb;
}

// ---------------------------------------------------------------------------
// 统一查询适配层
// ---------------------------------------------------------------------------

/**
 * 把 MySQL 专属函数改写为 SQLite 等价表达（仅 sqlite 模式使用）。
 * 当前处理 NOW() -> datetime('now')。
 * @param {string} sql
 * @returns {string}
 */
function normalizeSqlForSqlite(sql) {
  return sql.replace(/\bNOW\(\)/gi, "datetime('now')");
}

/**
 * 识别 mysql2 风格的批量 INSERT（'... VALUES ?' + 单一二维数组参数），
 * 改写为 SQLite 兼容的多值占位符并展开参数。
 * 非批量模式返回 null（调用方按单条 run 处理）。
 * @param {string} sql
 * @param {Array<*>} params
 * @returns {{sql:string, params:Array<*>}|null}
 */
function rewriteBulkInsert(sql, params) {
  const trimmed = (sql || '').trim();
  // 仅匹配末尾 'VALUES ?'
  if (!/\bVALUES\s+\?$/i.test(trimmed)) return null;
  if (!Array.isArray(params) || params.length !== 1 || !Array.isArray(params[0])) {
    return null;
  }
  const rows = params[0];
  if (rows.length === 0) return null; // 无数据，无需改写（调用方已提前返回）
  const colCount = rows[0].length;
  const tuple = '(' + Array(colCount).fill('?').join(',') + ')';
  const newSql = trimmed.replace(/\bVALUES\s+\?$/i, 'VALUES ' + rows.map(() => tuple).join(','));
  const flat = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    for (let j = 0; j < row.length; j++) flat.push(row[j]);
  }
  return { sql: newSql, params: flat };
}

/**
 * 统一执行查询，兼容 MySQL 与 SQLite 两种后端。
 *   - mysql：pool.query，返回 rows（与现有一致，[rows] 形式）。
 *   - sqlite：SELECT 用 prepare(sql).all(params)；INSERT/UPDATE 用 prepare(sql).run(params)，
 *     返回 { insertId, changes, affectedRows }（INSERT 后 insertId = info.lastInsertRowid）。
 * 任何失败仅记日志并上抛（不崩溃进程），由调用方 try/catch 处理（保证可降级）。
 * @param {string} sql
 * @param {Array<*>} [params]
 * @returns {Promise<Array<object>|object>}
 */
async function query(sql, params) {
  params = params || [];

  if (DB_TYPE === 'sqlite') {
    const dbc = getSqliteDb();
    try {
      const s = normalizeSqlForSqlite(sql);
      const isSelect = /^\s*(SELECT|WITH|PRAGMA|EXPLAIN)/i.test(s);
      if (isSelect) {
        return dbc.prepare(s).all(...params);
      }
      // 批量 INSERT（mysql2 'VALUES ?' 风格）转多值占位符
      const bulk = rewriteBulkInsert(s, params);
      let stmtSql = s;
      let stmtParams = params;
      if (bulk) {
        stmtSql = bulk.sql;
        stmtParams = bulk.params;
      }
      const info = dbc.prepare(stmtSql).run(...stmtParams);
      return {
        insertId: info.lastInsertRowid,
        changes: info.changes,
        affectedRows: info.changes,
      };
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[autoclaw-db] sqlite query 失败:', (e && e.message) ? e.message : e);
      throw e;
    }
  }

  // ---- MySQL 路径（默认）----
  const p = getPool();
  try {
    const [rows] = await p.query(sql, params);
    return rows;
  } catch (e) {
    // 仅记日志，错误上抛给调用方的 try/catch 处理（保证可降级）
    // eslint-disable-next-line no-console
    console.error('[autoclaw-db] query 失败:', (e && e.message) ? e.message : e);
    throw e;
  }
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/**
 * 把 ISO 时间戳转为 MySQL DATETIME 字符串（UTC，'YYYY-MM-DD HH:MM:SS'）。
 * 失败返回 null（交由列 DEFAULT / NULL 处理）。SQLite 中同样以 TEXT 存储，格式一致。
 * @param {string} [iso]
 * @returns {string|null}
 */
function toMysqlDatetime(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * 把可能是 JSON 字符串或数组的值规整为数组。
 * @param {*} v
 * @returns {Array<*>}
 */
function asArray(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string' && v.length > 0) {
    try {
      const parsed = JSON.parse(v);
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      return [];
    }
  }
  return [];
}

// ---------------------------------------------------------------------------
// 写路径：配置落库 + 状态更新（F-21）
// ---------------------------------------------------------------------------

/**
 * 把任务配置写入 task_config（submit 阶段 await 调用）。
 * 映射关系见增量架构 §3.1。
 * @param {object} config TaskConfig（来自 core/taskConfig.buildTaskConfig）
 * @param {string} [operator] 关联 AUTOCLAW_TOKEN（仅作标签，无则 NULL）
 * @returns {Promise<number|undefined>} INSERT 自增/行 id（mysql: insertId，sqlite: lastInsertRowid）；无需时返回 undefined
 */
async function saveTaskConfig(config, operator) {
  const a = (config && config.anthropic) || {};
  const s = (config && config.strategy) || {};
  const t = (config && config.target) || {};

  const sql =
    'INSERT INTO task_config (' +
    'task_id, platforms, keywords, target_domain, title_keywords, ' +
    'stay_seconds, scroll_up, scroll_down, amp_min, amp_max, interval_min, interval_max, ' +
    'run_mode, fail_rate_threshold, max_retry, action_timeout_ms, ' +
    'status, operator, proxy_json, client_id, created_at' +
    ') VALUES (' +
    '?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?' +
    ')';

  const params = [
    config.taskId,
    JSON.stringify(config.platforms || []),
    JSON.stringify(config.keywords || []),
    t.domain || '',
    JSON.stringify(t.titleKeywords || []),
    a.staySeconds != null ? a.staySeconds : 15,
    a.scrollUp != null ? a.scrollUp : 3,
    a.scrollDown != null ? a.scrollDown : 3,
    a.ampMin != null ? a.ampMin : 300,
    a.ampMax != null ? a.ampMax : 800,
    a.intervalMin != null ? a.intervalMin : 1.0,
    a.intervalMax != null ? a.intervalMax : 2.0,
    s.mode || 'serial',
    s.failRateThreshold != null ? s.failRateThreshold : 0.3,
    s.maxRetry != null ? s.maxRetry : 2,
    s.actionTimeoutMs != null ? s.actionTimeoutMs : 30000,
    config.status || 'pending',
    operator || null,
    config.proxy ? JSON.stringify(config.proxy) : null,
    config.clientId || null,
    toMysqlDatetime(config.createdAt),
  ];

  const result = await query(sql, params);
  if (result && result.insertId != null) return result.insertId;
  return undefined;
}

/**
 * 更新 task_config.status（终态时调用）。设计为 fire-and-forget：
 * 调用方应自行 .catch(() => {})，失败不影响主流程。
 * @param {string} taskId
 * @param {string} status TaskStatus
 * @returns {Promise<void>}
 */
function updateTaskStatus(taskId, status) {
  const sql = 'UPDATE task_config SET status = ?, updated_at = NOW() WHERE task_id = ?';
  return query(sql, [status, String(taskId)]);
}

// ---------------------------------------------------------------------------
// 写路径：运行记录缓冲（F-22，非阻塞）
// ---------------------------------------------------------------------------

/**
 * 把一个 ProgressEvent 扁平化为 task_run_log 的按列顺序的值数组。
 * 映射关系见增量架构 §3.2。
 * @param {object} ev
 * @returns {Array<*>}
 */
function flattenEvent(ev) {
  const round = ev && ev.round ? ev.round : null;
  const step = ev && ev.step ? ev.step : null;
  const stepStatus = (step && step.status) || null;

  let error = null;
  if (stepStatus === 'failed' && step) {
    error = step.detail || null;
  } else if (round && round.error) {
    error = round.error;
  } else if (ev && ev.message) {
    error = ev.message;
  }

  // T0 对齐：错误码优先从步骤对象的 .code 取（横切执行器 stepExecutor 在 T2 注入）；
  // 兜底从事件顶层 error_code 取（部分旧路径 / 单测直接挂 error_code）。两者皆无则 null。
  // 结构先对齐，后续无需再改表/映射。
  const errorCode =
    step && step.code
      ? String(step.code)
      : ev && ev.error_code
        ? String(ev.error_code)
        : null;

  return [
    ev ? ev.taskId : null,
    round ? round.roundIndex : null,
    round ? round.totalRounds : null,
    round ? round.platform : null,
    round ? round.keyword : null,
    step ? step.step : null,
    stepStatus,
    ev ? ev.type : null,
    ev && ev.message ? ev.message : null,
    error,
    toMysqlDatetime(ev && ev.timestamp),
    errorCode, // 末尾追加，保持往下列（如 timestamp）索引不变，避免破坏既有测试
  ];
}

/** 启动批量落库定时器（仅一次，unref 不阻止进程退出） */
function ensureTimer() {
  if (timerStarted) return;
  timerStarted = true;
  const t = setInterval(() => {
    flushRunLog().catch(() => {});
  }, FLUSH_MS);
  if (t.unref) t.unref();
}

/**
 * 将内存缓冲批量写入 task_run_log（单条多值 INSERT）。
 * 失败仅记日志、丢弃该批（降级为仅内存 + 文件日志，不重试）。
 * @returns {Promise<void>}
 */
async function flushRunLog() {
  if (pending.length === 0) return;
  const batch = pending.splice(0, BATCH);
  const cols = [
    'task_id', 'round', 'total_rounds', 'platform', 'keyword',
    'step', 'step_status', 'event_type', 'message', 'error', 'timestamp', 'error_code',
  ];
  const rows = batch.map(flattenEvent);
  const sql = 'INSERT INTO task_run_log (' + cols.join(',') + ') VALUES ?';
  try {
    await query(sql, [rows]);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[autoclaw-db] flushRunLog 失败，丢弃该批 ' + batch.length + ' 条:', (e && e.message) ? e.message : e);
  }
}

/**
 * 同步把内存缓冲批量写入 task_run_log（sqlite 同步 flush）。
 * 用于 worker/主进程退出前确保 pending 全部落库，不为 1s 定时器所困（修复 H-4）。
 * 仅 sqlite 后端提供同步 API；mysql 无同步写入能力，交由异步定时器覆盖（返回 0）。
 * @returns {number} 实际写入行数
 */
function flushRunLogSync() {
  if (DB_TYPE !== 'sqlite') return 0;
  if (pending.length === 0) return 0;
  const batch = pending.splice(0, BATCH);
  const cols = [
    'task_id', 'round', 'total_rounds', 'platform', 'keyword',
    'step', 'step_status', 'event_type', 'message', 'error', 'timestamp', 'error_code',
  ];
  const rows = batch.map(flattenEvent);
  const sql = 'INSERT INTO task_run_log (' + cols.join(',') + ') VALUES ?';
  const bulk = rewriteBulkInsert(normalizeSqlForSqlite(sql), [rows]);
  if (!bulk) return 0;
  try {
    const dbc = getSqliteDb();
    const info = dbc.prepare(bulk.sql).run(...bulk.params);
    return info.changes || 0;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[autoclaw-db] flushRunLogSync 失败，丢弃该批 ' + batch.length + ' 条:', (e && e.message) ? e.message : e);
    return 0;
  }
}

/**
 * 同步把运行记录压入内存缓冲（立即返回，绝不 await）。
 * @param {object} event ProgressEvent
 */
function bufferRunLog(event) {
  if (!event) return;
  pending.push(event);
  if (pending.length > PENDING_CAP) {
    // 超出上限，丢弃最旧条目
    pending.splice(0, pending.length - PENDING_CAP);
  }
  ensureTimer();
}

// ---------------------------------------------------------------------------
// 读路径：历史配置 + 运行记录（F-24 / F-25）
// ---------------------------------------------------------------------------

/**
 * 列历史配置（created_at DESC）。返回已规整为 camelCase 的对象，便于前端回填表单。
 * @param {number} [limit=50]
 * @param {number} [offset=0]
 * @returns {Promise<Array<object>>}
 */
async function getHistory(limit, offset) {
  limit = Math.min(Number(limit) || 50, 200);
  offset = Number(offset) || 0;
  if (offset < 0) offset = 0;

  const sql =
    'SELECT task_id, platforms, keywords, target_domain, title_keywords, ' +
    'stay_seconds, scroll_up, scroll_down, amp_min, amp_max, interval_min, interval_max, ' +
    'run_mode, status, client_id, created_at ' +
    'FROM task_config ORDER BY created_at DESC LIMIT ? OFFSET ?';

  const rows = await query(sql, [limit, offset]);
  return rows.map((r) => ({
    taskId: r.task_id,
    platforms: asArray(r.platforms),
    keywords: asArray(r.keywords),
    targetDomain: r.target_domain,
    titleKeywords: asArray(r.title_keywords),
    anthropic: {
      staySeconds: r.stay_seconds,
      scrollUp: r.scroll_up,
      scrollDown: r.scroll_down,
      ampMin: r.amp_min,
      ampMax: r.amp_max,
      intervalMin: r.interval_min,
      intervalMax: r.interval_max,
    },
    runMode: r.run_mode,
    status: r.status,
    clientId: r.client_id || null,
    createdAt: r.created_at || null,
  }));
}

/**
 * 取某任务的运行记录时间线（按 id 升序）。
 * @param {string} taskId
 * @param {number} [limit=500]
 * @returns {Promise<Array<object>>}
 */
async function getRunLogs(taskId, limit) {
  limit = Math.min(Number(limit) || 500, 2000);
  if (!taskId) return [];

  const sql =
    'SELECT id, task_id, round, total_rounds, platform, keyword, ' +
    'step, step_status, event_type, message, error, timestamp, error_code ' +
    'FROM task_run_log WHERE task_id = ? ORDER BY id ASC LIMIT ?';

  const rows = await query(sql, [String(taskId), limit]);
  return rows.map((r) => ({
    id: r.id,
    taskId: r.task_id,
    round: r.round,
    totalRounds: r.total_rounds,
    platform: r.platform,
    keyword: r.keyword,
    step: r.step,
    stepStatus: r.step_status,
    eventType: r.event_type,
    message: r.message,
    error: r.error,
    timestamp: r.timestamp || null,
    errorCode: r.error_code || null, // T0 对齐：回查补 error_code（修复 handoff T-2）
  }));
}

/**
 * 聚合某任务的成功率/失败率（仅统计 step IS NOT NULL 的行，见 §3.2）。
 * @param {string} taskId
 * @returns {Promise<{total:number, success:number, fail:number, failRate:number}>}
 */
async function getRunStats(taskId) {
  if (!taskId) return { total: 0, success: 0, fail: 0, failRate: 0 };

  const sql =
    'SELECT COUNT(*) AS total, ' +
    "SUM(CASE WHEN step_status = 'success' THEN 1 ELSE 0 END) AS success, " +
    "SUM(CASE WHEN step_status = 'failed' THEN 1 ELSE 0 END) AS fail " +
    'FROM task_run_log WHERE task_id = ? AND step IS NOT NULL';

  const rows = await query(sql, [String(taskId)]);
  const row = rows && rows[0] ? rows[0] : { total: 0, success: 0, fail: 0 };
  const total = Number(row.total) || 0;
  const success = Number(row.success) || 0;
  const fail = Number(row.fail) || 0;
  return {
    total: total,
    success: success,
    fail: fail,
    failRate: total > 0 ? fail / total : 0,
  };
}

/**
 * 把一行 client 表记录规整为 camelCase 对象。
 * @param {object} r
 * @returns {object}
 */
function rowToClient(r) {
  if (!r) return null;
  return {
    clientId: r.client_id,
    name: r.name,
    contact: r.contact || null,
    notes: r.notes || null,
    createdAt: r.created_at || null,
    updatedAt: r.updated_at || null,
  };
}

/**
 * 创建客户档案（P0-8）。
 * @param {{name:string, contact?:string, notes?:string}} input
 * @returns {Promise<object>} 新建的客户对象
 */
async function createClient(input) {
  const name = input && input.name ? String(input.name).trim() : '';
  if (!name) {
    const e = new Error('客户名称不能为空');
    e.code = 'ERR_INVALID_CONFIG';
    throw e;
  }
  const clientId = crypto.randomUUID();
  const nowIso = toMysqlDatetime(new Date().toISOString());
  const sql =
    'INSERT INTO client (client_id, name, contact, notes, created_at, updated_at) ' +
    'VALUES (?, ?, ?, ?, ?, ?)';
  const params = [clientId, name, input.contact || null, input.notes || null, nowIso, null];
  await query(sql, params);
  return {
    clientId: clientId,
    name: name,
    contact: input.contact || null,
    notes: input.notes || null,
    createdAt: nowIso,
    updatedAt: null,
  };
}

/**
 * 列出全部客户（created_at DESC）。
 * @returns {Promise<Array<object>>}
 */
async function listClients() {
  const sql =
    'SELECT client_id, name, contact, notes, created_at, updated_at ' +
    'FROM client ORDER BY created_at DESC';
  const rows = await query(sql);
  return rows.map(rowToClient);
}

/**
 * 取单个客户。
 * @param {string} clientId
 * @returns {Promise<object|null>}
 */
async function getClient(clientId) {
  if (!clientId) return null;
  const sql =
    'SELECT client_id, name, contact, notes, created_at, updated_at ' +
    'FROM client WHERE client_id = ?';
  const rows = await query(sql, [String(clientId)]);
  return rows && rows[0] ? rowToClient(rows[0]) : null;
}

/**
 * 更新客户档案（P0-8，局部更新）。
 * @param {string} clientId
 * @param {{name?:string, contact?:string, notes?:string}} patch
 * @returns {Promise<object|null>} 更新后的客户对象，不存在返回 null
 */
async function updateClient(clientId, patch) {
  const existing = await getClient(clientId);
  if (!existing) return null;
  const nowIso = toMysqlDatetime(new Date().toISOString());
  const name = patch && patch.name != null ? String(patch.name).trim() : existing.name;
  const contact = patch && patch.contact !== undefined ? (patch.contact || null) : existing.contact;
  const notes = patch && patch.notes !== undefined ? (patch.notes || null) : existing.notes;
  const sql = 'UPDATE client SET name = ?, contact = ?, notes = ?, updated_at = ? WHERE client_id = ?';
  await query(sql, [name, contact, notes, nowIso, String(clientId)]);
  return getClient(clientId);
}

/**
 * 删除客户（P0-8）。存在关联任务时拒绝（返回 false 由调用方转 409）。
 * @param {string} clientId
 * @returns {Promise<boolean>} 删除成功返回 true
 * @throws {Error} 含 .code='ERR_CLIENT_HAS_TASKS' 当有任务关联
 */
async function deleteClient(clientId) {
  if (!clientId) return false;
  const cntRows = await query('SELECT COUNT(*) AS c FROM task_config WHERE client_id = ?', [String(clientId)]);
  const count = cntRows && cntRows[0] ? Number(cntRows[0].c) : 0;
  if (count > 0) {
    const e = new Error('客户存在关联任务，无法删除');
    e.code = 'ERR_CLIENT_HAS_TASKS';
    throw e;
  }
  await query('DELETE FROM client WHERE client_id = ?', [String(clientId)]);
  return true;
}

/**
 * 客户维度统计（P0-10）：基于 task_config + task_run_log。
 * @param {string} clientId
 * @returns {Promise<{taskCount:number, lastRunAt:*, total:number, success:number, fail:number, successRate:number|null}>}
 */
async function getClientStats(clientId) {
  if (!clientId) {
    return { taskCount: 0, lastRunAt: null, total: 0, success: 0, fail: 0, successRate: null };
  }
  const sql =
    'SELECT ' +
    'COUNT(DISTINCT tc.task_id) AS task_count, ' +
    'MAX(tc.created_at) AS last_run_at, ' +
    "SUM(CASE WHEN trl.step_status = 'success' THEN 1 ELSE 0 END) AS success, " +
    "SUM(CASE WHEN trl.step_status = 'failed' THEN 1 ELSE 0 END) AS fail, " +
    'COUNT(trl.step) AS total ' +
    'FROM task_config tc ' +
    'LEFT JOIN task_run_log trl ON trl.task_id = tc.task_id AND trl.step IS NOT NULL ' +
    'WHERE tc.client_id = ?';
  const rows = await query(sql, [String(clientId)]);
  const r = rows && rows[0] ? rows[0] : {};
  const total = Number(r.total) || 0;
  const success = Number(r.success) || 0;
  const fail = Number(r.fail) || 0;
  return {
    taskCount: Number(r.task_count) || 0,
    lastRunAt: r.last_run_at || null,
    total: total,
    success: success,
    fail: fail,
    successRate: total > 0 ? success / total : null,
  };
}

/**
 * 取某客户名下全部任务（用于交付报告 P0-11）。
 * @param {string} clientId
 * @returns {Promise<Array<object>>}
 */
async function getClientTasks(clientId) {
  if (!clientId) return [];
  const sql =
    'SELECT task_id, target_domain, keywords, title_keywords, status, created_at ' +
    'FROM task_config WHERE client_id = ? ORDER BY created_at DESC';
  const rows = await query(sql, [String(clientId)]);
  return rows.map((r) => ({
    taskId: r.task_id,
    targetDomain: r.target_domain,
    keywords: asArray(r.keywords),
    titleKeywords: asArray(r.title_keywords),
    status: r.status,
    createdAt: r.created_at || null,
  }));
}

module.exports = {
  // DB_TYPE 主要用于调试/测试可见当前后端
  DB_TYPE,
  getPool,
  query,
  saveTaskConfig,
  updateTaskStatus,
  bufferRunLog,
  flushRunLog,
  flushRunLogSync, // T0：sqlite 同步 flush，供退出前兜底落库（H-4）
  flattenEvent, // T0：导出以支持单测直接验证 error_code 对齐
  getHistory,
  getRunLogs,
  getRunStats,
  // V2 客户线（P0-8 ~ P0-11）
  createClient,
  listClients,
  getClient,
  updateClient,
  deleteClient,
  getClientStats,
  getClientTasks,
  rowToClient,
};
