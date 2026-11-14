' Watchdog launcher for the specialist-subagents daemon.
'
' Installed into the Startup folder by tools/install-watchdog.ps1, which substitutes __REPO__ with
' this repository's path — the installed copy cannot find the repository from its own location. A copy
' still living in tools/ resolves it on its own, so it can be run by hand from there too.
'
' It starts tools/watchdog.mjs hidden; that process checks 127.0.0.1:43130 once a minute and starts the
' daemon whenever it is missing. Window style 0 is a hidden window, so logon never flashes a console.
'
' No stdout redirection on purpose. The first version ended in `>> .data\daemon.log 2>&1`, and because
' the watchdog never exits, that cmd held the log file open for the machine's whole uptime: the daemon
' could not append its own life lines to it (EBUSY, swallowed by the logger) and the daemon's own log
' stayed empty. The watchdog writes .data/watchdog.log itself; the daemon owns .data/daemon.log.
'
' Why the Startup folder owns the lifetime instead of the DSH bridge: a process started from inside the
' host lands in the host's job object and is killed with it. Until 2026-09-19 the bridge started the
' daemon on demand, so every host crash or restart took the service, the wall page and every running
' seat down with it. Started from here, the daemon is outside that job and survives.
Option Explicit

Dim fso, shell, scriptDir, repoDir, candidate
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
repoDir = "__REPO__"

' A copy living in <repo>\tools finds the repository one level up; the installed copy keeps the path
' the installer wrote.
candidate = fso.GetParentFolderName(scriptDir)
If fso.FileExists(fso.BuildPath(candidate, "bin\specialist-subagents.mjs")) Then
  repoDir = candidate
End If

shell.CurrentDirectory = repoDir
shell.Run "cmd /c node tools\watchdog.mjs", 0, False