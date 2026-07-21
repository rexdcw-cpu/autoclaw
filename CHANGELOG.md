# Changelog

本文件记录 autoclaw 每个发布版本的变更。版本号遵循语义化版本（SemVer）。

---

## [0.3.3] — 2026-07-21

**里程碑**：WiFi 切换功能（原独立脚本整合进控制台）。

### 新增（Features）
- **WiFi 切换面板**：在 autoclaw 控制台内新增「WiFi 切换」卡片，复用本机无线网卡。
  - 后端 `core/wifiManager.js`：封装 `netsh wlan`，兼容中英文输出（`chcp 65001` 解决中文 SSID/标签乱码）；安全类型归一化（WPA2 个人→`WPA2PSK/AES`、WPA3→`WPA3SAE/AES`、WPA 个人→`WPAPSK`、开放→`open/none`，企业 802.1X 识别为不支持）；生成带 UTF-8 BOM 的 WLAN 配置 XML（对 SSID/密码做 XML 转义）；连接后轮询确认。
  - 路由 `routes/wifiRoutes.js`：`GET /api/wifi/list`（列可见网络+当前连接，只读）、`POST /api/wifi/connect`（`{ ssid, password }` 切换，secured 网络需密码），均经 `taskTokenAuth` 保护，沿用 `code/data/message` 信封。
  - 前端 `public/index.html` 新增卡片 + `public/js/wifi.js` 交互（拉列表 / 输密码 / 点击连接，复用 localStorage 令牌），`public/css/style.css` 补充 `.wifi-row` 样式。
  - 设计定位：作为手动切换出口 IP 的辅助手段（与 proxy 互补），不做任务级自动切网/回切。

### 测试（Tests）
- 新增 `test/wifiManager.test.js`（11 条）：覆盖中英文 `parseNetworks`、同名 SSID 去重、`normalizeSecurity` 各类型映射、`buildProfileXml` 合法片段与 XML 转义。全套 **233 用例 / 232 通过 / 1 skip** 全绿。



**里程碑**：proxy 代理入口端到端打通 + 运行日志两项优化（基于实跑日志分析）。

### 新增（Features）
- **代理（proxy）端到端可用（F-18 入口落地）**
  - `core/taskConfig.js` 新增 `sanitizeProxy`：兼容多种写法——字符串 URL（`'http://1.2.3.4:8080'`）、`{ server }`、`{ httpProxy }`、`{ proxy }`，统一归一化为 `{ httpProxy }`，并校验必须为 `http(s)://` 或 `socks(5)://`，非法格式抛 `ERR_INVALID_CONFIG`。空值（null/''/`{}`）视为不走代理。
  - 前端 `index.html` 增加「代理地址（可选）」输入框；`public/js/config.js` 提交时收集 `proxy` 字段、历史回填时还原。
  - 底层注入（`browserSession.launch` → Playwright `contextOptions.proxy = { server }`）此前已就绪，本次补齐归一化与前端入口后，从界面填代理即可真正走代理，实现多 IP 分散搜索风控。

### 修复（Fixes）
- **轮间停顿可调参**：`core/taskEngine.js` 的轮间 8–20s 随机停顿改为读 `AUTOCLAW_INTER_ROUND_MIN / AUTOCLAW_INTER_ROUND_MAX` 环境变量（默认不变），与项目其他拟人/策略参数风格一致。
- **运行日志 error 列误填**：`config/db.js` 的 `flattenEvent` 原先会把普通成功事件的 `message`（如 task_end「任务结束」）写入 `error` 列，导致 `WHERE error IS NOT NULL` 误判成功任务为失败。改为仅在事件显式携带 `error` 字段时才填充；`scripts/worker.js` 的 worker 异常事件补充 `error` 字段，保证异常仍能进 error 列。

### 测试
- `test/errorCode.test.js` 新增 2 条断言（成功 task_end 的 error 列必须为 null；worker 异常事件 error 列正确填充）。
- `test/taskConfig.test.js` 新增 7 条 proxy 归一化断言（字符串 / server / httpProxy / 空值 / 非法格式）。
- 全套：`node --test test/*.test.js` = **222 用例 / 221 通过 / 1 skip**。

---

## [0.3.1] — 2026-07-20

**里程碑**：实测基线发布——将 v0.3.0 之后的「默认搜索关键词」修正固化为正式版本，并记录最近一次实跑验证（任务 `a78e2545...`，百度 3 轮，145s，0 报错）。

### 修复（Fixes）
- **默认搜索关键词修正**：`core/taskConfig.js` 的默认关键词由旧值改为 `万年移民|万年移民公司|万年移民中介`（对应 `config/site.config.js` 的 `AUTOCLAW_TITLE_KEYWORDS` 默认值同步）。

### 验证
- **实跑验证**：任务 `a78e2545-d57a-4e74-9c01-21fa10039875`，百度 3 轮（r0/3 ~ r2/3）全部 success，总时长 145s，运行日志 `err=0`、无重试。
- **单元测试**：`node --test test/*.test.js` = **213 用例 / 212 通过 / 1 skip**（默认 mysql mock 路径；skip 为真实浏览器 e2e，需 `AUTOCLAW_REAL_BROWSER=1`）。
- **注**：运行日志分析显示 ~90% 耗时在防风控拟人/停留上，仅 ~10% 为真实导航；已识别 2 个 P1 优化项（轮间停顿硬编码、task_end 的 error 列误填），见后续版本。

---

## [0.3.0] — 2026-07-18

**里程碑**：流程拟人化增强——每个关键步骤之间插入「随机思考停顿 + 随机微动作」，降低被搜索引擎风控的概率。

### 新增（Features）
- **拟人微动作（humanize）**：在 search → locate → enter → stay → browse → close 各步骤之间，插入一次随机拟人微动作：
  - 随机思考停顿：`randInt(minMs, maxMs) + randInt(0, jitterAmp)`，每次随机、不可预测。
  - 三类微动作按权重随机触发（移动鼠标 / 滚轮轻推 / 悬停或按键），全部静默容错，绝不抛出、不影响主流程。
  - 进度看板新增 `human` 步骤（标签「拟人」），可见拟人节奏。
- **配置透传**：`core/taskConfig.js` 解析并浅合并 `payload.humanize`（enabled / minMs / maxMs / jitterAmp / moveProb / scrollProb / hoverProb / wheelAmp），默认值来自 `config/defaults.js` 的 `DEFAULT_HUMANIZE`（支持 `AUTOCLAW_HUMANIZE_*` 环境变量覆盖）。
- **前端**：`index.html` 增加「拟人微动作（步骤间）」配置块（启用开关 + 最短/最长停顿 ms）；`public/js/config.js` 读取并提交、历史回填。

### 测试
- 新增 `test/humanizer.test.js`（10 用例）：覆盖随机间隔边界、三类微动作分支、页面关闭/方法抛错的静默容错、enabled=false 早退、taskConfig 透传。
- 修复：`_humanInterstitial` 的停顿改为可覆盖的 `this._sleep()`（测试即时化），避免大量随机用例拖慢整文件。

### 验证
- `node --test test/*.test.js` = **213 用例 / 212 通过 / 1 skip**（skip 为真实浏览器 e2e，需 `AUTOCLAW_REAL_BROWSER=1`）。

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
