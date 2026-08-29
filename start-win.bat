@echo off
REM ===========================================================================
REM autoclaw · Windows 原生启动脚本（T-D5：本机可见 Chrome 窗口）
REM ---------------------------------------------------------------------------
REM 双击本文件即可：自动设置环境变量 + 用 WorkBuddy 托管 node 启动 app.js。
REM 提交任务后 Chrome 会弹出真实可见窗口，可在桌面实时观察自动化过程。
REM （前台运行，关闭此窗口即停服务；如需后台保活请用 autostart-autoclaw.bat）
REM ===========================================================================

setlocal enabledelayedexpansion

set "APP_DIR=C:\Users\Jimmy\WorkBuddy\Claw\autoclaw"
cd /d "%APP_DIR%" || exit /b 1

REM --- 持久化后端：本地默认 SQLite（免装 MySQL 服务器，启动自动建表）---
set AUTOCLAW_TOKEN=autoclaw-dev
set AUTOCLAW_DB_TYPE=sqlite
set AUTOCLAW_SQLITE_PATH=

REM --- MySQL 连接（仅 AUTOCLAW_DB_TYPE=mysql 时生效）---
set AUTOCLAW_DB_HOST=localhost
set AUTOCLAW_DB_PORT=3306
set AUTOCLAW_DB_USER=root
set AUTOCLAW_DB_PASSWORD=
set AUTOCLAW_DB_NAME=autoclaw
set AUTOCLAW_DB_LIMIT=10

REM --- 解析 node.exe：优先 WorkBuddy 托管 node，其次 PATH ---
set "NODE_EXE="
set "NODE_BASE=C:\Users\Jimmy\.workbuddy\binaries\node\versions"
if exist "%NODE_BASE%" (
  for /f "delims=" %%d in ('dir /b /ad /o-n "%NODE_BASE%" 2^>nul') do (
    if not defined NODE_EXE if exist "%NODE_BASE%\%%d\node.exe" set "NODE_EXE=%NODE_BASE%\%%d\node.exe"
  )
)
if not defined NODE_EXE (
  for /f "delims=" %%i in ('where node 2^>nul') do (
    if not defined NODE_EXE set "NODE_EXE=%%i"
  )
)
if not defined NODE_EXE (
  echo [ERROR] node.exe not found - install Node.js or check %NODE_BASE%
  pause
  exit /b 1
)

echo Starting autoclaw (foreground, visible Chrome)
echo   node    : !NODE_EXE!
echo   app dir : %APP_DIR%
echo.
"!NODE_EXE!" app.js
