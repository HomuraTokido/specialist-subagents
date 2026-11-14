// specialist-subagents demo: the ledger is outside every process, so seats outlive their callers.
// Run with: node bin/specialist-subagents.mjs demo   (or directly: node bin/demo.mjs)
//
// The demo runs a THROWAWAY service, never the live one: a copy of src/, roles/ and roles.json in a
// temp directory (so its .data/, daemon.json and ledger are its own), on a free port, with its own
// SPECIALIST_SUBAGENTS_DB. Until 2026-09-30 it killed whatever daemon was on the real port (running
// seats lost their settle step) and left a permanent open coder seat and a real explorer run in the
// live ledger. Whatever SPECIALIST_SUBAGENTS_PORT / _DB the caller has set is ignored on purpose. The
// temp copy is removed when the demo ends. This mirrors tests/lib/sandbox.mjs.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveRuntime } from '../src/role-contract.mjs';
import { ensureOnboarding } from '../src/onboarding.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// The runtime is machine-local and resolved relative to the checkout (.runtime.json, the sibling
// runtimes/ directory), which the temp copy does not have: resolve it here and hand the answer over.
const RUNTIME = resolveRuntime().runtime;

if (!(await ensureOnboarding({ mode: 'demo', runtimePath: RUNTIME })).ok) process.exit(1);

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ssa-demo-')));
for (const entry of ['src', 'roles', 'roles.json', 'presets.json']) {
  fs.cpSync(path.join(REPO, entry), path.join(ROOT, entry), { recursive: true });
}
const DAEMON_FILE = path.join(ROOT, 'src', 'daemon.mjs');
const DATA_DIR = path.join(ROOT, '.data');
const STATE_FILE = path.join(DATA_DIR, 'daemon.json');

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
function localFetch(url, options = {}) {
  const token = process.env.SPECIALIST_SUBAGENTS_TOKEN?.trim();
  return fetch(url, { ...options, headers: { ...options.headers, ...(token ? { authorization: `Bearer ${token}` } : {}) } });
}
// Everything a child of the demo is given. The port and the ledger are the demo's own; the rest of
// the caller's environment stays, because the last step spawns a real explorer that needs the
// caller's real logins (HOME) to reach a model.
const CHILD_ENV = {
  ...process.env,
  SPECIALIST_SUBAGENTS_PORT: String(PORT),
  SPECIALIST_SUBAGENTS_DB: path.join(DATA_DIR, 'ledger.sqlite3'),
  SPECIALIST_SUBAGENTS_RUNTIME: RUNTIME,
};

// True while a daemon of this demo may be running: the exit handler only kills a pid it still owns.
let daemonLive = false;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const step = (n, text) => console.log(`${n}. ${text}`);

// Runs however the demo ends (finished, failed assertion, uncaught error): stop the throwaway daemon
// and delete the temp copy. Synchronous on purpose, an exit handler cannot wait for anything.
process.on('exit', (code) => {
  if (code !== 0) {
    try {
      const tail = fs.readFileSync(path.join(DATA_DIR, 'daemon.log'), 'utf8').trim().slice(-600);
      if (tail) console.error(`the demo service's own log ends with:\n${tail}`);
    } catch {
      // no log written yet
    }
  }
  if (daemonLive) {
    try {
      process.kill(JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')).pid);
    } catch {
      // never wrote its state file, or already gone
    }
  }
  try {
    fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    // a temp directory left behind is harmless
  }
});

function assert(condition, message) {
  if (!condition) {
    console.error(`assertion failed: ${message}`);
    process.exit(1);
  }
}

async function health() {
  try {
    const res = await localFetch(`${BASE}/health`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function waitUp(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const report = await health();
    if (report) return report;
    if (Date.now() > deadline) return null;
    await sleep(150);
  }
}

async function waitDown(timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!(await health())) return true;
    if (Date.now() > deadline) return false;
    await sleep(150);
  }
}

function spawnDaemon() {
  const child = spawn(process.execPath, [DAEMON_FILE], { cwd: ROOT, env: CHILD_ENV, detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  daemonLive = true;
  return child;
}

function readDaemonFile() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

async function api(method, route, body) {
  const res = await localFetch(`${BASE}${route}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  assert(res.ok, `${method} ${route} -> ${res.status} ${JSON.stringify(data)}`);
  return data;
}

// Runs a script in a truly separate process and brings back its stdout.
// stdio is file backed because piped stdio is blocked on this host (EPERM).
function runProbeProcess(script) {
  const dir = path.join(DATA_DIR, 'probe');
  fs.mkdirSync(dir, { recursive: true });
  const outFile = path.join(dir, 'probe.out');
  const errFile = path.join(dir, 'probe.err');
  const outFd = fs.openSync(outFile, 'w');
  const errFd = fs.openSync(errFile, 'w');
  const result = spawnSync(process.execPath, ['-e', script], { cwd: ROOT, env: CHILD_ENV, stdio: ['ignore', outFd, errFd], windowsHide: true });
  fs.closeSync(outFd);
  fs.closeSync(errFd);
  const stdout = fs.readFileSync(outFile, 'utf8');
  const stderr = fs.readFileSync(errFile, 'utf8');
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // scratch files only
  }
  return { status: result.status, stdout, stderr };
}

// 1. daemon: always a fresh throwaway one (see the top of this file), never the live service.
spawnDaemon();
const up = await waitUp();
assert(up, `the demo's own daemon did not answer /health on ${BASE} within 15s`);
assert(path.resolve(up.db) === path.join(DATA_DIR, 'ledger.sqlite3'), `the demo daemon is not on the throwaway ledger: ${up.db}`);
step(1, `throwaway daemon started on ${BASE} (db ${up.db}); a live daemon on the real port is not touched`);

// 2. seat_open(coder)
const opened = await api('POST', '/seat/open', { role: 'coder', owner: 'demo', parent: null });
assert(/^seat-coder-\d+$/.test(opened.seat), `unexpected seat id ${opened.seat}`);
assert(opened.contract === 'roles/coder.md', `unexpected contract ${opened.contract}`);
assert(opened.spawn?.command, 'seat_open reply carries no spawn spec');
step(2, `seat_open(coder) -> ${opened.seat}`);

// 3. a separate process reads the same ledger over HTTP
const probeScript = `
fetch('http://127.0.0.1:${PORT}/seats', { headers: process.env.SPECIALIST_SUBAGENTS_TOKEN?.trim() ? { authorization: 'Bearer ' + process.env.SPECIALIST_SUBAGENTS_TOKEN.trim() } : {} }).then((res) => res.json()).then((rows) => {
  console.log('probe sees ' + rows.length + ' seats: ' + rows.map((s) => s.id).join(','));
}).catch((err) => { console.error('probe failed: ' + err.message); process.exit(1); });
`;
const probe = runProbeProcess(probeScript.trim());
assert(probe.status === 0, `probe process exited ${probe.status}: ${probe.stderr.trim()}`);
assert(probe.stdout.includes(opened.seat), `separate process did not see ${opened.seat}: ${probe.stdout.trim()}`);
step(3, `separate process GET /seats -> ${probe.stdout.trim()}`);

// 4. record an event and read it back
const marker = `demo-note-${Date.now()}`;
await api('POST', '/seat/record', { seat: opened.seat, kind: 'note', body: marker });
const shown = await api('GET', `/seats/${opened.seat}`);
assert(shown.seat?.id === opened.seat, `seat_show returned ${shown.seat?.id}`);
assert((shown.events ?? []).some((event) => event.body === marker), `seat_show did not return ${marker}`);
step(4, `seat_record + seat_show -> ${shown.events.length} events, last body ${shown.events.at(-1).body}`);

// 5. kill the daemon, start a fresh one, the seat is still in the ledger
const before = readDaemonFile();
assert(before?.pid, 'daemon.json carries no pid');
process.kill(before.pid);
assert(await waitDown(), `daemon ${before.pid} kept answering after it was killed`);
spawnDaemon();
const up2 = await waitUp();
assert(up2, 'the second daemon did not answer /health within 15s');
const after = readDaemonFile();
assert(after?.pid && after.pid !== before.pid, `unexpected second daemon pid ${after?.pid}`);
const rowsAfter = await api('GET', '/seats');
assert(rowsAfter.some((row) => row.id === opened.seat), `${opened.seat} was lost across the daemon restart`);
const reopened = await api('GET', `/seats/${opened.seat}`);
assert((reopened.events ?? []).some((event) => event.body === marker), `event ${marker} was lost across the daemon restart`);
step(5, `daemon ${before.pid} killed -> ${after.pid} started: ${opened.seat} still there with ${reopened.events.length} events`);

// 6. dispatch(explorer, task) over HTTP: the daemon spawns it and answers at once.
// Dispatch never blocks (FR-4): the demo waits because a test has to — the agent loop never does.
// The roles are real agent runtimes now, not the first-generation stub that answered with
// `{"role":…,"ok":true}`, so what this step asserts is the pipeline (a real process ran, said
// something, and exited clean), not the shape of a model's answer.
const started = await api('POST', '/seat/start', { role: 'explorer', task: 'demo task', owner: 'demo', parent: null });
assert(started.state === 'running' && typeof started.seat === 'string', `seat/start did not hand back a running seat: ${JSON.stringify(started)}`);
let callSeat = null;
for (let second = 0; second < 180 && !callSeat; second += 1) {
  await new Promise((resolve) => setTimeout(resolve, 1000));
  const row = await api('GET', `/seats/${started.seat}`);
  if ((row.events ?? []).some((event) => event.kind === 'exit')) callSeat = row;
}
if (!callSeat) {
  // Stop the runtime before failing: the temp copy is about to be deleted under it.
  await localFetch(`${BASE}/seat/close`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ seat: started.seat, reason: 'demo gave up waiting' }) }).catch(() => {});
}
assert(callSeat, `seat ${started.seat} never settled within 180s`);
const stdout = callSeat.events.filter((event) => event.kind === 'stdout').map((event) => event.body).join('\n');
const stderr = callSeat.events.filter((event) => event.kind === 'stderr' || event.kind === 'error').map((event) => event.body).join('\n').trim();
const exit = callSeat.events.filter((event) => event.kind === 'exit').pop();
if (exit.body !== '0' || !callSeat.events.some((event) => event.kind === 'stdout') || stdout.trim().length === 0) {
  if (stderr) console.error(`seat ${started.seat} error detail: ${stderr.slice(0, 600)}`);
  console.error('hint: demo requires at least one working logged-in CLI backend (codex / claude / agy) or DEEPSEEK_API_KEY; run with --reset-onboarding to reconfigure.');
}
assert(callSeat.events.some((event) => event.kind === 'stdout'), `no stdout event recorded on ${started.seat}`);
assert(exit.body === '0', `seat ${started.seat} exited ${exit.body}`);
assert(stdout.trim().length > 0, `seat ${started.seat} came back with empty stdout`);
step(6, `seat/start(explorer) -> ${started.seat} exit ${exit.body} stdout ${stdout.trim().split('\n')[0]}`);

// The throwaway daemon leaves with the demo; the exit handler then deletes the temp copy.
await localFetch(`${BASE}/shutdown`, { method: 'POST' }).catch(() => {});
if (await waitDown()) daemonLive = false;

console.log('specialist-subagents demo ok');
