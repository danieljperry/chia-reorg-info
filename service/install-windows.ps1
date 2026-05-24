# install-windows.ps1 — install the chia-reorg-info re-org monitor as a Windows
# service using NSSM (https://nssm.cc).
#
# Prerequisites:
#   - Node.js installed and on PATH
#   - NSSM downloaded; either on PATH or use -NssmPath to point at nssm.exe
#   - PowerShell run as Administrator (required by NSSM)
#
# Usage:
#
#   PS> .\install-windows.ps1 `
#         -InstallPath  'C:\Users\me\chia-reorg-info' `
#         -Recipient    'you@example.com:1' `
#         -SmtpEnvFile  'C:\Users\me\chia-reorg-info.env'
#
# Stop / uninstall:
#
#   PS> nssm stop   ChiaReorgMonitor
#   PS> nssm remove ChiaReorgMonitor confirm

param(
  [string]$ServiceName = 'ChiaReorgMonitor',
  [Parameter(Mandatory)] [string]$InstallPath,
  [Parameter(Mandatory)] [string]$Recipient,
  [Parameter(Mandatory)] [string]$SmtpEnvFile,
  [string]$Network = 'mainnet',
  [string]$NssmPath = 'nssm.exe',
  [string]$NodePath = (Get-Command node.exe -ErrorAction Stop).Source
)

$ErrorActionPreference = 'Stop'

$entry = Join-Path $InstallPath 'dist\index.js'
if (-not (Test-Path $entry)) {
  throw "Could not find $entry — run 'npm run build' in $InstallPath first."
}
if (-not (Test-Path $SmtpEnvFile)) {
  throw "SMTP env file not found: $SmtpEnvFile"
}

$arguments = @(
  '"' + $entry + '"',
  'reorg_monitor',
  '--network', $Network,
  '--recipient', $Recipient,
  '--smtp-env-file', '"' + $SmtpEnvFile + '"'
) -join ' '

Write-Host "Installing service '$ServiceName'..."
& $NssmPath install $ServiceName $NodePath $arguments
& $NssmPath set     $ServiceName AppDirectory $InstallPath
& $NssmPath set     $ServiceName Start SERVICE_AUTO_START
& $NssmPath set     $ServiceName AppStdout (Join-Path $env:USERPROFILE 'logs\reorg_monitor.nssm.out')
& $NssmPath set     $ServiceName AppStderr (Join-Path $env:USERPROFILE 'logs\reorg_monitor.nssm.err')

Write-Host "Starting service..."
& $NssmPath start $ServiceName

Write-Host ""
Write-Host "Installed. Logs:"
Write-Host "  $env:USERPROFILE\logs\reorg_monitor.log         (the monitor's own log)"
Write-Host "  $env:USERPROFILE\logs\reorg_monitor.nssm.err    (stderr captured by NSSM)"
