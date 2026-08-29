# autoclaw 安装部署手册（Agent 一键安装与测试指南）

> 适用对象：**在另一台电脑 / 服务器上接手本项目的 Agent（或新人）**。
> 读完本文件即可独立完成「克隆 → 安装 → 跑测试 → 启服务 → 排错」全流程。
> 配套脚本：`scripts/bootstrap.js`（跨平台一键安装+测试）。
>
> 📘 **环境装好之后怎么用？** → [USAGE-GUIDE.md](./USAGE-GUIDE.md)（日常操作 / 拉取更新 / 注意事项）。
> 本文件讲**安装部署**，那份讲**日常使用**，两者互补。

---

## 0. 项目速览

| 项 | 内容 |
|---|---|
| 是什么 | SEO 浏览器自动化控制台：在**百度 / 谷歌**对指定站点执行「拟人化、可循环」的搜索点击与站内浏览，配可视化进度看板 |
| 技术栈 | Node.js (Express) + socket.io + Playwright(Chrome) + 持久化（SQLite 本地 / MySQL 可选） |
| 端口 | 默认 `7788`，HTTP 控制台 + WebSocket 实时推送 |
| 默认令牌 | `AUTOCLAW_TOKEN=autoclaw-dev`（所有 `/api/task/*` 与 socket 事件鉴权用） |
| 仓库 | `https://github.com/rexdcw-cpu/autoclaw`（**需 GitHub 认证**，克隆/推送请准备 PAT；默认分支 `master`） |
| 当前版本 | 见 `package.json`（v0.3.60），`/api/status` 返回启动时缓存的 `version` |

其它权威文档（按需查阅，本手册是它们的「浓缩操作版」）：
- `README.md` — 架构、目录结构、API 速览、环境变量总表
- `docs/ACCESS-FAQ.md` — 访问 / 端口 / 反向代理排错（Windows↔WSL 旧服务清理）
- `docs/arch-autoclaw-stepwise.md` — 分步架构设计
- `CHANGELOG.md` — 版本变更（每个特性/修复都有记录）
- `docs/prd-*.md` — 需求文档（功能细节）

---

## 1. 环境要求

| 组件 | 要求 |
|---|---|
| Node.js | **≥ 18**（推荐 20 或 22，本地开发用 22.22.x） |
| 浏览器（运行服务时） | **Windows**：本机已装 Chrome（稳定版），走 `channel:'chrome'`，**无需** Playwright Chromium<br>**Linux 服务器 / 无桌面**：必须设无头模式，并装 Playwright Chromium（`npx playwright install chromium`）+ 系统库 |
| 数据库 | **本地测试用 SQLite，免装任何 DB 服务器**；需 MySQL 时才装并设 `AUTOCLAW_DB_TYPE=mysql` |
| 包管理 | `npm`（依赖已锁定在 `package-lock.json`） |

> ⚠️ **Windows 运行服务不需要 `npx playwright install chromium`**——它直接用本机 Chrome，弹真实可见窗口。
> 只有 Linux 无头服务器模式才需要 Chromium 二进制。

---

## 2. 一键安装与测试（给 Agent）

### 方式 A：跑脚本（推荐，零脑负担）

在仓库根目录执行：

```bash
# 自动检测 OS → npm install → 跑全量单元测试
node scripts/bootstrap.js
```

- 跨平台（Windows 用 `npm.cmd` / `npx.cmd`，Linux/macOS 用 `npm` / `npx`）。
- 单元测试**不需要浏览器、不需要数据库**：DB 相关用例 mock 了 mysql2，浏览器相关用例在缺真实环境时自动 skip。
- 想顺便为「无头服务器跑服务」准备 Chromium，加 `--with-browser`：
  ```bash
  node scripts/bootstrap.js --with-browser
  ```

成功标志：末尾打印 `全部单元测试通过 ✅` 且 `exit 0`。

### 方式 B：手动分步（等价于脚本）

```bash
# 1) 取代码（私有仓库需认证：用户名任意，密码填 GitHub PAT）
git clone https://github.com/rexdcw-cpu/autoclaw.git
cd autoclaw

# 2) 装依赖（含 express / socket.io / playwright / better-sqlite3 / mysql2，无需单独装浏览器）
npm install

# 3) （仅 Linux 无头服务器需要）装 Chromium + 系统库
#    npx playwright install chromium
#    sudo apt-get install -y libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 \
#      libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 \
#      libxrandr2 libgbm1 libpango-1.0-0 libcairo2 libasound2 libatspi2.0-0

# 4) 跑单元测试（关键：不要设 AUTOCLAW_DB_TYPE，见 §5 铁律）
node --test test/*.test.js
```

### 为什么测试能在「没浏览器 / 没数据库」的机器上跑通？

- `test/db.test.js` 等 DB 用例在 `mysql2` 上做了假打（interception），默认 `AUTOCLAW_DB_TYPE` 为 `mysql` 时它们 mock 掉连接；若你**错设成 sqlite**，它们会去碰真实 `better-sqlite3` 反而假红。
- `test/step1-boot.test.js` 等浏览器用例：未装 playwright 时整体 skip；真实浏览器端到端用例默认 skip，仅 `AUTOCLAW_REAL_BROWSER=1` 才开启。
- 因此**干净的 `node --test test/*.test.js`（不带任何 DB 环境变量）** 在任何机器上都应全绿。

---

## 3. 配置（环境变量）

复制 `.env.example` 为 `.env`（已被 `.gitignore` 忽略，勿提交）。核心变量：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `AUTOCLAW_TOKEN` | `autoclaw-dev` | 访问令牌（HTTP 头 `x-autoclaw-token` 或 `?token=`；socket `auth.token`） |
| `PORT` | `7788` | 监听端口 |
| `AUTOCLAW_DB_TYPE` | `mysql` ⚠️ | **持久化后端**：`sqlite`（本地免服务器，启动自动建表 `data/autoclaw.db`）/ `mysql`（连远程）。**本地测试务必显式设 `sqlite`** |
| `AUTOCLAW_SQLITE_PATH` | 空（默认 `data/autoclaw.db`） | 仅 sqlite 模式生效 |
| `AUTOCLAW_HEADLESS` | 关（设 `1`/`true` 开启） | **服务器无桌面 / root 容器必须设 `1`**，否则 Chrome 启动失败；同时自动追加 `--no-sandbox`/`--disable-setuid-sandbox`/`--disable-gpu` |
| `AUTOCLAW_CHROME_PATH` | 空（自动探测） | 可选，指定本机 Chrome 可执行文件路径 |
| `AUTOCLAW_DB_HOST` / `_PORT` / `_USER` / `_PASSWORD` / `_NAME` / `_LIMIT` | `localhost`/`3306`/`root`/`''`/`autoclaw`/`10` | 仅 `mysql` 模式生效 |
| `AUTOCLAW_GOOGLE_NODE_RETRIES` | `2` | 谷歌单节点失败后节点内重试次数 |
| `AUTOCLAW_GOOGLE_ACTION_TIMEOUT` | `60000` | 谷歌单动作超时(ms)；百度仍用全局 `AUTOCLAW_ACTION_TIMEOUT`(150000) |
| `AUTOCLAW_GOOGLE_PERSIST_PROFILE` | 关（设 `1` 开启） | 谷歌阶段复用固定 `data/google-profile` 建身份、降验证码；每台机器独立、含登录态、**不入库**、渐进生效 |
| `AUTOCLAW_GOOGLE_AVOID_HOT_NODES` | `1`（开启） | 谷歌软降权高标记共享 VPN 节点（如热门 GPT 出口），移到节点池末尾；设 `0` 关闭 |
| `AUTOCLAW_GOOGLE_AVOID_NODE_PATTERN` | `/GPT/i` | 软降权匹配正则，可被自定义覆盖 |
| 拟人/策略（`AUTOCLAW_STAY_SECONDS` 等、`AUTOCLAW_MODE`/`_FAIL_RATE`/`_MAX_RETRY`/`_ACTION_TIMEOUT`） | 见 `config/defaults.js` | 覆盖默认拟人参数与熔断策略 |

---

## 4. 启动服务

### 4.1 Windows（本机可见窗口，开箱即用）

双击 `start-win.bat`（已内置 `AUTOCLAW_DB_TYPE=sqlite` + 默认令牌），或：

```bat
set AUTOCLAW_TOKEN=autoclaw-dev
set AUTOCLAW_DB_TYPE=sqlite
node app.js
```

启动后访问 `http://localhost:7788` 打开配置控制台；提交任务后 Chrome 弹出真实窗口，桌面实时可见搜索/点击/浏览过程。

### 4.2 Linux / WSL 无头服务器（远程部署）

```bash
# 必须：无头 + 系统库 + Chromium（见 §1）。用 SQLite 免数据库服务器：
AUTOCLAW_DB_TYPE=sqlite AUTOCLAW_HEADLESS=1 AUTOCLAW_TOKEN=autoclaw-dev PORT=7788 \
  nohup node app.js > logs/app.log 2>&1 &

# 健康检查（不鉴权）
curl -s http://127.0.0.1:7788/api/status
# → {"code":0,"data":{"service":"autoclaw","version":"...","status":null},"message":"ok"}
```

> 生产若用 MySQL：`AUTOCLAW_DB_TYPE=mysql` 并先执行 `scripts/schema.sql`（MySQL）或 `scripts/schema.sqlite.sql`（SQLite 参考）。

### 4.3 本地调试（任何带桌面的机器）

```bash
AUTOCLAW_DB_TYPE=sqlite AUTOCLAW_TOKEN=autoclaw-dev PORT=7788 node app.js
```

### 4.4 重启铁律（本机）

- **本机/单机无 MySQL：启动必须带 `AUTOCLAW_DB_TYPE=sqlite`**，否则默认走 `mysql` 连 `localhost:3306` 导致任务落库 `ECONNREFUSED` 全败。
- 杀 7788 进程后重启（PowerShell）：
  ```powershell
  Stop-Process -Id <pid> -Force   # 用 Get-Process -Id 找监听 7788 的 node
  # 或按端口：Get-NetTCPConnection -LocalPort 7788 | Select-Object OwningProcess
  ```
  > 注意：PowerShell 里 `taskkill //PID` 双斜杠无效，用单斜杠或 `Stop-Process`。

### 4.5 Windows 开机自启与崩溃自愈（可选）

`start-win.bat` 是**前台**运行（关窗即停）。若需长期驻留，用守护模式：

| 文件 | 作用 |
|---|---|
| `autostart-guardian.js` | 守护进程：拉起 `app.js`，子进程退出后约 10 秒自动重启；单实例锁在 `data/guardian.lock` |
| `autostart-autoclaw.bat` | 手动入口（可见窗口），以守护模式启动 |
| `Startup\autoclaw-autostart.vbs` | 开机自启（隐藏窗口，登录触发）——**每台机器需单独配置，不随仓库走** |

**重启服务的正确姿势（重要）**：
- 改了后端代码 → 只杀 `app.js` 子进程（按端口找 PID），**守护会在约 10 秒后自动用新代码拉起**。
  不要手动 `Start-Process node app.js`，否则会和守护抢 7788 端口。
  ```powershell
  netstat -ano | Select-String ":7788.*LISTENING"   # 取最后一列 PID
  Stop-Process -Id <pid> -Force
  ```
- **彻底停服务**：先杀守护父进程（`data/guardian.lock` 里记的 pid），再杀子进程——只杀子进程会被自动拉回。
- 「停止所有任务」≠ 杀服务：调 `GET /api/task/status` 取 `activeTaskId` → `POST /api/task/stop {taskId}`，
  worker 退出后运行槽释放，服务照常运行。

> GUI 限制：非交互会话（如某些自动化环境）**无法代替用户启动桌面程序**，
> 故每个新的登录会话至少需要人工双击一次 `autostart-autoclaw.bat`，之后靠守护自愈即可。

---

## 5. 代码开发注意事项（踩坑清单）

1. **🔴 DB_TYPE 运行 vs 单测「相反」铁律**
   - **运行服务**：本地无 MySQL → 必须 `AUTOCLAW_DB_TYPE=sqlite`（否则 `ECONNREFUSED 127.0.0.1:3306`）。
   - **跑单测**：**必须不设** `AUTOCLAW_DB_TYPE`（默认 mysql，db 用例假打 mysql2 拦截；错设 sqlite 会走真实 better-sqlite3 假红）。

2. **🔴 单测命令**：`node --test test/*.test.js`，**不带任何 DB 环境变量**。全量应全绿（部分用例在缺浏览器/DB 时优雅 skip）。单文件调试：`node --test test/xxx.test.js`。

3. **🔴 HEADLESS 铁律**：无桌面服务器必须 `AUTOCLAW_HEADLESS=1`，否则 `chromium.launchPersistentContext` 失败（`ERR_BROWSER_LAUNCH`）。无头模式自动加 `--no-sandbox` 等，兼容 root 容器。

4. **谷歌持久 profile（`AUTOCLAW_GOOGLE_PERSIST_PROFILE=1`）**：复用 `data/google-profile` 累积 cookie 降验证码；**每台机器独立、含登录态，已在 `.gitignore` 排除、勿入库**；多实例并行勿共享同目录（锁竞争）；效果随 cookie 累积**渐进显现**（首次接近空身份）。

5. **谷歌节点排序：地域偏好 > 软降权**（v0.3.60 起）
   - 软降权（默认开）：把热门共享出口（名含 `GPT`）挪到节点池末尾，设 `AUTOCLAW_GOOGLE_AVOID_HOT_NODES=0` 关闭。
   - **地域节点偏好优先**：在批量任务的站点卡片填「地域节点偏好」（如 `TW|HK`，`|` 分隔、留空不限），
     命中该地区的节点会被**提到最前并豁免软降权**——否则会出现「节点地域明明对，却被降权排到末尾、
     还没轮到就触发连续失败止损」的死局。
   - ⚠️ 该配置落在**数据库**（`campaigns.targets[].preferredNodes`），换机器不会迁移，需重新配置。

6. **谷歌验证码需人工过码**：极少数触发「异常流量验证拦截」时，程序在弹出的 Chrome 窗口等待，请在可见窗口内手动完成验证，检测通过自动继续（提示已降噪，每节点至多一次）。

7. **运行数据不入库**：`data/google-profile/`、`data/*.db`、`data/task-stats-*.{json,md}`、`data/*.log`（worker/守护落盘日志）、`data/guardian.lock`、`logs/*.log` 等都是运行产物，已 `.gitignore` 排除，勿提交。

   > **换机器 = 空库起步**：数据库不随仓库迁移。新机器首次启动会自动建表（schema 幂等），
   > 但**所有批量任务（campaign）、任务历史、地域偏好配置都不会带过去，必须重建**。
   > 如需搬运配置，先手工导出 `campaigns` 表的 `targets` 字段再在新库导入。

8. **前端静态资源不缓存**：`app.js` 对 `public/` 强制 `no-cache`。改了前端 JS（尤其 WiFi 面板 `wifi.js`）后**必须硬刷新（Ctrl/Cmd+Shift+R）**，否则一直跑旧逻辑。

9. **平台适配器隔离**：百度 / 谷歌是两套独立 `core/adapters/*Adapter.js`，配置与运行时**不混用**（用户强约束）。谷歌强依赖 Mihomo 内核监听 `127.0.0.1:7890` 作出口，百度走本机 IP。

10. **单活跃任务**：运行中收到新提交返回 **HTTP 409 `ERR_TASK_RUNNING`**；无「断点续跑」，熔断后仅「重新提交」。

11. **错误码约定**：`ERR_INVALID_CONFIG` / `ERR_NO_TARGET` / `ERR_ADAPTER_FAIL` / `ERR_TIMEOUT` / `ERR_RETRY_EXHAUSTED` / `ERR_BROWSER_LAUNCH` / `ERR_TASK_NOT_FOUND` / `ERR_TASK_RUNNING` / `ERR_DB_WRITE` / `ERR_DB_QUERY`（见 `core/progressEvent.js`）。

12. **API 响应信封**：统一 `{ code:0, data:{}, message:'ok' }`，非 0 即错误。

---

## 6. 排错 FAQ（速查）

| 现象 | 根因 | 解决 |
|---|---|---|
| 提交任务落库全败，`ECONNREFUSED 127.0.0.1:3306` | 启动没带 `AUTOCLAW_DB_TYPE=sqlite`，默认走 mysql | 带 `AUTOCLAW_DB_TYPE=sqlite` 重启 |
| `ERR_BROWSER_LAUNCH` / Chrome 启动失败 | 服务器无桌面却没设 `AUTOCLAW_HEADLESS=1`；或 Chromium 未装/系统库缺失 | 设 `HEADLESS=1` + `npx playwright install chromium` + 装系统库 |
| 访问 `http://域名/`（不带 `:7788`）报找不到浏览器(Linux 路径) | 命中旧 WSL 服务转发，而非新服务 | 带端口 `:7788` 访问；或清理旧服务（见 `docs/ACCESS-FAQ.md` 的 `scripts/kill-old-service.bat` / `enable-port80.bat`） |
| 谷歌任务全败 / 卡验证码 | 出口被限流 或 触发验证拦截 | 切节点 / 开持久 profile 降权；验证码窗口内手动过码 |
| 🔴 **所有谷歌站点同一天起集体「定位不到目标」，报「N 页均未解析到任何外链」** | **SERP 链接格式变化**——不是站点/关键词/节点问题。2026-08 起 Google 把结果链接从 `/url?q=<明文>` 改为 `/goto?url=<加密串>`，旧解码逻辑全部落空（本项目已修复于 v0.3.60） | **先做影响面判断**：按天统计各任务的 locate 成功数，若多站点同时集体归零 → 全局解析故障，去查 `core/adapters/googleAdapter.js` 的链接解码（`_decodeGoogleRedirect` / `matchUrl`）；若仅单站归零 → 才是关键词/排名问题 |
| 排错时被「页面片段」误导 | 报错里的页面片段取自 `document.body.innerText`，**不等于搜索结果**——解析异常时会混入 AI 概览/相关推荐 | 片段里出现无关内容时，先怀疑解析链路（选择器命中数、href 形式），**不要**据此推断地域或排名 |
| 任务失败率 >30% 被熔断 | 正常熔断策略（A4） | 看 `logs/` 与 `data/task-stats-*.md` 定位；重新提交 |
| 改了前端没生效 | 浏览器用了旧 JS | 硬刷新（Ctrl/Cmd+Shift+R） |

> 更多访问/端口/代理排错见 `docs/ACCESS-FAQ.md`。

---

## 7. 测试命令参考

```bash
# 全量单元（不带 DB 变量，应全绿）
node --test test/*.test.js

# 单文件
node --test test/wifiPoll.test.js

# 真实浏览器端到端（默认 skip，需本机 Chrome + 桌面会话，且不能 nohup 脱离桌面）
AUTOCLAW_REAL_BROWSER=1 node --test test/step1-boot.test.js

# 启动后冒烟：验证「浏览器能起 + 能拿到可操作 page」（需桌面/Chrome）
node scripts/smoke-launch.js
```

---

## 8. 目录结构与关键文件

```
autoclaw/
├── app.js                  # 主进程入口：Express + socket.io + A3 鉴权
├── package.json            # 依赖与版本（v0.3.60）
├── start-win.bat           # Windows 一键启动（前台，内置 sqlite）
├── autostart-guardian.js   # 守护进程：崩溃/退出后约 10 秒自动拉起 app.js
├── autostart-autoclaw.bat  # 守护模式手动入口（可见窗口）
├── scripts/
│   ├── bootstrap.js        # ★ 跨平台一键安装+测试（本手册配套）
│   ├── smoke-launch.js     # 浏览器启动冒烟验证
│   ├── schema.sql          # MySQL 建表 DDL
│   ├── schema.sqlite.sql   # SQLite 建表参考
│   ├── worker.js           # worker 子进程（Playwright 执行；谷歌节点池排序在此）
│   └── kill-old-service.bat / enable-port80.bat / diagnose.bat  # Windows 排错
├── config/  (db.js 双后端 / defaults.js 拟人参数 / site.config.js 默认站点)
├── core/    (scheduler 批量任务调度 / taskManager / taskEngine / browserSession /
│            vpnController / taskConfig / adapters/{baidu,google}Adapter.js)
├── routes/  (taskRoutes / clientRoutes / wifiRoutes / schedulerRoutes 批量任务)
├── public/  (index.html 配置页 / campaigns.html 批量任务页 / progress.html 看板页 / css+js)
├── test/    (24+ 单元测试，缺浏览器/DB 时优雅 skip)
└── docs/    (ACCESS-FAQ / arch / prd)
```

---

## 9. 新机器起步检查清单（换机/交接时对照）

按顺序勾完即可开跑：

- [ ] `git clone` + `npm install`（私有仓库需 PAT）
- [ ] `node scripts/bootstrap.js` 跑通（末尾 `全部单元测试通过 ✅`）
- [ ] 复制 `.env.example` → `.env`，确认 `AUTOCLAW_DB_TYPE=sqlite`
- [ ] 起服务后 `curl -s http://127.0.0.1:7788/api/status` 返回 `{"code":0,...}`
- [ ] 打开 `http://localhost:7788` 能进控制台
- [ ] **恢复历史数据**：若仓库里带了 `data/seed/autoclaw-dump.sql`，执行 `node scripts/import-db.js`
      即可还原全部批量任务、地域偏好与运行日志（详见 USAGE-GUIDE §8）；
      没有该文件才需要手工重建 campaign（**换机前应在旧机器先跑 `node scripts/export-db.js`**）
- [ ] 若跑谷歌任务：确认 Mihomo 内核在跑、`127.0.0.1:7890` 已监听
- [ ] 若需长期驻留：配 `Startup\autoclaw-autostart.vbs` 或手动跑 `autostart-autoclaw.bat`
- [ ] 若需 Windows 可见 Chrome 过验证码：确保服务启动在**桌面登录会话**内，不是后台 Session 0

---

**一句话上手**：`git clone` → `node scripts/bootstrap.js`（装依赖+跑测试）→ Windows 双击 `start-win.bat`（或 Linux `AUTOCLAW_DB_TYPE=sqlite AUTOCLAW_HEADLESS=1 node app.js`）→ 开 `http://localhost:7788` → 按 §9 重建批量任务。
