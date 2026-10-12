@echo off
REM start-mincomfy.bat
REM Put this folder inside your ComfyUI_windows_portable folder (any name is fine).
REM 1. If ComfyUI is already running on http://127.0.0.1:8188, it is NOT started again.
REM 2. Otherwise it looks for run_nvidia_gpu.bat in the parent folder, the grandparent
REM    folder, and this folder. If not found, it asks for the full path.
REM 3. It starts ComfyUI in its own window, waits for it, then starts MinComfy UI.

setlocal
cd /d "%~dp0"
set "COMFY_BAT="

call :isup
if not errorlevel 1 (
  echo [MinComfy] ComfyUI is already running at http://127.0.0.1:8188. Not starting it again.
  goto deps
)

echo [MinComfy] ComfyUI is not running yet. Looking for run_nvidia_gpu.bat...
call :findbat "%~dp0.."
if not defined COMFY_BAT call :findbat "%~dp0..\.."
if not defined COMFY_BAT call :findbat "%~dp0"

if not defined COMFY_BAT (
  echo [MinComfy] run_nvidia_gpu.bat was not found automatically.
  echo Looked in:
  echo   %~dp0..
  echo   %~dp0..\..
  echo   %~dp0
  echo.
  echo .bat files in the parent folder ^(%~dp0..^):
  dir /b "%~dp0..\*.bat" 2>nul
  echo.
  set /p "COMFY_BAT=Paste the full path to run_nvidia_gpu.bat, or press Enter to quit: "
)

if not defined COMFY_BAT goto nobat
if not exist "%COMFY_BAT%" goto nobat
for %%I in ("%COMFY_BAT%") do set "COMFY_DIR=%%~dpI"
echo [MinComfy] Using: %COMFY_BAT%

echo [MinComfy] Starting ComfyUI in a separate window...
start "ComfyUI (run_nvidia_gpu)" /d "%COMFY_DIR%" cmd /k ""%COMFY_BAT%""

echo [MinComfy] Waiting for ComfyUI at http://127.0.0.1:8188 ...
set /a TRIES=0
:waitloop
set /a TRIES+=1
call :isup
if not errorlevel 1 goto ready
if %TRIES% GEQ 90 (
  echo [MinComfy] ComfyUI did not respond after about 3 minutes. Check the ComfyUI window for errors.
  echo Starting MinComfy UI anyway. Use Refresh in Settings - ComfyUI once ComfyUI is up.
  goto deps
)
timeout /t 2 /nobreak >nul
goto waitloop

:ready
echo [MinComfy] ComfyUI is up.
goto deps

:nobat
echo [MinComfy] No valid run_nvidia_gpu.bat path. Nothing was started.
pause
exit /b 1

:deps
where node >nul 2>nul
if errorlevel 1 (
  echo [MinComfy] Node.js is not installed. Install the LTS version from https://nodejs.org and run this again.
  pause
  exit /b 1
)

if not exist "node_modules\" (
  echo [MinComfy] First run: installing dependencies. This can take several minutes.
  call npm install
  if errorlevel 1 (
    echo [MinComfy] npm install failed.
    pause
    exit /b 1
  )
)

echo [MinComfy] Starting MinComfy UI...
call npm run electron:dev
pause
exit /b 0

:isup
curl -s -o nul -w "%%{http_code}" http://127.0.0.1:8188/system_stats | findstr "200" >nul 2>nul
goto :eof

:findbat
if exist "%~1\run_nvidia_gpu.bat" set "COMFY_BAT=%~1\run_nvidia_gpu.bat"
goto :eof
