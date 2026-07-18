-- ===========================================================================
-- autoclaw · MySQL 建表脚本（增量架构 v0.2 §3）
-- ---------------------------------------------------------------------------
-- 引擎：InnoDB；字符集：utf8mb4（含 utf8mb4_unicode_ci，支持中文与 emoji）。
-- JSON 列不声明 DEFAULT（MySQL 对 JSON 默认值支持受限），INSERT 时始终显式提供。
-- 部署侧在独立的 `autoclaw` 库执行一次：mysql -u<user> -p autoclaw < schema.sql
-- ===========================================================================

CREATE TABLE IF NOT EXISTS task_config (
  task_id            VARCHAR(36)   NOT NULL COMMENT 'crypto.randomUUID() 唯一',
  platforms          JSON          NOT NULL COMMENT '["baidu","google"]',
  keywords           JSON          NOT NULL COMMENT '拆分后关键词数组',
  target_domain      VARCHAR(255)  NOT NULL COMMENT 'A1 targetDomain',
  title_keywords     JSON          NOT NULL COMMENT 'A1 标题关键词数组',
  stay_seconds       INT           NOT NULL DEFAULT 15,
  scroll_up          INT           NOT NULL DEFAULT 3,
  scroll_down        INT           NOT NULL DEFAULT 3,
  amp_min            INT           NOT NULL DEFAULT 300,
  amp_max            INT           NOT NULL DEFAULT 800,
  interval_min       DECIMAL(4,2)  NOT NULL DEFAULT 1.00,
  interval_max       DECIMAL(4,2)  NOT NULL DEFAULT 2.00,
  run_mode           VARCHAR(16)   NOT NULL DEFAULT 'serial' COMMENT 'serial/concurrent',
  fail_rate_threshold DECIMAL(5,3) NOT NULL DEFAULT 0.300 COMMENT 'A4 熔断阈值',
  max_retry          INT           NOT NULL DEFAULT 2,
  action_timeout_ms  INT           NOT NULL DEFAULT 30000,
  status             VARCHAR(16)   NOT NULL DEFAULT 'pending' COMMENT 'TaskStatus',
  operator           VARCHAR(64)   NULL DEFAULT NULL COMMENT '关联 AUTOCLAW_TOKEN（V1 单 token 视角，仅作标签）',
  proxy_json         JSON          NULL DEFAULT NULL COMMENT 'F-18 预留，V1 存 NULL',
  created_at         DATETIME      NOT NULL COMMENT '提交时间(UTC)',
  updated_at         DATETIME      NULL DEFAULT NULL COMMENT '状态变更时更新',
  PRIMARY KEY (task_id),
  KEY idx_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS task_run_log (
  id            BIGINT        NOT NULL AUTO_INCREMENT,
  task_id       VARCHAR(36)   NOT NULL,
  round         INT           NULL DEFAULT NULL COMMENT 'RoundState.roundIndex',
  total_rounds  INT           NULL DEFAULT NULL COMMENT '冗余便于统计',
  platform      VARCHAR(16)   NULL DEFAULT NULL COMMENT 'baidu/google',
  keyword       VARCHAR(255)  NULL DEFAULT NULL COMMENT '当轮关键词',
  step          VARCHAR(16)   NULL DEFAULT NULL COMMENT 'StepName: search/locate/enter/stay/browse/close',
  step_status   VARCHAR(16)   NULL DEFAULT NULL COMMENT 'StepStatus: running/success/failed（仅 step 事件有）',
  event_type    VARCHAR(16)   NULL DEFAULT NULL COMMENT 'EventType: round_start/step/round_end/task_end/paused/stopped/alert',
  message       TEXT          NULL,
  error         TEXT          NULL COMMENT '失败详情（step 失败取 detail，轮/任务失败取原因）',
  timestamp     DATETIME      NOT NULL COMMENT '映射 ProgressEvent.timestamp (UTC)',
  error_code    VARCHAR(64)   NULL DEFAULT NULL COMMENT 'T0 对齐：结构化错误码（ERR_BROWSER_LAUNCH/ERR_BAIDU_CAPTCHA…，由 step.code 写入）',
  PRIMARY KEY (id),
  KEY idx_task_id (task_id),
  KEY idx_task_round (task_id, round),
  KEY idx_task_ts (task_id, timestamp)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 客户档案（V2 客户线 P0-8 ~ P0-11）
CREATE TABLE IF NOT EXISTS client (
  client_id   VARCHAR(36)   NOT NULL,
  name        VARCHAR(255)  NOT NULL,
  contact     VARCHAR(255)  NULL DEFAULT NULL,
  notes       TEXT          NULL,
  created_at  DATETIME      NOT NULL,
  updated_at  DATETIME      NULL DEFAULT NULL,
  PRIMARY KEY (client_id),
  KEY idx_client_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- task_config 增加客户外键列（迁移用；新库建表时可直接并入建表语句）
ALTER TABLE task_config ADD COLUMN client_id VARCHAR(36) NULL DEFAULT NULL COMMENT 'FK -> client.client_id（V2 客户线）';
