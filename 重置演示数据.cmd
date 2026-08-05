@echo off
setlocal
cd /d "%~dp0"
set "NODE_EXE=node"
if exist "runtime-bin\node.exe" (
  set "NODE_EXE=%~dp0runtime-bin\node.exe"
  set "OPERATOR_DATA_DIR=%LOCALAPPDATA%\OperatorStudioExhibition\data"
  set "OPERATOR_RUNTIME_DIR=%LOCALAPPDATA%\OperatorStudioExhibition\runtime"
)
"%NODE_EXE%" server\reset-data.mjs
if errorlevel 1 pause
