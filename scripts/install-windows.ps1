# Watchpost — Windows installer
#
# Installs:
#   1. Node dependencies (`npm install`).
#   2. A `watchpost` shim on PATH (added to user PATH if not already present).
#   3. (Optional) A Windows Scheduled Task that starts Watchpost at user logon.
#
# Usage:
#   .\scripts\install-windows.ps1                 install + add to PATH
#   .\scripts\install-windows.ps1 -InstallService also register start-on-logon
#   .\scripts\install-windows.ps1 -Uninstall      remove the scheduled task
#
# Run from a normal PowerShell window (no admin needed for user PATH or user
# scheduled tasks). For all-users PATH or admin tasks you'd need elevation,
# but Watchpost is designed for per-user install.

param(
    [switch]$InstallService,
    [switch]$Uninstall,
    [string]$ServiceName = 'Watchpost',
    [int]$Port = 6010
)

$ErrorActionPreference = 'Stop'

$RepoRoot = (Resolve-Path (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) '..')).Path
$BinDir = Join-Path $RepoRoot 'bin'
$Cmd = Join-Path $BinDir 'watchpost.cmd'
$Ps1 = Join-Path $BinDir 'watchpost.ps1'

function Add-ToUserPath {
    param([string]$Dir)
    $current = [Environment]::GetEnvironmentVariable('Path', 'User')
    if (-not $current) { $current = '' }
    $segments = $current.Split(';') | Where-Object { $_ -and ($_.Trim() -ne '') }
    if ($segments -contains $Dir) {
        Write-Host "  PATH already contains $Dir"
        return
    }
    $new = if ($current -and -not $current.EndsWith(';')) { "$current;$Dir" } else { "$current$Dir" }
    [Environment]::SetEnvironmentVariable('Path', $new, 'User')
    Write-Host "  Added $Dir to user PATH (restart shells to pick it up)"
}

function Remove-WatchpostScheduledTask {
    try {
        Unregister-ScheduledTask -TaskName $ServiceName -Confirm:$false -ErrorAction Stop
        Write-Host "Removed scheduled task: $ServiceName"
    } catch {
        Write-Host "No existing task '$ServiceName' (nothing to remove)."
    }
}

function Register-WatchpostScheduledTask {
    Write-Host ""
    Write-Host "Registering scheduled task '$ServiceName' (start at logon)"

    # Replace any existing version idempotently.
    Remove-WatchpostScheduledTask | Out-Null

    $action = New-ScheduledTaskAction -Execute 'powershell.exe' `
        -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$Ps1`" dashboard" `
        -WorkingDirectory $RepoRoot

    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME

    # Run only when interactive, not on battery limits.
    $settings = New-ScheduledTaskSettingsSet `
        -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries `
        -StartWhenAvailable `
        -ExecutionTimeLimit (New-TimeSpan -Hours 0) `
        -Hidden

    $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive

    Register-ScheduledTask -TaskName $ServiceName `
        -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
        -Description 'Watchpost dashboard — local AI orchestration server' | Out-Null

    Write-Host "  Scheduled task registered. It will start Watchpost at next logon."
    Write-Host "  Start it now with: Start-ScheduledTask -TaskName $ServiceName"
}

if ($Uninstall) {
    Remove-WatchpostScheduledTask
    exit 0
}

Write-Host "Watchpost — Windows install"
Write-Host "  repo:    $RepoRoot"
Write-Host "  bin dir: $BinDir"

# Sanity checks
if (-not (Test-Path $Cmd) -or -not (Test-Path $Ps1)) {
    Write-Error "Missing launcher files in $BinDir. Did you run from a fresh checkout?"
    exit 1
}

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Write-Error "Node.js not found on PATH. Install Node 18+ from https://nodejs.org/ before re-running."
    exit 1
}

# Install npm deps
Write-Host ""
Write-Host "Running: npm install"
Push-Location $RepoRoot
try {
    npm install --no-audit --no-fund
} finally {
    Pop-Location
}

# Add bin dir to user PATH
Write-Host ""
Write-Host "Updating PATH"
Add-ToUserPath $BinDir

if ($InstallService) {
    Register-WatchpostScheduledTask
}

Write-Host ""
Write-Host "Done. Open a new shell and run: watchpost"
Write-Host "Then visit http://localhost:$Port"
