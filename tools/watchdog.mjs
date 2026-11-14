#!/usr/bin/env node
// Watchdog: keep the specialist-subagents daemon up, started from outside any host.
//
// Why a process started at logon rather than a scheduled task: registering a task needs elevation
// (`Register-ScheduledTask` answers "拒绝访问" for an Interactive principal on this machine), and the
// watchdog has to be installable without it. tools/install-watchdog.ps1 drops a Startup entry, which
// is already the mechanism this machine uses for the daemon's first start.
//
// Why a watchdog at all: a process started from inside the DSH host lands in the host's job object and
// is killed with it. Until 2026-09-19 the MCP bridge started the daemon on demand, so every host crash
// or restart took the service, the wall page and every running seat down with it. Started from the
// Startup folder, this process — and the daemon it starts — are outside that job entirely.
//
// It checks the port once a minute and only starts what is genuinely missing: the CLI's `start`
// health-checks 127.0.0.1 first and reports "already running", so this never races a daemon that some
// other path already brought up.
//
//   run now:  wscript tools\watchdog.vbs      (hidden, the way the Startup entry does it)
//   or:       node tools\watchdog.mjs         (foreground, for watching it work)
//   check:    node bin\specialist-subagents.mjs status

import { spawn } from 'node:child_process'
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
// Its own file, not the daemon's: two writers on one log is how the daemon's life lines went missing
// when the launcher held .data/daemon.log open through a redirect (see tools/watchdog.vbs).
const LOG = join(ROOT, '.data', 'watchdog.log')
const CLI = join(ROOT, 'bin', 'specialist-subagents.mjs')
const PORT = process.env.SPECIALIST_SUBAGENTS_PORT ?? '43130'
const INTERVAL_MS = 60_000
// How long /health may take before the daemon counts as not answering. Without a limit a daemon that
// accepted the connection and then never replied held this check for undici's default (about 5 minutes)
// while a new tick piled up every minute.
const HEALTH_TIMEOUT_MS = 5_000

function log(message) {
  try {
    mkdirSync(dirname(LOG), { recursive: true })
    appendFileSync(LOG, `${new Date().toISOString()} watchdog pid=${process.pid} ${message}\n`)
  } catch {
    // logging must never be the reason the watchdog stops watching
  }
}

// 'up' answered /health in time, 'silent' accepted the connection (or is still holding it) but gave no healthy
// answer within HEALTH_TIMEOUT_MS, 'down' refused or reset the connection: nothing is listening.
async function daemonState() {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) })
    return res.ok ? 'up' : 'silent'
  } catch (error) {
    return error?.name === 'TimeoutError' ? 'silent' : 'down'
  }
}

async function tick() {
  const state = await daemonState()
  if (state === 'up') return
  if (state === 'silent') {
    // Deliberately not started and not killed. From out here a wedged daemon cannot be told from a busy
    // one, and killing a busy one takes its seats' settle step with it; starting a second one only fails
    // on the taken port (and, run with stdio ignored, says nothing about why). So it is logged, once per
    // tick, and left to a person.
    log(`daemon on port ${PORT} gave no healthy /health answer within ${HEALTH_TIMEOUT_MS / 1000}s (timed out, or replied with an error); it may be wedged or just busy, so it is NOT being restarted. If this line keeps repeating, stop it by hand (node bin/specialist-subagents.mjs stop; if that does not answer either, end its process using the pid in .data/daemon.json) and this watchdog starts a fresh one within a minute`)
    return
  }
  log('daemon is down; starting it')
  const child = spawn(process.execPath, [CLI, 'start'], { cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: true })
  child.unref()
}

log(`watchdog started (port ${PORT}, every ${INTERVAL_MS / 1000}s)`)
tick().catch((error) => log(`first tick failed: ${error?.message ?? error}`))
setInterval(() => {
  tick().catch((error) => log(`tick failed: ${error?.message ?? error}`))
}, INTERVAL_MS)
