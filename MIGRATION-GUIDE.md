# autoclaw 换机一键指南（数据 + 代码完整迁移）

> 适用场景：**旧机重装 / 换到新机器**，要求完整保留数据库（任务配置、运行日志、批量任务等），
> 新机器安装好后能看到**当前电脑的全部数据**。
>
> - 当前数据快照：**2026-08-29 15:05**（共 91,692 行：12 campaign / 12 campaign_runs / 88 task_config / 91,580 task_run_log）
> - 快照形式：Git 内的 5 个分片 `data/seed/autoclaw-dump.part01~05.sql.gz`
> - 配套脚本：`scripts/export-db.js`（导出）、`scripts/import-db.js`（导入）

---

## 一、新机器三步恢复（核心，复制即可跑）

```bash
# 1. 拉取代码（已含数据分片 + 导入脚本）
git clone https://github.com/rexdcw-cpu/autoclaw.git
cd autoclaw

# 2. 安装依赖（better-sqlite3 需本地编译，务必成功）
npm install

# 3. 一键导入全部数据（自动识别 part01~05.sql.gz，按文件名顺序导入）
node scripts/import-db.js
```

导入脚本会自动完成：备份旧库（若已存在）→ 事务内导入 → 末尾跑 `integrity_check` 校验。
看到 `integrity_check: ok` 即成功，数据与旧机一致。

---

## 二、启动服务

```bash
# 方式 A（推荐，日常用）：守护模式，崩溃 10 秒自愈 + Chrome 可见窗口
autostart-autoclaw.bat

# 方式 B（临时前台）：手动启动（需本机已装 Chrome）
AUTOCLAW_DB_TYPE=sqlite AUTOCLAW_TOKEN=autoclaw-dev PORT=7788 node app.js
```

启动后访问 **http://localhost:7788**，令牌 `autoclaw-dev`。

---

## 三、校验是否恢复完整

| 校验项 | 期望 |
|--------|------|
| 控制台 campaigns / task_config | 与旧机一致（12 个 campaign、88 条 task_config） |
| 任务运行日志 | 91,580 条 task_run_log 可回看 |
| 跑一轮测试任务 | 百度 / 谷歌解析正常、能着陆目标站 |

---

## 四、旧机重装前（可选，但建议）

若旧机还能跑、且之后又产生了**新任务 / 新日志**，先刷新一次快照再换机：

```bash
cd /path/to/autoclaw
node scripts/export-db.js          # 重新生成 part01~05.sql.gz
git add data/seed/autoclaw-dump.part*.sql.gz
git commit -m "data: 刷新换机前快照"
git push origin master
```

> ⚠️ **快照是 Git 里的静态文件，不是实时同步。** 换机前务必确认已导出最新数据。

---

## 五、关键注意事项

- **数据来源是 Git 分片，不是实时库**：换机后新机器看到的是「快照时间点」的数据。换机后旧机若再跑任务，需重跑第四节刷新。
- **PAT 安全**：本会话/旧机用过的 GitHub Personal Access Token 请在
  GitHub → Settings → Developer settings → Personal access tokens 处**撤销**，避免泄露。
- **端口冲突**：新机先确认 7788 未被占用
  （PowerShell：`netstat -ano | findstr :7788`），占用则先结束对应进程。
- **VPN 节点偏好**：`preferredNodes`（C 方案，HK/TW 节点优先）已随数据迁移，新机无需重配。
- **Google 解析**：已修复 `/goto?url=` 加密串导致全线解析失效的问题，新机直接生效。
- **谷歌持久 profile 不迁移**：`data/google-profile/` 含本机登录态、已在 `.gitignore` 排除，
  新机首次运行接近空身份，多跑几轮累积 cookie 后越来越稳（属正常）。
- **运行产物不入版本库**：`data/*.db`、`data/google-profile/`、`*.log` 等均为运行产物，勿提交。

---

## 六、故障排查

| 现象 | 处理 |
|------|------|
| `npm install` 报 better-sqlite3 编译失败 | 确认本机有 C++ 编译工具链（Windows 装 VS Build Tools / python）；或 `npm rebuild better-sqlite3` |
| 导入报 `table already exists` | 目标库非空，加 `--force`：`node scripts/import-db.js --force`（会先备份旧库） |
| 导入后数据条数为 0 | 确认 `data/seed/` 下 5 个 `.sql.gz` 都在；脚本只识别 `autoclaw-dump.part*.sql.gz` |
| 启动连 `localhost:3306` 报错 | 未带 `AUTOCLAW_DB_TYPE=sqlite`；`start-win.bat` 已内置，手动启动请补上该变量 |
| 端口 7788 被占用 | `netstat -ano | findstr :7788` 找到 PID，`Stop-Process -Id <PID>` 释放 |

---

## 七、文档分工

| 文档 | 用途 |
|------|------|
| **本文件 `MIGRATION-GUIDE.md`** | **换机 / 重装，数据 + 代码一键迁移**（你正在看这份） |
| `USAGE-GUIDE.md` | 日常使用手册：拉代码、启停服务、建任务、看结果、地域节点偏好 |
| `AGENT-SETUP.md` | 安装部署手册：环境要求、一键安装、守护进程、踩坑清单、新机检查清单 |

> 一句话：**装环境看 AGENT-SETUP，装完怎么用看 USAGE-GUIDE，换机迁移看本文件。**
