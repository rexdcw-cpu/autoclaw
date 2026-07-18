@echo off
REM ===========================================================================
REM autoclaw · 本地 hosts 解析修复脚本
REM ---------------------------------------------------------------------------
REM 作用：
REM   将 test.openclaw.com 与 test.autoclaw.com 指向 127.0.0.1，
REM   使浏览器访问该域名时能命中本机 Windows 原生服务（端口 7788）。
REM
REM 为什么需要：
REM   新的 Windows 原生服务监听在 0.0.0.0:7788（本机）。如果域名被 DNS
REM   解析到远程旧服务器，:7788 就到不了本机服务。把域名指向 127.0.0.1
REM   可强制走本机。
REM
REM 注意：
REM   必须「以管理员身份运行」，否则无法写入 hosts 文件。
REM   若你只用 127.0.0.1 / localhost 访问，此步骤可跳过。
REM ===========================================================================

@echo off
chcp 65001 >nul
setlocal EnableExtensions
set "HOSTS=%SystemRoot%\System32\drivers\etc\hosts"

REM 需要管理员权限才能写入 hosts
net session >nul 2>&1
if %errorLevel% neq 0 (
  echo [autoclaw] 需要管理员权限！请右键本文件 →「以管理员身份运行」。
  pause
  exit /b 1
)

set "NEED=0"
findstr /C:"test.openclaw.com" "%HOSTS%" >nul 2>&1 || set "NEED=1"
findstr /C:"test.autoclaw.com" "%HOSTS%" >nul 2>&1 || set "NEED=1"

if %NEED%==0 (
  echo [autoclaw] hosts 中已存在相关条目，无需修改。
) else (
  echo # autoclaw local dev >> "%HOSTS%"
  echo 127.0.0.1 test.openclaw.com >> "%HOSTS%"
  echo 127.0.0.1 test.autoclaw.com >> "%HOSTS%"
  echo [autoclaw] 已追加以下解析到 127.0.0.1：
  echo [autoclaw]   127.0.0.1 test.openclaw.com
  echo [autoclaw]   127.0.0.1 test.autoclaw.com
)

ipconfig /flushdns >nul 2>&1
echo [autoclaw] 已刷新 DNS 缓存。现在可用以下任一地址访问新服务：
echo [autoclaw]   http://test.openclaw.com:7788/progress.html?taskId=xxx
echo [autoclaw]   http://test.autoclaw.com:7788/progress.html?taskId=xxx
echo [autoclaw]   http://127.0.0.1:7788/progress.html?taskId=xxx
echo [autoclaw]   http://localhost:7788/progress.html?taskId=xxx
echo [autoclaw] 完成。
pause
