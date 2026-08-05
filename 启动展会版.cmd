@echo off
setlocal
cd /d "%~dp0"
set "NODE_EXE=node"
if exist "runtime-bin\node.exe" (
  set "NODE_EXE=%~dp0runtime-bin\node.exe"
  set "OPERATOR_DATA_DIR=%LOCALAPPDATA%\OperatorStudioExhibition\data"
  set "OPERATOR_RUNTIME_DIR=%LOCALAPPDATA%\OperatorStudioExhibition\runtime"
)
if not exist "runtime-bin\node.exe" where node >nul 2>nul
if not exist "runtime-bin\node.exe" if errorlevel 1 (
  echo Node.js is not available. Use the prepared offline exhibition package.
  pause
  exit /b 1
)
if not exist "dist\index.html" (
  call npm run build
  if errorlevel 1 (
    echo The exhibition web bundle could not be built.
    pause
    exit /b 1
  )
)
start "" "http://127.0.0.1:4173"
"%NODE_EXE%" server\mock-server.mjs
if errorlevel 1 pause
