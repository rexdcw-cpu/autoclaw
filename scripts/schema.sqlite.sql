-- ===========================================================================
-- autoclaw · SQLite 建表脚本（本地免服务器测试用，AUTOCLAW_DB_TYPE=sqlite）
-- ---------------------------------------------------------------------------
-- 与 scripts/schema.sql（MySQL）保持列结构一致；差异：
--   * 无 ENGINE / CHARSET（SQLite 不支持），使用原生类型。
--   * MySQL 的 JSON 列（platforms / keywords / title_keywords / proxy_json）
--     在 SQLite 中以 TEXT 存储（应用层原本就是 JSON 字符串存取，无需改映射）。
--   * updated_at 由应用层 NOW() -> datetime('now') 写入，这里允许 NULL。
-- 本脚本由 config/db.js 在首次打开 SQLite 时幂等执行（CREATE TABLE IF NOT EXISTS）。
-- ===========================================================================

CREATE TABLE IF NOT EXISTS task_config (
  task_id            TEXT    NOT NULL,
  platforms          TEXT    NOT NULL,
  keywords           TEXT    NOT NULL,
  target_domain      TEXT    NOT NULL,
  title_keywords     TEXT    NOT NULL,
  stay_seconds       INTEGER NOT NULL DEFAULT 15,
  scroll_up          INTEGER NOT NULL DEFAULT 3,
  scroll_down        INTEGER NOT NULL DEFAULT 3,
  amp_min            INTEGER NOT NULL DEFAULT 300,
  amp_max            INTEGER NOT NULL DEFAULT 800,
  interval_min       REAL    NOT NULL DEFAULT 1.0,
  interval_max       REAL    NOT NULL DEFAULT 2.0,
  run_mode           TEXT    NOT NULL DEFAULT 'serial',
  fail_rate_threshold REAL   NOT NULL DEFAULT 0.3,
  max_retry          INTEGER NOT NULL DEFAULT 2,
  action_timeout_ms  INTEGER NOT NULL DEFAULT 30000,
  status             TEXT    NOT NULL DEFAULT 'pending',
  operator           TEXT    NULL,
  proxy_json         TEXT    NULL,
  client_id          TEXT    NULL,
  created_at         TEXT    NOT NULL,
  updated_at         TEXT    NULL,
  PRIMARY KEY (task_id)
);

CREATE INDEX IF NOT EXISTS idx_task_config_created ON task_config (created_at);
CREATE INDEX IF NOT EXISTS idx_task_config_client ON task_config (client_id);

-- 客户档案（V2 客户线 P0-8 ~ P0-11）
CREATE TABLE IF NOT EXISTS client (
  client_id   TEXT    NOT NULL,
  name        TEXT    NOT NULL,
  contact     TEXT    NULL,
  notes       TEXT    NULL,
  created_at  TEXT    NOT NULL,
  updated_at  TEXT    NULL,
  PRIMARY KEY (client_id)
);

CREATE INDEX IF NOT EXISTS idx_client_name ON client (name);

CREATE TABLE IF NOT EXISTS task_run_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id       TEXT    NOT NULL,
  round         INTEGER NULL,
  total_rounds  INTEGER NULL,
  platform      TEXT    NULL,
  keyword       TEXT    NULL,
  step          TEXT    NULL,
  step_status   TEXT    NULL,
  event_type    TEXT    NULL,
  message       TEXT    NULL,
  error         TEXT    NULL,
  timestamp     TEXT    NOT NULL,
  error_code    TEXT    NULL
);

CREATE INDEX IF NOT EXISTS idx_task_run_log_task_id ON task_run_log (task_id);
CREATE INDEX IF NOT EXISTS idx_task_run_log_task_round ON task_run_log (task_id, round);
CREATE INDEX IF NOT EXISTS idx_task_run_log_task_ts ON task_run_log (task_id, timestamp);

-- 批量定时任务（campaign）：一组网站目标 + 调度 + 打乱开关。
-- 一个 campaign 每次运行按（可选打乱的）顺序把各目标串行提交为普通 task。
-- 时间字段以 epoch 毫秒（TEXT 数字串）存储，便于调度器直接比较、规避时区问题。
CREATE TABLE IF NOT EXISTS campaigns (
  id                TEXT    NOT NULL,
  name              TEXT    NOT NULL,
  schedule_type     TEXT    NOT NULL DEFAULT 'daily',
  schedule_hour     INTEGER NULL,
  schedule_minute   INTEGER NULL,
  interval_hours    INTEGER NULL,
  enabled           INTEGER NOT NULL DEFAULT 1,
  shuffle           INTEGER NOT NULL DEFAULT 1,
  platforms         TEXT    NOT NULL,
  poll_wifi         INTEGER NOT NULL DEFAULT 0,
  remembered_wifis  TEXT    NULL,
  targets           TEXT    NOT NULL,
  run_state         TEXT    NULL,
  last_run_at       TEXT    NULL,
  last_run_status   TEXT    NULL,
  next_run_at       TEXT    NULL,
  created_at        TEXT    NOT NULL,
  updated_at        TEXT    NULL,
  PRIMARY KEY (id)
);

CREATE INDEX IF NOT EXISTS idx_campaigns_next ON campaigns (next_run_at);
CREATE INDEX IF NOT EXISTS idx_campaigns_enabled ON campaigns (enabled);
