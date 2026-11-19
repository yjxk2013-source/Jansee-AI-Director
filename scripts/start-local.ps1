$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Set-Location -LiteralPath $root
$logRoot = Join-Path $root ".local\logs"
New-Item -ItemType Directory -Path $logRoot -Force | Out-Null
$nodeExe = (Get-Command node.exe -ErrorAction Stop).Source
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"

function Test-ListeningPort([int]$Port) {
  return [bool](Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue | Select-Object -First 1)
}

function Start-NodeService([string]$Name, [string[]]$Arguments, [string]$LogName) {
  $stdout = Join-Path $logRoot "$LogName-$stamp.out.log"
  $stderr = Join-Path $logRoot "$LogName-$stamp.err.log"
  $process = Start-Process -FilePath $nodeExe -ArgumentList $Arguments -WorkingDirectory $root -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
  Write-Host "Started $Name (PID $($process.Id)); logs: $stdout"
}

function Wait-ForPort([int]$Port, [int]$Seconds, [string]$Service) {
  $deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $deadline) {
    if (Test-ListeningPort $Port) { return }
    Start-Sleep -Milliseconds 500
  }
  throw "$Service did not listen on port $Port within $Seconds seconds."
}

function Test-ApiReady {
  try {
    $response = Invoke-RestMethod -Uri "http://127.0.0.1:4100/health/ready" -TimeoutSec 2
    return $response.status -eq "ready" -and $response.checks.database -eq $true -and $response.checks.worker -eq $true
  } catch {
    return $false
  }
}

if (-not (Test-Path (Join-Path $root ".env"))) {
  throw "Missing .env. Copy .env.example to .env and configure local development values first."
}
if (-not (Test-Path (Join-Path $root "node_modules"))) {
  throw "Dependencies are missing. Run npm install in the V4 repository first."
}

Write-Host "JANSEE V4 local startup" -ForegroundColor Cyan

if (-not (Test-ApiReady)) {
  if (Test-ListeningPort 4100) {
    throw "Port 4100 is occupied, but the listener is not a ready JANSEE V4 API. Stop the conflicting process and retry."
  }
  Start-NodeService "API and render worker" @("--import", "tsx", "apps/api/src/server.ts") "api"
  $deadline = (Get-Date).AddSeconds(75)
  while ((Get-Date) -lt $deadline -and -not (Test-ApiReady)) {
    Start-Sleep -Seconds 1
  }
  if (-not (Test-ApiReady)) {
    $errorLog = Get-ChildItem $logRoot -Filter "api-$stamp.err.log" | Select-Object -First 1
    $outputLog = Get-ChildItem $logRoot -Filter "api-$stamp.out.log" | Select-Object -First 1
    if ($errorLog) { Get-Content $errorLog.FullName -Tail 30 }
    if ($outputLog) { Get-Content $outputLog.FullName -Tail 30 }
    throw "JANSEE V4 API did not become ready. Check .local/logs for startup errors."
  }
} else {
  Write-Host "API, database, and render worker are already ready; reusing them."
}

if (-not (Test-ListeningPort 5173)) {
  Start-NodeService "Vite web client" @("node_modules/vite/bin/vite.js", "--host", "127.0.0.1") "web"
}
$webDeadline = (Get-Date).AddSeconds(45)
$webReady = $false
while ((Get-Date) -lt $webDeadline) {
  try {
    $response = Invoke-WebRequest -Uri "http://127.0.0.1:5173/health/ready" -UseBasicParsing -TimeoutSec 2
    if ($response.StatusCode -eq 200 -and $response.Content -match '"status"\s*:\s*"ready"') {
      $webReady = $true
      break
    }
  } catch {
    Start-Sleep -Milliseconds 750
  }
}
if (-not $webReady) {
  throw "Web client did not become ready through the API proxy. Check .local/logs and port 5173."
}

Write-Host ""
Write-Host "JANSEE V4 is ready for local testing." -ForegroundColor Green
Write-Host "Web:      http://127.0.0.1:5173/"
Write-Host "Admin:    http://127.0.0.1:5173/admin"
Write-Host "API:      http://127.0.0.1:4100/health/ready"
Write-Host "Logs:     $logRoot"
