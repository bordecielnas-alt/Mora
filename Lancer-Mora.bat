@echo off
setlocal EnableExtensions
title Mora
rem Lanceur Windows de Mora : double-clique ce fichier.
rem Marche place a la racine du projet (a cote de mora-app) ou dans mora-app.

set "APPDIR=%~dp0"
if exist "%~dp0mora-app\package.json" set "APPDIR=%~dp0mora-app\"
if not exist "%APPDIR%package.json" (
  echo [Mora] Dossier de l'app introuvable a cote de ce lanceur.
  pause
  exit /b 1
)
cd /d "%APPDIR%"

rem 1. Node.js 20 ou plus
where node >nul 2>nul
if errorlevel 1 (
  echo [Mora] Node.js n'est pas installe. Installe la version LTS depuis https://nodejs.org puis relance.
  start "" https://nodejs.org
  pause
  exit /b 1
)
for /f "tokens=1 delims=." %%v in ('node -v') do set "NODEMAJ=%%v"
set "NODEMAJ=%NODEMAJ:v=%"
if %NODEMAJ% LSS 20 (
  echo [Mora] Node.js 20 ou plus est requis. Version actuelle :
  node -v
  pause
  exit /b 1
)

rem 2. Dependances au premier lancement
if not exist "node_modules\" (
  echo [Mora] Premier lancement : installation des dependances...
  call npm install
  if errorlevel 1 (
    echo [Mora] npm install a echoue.
    pause
    exit /b 1
  )
)

rem 3. Port : celui du .env s'il est defini, sinon 3000
set "PORT=3000"
if exist ".env" (
  for /f "usebackq tokens=1,* delims==" %%a in (".env") do (
    if /i "%%a"=="PORT" set "PORT=%%b"
  )
)
set "PORT=%PORT: =%"

rem 4. Ouvre le navigateur dans 3 secondes, puis lance le serveur ici
start "" /min cmd /c "timeout /t 3 /nobreak >nul & start "" http://localhost:%PORT%"
echo [Mora] Demarrage sur http://localhost:%PORT%  (ferme cette fenetre pour arreter Mora)
call npm start

echo.
echo [Mora] Le serveur s'est arrete.
pause
