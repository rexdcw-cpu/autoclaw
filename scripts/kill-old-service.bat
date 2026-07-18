@echo off
REM ===========================================================================
REM autoclaw · 彻底清理旧服务脚本（kill-old-service.bat）
REM ---------------------------------------------------------------------------
REM 背景（重要，请先读 ACCESS-FAQ.md）：
REM   用户报的错 "browserType.launch: Executable doesn't exist at
REM   /root/.cache/ms-playwright/chromium_headless_shell-1228/..." 中的路径是
REM   Linux/WSL 路径，说明报错来自【跑在 WSL 里的旧 autoclaw 服务】，而不是
REM   新的 Windows 原生服务（新服务用本机 Chrome，路径在 Windows 上）。
REM
REM   根因链路：
REM     test.autoclaw.com -> hosts -> 127.0.0.1 -> 访问 80 端口
REM     -> wslrelay.exe 把 Windows 的 127.0.0.1:80 转发进 WSL
REM     -> WSL 里仍在跑的旧 node app.js（监听 WSL 的 80/7788）
REM     -> 它用 Playwright 自带的 headless shell（/root/.cache/...）启动浏览器
REM     -> 该浏览器在 WSL 里没装 -> 报上述错误。
REM
REM   所以「只杀 Windows 3000 端口」没用：真正的旧服务在 WSL 里。
REM   本脚本会：① 杀 Windows 占用 3000 的旧 node；② 杀 WSL 内的旧 autoclaw；
REM   ③ 复查端口 80 占用情况并给出后续建议。
REM
REM 用法：
REM   建议「以管理员身份运行」（释放 80 端口 / 结束 WSL 进程有时需要提权）。
REM ===========================================================================
chcp 65001 >nul
setlocal EnableDelayedExpansion

echo ============================================================
echo  autoclaw · 彻底清理旧服务（kill-old-service.bat）
echo ============================================================

REM --- 管理员检查（非必须，但建议）---
net session >nul 2>&1
if %errorLevel% neq 0 (
  echo [提示] 未以管理员身份运行。部分进程可能无法结束，建议关闭本窗口后
  echo        右键本文件 ->「以管理员身份运行」。仍会先尝试非管理员能做的清理。
) else (
  echo [ok] 已识别为管理员权限。
)
echo.

REM ---------------------------------------------------------------------------
REM [1] 结束 Windows 上占用 3000 端口的旧 node 服务（旧 Windows 时代残留）
REM ---------------------------------------------------------------------------
echo [1] 查找并结束 Windows 上占用 3000 端口的进程...
set "KILLED_WIN=0"
for /f "tokens=5" %%p in ('netstat -ano 2^>nul ^| findstr /i "LISTENING" ^| findstr /r ":3000 "') do (
  echo     发现 PID=%%p 占用 3000，正在终止...
  taskkill /PID %%p /F /T >nul 2>&1
  if !errorlevel!==0 ( echo     已终止 PID=%%p & set "KILLED_WIN=1" ) else ( echo     终止 PID=%%p 失败（权限不足？请管理员运行） )
)
if %KILLED_WIN%==0 echo     未发现占用 3000 的进程（可能已停止）。

REM ---------------------------------------------------------------------------
REM [1.5] 结束 Windows 上占用 7788 端口的旧 autoclaw（关键！）
REM   旧进程可能是 mysql 默认模式（连不上已关的 WSL MySQL 会「落库失败」），
REM   也可能是任何残留实例。不先清它，start-win.bat 会因 EADDRINUSE 退出，
REM   浏览器永远命中旧进程。
REM ---------------------------------------------------------------------------
echo.
echo [1.5] 查找并结束 Windows 上占用 7788 端口的旧进程（无论 mysql/sqlite 模式）...
set "KILLED_7788=0"
for /f "tokens=5" %%p in ('netstat -ano 2^>nul ^| findstr /i "LISTENING" ^| findstr /r ":7788 "') do (
  echo     发现 PID=%%p 占用 7788，正在终止...
  taskkill /PID %%p /F /T >nul 2>&1
  if !errorlevel!==0 ( echo     已终止 PID=%%p & set "KILLED_7788=1" ) else ( echo     终止 PID=%%p 失败（权限不足？请管理员运行） )
)
if %KILLED_7788%==0 echo     未发现占用 7788 的进程（端口空闲，可直接启动）。

REM ---------------------------------------------------------------------------
REM [2] 结束 WSL(Ubuntu) 内仍在运行的旧 autoclaw（真正的报错源头）
REM ---------------------------------------------------------------------------
echo.
echo [2] 结束 WSL 内仍在运行的旧 autoclaw（node app.js）...
wsl -- bash -lc "pkill -f 'node app.js'; pkill -f 'autoclaw'; true" 2>nul
echo     WSL 内旧服务已尝试结束（pkill 返回码被忽略，属正常）。

REM ---------------------------------------------------------------------------
REM [3] 复查端口 80 占用（用户误访的端口，通常由 wslrelay 转发进 WSL）
REM ---------------------------------------------------------------------------
echo.
echo [3] 复查端口 80 当前占用情况：
set "PORT80_FOUND=0"
for /f "tokens=1,2,3,4,5" %%a in ('netstat -ano 2^>nul ^| findstr /i "LISTENING" ^| findstr /r ":80 "') do (
  set "PORT80_FOUND=1"
  for /f "tokens=1" %%n in ('tasklist /FI "PID eq %%e" /NH 2^>nul ^| findstr /v "INFO:"') do (
    echo     端口 80 由 PID=%%e ^(%%n^) 占用
  )
)
if %PORT80_FOUND%==0 (
  echo     端口 80 当前空闲（WSL 旧服务已停止，wslrelay 已释放转发）。
  echo     此时可直接用裸域名 http://test.autoclaw.com/ 访问（需先启用 80->7788 转发，见下）。
) else (
  echo     端口 80 仍被占用（通常是 wslrelay.exe）。这不会造成报错，只是裸域名仍到不了新服务。
  echo     若想让 http://test.autoclaw.com/ （不带端口）可用，请运行 enable-port80.bat。
)

echo.
echo ============================================================
echo  清理完成。下一步：
echo    1) 确认 Chrome 已安装（新服务用本机 Chrome）。
echo    2) 运行 start-win.bat 启动新服务（监听 7788）。
echo    3) 访问 http://test.autoclaw.com:7788/  （务必带 :7788）
echo    如需裸域名也能用，运行 scripts/enable-port80.bat（需管理员）。
echo ============================================================
pause
