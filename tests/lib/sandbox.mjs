// A throwaway copy of the service, so no test touches the real daemon, ledger or .data/.
//
// The service finds its own root from the location of src/*.mjs and keeps its state under
// <root>/.data, so copying src/, roles/ and roles.json into a temp directory gives a second,
// fully separate service: own ledger, own daemon.json, own backend-prefer.json. Nothing in the
// checkout is written and port 43130 is never touched (each daemon gets a free port).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const FAKE_CODEX = path.join(REPO, 'tests', 'fakes', 'fake-codex.mjs');
export const FAKE_CODEX_BRAIN = path.join(REPO, 'tests', 'fakes', 'fake-codex-brain.mjs');
export const FAKE_SLEEPER =path.join(REPO, 'tests', 'fakes', 'fake-sleeper.mjs');
// The Claude Code CLI stand-in (SPECIALIST_CLAUDE_BIN), whose model is the fake brain.
export const FAKE_CLAUDE = path.join(REPO, 'tests', 'fakes', 'fake-claude.mjs');
// The --pi argument seat-runner wants: it only uses this path to find the SDK next to it (fake-pi/dist/index.js).
export const FAKE_PI_CLI = path.join(REPO, 'tests', 'fakes', 'fake-pi', 'dist', 'bundle', 'cli.js');

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function tempDir(prefix = 'ssa-test-') {
  // .native, as the service's own path identity does (store.mjs dirKey, E-7): on Windows it expands an
  // 8.3 short name (C:\Users\RUNNER~1 on CI) that the JS realpath keeps, so a test comparing a seat's
  // stored directory with the one it made would otherwise see two spellings of one place.
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

export function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

export function copyService(root) {
  // dispatch/ ships with the service: the MCP shell sends dispatch/team-leader.md as its instructions.
  for (const entry of ['src', 'roles', 'roles.json', 'presets.json', 'dispatch']) {
    fs.cpSync(path.join(REPO, entry), path.join(root, entry), { recursive: true });
  }
}

// Environment for a child that must not see this machine: no real CLI login state, no real
// ledger, no real daemon port, and no daemon-specific variables leaking in from the caller.
export function isolatedEnv(root, extra = {}) {
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true });
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('SPECIALIST_')) delete env[key];
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    CODEX_HOME: path.join(home, '.codex'),
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    SPECIALIST_SUBAGENTS_DB: path.join(root, '.data', 'ledger.sqlite3'),
    // The gate only checks that the runtime file exists; nothing in these tests ever runs pi.
    SPECIALIST_SUBAGENTS_RUNTIME: path.join(root, 'fake-pi-cli.js'),
    SPECIALIST_CODEX_JS: FAKE_CODEX,
    FAKE_CODEX_CALLS: path.join(root, 'codex-calls.jsonl'),
    SPECIALIST_NO_HOST_PATH: '1',
    ...extra,
  };
}

// `prepare(root)` runs after the copy and before the daemon starts: a test edits roles.json, plants
// files or seeds the ledger there.
export async function startService({ env = {}, prepare = null } = {}) {
  const root = tempDir();
  copyService(root);
  fs.writeFileSync(path.join(root, 'fake-pi-cli.js'), '// never run\n');
  if (prepare) await prepare(root);
  const port = await freePort();
  const childEnv = isolatedEnv(root, { SPECIALIST_SUBAGENTS_PORT: String(port), ...env });
  const child = spawn(process.execPath, [path.join(root, 'src', 'daemon.mjs')], {
    cwd: root,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let log = '';
  child.stdout.on('data', (chunk) => { log += chunk; });
  child.stderr.on('data', (chunk) => { log += chunk; });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`daemon exited early (${child.exitCode}):\n${log}`);
    try {
      const res = await fetch(`${base}/health`);
      if (res.ok) break;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) {
      child.kill();
      throw new Error(`daemon did not come up:\n${log}`);
    }
    await sleep(100);
  }

  const call = async (method, route, body) => {
    let res;
    for (let attempt = 1; ; attempt += 1) {
      try {
        res = await fetch(`${base}${route}`, {
          method,
          headers: body === undefined ? {} : { 'content-type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        break;
      } catch (err) {
        // Windows CI, 2026-10-11 (twice): a bare "fetch failed" right after the daemon wrote thousands of
        // events synchronously. A keep-alive socket the daemon closed the moment its event loop came
        // back fails the next request on it, though the daemon is fine; a GET changes nothing, so it is
        // tried again on a fresh connection. The underlying cause goes into the message either way.
        const cause = err?.cause ? ` (${[err.cause.code, err.cause.message].filter(Boolean).join(' ')})` : '';
        if (method !== 'GET' || attempt >= 3) throw new Error(`${method} ${route}: ${err?.message ?? err}${cause}`);
        console.error(`sandbox: ${method} ${route} failed${cause}, retrying (${attempt})`);
        await sleep(200);
      }
    }
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* html or empty */ }
    return { status: res.status, text, json };
  };

  return {
    root, port, base, env: childEnv, call, log: () => log,
    async waitSeat(id, states = ['done', 'failed', 'interrupted'], timeoutMs = 30000) {
      const end = Date.now() + timeoutMs;
      for (;;) {
        const { json } = await call('GET', `/seats/${id}`);
        if (json && states.includes(json.seat.state)) return json;
        if (Date.now() > end) throw new Error(`seat ${id} still ${json?.seat?.state} after ${timeoutMs}ms\n${log}`);
        await sleep(150);
      }
    },
    async stop() {
      if (child.exitCode === null) {
        await fetch(`${base}/shutdown`, { method: 'POST' }).catch(() => {});
        await new Promise((resolve) => {
          const timer = setTimeout(() => { child.kill(); resolve(); }, 3000);
          child.once('exit', () => { clearTimeout(timer); resolve(); });
        });
      }
      // Windows frees a killed process tree's handles on the directory a moment after taskkill returns;
      // the timeout test in lifecycle.test.mjs hit EBUSY on .data/nowhere twice in CI (2026-10-11) with
      // five retries (about 3 s). Ten retries with the linear back-off wait up to about 11 s.
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    },
  };
}
