# Builds the pokeemerald-3d WebAssembly target using the project-local MSYS2 toolchain.
# Run from anywhere:  powershell -ExecutionPolicy Bypass -File .\build-wasm.ps1

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$repo = Join-Path $root 'pokeemerald-3d'
$shell = Join-Path $root '.toolchain\msys64\msys2_shell.cmd'

if (-not (Test-Path (Join-Path $repo 'Makefile'))) {
    Write-Host "Upstream pokeemerald-wasm tree not yet installed; running tools/install-upstream.mjs..."
    & node (Join-Path $root 'tools\install-upstream.mjs')
    if ($LASTEXITCODE -ne 0) {
        throw "install-upstream.mjs failed with exit code $LASTEXITCODE"
    }
}

if (-not (Test-Path $shell)) {
    throw "MSYS2 toolchain not found at $shell"
}

# Windows Python defaults to cp1252, but the game's data files are UTF-8.
$env:PYTHONUTF8 = '1'
$env:PYTHONIOENCODING = 'utf-8'

Push-Location $repo
try {
    & $shell -ucrt64 -defterm -no-start -here -c 'make -j$(nproc) wasm'
    if ($LASTEXITCODE -ne 0) {
        throw "make wasm failed with exit code $LASTEXITCODE"
    }
} finally {
    Pop-Location
}

Write-Host "Built: $repo\build\wasm\pokeemerald.wasm"
