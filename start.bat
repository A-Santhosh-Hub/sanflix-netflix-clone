@echo off
setlocal
title SANFLIX - Personal Media Library
cd /d "%~dp0"
if not defined SANFLIX_PORT set "SANFLIX_PORT=5000"
if not defined SANFLIX_HOST set "SANFLIX_HOST=0.0.0.0"
if /i "%~1"=="dev" set "SANFLIX_DEV=1"
echo Checking configuration...
python serve.py --check
if errorlevel 1 goto config_failed
echo Scanning your media library...
python scan_media.py
if errorlevel 1 goto failed
echo Preparing HLS in the background. Progress: database\hls-conversion.log
start "" /b python convert_hls.py >"database\hls-conversion.log" 2>&1
start "" /b python -c "import os,time,webbrowser; time.sleep(2); webbrowser.open('http://localhost:' + os.environ.get('SANFLIX_PORT','5000'))"
echo Starting SANFLIX. Network addresses are shown below.
echo If Windows asks, allow Python on Private networks so other devices can connect.
if defined SANFLIX_DEV (python app.py) else (python serve.py)
echo Server stopped. Background conversion may continue until its queue finishes.
pause
exit /b
:config_failed
echo.
echo SANFLIX did not start because its security settings are incomplete.
pause
exit /b 2
:failed
echo The scan failed. Check Python, FFmpeg and FFprobe. Your existing catalog was kept.
pause
exit /b 1
