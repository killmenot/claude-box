@echo off
rem claude-box launcher for Windows (WSL2 + Docker Desktop): brings up the web UI.
rem This file stays pure ASCII on purpose. The folder path (which may contain
rem Cyrillic/spaces) is taken at runtime via %~dp0 and converted to a WSL path
rem by wslpath inside bash, so no non-ASCII ever lives in this .bat.
rem The first start asks for the workspace folder and the web login, so it runs in a console.

wsl.exe -d Ubuntu bash -lic "bash \"$(wslpath -u '%~dp0')claude-box\" %*"
set "RC=%errorlevel%"

if not "%RC%"=="0" (
  echo.
  echo [claude-box] Exited with code %RC%.
  echo  - "docker: command not found"            -^> enable Docker Desktop WSL Integration for your distro
  echo  - "cannot connect to the Docker daemon"  -^> start Docker Desktop, wait until it is running
  echo  - "No such file or directory"            -^> tell me, the path conversion failed
  echo.
)
pause
