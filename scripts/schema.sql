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
  seq                INT           NULL DEFAULT NULL COMMENT '自增展示编号（应用层 SELECT MAX+1 写入，不改主键）',
  PRIMARY KEY (task_id),
  KEY idx_created (created_at),
  UNIQUE KEY uk_seq (seq)
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

-- 批量定时任务（campaign）：一组网站目标 + 调度 + 打乱开关。
-- 时间字段以 epoch 毫秒（BIGINT）存储，便于调度器直接比较、规避时区问题。
CREATE TABLE IF NOT EXISTS campaigns (
  id                VARCHAR(36)   NOT NULL,
  name              VARCHAR(255)  NOT NULL,
  schedule_type     VARCHAR(16)   NOT NULL DEFAULT 'daily' COMMENT 'daily | interval',
  schedule_hour     INT           NULL DEFAULT NULL,
  schedule_minute   INT           NULL DEFAULT NULL,
  interval_hours    INT           NULL DEFAULT NULL,
  enabled           TINYINT       NOT NULL DEFAULT 1,
  shuffle           TINYINT       NOT NULL DEFAULT 1,
  platforms         JSON          NOT NULL COMMENT '["baidu","google"]',
  poll_wifi         TINYINT       NOT NULL DEFAULT 0,
  remembered_wifis  JSON          NULL DEFAULT NULL COMMENT '面板「已存」SSID 数组',
  targets           JSON          NOT NULL COMMENT '[{name,domain,titleKeywords,keywords,clientId?}]',
  run_state         JSON          NULL DEFAULT NULL COMMENT '运行态快照',
  last_run_at       BIGINT        NULL DEFAULT NULL COMMENT 'epoch ms',
  last_run_status   VARCHAR(16)   NULL DEFAULT NULL COMMENT 'done | partial | aborted | error',
  next_run_at       BIGINT        NULL DEFAULT NULL COMMENT 'epoch ms',
  created_at        DATETIME      NOT NULL,
  updated_at        DATETIME      NULL DEFAULT NULL,
  PRIMARY KEY (id),
  KEY idx_campaigns_next (next_run_at),
  KEY idx_campaigns_enabled (enabled)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 批量任务「每轮执行」历史表（可审计）：每一轮 campaign 跑一次写一条，
-- 记录起止时间、站点总数/已完成数、终态与中止原因。与 run_state（仅存当前轮、
-- 重启即清）互补，使每轮整体执行情况可长期留存与复盘。
CREATE TABLE IF NOT EXISTS campaign_runs (
  run_id         VARCHAR(36)   NOT NULL,
  campaign_id    VARCHAR(36)   NOT NULL,
  campaign_name  VARCHAR(255)  NULL,
  started_at     BIGINT        NOT NULL,
  finished_at    BIGINT        NULL,
  total_sites    INT           NOT NULL DEFAULT 0,
  done_sites     INT           NOT NULL DEFAULT 0,
  status         VARCHAR(16)   NOT NULL DEFAULT 'running',
  abort_reason   VARCHAR(255)  NULL,
  created_at     DATETIME      NOT NULL,
  PRIMARY KEY (run_id),
  KEY idx_campaign_runs_campaign (campaign_id, started_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
