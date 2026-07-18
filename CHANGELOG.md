# Changelog

本文件记录 autoclaw 每个发布版本的变更。版本号遵循语义化版本（SemVer）。

---

## [0.2.0] — 2026-07-18

**里程碑**：客户线（P0-8~P0-11）完整落地 + BROWSE 站内锚点相对路径修复（端到端验证通过）。

### 新增（Features）
- **客户线（P0-8~P0-11）**
  - 数据层：`client` 表 + `task_config.client_id` 列（sqlite / mysql 双后端，含幂等迁移）。
  - 路由：`routes/clientRoutes.js` 挂载 `/api/client`，含 list / create / get / update / delete / stats / report（report 支持 markdown / csv / html 三种导出），复用 `x-autoclaw-token` 鉴权。
  - 配置层：`core/taskConfig.js` 透传 `clientId` / `client_id`，任务归属客户。
  - 前端：`index.html` 增加「归属客户」下拉 + 「客户管理」面板；`public/js/config.js` 拉取客户列表、提交携带 clientId、增删客户。
  - 错误码：新增 `ERR_CLIENT_NOT_FOUND`、`ERR_CLIENT_HAS_TASKS`（删除有关联任务的客户时拒删 → 409）。
- **测试**：新增 `test/clientRoutes.test.js`、`test/clientData.test.js`、`test/browseRelativeLink.test.js`。

### 修复（Fixes）
- **BROWSE 站内锚点相对路径解析（T-6）**
  - 根因：导航栏链接为相对路径（如 `href="about.html"`），原 `_findContactLink` 只处理 `/` 绝对路径与完整 `http(s)://` URL，相对路径被忽略 → 返回 `null` → BROWSE 软失败（日志显示「候选链接：关于万年」却找不到）。
  - 修复：`core/taskEngine.js` 改用 `new URL(href, base.href)` 统一解析 `/about.html`、相对路径、完整 URL；过滤 `#` / `javascript:` / `mailto:` / `tel:` / `data:` 伪链接；`_collectLinkDiag` 同时输出链接文本与解析后的 URL，便于排查。

### 验证
- **端到端实测**：任务 `8843780e-1b88-4806-be63-70565a7507c3`，关键词 `[万年移民, 万年移民公司, 万年移民中介]` 打 `manincorp.cn`，3 轮 `search→locate→enter→stay→browse→close` **全部 success**，browse 修复确认生效。
- **单元测试**：`node --test test/*.test.js` = **203 用例 / 202 通过 / 1 skip**（skip 为真实浏览器 e2e，需 `AUTOCLAW_REAL_BROWSER=1`）。

### 文档
- `docs/prd-autoclaw-handoff.md`：§4.3 目录树补 `routes/clientRoutes.js`；§4.6 API 表补 `/api/client/*`；§7.2 新增 T-6；§10 第 10 条修正说明；§6 / §8 / §9 同步版本与测试计数。

---

## [0.1.0] — 2026-07-18（基线）

- 初始交付：Express + socket.io + Playwright 复用本机 Chrome 的 SEO 浏览器自动化控制台。
- 平台适配器：Baidu（已实现）、Google（代码就位，需 VPN 实测）。
- 任务引擎：search / locate / enter / stay / browse / close 六步流水线，串行/并行模式，熔断与重试。
- 持久化：MySQL / SQLite 双后端，任务配置 + 运行日志落库，实时进度看板。
- 单元测试：155 基线用例（接手时），后续随修复增长。
