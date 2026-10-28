@echo off
setlocal
set "SCRIPT=%~dp0zhiyi-setup.ps1"
if not exist "%SCRIPT%" (
  echo Zhiyi setup script not found: "%SCRIPT%" 1>&2
  endlocal & exit /b 2
)
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" %*
set "EXITCODE=%ERRORLEVEL%"
endlocal & exit /b %EXITCODE%
