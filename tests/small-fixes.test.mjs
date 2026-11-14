import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { after, describe, it, before } from 'node:test';
import { startMcp } from './lib/mcp.mjs';
import { FAKE_CODEX, FAKE_PI_CLI, REPO, copyService, freePort, isolatedEnv, sleep, startService, tempDir, FAKE_SLEEPER } from './lib/sandbox.mjs';

describe('OSS readiness boundaries', () => {
  function runCli(root, args, env) {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(root, 'bin', 'specialist-subagents.mjs'), ...args], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      child.stdout.on('data', (data) => { stdout += data; });
      child.stderr.on('data', (data) => { stderr += data; });
      child.once('error', reject);
      child.once('close', (status) => resolve({ status, stdout, stderr }));
    });
  }

  async function withCopy(run) {
    const root = tempDir('ssa-oss-readiness-');
    copyService(root);
    fs.cpSync(path.join(REPO, 'bin'), path.join(root, 'bin'), { recursive: true });
    try { await run(root, isolatedEnv(root)); }
    finally { fs.rmSync(root, { recursive: true, force: true }); }
  }

  it('empty seats is explicit in both languages and global port overrides the environment', async () => withCopy(async (root, env) => {
    const server = http.createServer((req, res) => {
      assert.equal(req.url, '/seats');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('[]');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const port = String(server.address().port);
      const english = await runCli(root, ['--port', port, 'seats'], { ...env, SPECIALIST_SUBAGENTS_PORT: String(await freePort()) });
      assert.equal(english.status, 0, english.stderr);
      assert.equal(english.stdout.trim(), 'seats: none');
      const chinese = await runCli(root, ['seats', '--port', port], { ...env, SPECIALIST_SUBAGENTS_LANG: 'zh' });
      assert.equal(chinese.stdout.trim(), '座位：无');
    } finally { await new Promise((resolve) => server.close(resolve)); }
  }));

  it('help and unknown commands report usage, and Chinese pool fallback stays available', async () => withCopy(async (root, env) => {
    const help = await runCli(root, ['--help'], env);
    assert.equal(help.status, 0, help.stderr);
    for (const flag of ['--port', '--non-interactive', '--reset-onboarding', 'SPECIALIST_SUBAGENTS_LANG', 'SPECIALIST_TOOL_PROFILE']) assert.ok(help.stdout.includes(flag), flag);
    assert.equal((await runCli(root, ['not-a-command'], env)).status, 2);
    const port = String(await freePort());
    assert.equal((await runCli(root, ['pool', '--port', port], env)).stdout.trim(), 'pool: unknown');
    assert.equal((await runCli(root, ['pool', '--port', port], { ...env, SPECIALIST_SUBAGENTS_LANG: 'zh' })).stdout.trim(), '池：未知');
  }));

  it('stop distinguishes health and shutdown authentication failures without killing a PID', async () => withCopy(async (root, env) => {
    for (const stage of ['health', 'shutdown']) {
      const seen = [];
      const server = http.createServer((req, res) => {
        seen.push(req.url);
        res.writeHead(stage === 'health' || req.url === '/shutdown' ? 401 : 200, { 'content-type': 'application/json' });
        res.end(req.url === '/health' && stage !== 'health' ? '{"ok":true,"pid":2147483000}' : '{"error":"authentication required"}');
      });
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      try {
        const result = await runCli(root, ['stop', '--port', String(server.address().port)], env);
        assert.equal(result.status, 1, result.stdout + result.stderr);
        assert.match(result.stderr, /stop failed: authentication required \(HTTP 401; set SPECIALIST_SUBAGENTS_TOKEN\)/);
        assert.doesNotMatch(result.stdout + result.stderr, /no \/shutdown route|stopped pid|kill ESRCH/);
        assert.deepEqual(seen, stage === 'health' ? ['/health'] : ['/health', '/shutdown']);
      } finally { await new Promise((resolve) => server.close(resolve)); }
    }
  }));

  it('stop removes a stale daemon state only after confirming its PID is dead', async () => withCopy(async (root, env) => {
    const file = path.join(root, '.data', 'daemon.json');
    const port = await freePort();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ port, pid: 2147483000 }));
    const result = await runCli(root, ['stop', '--port', String(port)], env);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /removed stale daemon\.json/);
    assert.equal(fs.existsSync(file), false);
  }));

  it('invalid runtime pointers fail explicitly instead of silently selecting a fallback', async () => withCopy(async (root, env) => {
    delete env.SPECIALIST_SUBAGENTS_RUNTIME;
    for (const value of ['{broken', 'null', '[]', '42']) {
      fs.writeFileSync(path.join(root, '.runtime.json'), value);
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', "import { resolveRuntime, resolveCallerTitle } from './src/role-contract.mjs'; for (const read of [resolveRuntime, resolveCallerTitle]) { try { read(); process.exitCode = 2; } catch (err) { if (!/Parse error in \\.runtime\\.json/.test(err.message)) throw err; console.log(err.message); } }"], { cwd: root, env, encoding: 'utf8', windowsHide: true });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout.trim().split('\n').length, 2);
      assert.match(result.stdout, /Parse error in \.runtime\.json/);
    }
  }));

  it('model discovery resolves grok and agy from PATH unless disabled or explicitly overridden', async () => withCopy(async (root, env) => {
    const { grokBinary, agyBinary } = await import('../src/models.mjs');
    const dir = path.join(root, 'path-bin');
    fs.mkdirSync(dir);
    const lookup = Object.fromEntries(Object.entries(env).filter(([key]) => key.toLowerCase() !== 'path'));
    lookup.PATH = [dir, process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32') : '/usr/bin'].join(path.delimiter);
    delete lookup.SPECIALIST_NO_HOST_PATH;
    for (const [name, resolve] of [['grok', grokBinary], ['agy', agyBinary]]) {
      const file = path.join(dir, name + (process.platform === 'win32' ? '.exe' : ''));
      fs.writeFileSync(file, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      assert.equal(resolve(lookup, root), file);
      assert.equal(resolve({ ...lookup, SPECIALIST_NO_HOST_PATH: '1' }, root), null);
      assert.equal(resolve({ ...lookup, [`SPECIALIST_${name.toUpperCase()}_BIN`]: '' }, root), null);
    }
  }));
});

await describe('small-fixes', { concurrency: false }, async () => {
// Guards for the 2026-09-30 batch of small fixes: each test pins one behaviour a caller (a model, an
// operator, a script) would notice, on a throwaway copy of the service so nothing here touches the live
// daemon, its ledger or .data/.










// Everything a test starts registers its own undo here; each suite drains the list when it ends. (A
// file-level after() is not used: node:test runs it before the later suites of the file have run.)
const cleanups = [];
async function cleanUp() {
  for (const fn of cleanups.splice(0).reverse()) {
    try {
      await fn();
    } catch (err) {
      process.stderr.write(`CLEANUPERR ${fn.toString().slice(0, 80)} ${err.stack}\n`);
    }
  }
}

// A temp directory may still be the working directory of a child that is on its way out (Windows refuses
// to delete it until that exits), so removal retries for a moment and then gives up quietly.
async function rmQuiet(dir) {
  for (let attempt = 0; attempt < 25; attempt += 1) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      await sleep(200);
    }
  }
}

function stopChild(child) {
  if (child.exitCode !== null) return undefined;
  return new Promise((resolve) => {
    child.once('exit', resolve);
    child.kill();
  });
}

// A listener that plays a daemon. The handler decides per request whether to answer or to hold it forever.
async function fakeDaemon(handler) {
  const seen = [];
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    handler(req, res);
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  // Under load, listen() resolving does not mean the socket is accept()-ing yet: a client (the MCP
  // shell or the watchdog) probing immediately got ECONNREFUSED before the loop was ready. Probe the
  // port with a real TCP connection and only hand it back once the server actually accepts. A bare
  // connect that we destroy sends no HTTP request, so `seen` stays clean.
  await new Promise((resolve, reject) => {
    let attempts = 0;
    const tryConnect = () => {
      const sock = net.connect(port, '127.0.0.1');
      sock.once('connect', () => { sock.destroy(); resolve(); });
      sock.once('error', (err) => {
        sock.destroy();
        attempts += 1;
        if (attempts >= 50) reject(err);
        else setTimeout(tryConnect, 20);
      });
    };
    tryConnect();
  });
  cleanups.push(() => new Promise((resolve) => {
    for (const socket of sockets) socket.destroy();
    server.close(resolve);
  }));
  return { port, seen };
}

// An MCP shell on its own copy of the service, pointed at a port the test controls.
function mcpAt(port, extraEnv = {}) {
  const root = tempDir('ssa-mcp-');
  copyService(root);
  cleanups.push(() => rmQuiet(root));
  const mcp = startMcp({ root, env: isolatedEnv(root, { SPECIALIST_SUBAGENTS_PORT: String(port), ...extraEnv }) });
  cleanups.push(() => mcp.close());
  return { mcp, root };
}

describe('POST /backend', () => {
  after(cleanUp);
  it('names every accepted value in its refusal, claude included', async () => {
    const service = await startService();
    cleanups.push(() => service.stop());
    const { status, json } = await service.call('POST', '/backend', { mode: 'gemini' });
    assert.equal(status, 400);
    for (const kind of ['best', 'codex', 'grok', 'claude', 'deepseek']) assert.match(json.error, new RegExp(kind));
    assert.match(json.error, /gemini/, 'it says what it was given');
  });
});

describe('the MCP shell when the daemon is not there', () => {
  after(cleanUp);
  it('says the truth: no scheduled task, no waiting, the exact command and the log path', async () => {
    const port = await freePort(); // nothing listens on it
    const { mcp, root } = mcpAt(port);
    const { text, isError } = await mcp.tool('role_list');
    assert.equal(isError, true);
    assert.doesNotMatch(text, /计划任务|最多等一分钟/);
    assert.ok(text.includes(`node "${path.join(root, 'bin', 'specialist-subagents.mjs')}" start`), text);
    assert.ok(text.includes(path.join(root, '.data', 'daemon.log')), text);
    assert.match(text, /watchdog/);
  });

  it('gives up on a daemon that accepts the connection and never answers /health', async () => {
    const { port } = await fakeDaemon(() => {});
    const { mcp } = mcpAt(port, { SPECIALIST_SUBAGENTS_CALL_TIMEOUT_MS: '300' });
    const { text, isError } = await mcp.tool('role_list');
    assert.equal(isError, true);
    assert.match(text, /did not answer \/health/);
    assert.match(text, /status/);
  });

  it('times a stalled call out with a message that says what to check, and stays usable afterwards', async () => {
    const { port, seen } = await fakeDaemon((req, res) => {
      if (req.url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
      } // every other route is held forever
    });
    const { mcp } = mcpAt(port, { SPECIALIST_SUBAGENTS_CALL_TIMEOUT_MS: '300' });
    const started = Date.now();
    const { text, isError } = await mcp.tool('role_list');
    assert.equal(isError, true);
    assert.match(text, /did not answer GET \/roles within 0\.3 s/);
    assert.ok(Date.now() - started < 5000, 'it did not wait for undici\'s own default');
    assert.ok(seen.includes('GET /roles'));
    const ping = await mcp.request('ping');
    assert.deepEqual(ping.result, {});
  });

  it('warns that a timed-out write may have been applied', async () => {
    const { port } = await fakeDaemon((req, res) => {
      if (req.url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
      }
    });
    const { mcp } = mcpAt(port, { SPECIALIST_SUBAGENTS_CALL_TIMEOUT_MS: '300' });
    const { text, isError } = await mcp.tool('seat_close', { seat: 'seat-coder-1' });
    assert.equal(isError, true);
    assert.match(text, /may still have applied this write/);
  });
});

describe('role-contract as the main module', () => {
  after(cleanUp);
  it('still runs (and prints its verdict) when reached through a symlink or junction', (t) => {
    const holder = tempDir('ssa-link-');
    cleanups.push(() => rmQuiet(holder));
    const link = path.join(holder, 'repo-link');
    try {
      fs.symlinkSync(REPO, link, 'junction');
    } catch (err) {
      t.skip(`cannot create a link here: ${err.code}`);
      return;
    }
    // The gate also checks that the pi runtime exists; that is machine-local (absent on CI), so the
    // fake one stands in for it here.
    const run = spawnSync(process.execPath, [path.join(link, 'src', 'role-contract.mjs')], {
      encoding: 'utf8', windowsHide: true, timeout: 20000,
      env: { ...process.env, SPECIALIST_SUBAGENTS_RUNTIME: FAKE_PI_CLI },
    });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /contract ok/, 'a gate that prints nothing and exits 0 is a gate that did not run');
  });
});

describe('daemon and MCP shell as the main module', () => {
  after(cleanUp);
  // Same trap as role-contract above: Node resolves the link for import.meta.url but leaves argv[1] as typed,
  // and a bare comparison made `node <link>/src/daemon.mjs` start nothing and exit 0. The link points at a
  // copy of the service, so the daemon writes its life log and ledger there and not into this checkout.
  function linkedCopy(t) {
    const root = tempDir('ssa-main-');
    copyService(root);
    fs.writeFileSync(path.join(root, 'fake-pi-cli.js'), '// never run\n');
    cleanups.push(() => rmQuiet(root));
    const holder = tempDir('ssa-link-');
    cleanups.push(() => rmQuiet(holder));
    const link = path.join(holder, 'service-link');
    try {
      fs.symlinkSync(root, link, 'junction');
    } catch (err) {
      t.skip(`cannot create a link here: ${err.code}`);
      return null;
    }
    return { root, link };
  }

  it('the daemon still starts when reached through a symlink or junction', async (t) => {
    const made = linkedCopy(t);
    if (!made) return;
    const port = await freePort();
    const child = spawn(process.execPath, [path.join(made.link, 'src', 'daemon.mjs')], {
      cwd: made.root,
      env: isolatedEnv(made.root, { SPECIALIST_SUBAGENTS_PORT: String(port) }),
      stdio: 'ignore',
      windowsHide: true,
    });
    cleanups.push(() => stopChild(child));
    let health = null;
    for (let attempt = 0; attempt < 100 && health === null && child.exitCode === null; attempt += 1) {
      health = await fetch(`http://127.0.0.1:${port}/health`).then((res) => res.json()).catch(() => null);
      if (health === null) await sleep(100);
    }
    assert.equal(health?.ok, true, 'a daemon that exits 0 without listening is a daemon that did not start');
  });

  it('the MCP shell still answers when reached through a symlink or junction', async (t) => {
    const made = linkedCopy(t);
    if (!made) return;
    const mcp = startMcp({ root: made.link, env: isolatedEnv(made.root, { SPECIALIST_SUBAGENTS_PORT: String(await freePort()) }) });
    cleanups.push(() => mcp.close());
    const init = await mcp.request('initialize', {});
    assert.equal(init.result.serverInfo.name, 'specialist-subagents');
  });
});

describe('the watchdog', () => {
  after(cleanUp);
  it('reports a daemon that holds the port but does not answer, and neither starts nor kills anything', async () => {
    const { port } = await fakeDaemon(() => {}); // accepts, never replies
    // Guard: the watchdog's first probe must see a port that accepts connections but does not answer.
    // If it probes while the listener is not yet accept()-ing it logs "daemon is down; starting it".
    // Wait until a raw TCP connection actually succeeds before spawning the watchdog.
    await new Promise((resolve, reject) => {
      let attempts = 0;
      const probe = () => {
        const sock = net.connect(port, '127.0.0.1');
        sock.once('connect', () => { sock.destroy(); resolve(); });
        sock.once('error', (err) => {
          sock.destroy();
          attempts += 1;
          if (attempts >= 50) reject(err);
          else setTimeout(probe, 20);
        });
      };
      probe();
    });
    const root = tempDir('ssa-watchdog-');
    cleanups.push(() => rmQuiet(root));
    fs.mkdirSync(path.join(root, 'tools'));
    fs.mkdirSync(path.join(root, 'bin'));
    fs.copyFileSync(path.join(REPO, 'tools', 'watchdog.mjs'), path.join(root, 'tools', 'watchdog.mjs'));
    // If the watchdog wrongly tried to start a daemon, it would run this and leave a marker behind.
    fs.writeFileSync(path.join(root, 'bin', 'specialist-subagents.mjs'), `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(path.join(root, 'started'))}, 'x');\n`);
    const child = spawn(process.execPath, [path.join(root, 'tools', 'watchdog.mjs')], {
      cwd: root,
      env: { ...process.env, SPECIALIST_SUBAGENTS_PORT: String(port) },
      stdio: 'ignore',
      windowsHide: true,
    });
    cleanups.push(() => stopChild(child));
    const logFile = path.join(root, '.data', 'watchdog.log');
    const deadline = Date.now() + 15000;
    let log = '';
    while (Date.now() < deadline && !/NOT being restarted/.test(log)) {
      await sleep(250);
      try { log = fs.readFileSync(logFile, 'utf8'); } catch { /* not written yet */ }
    }
    assert.match(log, /NOT being restarted/);
    assert.match(log, /stop it by hand/);
    assert.doesNotMatch(log, /daemon is down; starting it/);
    assert.equal(fs.existsSync(path.join(root, 'started')), false);
  });
});

describe('bin/demo.mjs', () => {
  after(cleanUp);
  it('runs on its own throwaway service and never reaches the port or ledger the caller names', async () => {
    // Stands in for the live daemon: it owns the port the environment points the demo at.
    const live = await fakeDaemon((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true,"pid":1}');
    });
    const home = tempDir('ssa-demo-home-');
    cleanups.push(() => rmQuiet(home));
    const liveLedger = path.join(home, '.data', 'ledger.sqlite3');
    const env = isolatedEnv(home, {
      SPECIALIST_SUBAGENTS_PORT: String(live.port),
      SPECIALIST_SUBAGENTS_DB: liveLedger,
      SPECIALIST_SUBAGENTS_RUNTIME: FAKE_PI_CLI, // only has to exist; the explorer runs on the fake Codex
      SPECIALIST_CODEX_JS: FAKE_CODEX,
    });
    fs.writeFileSync(env.FAKE_CODEX_CALLS, '');
    const run = spawnSync(process.execPath, [path.join(REPO, 'bin', 'demo.mjs')], { cwd: REPO, env, encoding: 'utf8', windowsHide: true, timeout: 120000 });
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    assert.match(run.stdout, /specialist-subagents demo ok/);
    assert.deepEqual(live.seen, [], 'the stand-in live daemon was never contacted');
    assert.equal(fs.existsSync(liveLedger), false, 'the ledger named in the environment was never opened');
    assert.match(run.stdout, /throwaway daemon started on http:\/\/127\.0\.0\.1:(\d+)/);
    assert.notEqual(run.stdout.match(/started on http:\/\/127\.0\.0\.1:(\d+)/)[1], String(live.port));
  });
});
});

await describe('start-log', { concurrency: false }, async () => {
// A daemon that refuses to start says why in .data/daemon.log. The watchdog runs `start` with stdio
// ignored, and the MCP bridge points callers at the tail of that file, so an unlogged refusal is a
// service that is down for a reason nobody can read.








function sandboxDaemon(port) {
  const root = tempDir('ssa-refuse-');
  copyService(root);
  fs.writeFileSync(path.join(root, 'fake-pi-cli.js'), '// never run\n');
  return { root, env: isolatedEnv(root, { SPECIALIST_SUBAGENTS_PORT: String(port) }) };
}

const runDaemon = ({ root, env }) =>
  spawnSync(process.execPath, [path.join(root, 'src', 'daemon.mjs')], { cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000 });

const lifeLog = (root) => fs.readFileSync(path.join(root, '.data', 'daemon.log'), 'utf8');

describe('refused start is written to daemon.log', () => {
  it('[R-2] a contract that does not match its version file', async () => {
    const sandbox = sandboxDaemon(await freePort());
    fs.writeFileSync(path.join(sandbox.root, 'roles', 'coder.VERSION'), '9.9.9\n');
    const run = runDaemon(sandbox);
    assert.notEqual(run.status, 0);
    assert.match(lifeLog(sandbox.root), /refused to start: .*coder.*contract version mismatch/s);
    fs.rmSync(sandbox.root, { recursive: true, force: true });
  });

  it('a port somebody else holds', async () => {
    const holder = net.createServer();
    await new Promise((resolve) => holder.listen(0, '127.0.0.1', resolve));
    try {
      const sandbox = sandboxDaemon(holder.address().port);
      const run = runDaemon(sandbox);
      assert.notEqual(run.status, 0);
      assert.match(lifeLog(sandbox.root), /refused to start: port \d+ on 127\.0\.0\.1 is already in use/);
      fs.rmSync(sandbox.root, { recursive: true, force: true });
    } finally {
      holder.close();
    }
  });
});
});

await describe('seats-argv', { concurrency: false }, async () => {
// An oversized brief used to kill a seat with a bare `spawn ENAMETOOLONG` and no report
// (seat-explorer-46, 2026-10-05): the task goes into the spawn command line, and Windows refuses a
// command line past 32,767 characters. These tests hold both halves of the fix, against the real
// daemon with a fake runtime — the task must reach the seat from a file instead, and when even that
// cannot help, the refusal must say which limit was passed and what to do about it.







// The fake runtime stands in for the runner cli-runner.mjs, which is what the shipped roles spawn.
// `args` decides which form the daemon has to use.
function fakeRuntime(args) {
  return (root) => {
    fs.copyFileSync(FAKE_SLEEPER, path.join(root, 'src', 'fake-sleeper.mjs'));
    const file = path.join(root, 'roles.json');
    const roles = JSON.parse(fs.readFileSync(file, 'utf8'));
    roles.explorer.spawn.args = args;
    fs.writeFileSync(file, JSON.stringify(roles, null, 2));
  };
}

const ARGV_FORM = ['src/fake-sleeper.mjs', '--pi', '{runtime}', '--tools', 'read,grep,find,ls', '-p', '{task}'];
const PROMPT_FORM = ['src/fake-sleeper.mjs', '--pi', '{runtime}', '--tools', 'read,grep,find,ls', '--prompt', '{task}'];

// Limits differ: Windows limits the command line to 32,767 characters, while Linux has a
// MAX_ARG_STRLEN single-argument limit of 131,072 bytes. That is not a general POSIX limit.
// Probe a bounded set of real arguments so both scenarios use the first task the OS refuses.
let HUGE;
const probeResults = [];
for (const size of [200000, 400000, 800000, 1048000]) {
  const candidate = `${'x'.repeat(size)}\n任务：\nfinish-after:30`;
  const result = spawnSync(process.execPath, ['-e', 'process.exit(0)', candidate], { stdio: 'ignore', timeout: 20000 });
  probeResults.push({ size, error: result.error?.code, status: result.status, signal: result.signal });
  if (result.error?.code === 'E2BIG' || result.error?.code === 'ENAMETOOLONG') {
    HUGE = candidate;
    break;
  }
  assert.ok(
    !result.error && result.status === 0 && !result.signal,
    `unexpected argument probe result on ${process.platform}: ${JSON.stringify(probeResults)}`,
  );
}
assert.ok(HUGE, `the OS must refuse a candidate on ${process.platform}: ${JSON.stringify(probeResults)}`);

describe('a brief past the command-line limit', () => {
  it('reaches the seat from a file instead of dying as ENAMETOOLONG', { timeout: 120000 }, async () => {
    const workdir = tempDir('ssa-argv-work-');
    const service = await startService({ prepare: fakeRuntime(ARGV_FORM) });
    try {
      const payload = { role: 'explorer', task: HUGE, cwd: workdir };
      assert.ok(Buffer.byteLength(JSON.stringify(payload)) < 1024 * 1024, 'the request fits the daemon 1 MiB limit');
      const started = await service.call('POST', '/seat/start', payload);
      assert.equal(started.status, 200, started.text);
      const { seat } = started.json;
      const detail = await service.waitSeat(seat);
      assert.equal(detail.seat.state, 'done', JSON.stringify(detail.events?.slice(-3)));
      // The task really arrived: the fake reads its mode out of the task text it was handed.
      const lines = (detail.events ?? []).filter((e) => e.kind === 'stdout').map((e) => String(e.body).trim());
      assert.ok(lines.includes('before') && lines.includes('after'), `runtime saw the task, got ${JSON.stringify(lines)}`);
      // And the switch is on the record, not a silent workaround.
      const note = (detail.events ?? []).find((e) => e.kind === 'note' && String(e.body).includes('passed via file instead'));
      assert.ok(note !== undefined, 'the file handover is recorded');
      assert.ok(fs.existsSync(path.join(service.root, '.data', 'sessions', seat, 'task.md')), 'the task file is on disk');
    } finally {
      await service.stop();
      fs.rmSync(workdir, { recursive: true, force: true });
    }
  });

  it('refuses in words when the task cannot be moved to a file', { timeout: 120000 }, async () => {
    // No `-p {task}` to rewrite: the daemon must not invent one, and must not let the seat die dumb.
    const service = await startService({ prepare: fakeRuntime(PROMPT_FORM) });
    try {
      const started = await service.call('POST', '/seat/start', { role: 'explorer', task: HUGE });
      assert.equal(started.status, 200, started.text);
      const detail = await service.waitSeat(started.json.seat);
      assert.equal(detail.seat.state, 'failed');
      const said = JSON.stringify(detail.events ?? []);
      assert.match(said, /32,?767|ARG_MAX/, 'the message names the limit that was passed');
      assert.match(said, /shorten the brief|file paths and line ranges/, 'and says what to do about it');
      assert.doesNotMatch(said, /ENAMETOOLONG/, 'the platform error is not what the dispatcher reads');
    } finally {
      await service.stop();
    }
  });
});

describe('--task-file is the runner-side half', () => {
  let root;
  let runner;

  before(async () => {
    // A copy of the service, so the runner is exercised where its own root is the sandbox.
    const { copyService } = await import('./lib/sandbox.mjs');
    root = tempDir('ssa-runner-');
    copyService(root);
    runner = path.join(root, 'src', 'cli-runner.mjs');
  });
  after(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  const run = async (args) => {
    const { spawnSync } = await import('node:child_process');
    return spawnSync(process.execPath, [runner, ...args], { cwd: root, encoding: 'utf8', timeout: 20000 });
  };

  it('reads the task from the file, and refuses two task sources at once', async () => {
    const file = path.join(root, 'task.md');
    fs.writeFileSync(file, '任务正文\n');
    // A missing --role is the next error after parsing, which proves the file was read first.
    const read = await run(['--task-file', file]);
    assert.match(read.stderr + read.stdout, /Missing --role/);

    const absent = await run(['--task-file', path.join(root, 'nope.md')]);
    assert.match(absent.stderr + absent.stdout, /Could not read --task-file/);

    const both = await run(['-p', 'text', '--task-file', file]);
    assert.match(both.stderr + both.stdout, /Use only one/);

    const neither = await run(['--role', 'explorer']);
    assert.match(neither.stderr + neither.stdout, /Missing -p or --task-file/);
  });
});
});
