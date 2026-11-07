# Starts a free temporary HTTPS URL for testing.
#
# Runs three things locally and exposes them through two Cloudflare Quick Tunnels:
#   - the assembled game bundle (pokeemerald-3d/dist only)
#   - the presence and run relay
#
# The URL changes every run and this PC must stay on. For anything durable, use
# a Worker custom domain instead (see deploy/README.md).
#
#   powershell -ExecutionPolicy Bypass -File deploy/start-temp-tunnel.ps1
#   powershell -ExecutionPolicy Bypass -File deploy/start-temp-tunnel.ps1 -Build
#   powershell -ExecutionPolicy Bypass -File deploy/start-temp-tunnel.ps1 -Build -RestartRelay
# -Build refreshes the known PokeTech dist server so new MIME/upgrade routes load.
# -RestartRelay is required only when server/src/server.mjs itself changed.

param([switch]$Build, [switch]$RestartRelay)

$ErrorActionPreference = 'Stop'

$deploy = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $deploy
$dist = Join-Path $root 'pokeemerald-3d\dist'
$serverRoot = Join-Path $root 'server'
$cloudflared = Join-Path $root '.toolchain\cloudflared.exe'
$staticPort = 8090
$relayPort = 8787

function Test-Listening([int]$port) {
    return [bool](Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
}

function Get-ListenerProcesses([int]$port) {
    $processIds = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty OwningProcess -Unique
    foreach ($processId in $processIds) {
        Get-CimInstance Win32_Process -Filter "ProcessId = $processId"
    }
}

function Wait-TunnelUrl([string]$logPath) {
    for ($i = 0; $i -lt 120; $i++) {
        if (Test-Path $logPath) {
            $text = Get-Content $logPath -Raw -ErrorAction SilentlyContinue
            if ($text -match 'https://[a-z0-9-]+\.trycloudflare\.com') {
                return $Matches[0]
            }
        }
        Start-Sleep -Milliseconds 500
    }
    throw "Timed out waiting for a tunnel URL in $logPath"
}

function Get-ExistingTunnelUrl([int]$targetPort, [string]$logPath) {
    $origin = "http://127.0.0.1:$targetPort"
    $tunnels = @(Get-CimInstance Win32_Process | Where-Object {
        $executablePath = [string]$_.ExecutablePath
        $commandLine = [string]$_.CommandLine
        ([string]::Equals($executablePath, $cloudflared, [StringComparison]::OrdinalIgnoreCase) -and
            $commandLine.IndexOf($origin, [StringComparison]::OrdinalIgnoreCase) -ge 0)
    })
    if (-not $tunnels.Count) { return $null }
    if ($tunnels.Count -gt 1) {
        throw "More than one Cloudflare tunnel points at $origin; refusing to guess which URL is current."
    }
    if (-not (Test-Path $logPath)) {
        throw "An existing tunnel points at $origin but its URL log is missing: $logPath"
    }
    $text = Get-Content $logPath -Raw -ErrorAction SilentlyContinue
    $urls = [regex]::Matches($text, 'https://[a-z0-9-]+\.trycloudflare\.com')
    if (-not $urls.Count) {
        throw "An existing tunnel points at $origin but no URL was found in $logPath"
    }
    return $urls[$urls.Count - 1].Value
}

function Get-OrStartTunnel([int]$targetPort, [string]$logPath, [string]$outLog) {
    $existingUrl = Get-ExistingTunnelUrl $targetPort $logPath
    if ($existingUrl) {
        Write-Host "Reusing existing tunnel for $targetPort..."
        return $existingUrl
    }
    Remove-Item $logPath -ErrorAction SilentlyContinue
    $arguments = @('tunnel', '--url', "http://127.0.0.1:$targetPort", '--no-autoupdate')
    Start-Process -FilePath $cloudflared -ArgumentList $arguments `
        -WindowStyle Hidden `
        -RedirectStandardOutput $outLog `
        -RedirectStandardError $logPath | Out-Null
    return Wait-TunnelUrl $logPath
}

if (-not (Test-Path $cloudflared)) {
    throw "Missing $cloudflared. Download cloudflared-windows-amd64.exe into .toolchain\\cloudflared.exe"
}

if ($Build -or -not (Test-Path (Join-Path $dist 'index.html'))) {
    Write-Host 'Assembling deployment bundle...'
    node (Join-Path $deploy 'build-dist.mjs')
}

if ($Build -and (Test-Listening $staticPort)) {
    $listeners = @(Get-ListenerProcesses $staticPort)
    foreach ($process in $listeners) {
        $commandLine = [string]$process.CommandLine
        $scriptMatch = $commandLine -match '(?i)deploy[\\/]+serve-dist\.mjs(?:["\s]|$)'
        $portMatch = $commandLine -match "(?:^|\s)$staticPort(?:\s|$)"
        if (-not ($scriptMatch -and $portMatch)) {
            throw "Port $staticPort is held by an unrecognized process (PID $($process.ProcessId)); refusing to stop it."
        }
    }
    foreach ($process in $listeners) {
        Stop-Process -Id $process.ProcessId -Force
    }
    for ($i = 0; $i -lt 40 -and (Test-Listening $staticPort); $i++) {
        Start-Sleep -Milliseconds 250
    }
    if (Test-Listening $staticPort) {
        throw "PokeTech dist server did not release port $staticPort after rebuild."
    }
}

if ($RestartRelay -and (Test-Listening $relayPort)) {
    $listeners = @(Get-ListenerProcesses $relayPort)
    foreach ($process in $listeners) {
        $commandLine = [string]$process.CommandLine
        $scriptMatch = $commandLine -match '(?i)src[\\/]server\.mjs(?:["\s]|$)'
        if (-not $scriptMatch) {
            throw "Port $relayPort is held by an unrecognized process (PID $($process.ProcessId)); refusing to stop it."
        }
    }
    foreach ($process in $listeners) {
        Stop-Process -Id $process.ProcessId -Force
    }
    for ($i = 0; $i -lt 40 -and (Test-Listening $relayPort); $i++) {
        Start-Sleep -Milliseconds 250
    }
    if (Test-Listening $relayPort) {
        throw "PokeTech relay did not release port $relayPort after rebuild."
    }
}

function Start-DetachedProcess([string]$commandLine) {
    # Launch via wscript.exe (GUI subsystem) under WMI so it escapes job objects AND never opens a console/Terminal window.
    $vbsPath = Join-Path $deploy ("launch-hidden-" + [guid]::NewGuid().ToString('N') + ".vbs")
    $escaped = $commandLine.Replace('"', '""')
    Set-Content -Path $vbsPath -Value "CreateObject(""WScript.Shell"").Run ""$escaped"", 0, False" -Encoding ASCII
    $res = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
        CommandLine = "wscript.exe //B //NoLogo `"$vbsPath`""
    }
    Start-Sleep -Milliseconds 500
    Remove-Item $vbsPath -Force -ErrorAction SilentlyContinue
    if ($res.ReturnValue -ne 0) {
        throw "Failed to start detached process: $commandLine (ReturnValue $($res.ReturnValue))"
    }
}

if (-not (Test-Listening $relayPort)) {
    Write-Host "Starting relay on $relayPort..."
    $relayOut = Join-Path $deploy 'relay.out.log'
    $relayErr = Join-Path $deploy 'relay.err.log'
    $cmd = "cmd.exe /c cd /d `"$serverRoot`" && node src/server.mjs > `"$relayOut`" 2> `"$relayErr`""
    Start-DetachedProcess $cmd
}

if (-not (Test-Listening $staticPort)) {
    Write-Host "Starting static server on $staticPort..."
    $staticOut = Join-Path $deploy 'static.out.log'
    $staticErr = Join-Path $deploy 'static.err.log'
    $serveScript = Join-Path $deploy 'serve-dist.mjs'
    $cmd = "cmd.exe /c cd /d `"$root`" && node `"$serveScript`" $staticPort > `"$staticOut`" 2> `"$staticErr`""
    Start-DetachedProcess $cmd
}

for ($i = 0; $i -lt 40 -and -not (Test-Listening $staticPort); $i++) {
    Start-Sleep -Milliseconds 250
}
if (-not (Test-Listening $staticPort)) {
    $detail = Get-Content (Join-Path $deploy 'static.err.log') -Tail 20 -ErrorAction SilentlyContinue
    throw "Static server did not start listening on $staticPort. $detail"
}

Start-Sleep -Seconds 2

Write-Host 'Opening or reusing Cloudflare tunnels...'
$staticUrl = Get-OrStartTunnel $staticPort (Join-Path $deploy 'tunnel-static.log') (Join-Path $deploy 'tunnel-static.out.log')
$relayUrl = Get-OrStartTunnel $relayPort (Join-Path $deploy 'tunnel-relay.log') (Join-Path $deploy 'tunnel-relay.out.log')

$presence = $relayUrl -replace '^https://', 'wss://'
$presence = "$presence/presence"
$run = $relayUrl -replace '^https://', 'wss://'
$run = "$run/run"

Write-Host ''
Write-Host "Game:     $staticUrl"
Write-Host "Presence: $presence"
Write-Host "Run:      $run"
Write-Host ''
Write-Host "Open this: $staticUrl/"
Write-Host ''
Write-Host 'Share the game link with a friend. It proxies /presence and /run to the relay, so'
Write-Host 'no extra parameter is needed and every player must use this same link.'
Write-Host 'Keep this PC on; both tunnels and the two local servers must stay running.'
