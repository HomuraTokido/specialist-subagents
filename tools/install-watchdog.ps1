<#
  Install (or remove) the watchdog that owns the specialist-subagents daemon's lifetime.

  It drops a Startup-folder entry that launches tools/watchdog.vbs at logon; that process checks the
  port once a minute and starts the daemon when it is missing. No elevation needed — which is why this
  is a Startup entry and not a scheduled task: Register-ScheduledTask answers "拒绝访问" for an
  Interactive principal on this machine, and a watchdog nobody can install is not a watchdog.

  (An elevated scheduled task would additionally cover "runs with no logon". Add it by hand if this
  machine is ever used headless: same action, wscript.exe "<repo>\tools\watchdog.vbs".)

  Run:    pwsh -File tools/install-watchdog.ps1
          pwsh -File tools/install-watchdog.ps1 -Remove
  Check:  node bin/specialist-subagents.mjs status
          Get-Content .data\daemon.log -Tail 5
#>
[CmdletBinding()]
param([switch]$Remove)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$startup = [Environment]::GetFolderPath('Startup')
$installed = Join-Path $startup 'specialist-subagents-watchdog.vbs'
$legacy = Join-Path $startup 'specialist-subagents-daemon.vbs'

if ($Remove) {
  foreach ($file in @($installed, "$installed.disabled")) {
    if (Test-Path -LiteralPath $file) { Remove-Item -LiteralPath $file -Force; Write-Host "removed: $file" }
  }
  exit 0
}

$source = Join-Path $repo 'tools\watchdog.vbs'
if (-not (Test-Path -LiteralPath $source)) { throw "missing $source" }

# The installed copy lives in the Startup folder and cannot work out where the repository is from its
# own location (that was the first version's bug: `cmd /c node tools\watchdog.mjs` resolved against the
# Startup folder's parent and silently did nothing), so the path is written in at install time.
$content = [IO.File]::ReadAllText($source).Replace('__REPO__', $repo)
[IO.File]::WriteAllText($installed, $content, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "installed: $installed"

# The first generation started the daemon directly at logon (no watchdog, no recovery). It is
# superseded by the watchdog entry; disabled rather than deleted so it can be read or restored.
if (Test-Path -LiteralPath $legacy) {
  Move-Item -LiteralPath $legacy -Destination "$legacy.disabled" -Force
  Write-Host "superseded: $legacy -> $legacy.disabled"
}

Write-Host "run it now: wscript `"$installed`""