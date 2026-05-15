# Watchpost — Windows PowerShell launcher
#
# Usage:
#   watchpost              start the dashboard server (foreground)
#   watchpost dashboard    same as `watchpost` (compat with bash launcher)
#   watchpost status       hit /api/status to check if the server is running
#   watchpost open         open the dashboard URL in the default browser
#
# Honors WATCHPOST_DIR (defaults to repo root, two dirs up from this script).

param(
    [Parameter(Position = 0)]
    [string]$Command = 'dashboard',
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$Rest
)

$ErrorActionPreference = 'Stop'

# Resolve repo root: this file lives at <repo>/bin/watchpost.ps1
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = if ($env:WATCHPOST_DIR) { $env:WATCHPOST_DIR } else { (Resolve-Path (Join-Path $ScriptDir '..')).Path }
$DataDir = if ($env:WATCHPOST_DATA_DIR) { $env:WATCHPOST_DATA_DIR } else { Join-Path $RepoRoot 'data' }
$Port = if ($env:PORT) { $env:PORT } else { '6010' }
$Url = "http://localhost:$Port"

function Ensure-DataDir {
    if (-not (Test-Path $DataDir)) {
        New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
    }
}

function Get-NodeExe {
    $node = (Get-Command node -ErrorAction SilentlyContinue)
    if (-not $node) {
        Write-Error "Node.js not found on PATH. Install Node 18+ from https://nodejs.org/ and re-run."
        exit 1
    }
    return $node.Source
}

function Try-HttpStatus {
    try {
        $resp = Invoke-WebRequest -UseBasicParsing -Uri "$Url/api/status" -TimeoutSec 2
        return ($resp.StatusCode -eq 200)
    } catch {
        return $false
    }
}

switch ($Command.ToLower()) {
    { $_ -in @('dashboard', 'start', 'serve', 'tui', 'both') } {
        Ensure-DataDir
        $node = Get-NodeExe
        if (Try-HttpStatus) {
            Write-Host "Watchpost already running at $Url"
            exit 0
        }
        Write-Host "Starting Watchpost on $Url"
        Write-Host "  WATCHPOST_DIR = $RepoRoot"
        Write-Host "  data dir       = $DataDir"
        Push-Location $RepoRoot
        try {
            & $node 'server.js'
        } finally {
            Pop-Location
        }
    }

    'status' {
        if (Try-HttpStatus) {
            Write-Host "Watchpost is running at $Url"
            try {
                $info = Invoke-RestMethod -Uri "$Url/api/status" -TimeoutSec 2
                $info | ConvertTo-Json -Depth 5
            } catch {}
            exit 0
        } else {
            Write-Host "Watchpost is not responding at $Url"
            exit 1
        }
    }

    'open' {
        Start-Process $Url
    }

    'help' {
        Write-Host "Watchpost — Windows launcher"
        Write-Host ""
        Write-Host "Commands:"
        Write-Host "  watchpost dashboard   start the server (foreground)"
        Write-Host "  watchpost status      check if the server is running"
        Write-Host "  watchpost open        open the dashboard in your browser"
        Write-Host ""
        Write-Host "Environment:"
        Write-Host "  WATCHPOST_DIR              install location (default: $RepoRoot)"
        Write-Host "  WATCHPOST_DATA_DIR         data dir         (default: <WATCHPOST_DIR>/data)"
        Write-Host "  WATCHPOST_PROJECTS_FILE    projects.json    (default: <WATCHPOST_DIR>/projects.json)"
        Write-Host "  PORT                       server port      (default: 6010)"
    }

    default {
        Write-Error "Unknown command: $Command. Try: watchpost help"
        exit 2
    }
}
