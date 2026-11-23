@echo off
title ZEN Tiyatrosu Sunucusu
cd /d "%~dp0"
echo ZEN Tiyatrosu baslatiliyor...
echo Tarayicida aciliyor: http://localhost:5000
start "" http://localhost:5000
python server.py
pause
