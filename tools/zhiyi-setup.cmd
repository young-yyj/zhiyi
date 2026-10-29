@echo off
chcp 65001 >nul
setlocal
set "SCRIPT=%~dp0zhiyi-setup.ps1"
if not exist "%SCRIPT%" (
  echo.
  echo [错误] 找不到 zhiyi-setup.ps1
  echo        请确保 zhiyi-setup.cmd 和 zhiyi-setup.ps1 在同一个文件夹里。
  echo.
  pause
  endlocal & exit /b 2
)
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" %*
set "EXITCODE=%ERRORLEVEL%"
if "%~1"=="" pause
endlocal & exit /b %EXITCODE%
