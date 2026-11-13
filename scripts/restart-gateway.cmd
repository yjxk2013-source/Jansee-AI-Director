@echo off
chcp 65001 >nul
cd /d F:\janseeV2
set "NODE=D:\node\node-v22.23.2-win-x64\node.exe"
if not exist "%NODE%" set "NODE=node"

echo [1/3] stopping old gateway ...
powershell -NoProfile -Command "$c=Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue; if($c){Stop-Process -Id $c[0].OwningProcess -Force -ErrorAction SilentlyContinue}"
timeout /t 3 /nobreak >nul

echo [2/3] starting gateway with latest code ...
start "JANSEE-GATEWAY" /min "%NODE%" apps\web\server\index.mjs
timeout /t 8 /nobreak >nul

echo [3/3] health check ...
powershell -NoProfile -Command "try{(Invoke-WebRequest -UseBasicParsing http://127.0.0.1:3000/ -TimeoutSec 5)|Out-Null;Write-Host 'gateway OK' -ForegroundColor Green}catch{Write-Host 'gateway FAILED' -ForegroundColor Red}"
echo.
pause
