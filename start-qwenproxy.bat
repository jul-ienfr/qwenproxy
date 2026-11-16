@echo off
chcp 65001 >nul
setlocal EnableExtensions
cd /d "%~dp0"
title QwenProxy

where node >nul 2>&1
if errorlevel 1 (
  echo [ERREUR] Node.js introuvable. Installe Node.js 24+ depuis https://nodejs.org
  pause
  exit /b 1
)

node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 24 ? 0 : 1)" >nul 2>&1
if errorlevel 1 (
  echo [ERREUR] Le GUI QwenProxy necessite Node.js 24+.
  echo Pour le serveur sans GUI : scripts\start.bat
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo [INFO] node_modules absent - installation...
  call npm install
  if errorlevel 1 (
    echo [ERREUR] npm install a echoue.
    pause
    exit /b 1
  )
)

if not exist "node_modules\@webviewjs\webview" (
  echo [INFO] Module GUI absent - installation...
  call npm install --include=optional
  if not exist "node_modules\@webviewjs\webview" (
    echo [ERREUR] @webviewjs/webview est introuvable.
    echo Installe-le avec : npm install @webviewjs/webview
    pause
    exit /b 1
  )
)

if not exist "data\logs" mkdir "data\logs" >nul 2>&1

set "QWENPROXY_GUI_ARGS=%*"
echo QwenProxy - lancement du GUI...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $running=Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match 'gui[\\/]main' }; if ($running) { Write-Host ('QwenProxy GUI deja en cours (pid ' + (($running | ForEach-Object { $_.ProcessId }) -join ',') + ').'); try { $w0=New-Object -ComObject WScript.Shell; for ($i=0; $i -lt 8; $i++) { if ($w0.AppActivate('QwenProxy Dashboard')) { break }; Start-Sleep -Milliseconds 300 } } catch {}; exit 0 }; $logDir=Join-Path (Get-Location) 'data\logs'; New-Item -ItemType Directory -Force -Path $logDir | Out-Null; $out=Join-Path $logDir 'gui-launcher.log'; $err=Join-Path $logDir 'gui-launcher.err.log'; $guiArgs='bin\qwenproxy.js gui'; if ($env:QWENPROXY_GUI_ARGS) { $guiArgs += ' ' + $env:QWENPROXY_GUI_ARGS }; $p=Start-Process -FilePath 'node' -ArgumentList $guiArgs -WorkingDirectory (Get-Location) -WindowStyle Hidden -RedirectStandardOutput $out -RedirectStandardError $err -PassThru; $alive=$false; for ($i=0; $i -lt 10; $i++) { Start-Sleep -Milliseconds 300; if (Get-Process -Id $p.Id -ErrorAction SilentlyContinue) { $alive=$true; break } }; if (-not $alive) { if ((Get-Item -LiteralPath $err -ErrorAction SilentlyContinue).Length -gt 0) { Write-Host 'Le GUI a quitte immediatement :'; Get-Content -LiteralPath $err -Tail 15; exit 1 }; exit 0 }; try { $ws=New-Object -ComObject WScript.Shell; for ($i=0; $i -lt 8; $i++) { if ($ws.AppActivate('QwenProxy Dashboard')) { break }; Start-Sleep -Milliseconds 400 } } catch {}; Write-Host 'GUI lance. Fermer la fenetre la masque dans la zone de notification.'; Write-Host 'Pour quitter : icone QwenProxy, clic droit, menu Quit.'; exit 0"
if errorlevel 1 (
  echo.
  echo [ERREUR] Impossible de lancer le GUI QwenProxy.
  echo Logs : data\logs\gui-launcher.err.log
  pause
  exit /b 1
)

ping -n 5 127.0.0.1 >nul 2>&1
endlocal
exit /b 0
