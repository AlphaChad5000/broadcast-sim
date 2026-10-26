@echo off
cd /d "%~dp0"
start "" http://localhost:8060
node server.mjs
