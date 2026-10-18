@echo off
chcp 65001 > nul
cd /d "%~dp0"
title 짱구 서버
node server.js
pause
