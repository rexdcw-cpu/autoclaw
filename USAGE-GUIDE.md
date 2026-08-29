# autoclaw 使用手册（日常操作 · 更新代码 · 注意事项）

> 面向**使用者**：已经装好环境后，如何拉取最新代码、跑任务、看结果、避坑。
> 首次安装部署请看 **[AGENT-SETUP.md](./AGENT-SETUP.md)**（环境、依赖、配置、开机自启）。
> 本手册是它的「日常使用篇」。

当前版本：**v0.3.60**　|　控制台：`http://localhost:7788`　|　默认令牌：`autoclaw-dev`

---

## 1. 三步跑起来

```bash
# ① 取代码（私有仓库：用户名任意，密码填 GitHub PAT）
git clone https://github.com/rexdcw-cpu/autoclaw.git
cd autoclaw

# ② 装依赖 + 自检（推荐，自动跑单元测试）
node scripts/bootstrap.js

# ③ 启动
#    Windows：双击 start-win.bat
#    Linux 无头：AUTOCLAW_DB_TYPE=sqlite AUTOCLAW_HEADLESS=1 node app.js
```

然后打开 `http://localhost:7788` 即可。

---

## 2. 获取与更新最新代码

### 2.1 首次获取

```bash
git clone https://github.com/rexdcw-cpu/autoclaw.git
cd autoclaw
git log --oneline -3          # 看最近提交，确认拉到的是最新
```

### 2.2 已有仓库，更新到最新

```bash
git pull origin master
npm install                   # ⚠️ 依赖可能变了，务必补一次
```

**为什么 `npm install` 不能省**：`package.json` 会随版本变动（如新增 `preferredNodes` 相关改动），
只 `git pull` 不装依赖，服务可能启动即报错。

### 2.3 确认当前版本

三种方式任选：

```bash
# 方式 A：看文件
node -e "console.log(require('./package.json').version)"

# 方式 B：问服务（无需鉴权）
curl -s http://127.0.0.1:7788/api/status
# → {"code":0,"data":{"service":"autoclaw","version":"0.3.60",...},"message":"ok"}

# 方式 C：看提交
git log --oneline -1
```

> 改了代码后**必须重启服务**才生效（后端不会热加载）。重启方法见 §3.2。

### 2.4 想回退到某个版本

```bash
git log --oneline -20              # 找到目标 commit
git checkout <commit>              # 临时查看
git checkout -b fix-xxx <commit>   # 或从旧版本开分支
```

---

## 3. 启动与停止服务

### 3.1 三种启动方式

| 方式 | 命令 / 操作 | 适用场景 |
|---|---|---|
| Windows 前台 | 双击 `start-win.bat` | 临时用、要看得见窗口（**关窗即停**） |
| Windows 守护 | 双击 `autostart-autoclaw.bat` | 长期驻留，崩溃 10 秒后自动拉起 |
| 命令行 | `AUTOCLAW_DB_TYPE=sqlite node app.js` | 调试、Linux、无头服务器 |

Linux 无头服务器必须加 `AUTOCLAW_HEADLESS=1`，否则 Chrome 启动失败。

### 3.2 重启服务（改完代码后）

```powershell
# ① 按端口找到 PID
netstat -ano | Select-String ":7788.*LISTENING"

# ② 只杀这一个 app 子进程
Stop-Process -Id <pid> -Force
```

- **开着守护时**：杀掉后**不用手动启动**，守护约 10 秒后自动用新代码拉起。
- **没开守护时**：杀完需自己重新双击 `start-win.bat`。

> ⚠️ 不要手动 `Start-Process node app.js` —— 会和守护抢 7788 端口，导致起不来。

### 3.3 彻底停服务

1. 先杀**守护父进程**（`data/guardian.lock` 里记着它的 pid）
2. 再杀 `app.js` 子进程

只杀子进程会被守护自动拉回。

### 3.4 停止正在跑的任务（不关服务）

```bash
# 查当前活跃任务
curl -s -H "x-autoclaw-token: autoclaw-dev" http://127.0.0.1:7788/api/task/status
# → {"data":{"activeTaskId":"xxx","status":"running"}}

# 停它（服务照常运行，运行槽释放）
curl -s -X POST -H "x-autoclaw-token: autoclaw-dev" \
     -H "Content-Type: application/json" \
     -d '{"taskId":"xxx"}' http://127.0.0.1:7788/api/task/stop
```

---

## 4. 日常使用流程

### 4.1 页面导览

| 页面 | 地址 | 用途 |
|---|---|---|
| 配置页 | `/` | 提交单次任务（选平台、关键词、目标站、拟人参数） |
| 批量任务 | `/campaigns.html` | **主要用这个**：建站点集合 + 定时/手动跑一轮 |
| 进度看板 | `/progress.html?taskId=xxx` | 实时看搜索→定位→进站→浏览的每一步 |
| 历史 | `/history.html` | 回看往期任务与运行日志 |

### 4.2 建一个批量任务（推荐路径）

1. 打开 `/campaigns.html`
2. 填任务名、调度方式（**「每 N 小时」或「每天 HH:MM」**；只想手动跑可设 `interval` 且勾「立即跑一轮」）
3. 站点卡片里逐个填：

   | 字段 | 说明 |
   |---|---|
   | 域名 | 目标站域名，如 `maninconsultant.com` |
   | 平台 | 百度 / 谷歌（可单独设） |
   | 搜索关键词 | `\|` 分隔，如 `萬年商務\|万年商务` |
   | 标题关键词 | 用于结果标题匹配 |
   | 站内锚点 | 进站后要找的页面文字，默认「关于我们」 |
   | 扫描页数 | 最多翻几页找目标（默认 5） |
   | **地域节点偏好** | 见 §5.2，**留空＝不限地区** |

4. 保存 → 点「立即跑一轮」

### 4.3 看进度与结果

- 点「立即跑一轮」会自动弹出进度页；或点任务卡片上的「👁 查看执行过程」。
- 进度页顶部显示 **`T-<seq>`**（如 `T-4`），这是可读任务编号，日志里用它沟通最方便。
- 跑完看结果：
  - 页面：`/history.html`
  - 报告文件：`data/task-stats-<taskId>-google.md`（每站每平台一份，含逐节点明细）
  - 日志：`data/worker-<taskId>.log`

---

## 5. 两个 v0.3.60 的新能力

### 5.1 可读任务编号 `T-<seq>`

任务 ID 本身是 UUID（`1c36a402-6612-...`），难认难念。新增了自增可读编号：

- 进度页顶部显示 `T-1`、`T-2`、`T-3`……
- 历史列表、日志里都用它指代任务
- 老任务（没有编号的）会回退显示 UUID 短码，**属正常现象**

### 5.2 地域节点偏好 `preferredNodes`

**解决什么问题**：谷歌节点池默认按延迟排序 + 软降权高标记节点（名含 `GPT` 的会被排到末尾）。
如果某站点「地域对但节点被排到后面」，会出现**还没轮到它就触发连续失败止损**的死局。

**怎么用**：站点卡片的「地域节点偏好」填地区码，`|` 分隔。

| 填法 | 效果 |
|---|---|
| 留空 | 不限地区，走默认排序（大多数站点这样即可） |
| `TW\|HK` | 台湾/香港节点提到最前，**并豁免软降权** |

> 该配置存在数据库里，**换机器要重新配**（见 §6.1）。

---

## 6. 注意事项（按重要性排序）

### 🔴 6.1 换机/重装前**务必先导出数据**，否则历史全丢

数据库 `data/autoclaw.db` **不在 git 里**（已 `.gitignore`），重装系统就没了。

好在只要**换机前跑一次导出**，数据就能随代码一起走（详见 §8）：

```bash
node scripts/export-db.js      # → data/seed/autoclaw-dump.part*.sql.gz，随后 git push
```

新机器 `git clone` 后一条命令恢复全部数据（批量任务、地域偏好、运行日志一条不漏）：

```bash
node scripts/import-db.js
```

> ⚠️ 如果**没导出就重装了**，那就真没了——新机器只能空库起步，批量任务要重建。
> 所以这条是重装前**第一优先**要做的事。

### 🔴 6.2 改了前端必须硬刷新

`app.js` 对 `public/` 做了 `no-cache`，但浏览器仍可能用旧 JS。
改了 `public/js/*.js` 后按 **Ctrl+F5**（Mac：Cmd+Shift+R），否则一直跑旧逻辑。

### 🔴 6.3 数据库被多实例抢会变只读

若同时有多个 `node` 实例打开同一个 `data/autoclaw.db`，新实例会报：

```
attempt to write a readonly database
```

表现为任务触发了但**写不进任何记录**。解决：杀光所有 `node` 进程 → 删 `data/guardian.lock` → 重启守护。

### 🟡 6.4 跑谷歌任务需要 Mihomo 监听 7890

谷歌阶段强依赖本机 Mihomo 内核（`127.0.0.1:7890`）作出口，百度走本机 IP。
没跑 Mihomo 时谷歌阶段会直接跳过。检查：

```bash
netstat -ano | grep ":7890.*LISTENING"
```

### 🟡 6.5 验证码要在桌面会话里人工过

触发 Google「异常流量验证」时，程序会在 Chrome 窗口等待，**需要你手动点一下**。
前提是服务启动在**桌面登录会话**内（能看见窗口）；后台 Session 0 下窗口不可见、无法操作。

> 所以：需要过验证码时，用 `autostart-autoclaw.bat` 或 `start-win.bat` 在桌面启动，不要用无头/后台方式。

### 🟡 6.6 同一时刻只能跑一个任务

运行中提交新任务会返回 **HTTP 409 `ERR_TASK_RUNNING`**。
没有「断点续跑」，熔断后需要重新提交。

### 🟡 6.7 运行产物不入 git

`data/*.db`、`data/*.log`、`data/guardian.lock`、`data/google-profile/`、`data/task-stats-*` 等
都是运行产物，已在 `.gitignore` 排除。别手动 `git add -f` 它们。

### 🟡 6.8 本地务必用 SQLite

启动不带 `AUTOCLAW_DB_TYPE=sqlite` 会默认走 MySQL 连 `localhost:3306`，
单机没装 MySQL 时**任务落库全败**（`ECONNREFUSED`）。

---

## 7. 排错速查

| 现象 | 原因 | 处理 |
|---|---|---|
| 点了「立即跑一轮」，进度页空白 | 浏览器用了旧 JS，或任务还没派发到 taskId | 先 Ctrl+F5 硬刷新；仍空白则查 `/api/campaign/state` 是否返回 `activeTaskId` |
| 任务立刻失败，落库报 `ECONNREFUSED 3306` | 没设 `AUTOCLAW_DB_TYPE=sqlite` | 带该变量重启 |
| 报 `attempt to write a readonly database` | 多实例抢同一个 db | 杀光 node → 删 `data/guardian.lock` → 重启守护 |
| 所有谷歌站点**同一天起**集体「定位不到目标」 | 大概率是 **Google 改了结果链接格式**（2026-08 起 `/url?q=` → `/goto?url=`，本项目已修复） | **先看是不是多站点同时归零**：是→解析类全局故障，查 `core/adapters/googleAdapter.js` 的链接解码；只有单站出问题→才是关键词/排名问题 |
| 只有某几个节点能搜到目标站 | 节点地域差异 | 给该站点填「地域节点偏好」（§5.2） |
| 一直卡在某个节点不动 | 命中验证码 | 在可见的 Chrome 窗口里手动过验证 |
| 提交返回 409 | 已有任务在跑 | 等它跑完，或先 `stop` 掉（§3.4） |
| 改了代码没生效 | 没重启服务 / 浏览器缓存 | 重启服务 + Ctrl+F5 |

---

## 8. 数据备份与迁移（换机 / 重装必读）

### 8.1 为什么是「SQL 文本 + 分片压缩」

| 做法 | 问题 |
|---|---|
| 直接把 `data/autoclaw.db` 提交进 git | 二进制文件，git 每次变更都存完整副本，仓库迅速膨胀、无法 diff、无法 review |
| 导出成单个 SQL 文件（15 MB） | 体积仍太大，推送容易被连接重置 |
| **SQL 文本 + 按表分片 + gzip**（本项目采用） | 纯文本可压缩可 review；每片仅几百 KB，推送稳定 |

> 二进制 db 与未压缩的 `data/seed/*.sql` 都被 `.gitignore` 排除；
> 入库的是**分片压缩包** `data/seed/autoclaw-dump.part01..05.sql.gz`。

### 8.2 备份（旧机器上做）

```bash
node scripts/export-db.js
git add data/seed/autoclaw-dump.part*.sql.gz && git commit -m "data: 数据快照" && git push
```

输出示例：

```
=== 导出完成（分片）===
输出目录: data\seed
每片行数: 25000

  campaign_runs                 12 行
  campaigns                     12 行
  client                         0 行
  task_config                   88 行
  task_run_log               91580 行
  --------------------------------
  合计                       91692 行

  autoclaw-dump.part01.sql.gz             8 KB   表结构 + 基础数据
  autoclaw-dump.part02.sql.gz           276 KB   task_run_log 行 0~25000
  autoclaw-dump.part03.sql.gz           281 KB   task_run_log 行 25000~50000
  autoclaw-dump.part04.sql.gz           281 KB   task_run_log 行 50000~75000
  autoclaw-dump.part05.sql.gz           197 KB   task_run_log 行 75000~91580
```

**记下「合计」行数**，恢复后用来核对。

> 可选参数：`--chunk 50000` 改每片行数，`--outdir <目录>` 改输出位置。
> 分片数量变多时，导出脚本会提示清理旧的残留分片（务必删掉，否则恢复时会被一起导入）。

### 8.3 恢复（新机器上做）

```bash
git pull origin master          # 拿到所有分片
node scripts/import-db.js       # 自动按序导入全部分片 → data/autoclaw.db
```

导入脚本会自动扫描 `data/seed/` 下所有 `autoclaw-dump.part*.sql.gz` 并按文件名顺序导入，
**不需要手工指定分片**。若目录下只有单个 dump 文件（旧格式），也自动兼容。

安全设计（不用担心误操作）：
- 目标库已存在且非空时**默认拒绝**，必须显式 `--force`；
- 覆盖前自动把旧库备份为 `autoclaw.db.bak-<时间戳>`，不直接删；
- 逐片导入，任一片失败立即停止并提示（不会静默丢数据）；
- 结束后自动跑 `integrity_check` 并打印各表记录数。

> 前置条件：需先装好依赖（`npm install`），否则会提示「缺少 better-sqlite3」。

### 8.4 核对是否恢复完整

导入脚本会打印各表行数，与 §8.2 的「合计」对比即可。
想更严格可手工抽查：

```bash
# 批量任务与地域偏好是否还在
sqlite3 查询或看 campaigns 页

# 或用项目自带脚本再导一次，对比行数
node scripts/export-db.js /tmp/verify.sql
```

### 8.5 什么时候需要重新导出

数据只在**跑任务**时增长。建议：
- 重装/换机前：必导
- 长期运行后想留档：定期导一次（dump 是快照，导出后新增的数据不会自动包含）

---

## 9. 常用命令卡

```bash
# 更新代码
git pull origin master && npm install

# 备份数据（换机/重装前）
node scripts/export-db.js
git add data/seed/autoclaw-dump.part*.sql.gz && git commit -m "data: 数据快照" && git push

# 恢复数据（新机器）
node scripts/import-db.js

# 查版本
curl -s http://127.0.0.1:7788/api/status

# 查批量任务列表
curl -s -H "x-autoclaw-token: autoclaw-dev" http://127.0.0.1:7788/api/campaign/list

# 手动触发某个批量任务跑一轮（id 从上一条取）
curl -s -X POST -H "x-autoclaw-token: autoclaw-dev" \
     -H "Content-Type: application/json" \
     -d '{"id":"<campaignId>"}' http://127.0.0.1:7788/api/campaign/trigger

# 查运行状态（含当前跑到第几个节点）
curl -s -H "x-autoclaw-token: autoclaw-dev" http://127.0.0.1:7788/api/campaign/state

# 跑单元测试（不要带 DB 环境变量）
node --test test/*.test.js
```

---

**相关文档**：[AGENT-SETUP.md](./AGENT-SETUP.md)（安装部署）· [README.md](./README.md)（架构与 API）· [docs/ACCESS-FAQ.md](./docs/ACCESS-FAQ.md)（访问/端口排错）· [CHANGELOG.md](./CHANGELOG.md)（版本变更）
