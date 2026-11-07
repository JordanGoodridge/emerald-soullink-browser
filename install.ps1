# Hydrates the upstream tripplyons/pokeemerald-wasm source tree, applies
# PokeTech's patches, and optionally builds the WebAssembly runtime and static
# deployment bundle.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File .\install.ps1
#   powershell -ExecutionPolicy Bypass -File .\install.ps1 -Build

param(
    [switch]$Build,
    [switch]$Verify
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path

Push-Location $root
try {
    $argsList = @('tools/install-upstream.mjs')
    if ($Verify) {
        $argsList += '--verify'
    }
    & node @argsList
    if ($LASTEXITCODE -ne 0) {
        throw "install-upstream.mjs failed with exit code $LASTEXITCODE"
    }

    if ($Build) {
        & (Join-Path $root 'build-wasm.ps1')
        & node (Join-Path $root 'deploy/build-dist.mjs')
        if ($LASTEXITCODE -ne 0) {
            throw "build-dist.mjs failed with exit code $LASTEXITCODE"
        }
    }
} finally {
    Pop-Location
}
