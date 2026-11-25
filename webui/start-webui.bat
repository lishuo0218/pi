@echo off
rem Start the pi web UI (production mode): build dist/ if missing, then run the bridge.
rem Usage: start-webui.bat [--port N] [--pi-path PATH] [--cwd DIR]
rem Defaults to the pi build in this repo (packages/coding-agent/dist/bundle/cli.js),
rem falling back to the pi on PATH. Pass --pi-path to use another pi or a pi entry
rem file (run with node), e.g. a global install's .cmd shim:
rem   start-webui.bat --pi-path pi.cmd
setlocal
cd /d "%~dp0"

rem Build the frontend first: a stale dist/ would keep serving an old bundle.
if exist "dist\index.html" (
  echo Refreshing frontend build...
) else (
  echo Building frontend...
)
call npm run build
if errorlevel 1 (
  echo Build failed. Fix the errors above and retry.
  pause
  exit /b 1
)

rem Run the bridge outside the terminal's shell; keep the window open on exit.
node scripts\start.mjs %*
set EXITCODE=%errorlevel%
if not "%EXITCODE%"=="0" (
  echo.
  echo Bridge exited with code %EXITCODE%.
  pause
)
endlocal
exit /b %EXITCODE%
