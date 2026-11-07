@echo off
rem ============================================================================
rem  QwenProxy (johngbl) - Lanceur rapide
rem  Double-clique pour demarrer le serveur sur http://127.0.0.1:3000/v1
rem  Pour le dashboard terminal : npm run tui (arreter le serveur avant)
rem ============================================================================
setlocal
cd /d "%~dp0"
title QwenProxy

where node >nul 2>&1
if errorlevel 1 (
  echo [ERREUR] Node.js introuvable. Installe Node.js 22+ depuis https://nodejs.org
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

echo.
echo  QwenProxy - demarrage...
echo  API    : http://127.0.0.1:3000/v1
echo  Health : http://127.0.0.1:3000/health
echo.

call npm start --silent
if errorlevel 1 (
  echo.
  echo [ERREUR] Le serveur s'est arrete. Verifie que le port 3000 est libre.
  pause
)
endlocal
