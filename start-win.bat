@echo off
REM ===========================================================================
REM autoclaw · Windows 原生启动脚本（T-D5：本机可见 Chrome 窗口）
REM ---------------------------------------------------------------------------
REM 服务主进程在 Windows 原生运行；MySQL 仍跑在 WSL，经 localhost:3306 访问。
REM 双击本文件（或命令行运行）即可设置环境变量后启动 node app.js。
REM 提交任务后 Chrome 会弹出真实可见窗口，可在桌面实时观察自动化过程。
REM ===========================================================================

set AUTOCLAW_TOKEN=autoclaw-dev

REM --- 持久化后端：本地默认 SQLite（免装 MySQL 服务器，启动自动建表）---
REM 切回 MySQL 时改下面这行为：set AUTOCLAW_DB_TYPE=mysql
REM 并填写下方 MySQL 连接变量（连 WSL 内的 MySQL，localhost:3306）
set AUTOCLAW_DB_TYPE=sqlite
REM SQLite 文件路径（可选，留空默认 data/autoclaw.db）
set AUTOCLAW_SQLITE_PATH=

REM --- MySQL 连接（仅 AUTOCLAW_DB_TYPE=mysql 时生效）---
set AUTOCLAW_DB_HOST=localhost
set AUTOCLAW_DB_PORT=3306
set AUTOCLAW_DB_USER=root
set AUTOCLAW_DB_PASSWORD=
set AUTOCLAW_DB_NAME=autoclaw
set AUTOCLAW_DB_LIMIT=10

REM --- 可选：指定本机 Chrome 路径（默认用 channel:'chrome' 自动探测）---
REM set AUTOCLAW_CHROME_PATH=C:\Program Files\Google\Chrome\Application\chrome.exe

node app.js
