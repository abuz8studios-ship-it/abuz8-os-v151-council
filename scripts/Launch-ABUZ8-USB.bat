@echo off
REM ABUZ8 OS — portable USB launcher. Drop this next to "ABUZ8 OS.exe" inside the
REM win-unpacked folder, copy the whole folder onto a USB stick / external drive, and
REM run it anywhere — all data (memory, chain, models, config) is stored on the USB
REM itself in ABUZ8_OS_Data (nothing is written to the host machine).
setlocal
set "ABUZ8_DATA_DIR=%~dp0ABUZ8_OS_Data"
if not exist "%ABUZ8_DATA_DIR%" mkdir "%ABUZ8_DATA_DIR%"
start "" "%~dp0ABUZ8 OS.exe"
endlocal
