# Serves the game and multiplayer relay at http://localhost:8000 (and on your LAN / Tailscale IP).
# Run from anywhere:  powershell -ExecutionPolicy Bypass -File .\serve-local.ps1
# Requires a prior .\build-wasm.ps1 build.

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$repo = Join-Path $root 'pokeemerald-3d'
$serverDir = Join-Path $root 'server'
$wasm = Join-Path $repo 'build\wasm\pokeemerald.wasm'

if (-not (Test-Path $wasm)) {
    throw "Missing $wasm. Run .\build-wasm.ps1 first."
}

if (-not (Test-Path (Join-Path $serverDir 'node_modules'))) {
    Write-Host "Installing relay dependencies in server/..."
    Push-Location $serverDir
    try {
        npm install --no-audit --no-fund
    } finally {
        Pop-Location
    }
}

$relayListening = [bool](Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue)
$relayProc = $null

Push-Location $repo
try {
    if (-not $relayListening) {
        Write-Host "Starting multiplayer relay on port 8787..."
        $relayProc = Start-Process -FilePath "node" -ArgumentList "src/server.mjs" -WorkingDirectory $serverDir -PassThru -NoNewWindow
    } else {
        Write-Host "Multiplayer relay already running on port 8787."
    }
    node web/server.mjs
} finally {
    if ($relayProc -and -not $relayProc.HasExited) {
        Stop-Process -Id $relayProc.Id -Force -ErrorAction SilentlyContinue
    }
    Pop-Location
}
