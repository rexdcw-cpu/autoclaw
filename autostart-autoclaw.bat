@echo off
REM ===========================================================================
REM  autoclaw guardian - manual entry
REM ---------------------------------------------------------------------------
REM  Double click this file to start autoclaw with the guardian in a visible
REM  console window. The guardian keeps "node app.js" alive and mirrors all
REM  output into data\autostart.log
REM
REM  Auto-start at logon is handled by:
REM    %APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\autoclaw-autostart.vbs
REM  (same guardian, but with a hidden window)
REM
REM  Only one guardian can run at a time (single instance lock:
REM  data\guardian.lock) - starting a second one exits immediately.
REM ===========================================================================

setlocal enabledelayedexpansion

set "APP_DIR=C:\Users\Jimmy\WorkBuddy\Claw\autoclaw"
cd /d "%APP_DIR%" || exit /b 1

REM --- environment (mirrors start-win.bat) ---
set AUTOCLAW_TOKEN=autoclaw-dev
set AUTOCLAW_DB_TYPE=sqlite
set AUTOCLAW_SQLITE_PATH=

REM --- resolve node.exe : managed node first, then PATH ---
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

echo Starting autoclaw guardian
echo   node     : !NODE_EXE!
echo   app dir  : %APP_DIR%
echo   log file : %APP_DIR%\data\autostart.log
echo.
"!NODE_EXE!" autostart-guardian.js
