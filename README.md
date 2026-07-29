# autoclaw · SEO 浏览器自动化控制台

面向 SEO 运营/流量操盘手的浏览器自动化工具：在百度、谷歌等搜索引擎中对指定站点执行
「拟人化、可循环」的搜索点击与站内浏览，并通过可视化进度看板实时监控每一轮动作的成功/失败状态。

> 技术底座：Node.js (Express) + socket.io + Playwright (真实 Chromium)。
> 纯原生前端（HTML/CSS/JS），无构建步骤。WSL 宝塔部署，端口 7788，域名 http://test.autoclaw.com（Nginx 80→7788 反代）。

---

## 架构概览

```
浏览器/前端 (原生JS)
   │  POST /api/task/submit (x-autoclaw-token)
   ▼
Express 主进程 (app.js)
   ├─ /api/task/* 路由 (routes/taskRoutes.js, A3 鉴权中间件保护)
   ├─ socket.io 实时推送 (progress / task:state / alert)
   └─ TaskManager (core/taskManager.js)  ──fork──►  worker 子进程 (scripts/worker.js)
                                                    └─ TaskEngine (core/taskEngine.js)
                                                         ├─ BrowserSession (core/browserSession.js, Playwright)
                                                         └─ PlatformAdapter: baidu / google (core/adapters/*)
```

- **主进程**负责 HTTP/WS 与任务生命周期；**worker 子进程**负责 Playwright 实际执行，不阻塞 Web 请求。
- **单活跃任务**（决策 A2）：运行中收到新提交返回 HTTP 409 `ERR_TASK_RUNNING`。
- **简单令牌鉴权**（决策 A3）：所有 `/api/task/*` 与 socket `task:join` 需携带 `x-autoclaw-token` 头或 `?token=` 参数，对照环境变量 `AUTOCLAW_TOKEN`（默认 `autoclaw-dev`）。
- **熔断**（决策 A4）：任务失败率 > 30% 自动暂停 + 告警 + 置为终态（`failed`/熔断），前端仅展示告警与「重新提交」入口，无「继续」按钮、无断点续跑。
- **目标站点**（决策 A1）：`targetDomain` + `titleKeywords` 为必填表单字段，表单为唯一数据源；`config/site.config.js` 仅作表单预填默认值。

### 目录结构

```
autoclaw/
├── app.js                      # 主进程入口：Express + socket.io + 鉴权
├── package.json
├── start-win.bat              # Windows 原生启动脚本（设环境变量后 node app.js，T-D5）
├── config/
│   ├── site.config.js          # 默认目标站点 + 透出 anthropic/strategy 默认值
│   ├── defaults.js             # 拟人参数 / 策略默认值（支持 AUTOCLAW_ 环境变量覆盖）
│   └── db.js                   # 持久化层（双后端：MySQL 默认 / SQLite 本地免服务器）+ 运行日志缓冲（T-D1）
├── core/
│   ├── taskConfig.js           # 配置解析校验 + 关键词拆分 + RoundPlan 生成
│   ├── taskManager.js          # 主进程任务管理：fork/暂停/停止/进度/转发
│   ├── taskEngine.js           # worker 内轮次循环 + 容错 + 熔断 + 拟人动作
│   ├── browserSession.js       # Playwright 浏览器/上下文生命周期
│   ├── progressEvent.js        # ProgressEvent 构造 + 事件/状态/错误码常量
│   └── adapters/
│       ├── platformAdapter.js  # 抽象基类 + 双匹配/重定向解析工具
│       ├── baiduAdapter.js
│       └── googleAdapter.js
├── routes/
│   └── taskRoutes.js           # /api/task/{submit,progress,pause,stop,status}
├── scripts/
│   ├── worker.js               # worker 子进程入口（IPC ↔ TaskEngine）
│   ├── schema.sql              # 建表 DDL：task_config / task_run_log（T-D1）
│   └── screenshot.js           # Playwright 示例，保留参考
├── public/
│   ├── index.html              # 任务配置表单页
│   ├── progress.html           # 进度看板页
│   ├── css/style.css
│   └── js/{config.js,progress.js}
├── logs/                       # 任务日志（task-{taskId}.log 预留）
└── data/                       # 任务历史/模板预留
```

### 关键约定

| 项目 | 约定 |
|------|------|
| 配置命名 | `staySeconds` `scrollUp` `scrollDown` `ampMin` `ampMax` `intervalMin` `intervalMax`；`mode` `failRateThreshold`(0.3) `maxRetry`(2) `actionTimeoutMs`(30000)；`targetDomain` `titleKeywords[]` |
| API 响应信封 | `{ code: 0, data: {}, message: 'ok' }`，非 0 即错误 |
| socket 事件 | 客户端→服务端：`task:join` / `task:pause` / `task:stop`；服务端→客户端：`progress` / `task:state` / `alert`；房间 = taskId |
| 双匹配（Q3/A1） | 结果前 10 条中，标题含任一 `titleKeywords` 且真实地址含 `targetDomain`，取首个 |
| 站内「联系/关于」(Q4) | 链接文本含 联系/关于/contact/about 或 URL 路径含 /contact、/about、/about-us，取首个 |
| 容错（Q6） | 单动作重试 2 次、超时 30s；单轮失败跳过继续；失败率 >30% 熔断 |
| 错误码 | `ERR_INVALID_CONFIG` `ERR_NO_TARGET` `ERR_ADAPTER_FAIL` `ERR_TIMEOUT` `ERR_RETRY_EXHAUSTED` `ERR_BROWSER_LAUNCH` `ERR_TASK_NOT_FOUND` `ERR_TASK_RUNNING` `ERR_DB_WRITE` `ERR_DB_QUERY` |

---

## 本地 / WSL 安装与运行

```bash
# 1. 安装依赖
npm install

# 2. 安装 Playwright 的 Chromium 浏览器二进制（必需！）
npx playwright install chromium

# 3.（WSL/宝塔）安装 Chromium 运行所需系统库
#    缺失 libnss3 等会在 launch 时报 Failed to launch chromium 错误。
#    以 Debian/Ubuntu 为例：
sudo apt-get update
sudo apt-get install -y libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 \
  libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 \
  libxrandr2 libgbm1 libpango-1.0-0 libcairo2 libasound2 libatspi2.0-0

# 4. 配置令牌（可选，默认 autoclaw-dev）
export AUTOCLAW_TOKEN=your-secret-token
export PORT=7788

# 5. 启动（⚠️ 本机/单机无 MySQL 时务必带 AUTOCLAW_DB_TYPE=sqlite，否则默认 mysql 会连 localhost:3306 失败）
AUTOCLAW_DB_TYPE=sqlite AUTOCLAW_TOKEN=autoclaw-dev PORT=7788 node app.js
# 或（进程保活）setsid nohup env AUTOCLAW_DB_TYPE=sqlite AUTOCLAW_TOKEN=autoclaw-dev PORT=7788 node app.js > logs/app.log 2>&1 &
```

> 说明：生产部署沿用现有 `start.sh`（`setsid + nohup` 保活）与 `ecosystem.config.js`（PM2）。
> `start.sh` 建议在执行 `node app.js` 前补一步 `npx playwright install chromium`。

### 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `AUTOCLAW_TOKEN` | `autoclaw-dev` | 访问令牌（决策 A3） |
| `PORT` | `7788` | 监听端口 |
| `AUTOCLAW_TARGET_DOMAIN` | `manincorp.cn` | 默认目标域名（表单预填） |
| `AUTOCLAW_TITLE_KEYWORDS` | `万年移民` | 默认标题关键词（表单预填） |
| `AUTOCLAW_STAY_SECONDS` / `_SCROLL_UP` / `_SCROLL_DOWN` / `_AMP_MIN` / `_AMP_MAX` / `_INTERVAL_MIN` / `_INTERVAL_MAX` | 见 `config/defaults.js` | 拟人参数覆盖 |
| `AUTOCLAW_MODE` / `_FAIL_RATE` / `_MAX_RETRY` / `_ACTION_TIMEOUT` | `serial` / `0.3` / `2` / `30000` | 策略参数覆盖 |
| `AUTOCLAW_GOOGLE_NODE_RETRIES` | `2` | 谷歌单节点失败后节点内重试次数（最多 1+重试 次尝试），救回 VPN 瞬时抖动 / 解析失败 |
| `AUTOCLAW_GOOGLE_ACTION_TIMEOUT` | `60000` | 谷歌单动作超时（毫秒）；百度仍用全局 `AUTOCLAW_ACTION_TIMEOUT`(150000)，谷歌单独降超时避免单动作卡死拖垮整体 |
| `AUTOCLAW_GOOGLE_PERSIST_PROFILE` | 关（设 `1` 开启） | 谷歌阶段复用固定 `data/google-profile` 累积 cookie / 浏览历史，建身份显著降低机器人验证触发（首次空身份、随运行渐进生效） |
| `AUTOCLAW_GOOGLE_AVOID_HOT_NODES` | `1`（开启） | 谷歌软降权高标记共享 VPN 节点（如热门 GPT 出口），将其移到节点池末尾、优先用低标记节点；设 `0` 关闭 |
| `AUTOCLAW_GOOGLE_AVOID_NODE_PATTERN` | `/GPT/i` | 软降权匹配模式（正则），命中则降权；可被自定义正则覆盖 |

---

## Windows 部署（T-D5 · 路线 A：本机可见窗口）

服务主进程在 Windows 原生运行，数据库用 **SQLite 本地免服务器**（开箱即用，启动自动建表 `data/autoclaw.db`，无需安装 MySQL）。
浏览器使用本机已安装的 **Chrome**，以**真实可见窗口**运行（无需安装 Playwright 的 Chromium）。

> 若需接远程 / 服务器 MySQL，设 `AUTOCLAW_DB_TYPE=mysql` 并先执行 `scripts/schema.sql`（非本机测试默认路径）。

### 前置条件
- Windows 10/11 + Node.js ≥ 18 + 已安装 Chrome（稳定版）。
- （可选）若用 MySQL 后端：`AUTOCLAW_DB_TYPE=mysql` 且目标库已执行 `scripts/schema.sql`；**本地测试用默认 SQLite 无需此步**。
- 已 `npm install`（含 express / socket.io / playwright / mysql2；无需 `npx playwright install chromium`）。

### 快速启动（start-win.bat）
双击 `start-win.bat`（或命令行运行），它会设置环境变量后启动 `node app.js`：

> 本地默认用 **SQLite**（免数据库服务器、启动自动建表 `data/autoclaw.db`），开箱即可测试；
> 若要切回 MySQL，设 `AUTOCLAW_DB_TYPE=mysql` 并在 `autoclaw` 库先跑 `scripts/schema.sql`。

```bat
@echo off
set AUTOCLAW_TOKEN=autoclaw-dev
set AUTOCLAW_DB_HOST=localhost
set AUTOCLAW_DB_PORT=3306
set AUTOCLAW_DB_USER=root
set AUTOCLAW_DB_PASSWORD=
set AUTOCLAW_DB_NAME=autoclaw
set AUTOCLAW_DB_LIMIT=10
REM 可选：指定本机 Chrome 路径（默认用 channel:'chrome' 自动探测）
REM set AUTOCLAW_CHROME_PATH=C:\Program Files\Google\Chrome\Application\chrome.exe
node app.js
```

启动后访问 http://localhost:7788 打开配置控制台；提交任务后 Chrome 会弹出真实窗口，
可在桌面实时观察搜索 / 点击 / 站内浏览过程。

### 关键变化（相对 WSL 无头部署）
- `core/browserSession.js` 改为 `chromium.launch({ headless:false, channel:'chrome', userDataDir:<隔离临时目录> })`，
  并移除 `--no-sandbox` / `--disable-setuid-sandbox`；可选 `AUTOCLAW_CHROME_PATH` 指定 Chrome。
- 数据库用本地 SQLite（免服务器，启动自动建表 `data/autoclaw.db`）；如需 MySQL 后端，用 `AUTOCLAW_DB_HOST` 等变量指向目标实例（默认 `localhost:3306`）。
- worker / taskManager / taskEngine 逻辑保持不变；本机 Chrome 窗口即「可见窗口」，不做截图流（T-D5 范畴）。
- 每个任务使用独立的临时 `userDataDir`，任务结束随浏览器关闭释放，不污染本机默认 Chrome profile。

### 环境变量（增量）
| 变量 | 默认值 | 说明 |
|------|--------|------|
| `AUTOCLAW_DB_HOST` | `localhost` | Windows 侧连 WSL 的 MySQL |
| `AUTOCLAW_DB_PORT` | `3306` | |
| `AUTOCLAW_DB_USER` / `AUTOCLAW_DB_PASSWORD` / `AUTOCLAW_DB_NAME` / `AUTOCLAW_DB_LIMIT` | `root` / `''` / `autoclaw` / `10` | 同前 |
| `AUTOCLAW_CHROME_PATH` | 空（自动探测） | 可选，指定本机 Chrome 可执行文件路径 |
| `AUTOCLAW_DB_TYPE` | `mysql`（**本地测试须显式设 `sqlite`**） | 持久化后端：不设置则默认 `mysql` 并尝试连 `localhost:3306`；本机无 MySQL 时必须设 `sqlite`（本地免服务器，启动自动建表 `data/autoclaw.db`）。`start-win.bat` 已内置该设置 |
| `AUTOCLAW_SQLITE_PATH` | 空（默认 `data/autoclaw.db`） | 仅 `sqlite` 模式生效，指定 SQLite 文件路径 |

### 注意事项（部署 / 测试必读）

- **启动必须带 `AUTOCLAW_DB_TYPE=sqlite`**：本机 / 单机测试无 MySQL，若不设置该变量将默认走 `mysql` 并尝试连接 `localhost:3306`，导致任务提交落库失败（`ECONNREFUSED`）。`start-win.bat` 已内置此设置；手动 `node app.js` 时需自行带上（见上方「本地 / WSL 安装」第 5 步）。
- **谷歌持久 profile（`AUTOCLAW_GOOGLE_PERSIST_PROFILE=1`）**：开启后谷歌阶段复用固定 `data/google-profile` 累积 cookie / 浏览历史，显著降低谷歌机器人验证触发。该 profile **每台机器独立、含登录态**，已在 `.gitignore` 排除、请勿提交入库；多实例并行跑任务时不要共享同一 profile 目录，以免锁竞争。其效果随 cookie 累积**渐进显现**（首次运行接近空身份，多跑几轮越来越稳）。
- **高标记节点软降权（默认开启）**：谷歌默认把热门共享 VPN 出口（如名称含 `GPT` 的节点）移到节点池末尾、优先用低标记节点，降低被谷歌标记的出口。可用 `AUTOCLAW_GOOGLE_AVOID_HOT_NODES=0` 关闭，或用 `AUTOCLAW_GOOGLE_AVOID_NODE_PATTERN=<regex>` 调整匹配模式。
- **谷歌机器人验证需人工过码**：极少数情况下仍会触发「异常流量验证拦截」——此时程序会在弹出的 Chrome 窗口中等待，请在可见窗口内手动完成验证，程序检测通过后会自动继续。该提示已降噪（每节点至多提示一次 + 周期性提醒），不会刷屏。
- **运行数据不入版本库**：`data/google-profile/`、`data/*.db`、`data/task-stats-*.{json,md}`、`logs/*.log` 等均为运行产物，已在 `.gitignore` 排除，请勿提交。

---

## API 速览

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/task/submit` | 提交并启动任务，返回 `{ taskId, status }`；运行中返回 409 |
| GET  | `/api/task/progress?taskId=` | 轮询进度快照（降级链路） |
| POST | `/api/task/pause` | 暂停任务 `{ taskId }` |
| POST | `/api/task/stop` | 停止任务 `{ taskId }` |
| GET  | `/api/task/status` | 活跃任务概览 |
| GET  | `/api/task/history` | 历史配置列表（created_at DESC，F-24） |
| GET  | `/api/task/logs?taskId=` | 运行记录时间线 + 成功率/失败率（F-25） |
| GET  | `/api/status` | 健康检查（不鉴权） |

---

## License

本项目以 [MIT License](./LICENSE) 开源发布。© 2026 rexdcw-cpu。

欢迎在遵守 MIT 协议的前提下自由使用、修改与分发。如需协作开发，请直接 fork / clone 本仓库，或提交 Pull Request。
