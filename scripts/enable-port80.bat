@echo off
REM ===========================================================================
REM autoclaw · 让裸域名（不带端口）也能访问（enable-port80.bat）
REM ---------------------------------------------------------------------------
REM 为什么要这个脚本：
REM   新 Windows 服务监听 7788。用户常忘记加 :7788，直接访问
REM   http://test.autoclaw.com/ （默认 80 端口），结果被 wslrelay 转发进
REM   WSL 的旧服务而报错。
REM
REM   本脚本用 Windows 自带 netsh 端口转发，把 127.0.0.1:80 -> 127.0.0.1:7788，
REM   这样裸域名就能直达新服务。前提是 80 端口当前空闲（即先运行过
REM   kill-old-service.bat 杀掉 WSL 旧服务，让 wslrelay 释放 80）。
REM
REM 必须「以管理员身份运行」（netsh 改端口转发需要管理员）。
REM 若要撤销，运行： netsh interface portproxy delete v4tov4 listenport=80 listenaddress=127.0.0.1
REM ===========================================================================
chcp 65001 >nul
setlocal EnableDelayedExpansion

echo ============================================================
echo  autoclaw · 启用 80 -> 7788 端口转发（裸域名可用）
echo ============================================================

net session >nul 2>&1
if %errorLevel% neq 0 (
  echo [!] 必须以管理员身份运行！右键本文件 ->「以管理员身份运行」。
  pause
  exit /b 1
)

REM --- 确认新服务已在 7788 监听 ---
set "SVC_OK=0"
for /f "tokens=1,2,3,4,5" %%a in ('netstat -ano 2^>nul ^| findstr /i "LISTENING" ^| findstr /r ":7788 "') do set "SVC_OK=1"
if %SVC_OK%==0 (
  echo [!] 未在 7788 发现监听。请先运行 start-win.bat 启动新服务，再回来运行本脚本。
  pause
  exit /b 1
)

REM --- 若 80 仍被占用，尝试结束 wslrelay 释放（仅当 WSL 旧服务已杀）---
for /f "tokens=5" %%p in ('netstat -ano 2^>nul ^| findstr /i "LISTENING" ^| findstr /r ":80 "') do (
  for /f "tokens=1" %%n in ('tasklist /FI "PID eq %%p" /NH 2^>nul ^| findstr /v "INFO:"') do (
    if /i "%%n"=="wslrelay.exe" (
      echo [i] 端口 80 被 wslrelay.exe (PID=%%p) 占用，尝试释放...
      taskkill /PID %%p /F >nul 2>&1
      timeout /t 2 >nul
    )
  )
)

REM --- 添加端口转发 ---
netsh interface portproxy add v4tov4 listenaddress=127.0.0.1 listenport=80 connectaddress=127.0.0.1 connectport=7788
if !errorlevel!==0 (
  echo [!] 添加端口转发失败（80 可能仍被占用）。请确认已运行 kill-old-service.bat，
  echo     并手动检查： netstat -ano ^| findstr ":80 "
  pause
  exit /b 1
)

netsh interface portproxy show v4tov4
echo.
echo [ok] 已设置 127.0.0.1:80 -> 127.0.0.1:7788。
echo      现在 http://test.autoclaw.com/  （不带端口）即可访问新服务。
echo      注意：本机重启后该转发可能失效，可把本脚本设为开机自启或重新运行一次。
echo ============================================================
pause
