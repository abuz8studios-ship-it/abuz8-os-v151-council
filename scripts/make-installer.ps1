# Build ABUZ8-Setup.exe — a single one-click installer (GUI self-extractor) that
# bundles the app + brains + data in ONE file. The customer double-clicks once:
# it shows a progress window, deploys to LocalAppData (no admin), creates Start
# Menu + Desktop shortcuts AND a real uninstaller / Add-Remove-Programs entry,
# then launches. Fully offline; runs on any Windows 10/11 x64.
$ErrorActionPreference = 'Stop'
$install = "$env:LOCALAPPDATA\Programs\ABUZ8 OS"
$data    = "$env:APPDATA\abuz8-os"
$z7a     = "C:\tmp\7zextra\7za.exe"
$sfx     = "C:\tmp\7zinstall\7z.sfx"            # GUI SFX module (windowed progress)
$stage   = "C:\tmp\abuz8-stage"
$arc     = "C:\tmp\abuz8-bundle.7z"
$out     = "C:\tmp\ABUZ8-Setup.exe"

Write-Host "Staging..."
if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
New-Item -ItemType Directory -Force -Path "$stage" | Out-Null
robocopy "$install" "$stage\ABUZ8 OS" /E /NFL /NDL /NJH /NJS /NP /XF "app.asar.bak-*" | Out-Null
# Brain ships WITH the installer (Gemma 4 E4B omni + nano floor). Do NOT strip GGUFs here.
New-Item -ItemType Directory -Force -Path "$stage\ABUZ8_OS_Data" | Out-Null
foreach ($d in 'config','soul','skills','mcp','memory','mission','attachments','models','exports') {
  if (Test-Path "$data\$d") { robocopy "$data\$d" "$stage\ABUZ8_OS_Data\$d" /E /NFL /NDL /NJH /NJS /NP | Out-Null }
}

# install.bat — runs after extraction: deploy, shortcuts, uninstaller, ARP entry, launch.
$installer = @'
@echo off
title ABUZ8 OS Setup  v1.23
set "DEST=%LOCALAPPDATA%\ABUZ8 OS"
set "RK=HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\ABUZ8OS"
cls
echo  ============================================================
echo            ABUZ8 OS  -  Sovereign Agent  Setup  v1.23
echo  ============================================================
echo.
echo   Installing to: %DEST%
echo   One-time copy of the agent + brains (~4.5 GB). Please wait...
echo.
robocopy "%~dp0ABUZ8 OS" "%DEST%\ABUZ8 OS" /E /NFL /NDL /NJH /NJS /NP >nul
robocopy "%~dp0ABUZ8_OS_Data" "%DEST%\ABUZ8_OS_Data" /E /NFL /NDL /NJH /NJS /NP >nul
> "%DEST%\Launch-ABUZ8.bat" echo @echo off
>> "%DEST%\Launch-ABUZ8.bat" echo set "HERE=%%~dp0"
>> "%DEST%\Launch-ABUZ8.bat" echo set "ABUZ8_DATA_DIR=%%HERE%%ABUZ8_OS_Data"
>> "%DEST%\Launch-ABUZ8.bat" echo start "" "%%HERE%%ABUZ8 OS\ABUZ8 OS.exe"
powershell -NoProfile -Command "$w=New-Object -ComObject WScript.Shell; foreach($p in @([Environment]::GetFolderPath('Desktop'), ([Environment]::GetFolderPath('StartMenu')+'\Programs'))){ $s=$w.CreateShortcut($p+'\ABUZ8 OS.lnk'); $s.TargetPath='%DEST%\Launch-ABUZ8.bat'; $s.WorkingDirectory='%DEST%'; $s.IconLocation='%DEST%\ABUZ8 OS\ABUZ8 OS.exe,0'; $s.Save() }" 2>nul
> "%DEST%\Uninstall-ABUZ8.bat" echo @echo off
>> "%DEST%\Uninstall-ABUZ8.bat" echo echo Removing ABUZ8 OS...
>> "%DEST%\Uninstall-ABUZ8.bat" echo reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\ABUZ8OS" /f ^>nul 2^>^&1
>> "%DEST%\Uninstall-ABUZ8.bat" echo del "%%USERPROFILE%%\Desktop\ABUZ8 OS.lnk" ^>nul 2^>^&1
>> "%DEST%\Uninstall-ABUZ8.bat" echo del "%%APPDATA%%\Microsoft\Windows\Start Menu\Programs\ABUZ8 OS.lnk" ^>nul 2^>^&1
>> "%DEST%\Uninstall-ABUZ8.bat" echo cd /d "%%LOCALAPPDATA%%"
>> "%DEST%\Uninstall-ABUZ8.bat" echo timeout /t 1 ^>nul
>> "%DEST%\Uninstall-ABUZ8.bat" echo rmdir /s /q "%LOCALAPPDATA%\ABUZ8 OS"
reg add "%RK%" /v DisplayName /t REG_SZ /d "ABUZ8 OS" /f >nul
reg add "%RK%" /v DisplayVersion /t REG_SZ /d "1.23.0" /f >nul
reg add "%RK%" /v Publisher /t REG_SZ /d "ABUZ8" /f >nul
reg add "%RK%" /v DisplayIcon /t REG_SZ /d "%DEST%\ABUZ8 OS\ABUZ8 OS.exe" /f >nul
reg add "%RK%" /v InstallLocation /t REG_SZ /d "%DEST%" /f >nul
reg add "%RK%" /v UninstallString /t REG_SZ /d "\"%DEST%\Uninstall-ABUZ8.bat\"" /f >nul
reg add "%RK%" /v EstimatedSize /t REG_DWORD /d 4718592 /f >nul
reg add "%RK%" /v NoModify /t REG_DWORD /d 1 /f >nul
reg add "%RK%" /v NoRepair /t REG_DWORD /d 1 /f >nul
echo.
echo   Installed. A shortcut "ABUZ8 OS" is on your Desktop and Start Menu,
echo   and it now appears in Settings ^> Apps as "ABUZ8 OS 1.23.0" (removable).
echo   Launching now...
start "" "%DEST%\Launch-ABUZ8.bat"
timeout /t 2 >nul
'@
Set-Content -Path "$stage\install.bat" -Value $installer -Encoding ASCII

Write-Host "Archiving (store mode; models are already compressed)..."
if (Test-Path $arc) { Remove-Item -Force $arc }
& $z7a a -mx0 "$arc" "$stage\*" | Out-Null

# SFX config: run install.bat after extraction (GUI module shows a progress window).
$cfg = "C:\tmp\sfxcfg.txt"
$config = ";!@Install@!UTF-8!`r`nTitle=`"ABUZ8 OS Setup`"`r`nBeginPrompt=`"Install ABUZ8 OS v1.23 (the sovereign agent + offline brain)?`"`r`nRunProgram=`"install.bat`"`r`n;!@InstallEnd@!`r`n"
[System.IO.File]::WriteAllText($cfg, $config, [System.Text.Encoding]::UTF8)

Write-Host "Concatenating SFX -> $out"
if (Test-Path $out) { Remove-Item -Force $out }
cmd /c copy /b "`"$sfx`"" + "`"$cfg`"" + "`"$arc`"" "`"$out`"" | Out-Null

$mb = (Get-Item $out).Length / 1MB
Write-Host ("DONE: {0} ({1:N0} MB)" -f $out, $mb) -ForegroundColor Green
