@echo off
chcp 65001 >nul
cd /d F:\janseeV2
set "NODE=D:\node\node-v22.23.2-win-x64\node.exe"
if not exist "%NODE%" set "NODE=node"

echo ============================================
echo  简兮 JANSEE - 一键启动 3000 网关 + 3001 后台
echo ============================================

echo [1/3] 停止旧的 3000 / 3001 进程 ...
powershell -NoProfile -Command "$p=@(3000,3001); foreach($x in $p){ $c=Get-NetTCPConnection -LocalPort $x -State Listen -ErrorAction SilentlyContinue; if($c){ Stop-Process -Id $c[0].OwningProcess -Force -ErrorAction SilentlyContinue } }"
timeout /t 3 /nobreak >nul

echo [2/3] 启动 3000 网关 与 3001 后台 ...
start "JANSEE-GATEWAY-3000" /min "%NODE%" apps\web\server\index.mjs
start "JANSEE-ADMIN-3001" /min /d "F:\janseeV2\apps\admin" "%NODE%" dev-server.mjs
timeout /t 8 /nobreak >nul

echo [3/3] 健康检查 ...
powershell -NoProfile -Command "foreach($x in @(3000,3001)){ try{ $r=Invoke-WebRequest -UseBasicParsing ('http://127.0.0.1:'+$x+'/') -TimeoutSec 6; Write-Host ('  端口 '+$x+' 正常 HTTP '+$r.StatusCode) } catch { Write-Host ('  端口 '+$x+' 启动失败') } }"

echo.
echo 前台页面  http://localhost:3000
echo 管理后台  http://localhost:3000/admin  或  http://localhost:3001
echo.
if "%~1"=="--no-pause" exit /b 0
pause
