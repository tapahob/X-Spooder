@echo off
rem Builds the web site into dist\web\ and the Windows app into dist\X-Spooder-win32-x64\
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found in PATH. Install it from https://nodejs.org and try again.
  exit /b 1
)

if not exist "node_modules\@electron\packager" (
  echo Installing dependencies...
  call npm install --ignore-scripts
  if errorlevel 1 exit /b 1
)

node scripts\build.js
if errorlevel 1 exit /b 1

endlocal
