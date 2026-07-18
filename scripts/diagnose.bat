@echo off
REM ===========================================================================
REM autoclaw · 只读诊断脚本（diagnose.bat）
REM ---------------------------------------------------------------------------
REM 用途：
REM   收集排错所需的一切现场信息，不修改任何东西。把本脚本的完整输出
REM   复制粘贴发给技术支持即可。
REM
REM 用法：
REM   双击运行（无需管理员也能收集大部分信息）。
REM ===========================================================================
chcp 65001 >nul
setlocal EnableDelayedExpansion
echo ============================================================
echo  autoclaw 诊断报告  (diagnose.bat)
echo  生成时间: %date% %time%
echo ============================================================
echo.

echo [1] hosts 文件中的域名解析
findstr /C:"test.autoclaw.com" /C:"test.openclaw.com" "%SystemRoot%\System32\drivers\etc\hosts" 2>nul || echo   (hosts 中未找到 test.autoclaw.com / test.openclaw.com)
echo.

echo [2] 端口 80 / 443 / 3000 / 7788 监听情况（含占用进程 PID）
for %%P in (80 443 3000 7788) do (
  set "FOUND=0"
  for /f "tokens=1,2,3,4,5" %%a in ('netstat -ano 2^>nul ^| findstr /i "LISTENING" ^| findstr /r ":%%P "') do (
    set "FOUND=1"
    REM %%e 为最后一列 = PID
    for /f "tokens=1" %%n in ('tasklist /FI "PID eq %%e" /NH 2^>nul ^| findstr /v "INFO:"') do (
      echo   端口 %%P : %%a %%b  ^<- PID=%%e ^(%%n^)
    )
  )
  if !FOUND!==0 echo   端口 %%P : 无监听
)
echo.

echo [3] 是否安装了 Nginx / Apache / IIS（常见反向代理）
set "PROXY=0"
for %%x in (nginx httpd apache w3wp) do (
  tasklist /FI "IMAGENAME eq %%x.exe" 2>nul | findstr /i "%%x.exe" >nul && (
    echo   发现代理/Web 服务进程: %%x.exe
    set "PROXY=1"
  )
)
powershell -NoProfile -Command "Get-Service -Name 'W3SVC' -ErrorAction SilentlyContinue | Where-Object { $_.Status -eq 'Running' } | ForEach-Object { Write-Output '   IIS (W3SVC) 正在运行' }" 2>nul
if !PROXY!==0 echo   未发现常见反向代理进程（Nginx/Apache/IIS 未运行）
echo.

echo [4] WSL 发行版状态 与 WSL 内部仍在跑的 autoclaw/node 进程
wsl -l -v 2>&1
echo   --- WSL 内部进程（grep node app.js / autoclaw）---
wsl -- bash -lc "ps -ef 2>/dev/null | grep -E 'node app.js|autoclaw' | grep -v grep" 2>nul || echo   (WSL 内无相关进程，或 WSL 未运行)
echo.

echo [5] 实际探测：新服务(7788) 与 用户常误访的端口(80)
curl -s -m 5 http://127.0.0.1:7788/api/status >nul 2>&1
if !errorlevel!==0 ( echo   7788 -> 新 Windows 服务响应 OK ) else ( echo   7788 -> 无响应（新服务未启动？请运行 start-win.bat） )
for /f "tokens=*" %%s in ('curl -s -m 5 -o nul -w "%%{http_code}" http://127.0.0.1:80/ 2^>nul') do echo   80   -> HTTP %%s
echo.

echo [6] 端口 80 占用方（用于判断是否需要释放）
for /f "tokens=1,2,3,4,5" %%a in ('netstat -ano 2^>nul ^| findstr /i "LISTENING" ^| findstr /r ":80 "') do (
  for /f "tokens=1" %%n in ('tasklist /FI "PID eq %%e" /NH 2^>nul ^| findstr /v "INFO:"') do (
    echo   端口 80 由 PID=%%e ^(%%n^) 占用
  )
)
echo.
echo ============================================================
echo  诊断结束。请把以上全部内容复制发给技术支持。
echo ============================================================
pause
