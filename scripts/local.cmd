@echo off
setlocal

cd /d "%~dp0.."

set "PKG_NAME="
for /f "usebackq delims=" %%i in (`node -p "require('./package.json').name"`) do set "PKG_NAME=%%i"

if /i "%~1"=="--remove" goto :remove
if /i "%~1"=="--uninstall" goto :remove
if /i "%~1"=="-r" goto :remove
if not "%~1"=="" goto :usage

set "TEMP_DIR=%TEMP%\git-tm-local-%RANDOM%%RANDOM%"
mkdir "%TEMP_DIR%" || exit /b 1

set "PACKAGE="
for /f "usebackq delims=" %%i in (`npm pack --silent --pack-destination "%TEMP_DIR%"`) do set "PACKAGE=%%i"

call npm install -g "%TEMP_DIR%\%PACKAGE%"
set "CODE=%ERRORLEVEL%"

rmdir /s /q "%TEMP_DIR%"
exit /b %CODE%

:remove
call npm uninstall -g "%PKG_NAME%"
exit /b %ERRORLEVEL%

:usage
echo Usage: %~nx0 [--remove^|--uninstall^|-r] 1>&2
exit /b 1
