@echo off
title Super Battle Chess Server
cd /d "%~dp0"

set NODE=node
where node >nul 2>nul
if errorlevel 1 set "NODE=C:\Program Files\nodejs\node.exe"

if not exist node_modules (
    echo Installing dependencies...
    if exist "C:\Program Files\nodejs\npm.cmd" (
        call "C:\Program Files\nodejs\npm.cmd" install
    ) else (
        call npm install
    )
)

start "" http://localhost:3000
"%NODE%" server.js
pause
