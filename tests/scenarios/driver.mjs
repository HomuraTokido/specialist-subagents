// The shared driver of the end-to-end scenarios (PRD 4.0, T-1 to T-8).
//
// A scenario walks the whole chain a lead uses: an MCP client asks the service, the service picks the
// expert and loads its records, a backend runs, the ledger keeps the run, the result comes back. It
// asserts on outcomes only (what the expert answered, which tools it used, who is listed), never on
// how the service got there, so the same file keeps working when the feature behind it is built.
//
// PRD_SCENARIO_BACKEND=fake (the default) runs on the fakes in tests/fakes: a Codex stand-in and a pi
// stand-in whose "model" (fake-brain.mjs) knows only what is in its context. =real uses the real CLIs
// and a cheap real model; there is no brain log then, so the tools a run used are read off the run's
// own output lines (`· …`).
//
// A scenario that fails must fail at the step that needs the missing feature, and say so in words:
// every phase is wrapped in step(), and the driver's calls turn a missing tool or a refused call into
// an Error whose message says what was asked and what came back, never a TypeError.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startMcp } from '../lib/mcp.mjs';
import { FAKE_CODEX_BRAIN, FAKE_PI_CLI, REPO, sleep, startService, tempDir } from '../lib/sandbox.mjs';

export const MODE = process.env.PRD_SCENARIO_BACKEND === 'real' ? 'real' : 'fake';

const FAKE_REFINER = path.join(REPO, 'tests', 'fakes', 'fake-refiner.mjs');
const WEB_CALL = /web-search|tvly|hwiki/i;

const rm = (dir) => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
const oneLine = (text, max = 300) => String(text).replace(/\s+/g, ' ').trim().slice(0, max);

// A short single-line excerpt for a failure message.
export const brief = (text, max = 100) => oneLine(text, max);

// The task text for the current mode: the fake brain's command language, or plain Chinese for a real model.
export const t = (fakeText, realText) => (MODE === 'real' ? realText : fakeText);

// Runs one phase of a scenario; a failure says which step, in one line.
export async function step(n, what, fn) {
  try {
    return await fn();
  } catch (err) {
    const reason = oneLine(err?.message ?? err);
    throw new assert.AssertionError({ message: oneLine(`第${n}步（${what}）：${reason}`) });
  }
}

const parseJson = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

// `git` without a shell, with an identity and without signing, so a commit works on any machine.
function git(dir, ...args) {
  return execFileSync('git', ['-c', 'user.name=scenario', '-c', 'user.email=scenario@example.test', '-c', 'commit.gpgsign=false', ...args], {
    cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8',
  });
}

function writeFiles(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
}

// `prepare`: edits the copy of the service before the daemon starts (roles.json, planted files).
// `hskills`: true, or { 'h-coder': 'SKILL.md text' } to seed existing skills; the directory is always a
// temp one, so no scenario touches the real HSkills. `refiner`: the fake refiner (fake mode only).
export async function openScenario({ prepare = null, env = {}, hskills = false, refiner = false } = {}) {
  const scratch = tempDir('ssa-scn-');
  const dirs = [scratch];
  const clients = [];
  let service = null;
  let hskillsDir = null;
  const closeAll = async () => {
    while (clients.length) {
      try { clients.pop().close(); } catch { /* already gone */ }
    }
    // The fake brain's `慢` leaves a real process and a child under it. A scenario that failed halfway
    // (a cancel that does not exist yet) must not leave them running on the machine.
    const slow = [];
    try {
      for (const line of fs.readFileSync(path.join(scratch, 'brain.jsonl'), 'utf8').split('\n')) {
        const entry = parseJson(line);
        if (entry?.phase === 'slow') slow.push(entry.pid, entry.grandchild);
      }
    } catch {
      // no brain log: nothing was slow
    }
    if (service) {
      const stopping = service;
      service = null;
      await stopping.stop().catch(() => {});
    }
    for (const pid of slow) {
      try { if (Number.isInteger(pid)) process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    }
    while (dirs.length) rm(dirs.pop());
  };

  try {
    const worldFile = path.join(scratch, 'world.json');
    const brainLog = path.join(scratch, 'brain.jsonl');
    fs.writeFileSync(worldFile, '{}');

    // HSkills: a temp one with its skills/ directory, so replies carry no HSkills error. In real mode
    // an HSkills the caller's environment already names is kept, unless the scenario needs its own.
    const own = MODE === 'fake' || refiner || Boolean(hskills) || !process.env.SPECIALIST_SUBAGENTS_HSKILLS;
    hskillsDir = own ? path.join(scratch, 'hskills') : process.env.SPECIALIST_SUBAGENTS_HSKILLS;
    if (own) {
      fs.mkdirSync(path.join(hskillsDir, 'skills'), { recursive: true });
      if (hskills && typeof hskills === 'object') {
        for (const [name, text] of Object.entries(hskills)) {
          fs.mkdirSync(path.join(hskillsDir, 'skills', name), { recursive: true });
          fs.writeFileSync(path.join(hskillsDir, 'skills', name, 'SKILL.md'), text);
        }
      }
    }

    const childEnv = { SPECIALIST_SUBAGENTS_HSKILLS: hskillsDir, ...env };
    if (MODE === 'fake') {
      Object.assign(childEnv, {
        SPECIALIST_CODEX_JS: FAKE_CODEX_BRAIN,
        SPECIALIST_SUBAGENTS_RUNTIME: FAKE_PI_CLI,
        FAKE_PI_BRAIN: '1',
        FAKE_WORLD: worldFile,
        FAKE_BRAIN_LOG: brainLog,
        FAKE_TODAY: '2026-10-11',
        ...env,
      });
    } else {
      // The sandbox isolates HOME and points the runtimes at fakes; a real run needs the machine's own
      // CLI login state and runtimes. An unset variable is dropped from the child's environment.
      const real = (key) => process.env[key];
      Object.assign(childEnv, {
        HOME: real('HOME'),
        USERPROFILE: real('USERPROFILE'),
        CODEX_HOME: real('CODEX_HOME'),
        CLAUDE_CONFIG_DIR: real('CLAUDE_CONFIG_DIR'),
        SPECIALIST_CODEX_JS: real('SPECIALIST_CODEX_JS'),
        SPECIALIST_SUBAGENTS_RUNTIME: real('SPECIALIST_SUBAGENTS_RUNTIME'),
        ...env,
      });
    }

    const wired = async (root) => {
      if (refiner && MODE === 'fake') {
        // Exactly what tests/skill-loop.test.mjs does: the refiner's runtime is the fake one.
        fs.copyFileSync(FAKE_REFINER, path.join(root, 'src', 'fake-refiner.mjs'));
        const file = path.join(root, 'roles.json');
        const roles = JSON.parse(fs.readFileSync(file, 'utf8'));
        roles.refiner.spawn.args = ['src/fake-refiner.mjs', '--pi', '{runtime}', '--tools', 'read,grep,find,ls,edit,write', '-p', '{task}'];
        fs.writeFileSync(file, JSON.stringify(roles, null, 2));
      }
      if (MODE === 'real' && process.env.PRD_REAL_BACKEND) {
        fs.mkdirSync(path.join(root, '.data'), { recursive: true });
        fs.writeFileSync(path.join(root, '.data', 'backend-prefer.json'), JSON.stringify({ mode: process.env.PRD_REAL_BACKEND, max: false }));
      }
      if (prepare) await prepare(root);
    };

    service = await startService({ env: childEnv, prepare: wired });
  } catch (err) {
    await closeAll();
    throw err;
  }

  const newClient = () => {
    const client = startMcp(service);
    clients.push(client);
    return client;
  };
  const first = newClient();

  // ---- the service over HTTP ----
  const http = async (method, route, body) => {
    const reply = await service.call(method, route, body);
    return reply;
  };
  const getJson = async (route) => {
    const reply = await http('GET', route);
    if (reply.status !== 200 || reply.json === null) throw new Error(`GET ${route} 回的是 ${reply.status}：${oneLine(reply.text, 160)}`);
    return reply.json;
  };

  // ---- MCP calls ----
  // One tool call. An unknown tool is a JSON-RPC error, not an isError result; both end up as Errors
  // that say what was asked, so the step that needs a missing tool fails with that sentence.
  async function rawTool(client, name, args, timeoutMs = null) {
    let reply;
    try {
      reply = await client.request('tools/call', { name, arguments: args }, timeoutMs ?? undefined);
    } catch (err) {
      throw new Error(`${name}：${err.message}`);
    }
    if (reply.error) {
      if (/unknown tool/i.test(reply.error.message ?? '')) throw new Error(`服务没有 ${name} 这个工具`);
      throw new Error(`${name}：${reply.error.message}`);
    }
    const result = reply.result ?? {};
    const text = result.content?.[0]?.text ?? '';
    return { text, isError: Boolean(result.isError), blocks: (result.content ?? []).map((c) => c.text) };
  }

  const sc = {
    service,
    mode: MODE,
    hskills: hskillsDir,
    mcp: first,
    root: service.root,
    client: newClient,

    // A temp directory (realpath) with the files; `name` makes the directory's last level meaningful
    // (a fresh parent holds it); `git` makes it a repository with the files committed.
    workdir(files = {}, { git: asRepo = false, name = null } = {}) {
      const parent = tempDir('ssa-work-');
      dirs.push(parent);
      const dir = name ? path.join(parent, name) : parent;
      fs.mkdirSync(dir, { recursive: true });
      writeFiles(dir, files);
      if (asRepo) {
        git(dir, 'init', '-q');
        git(dir, 'add', '-A');
        git(dir, 'commit', '-q', '--allow-empty', '-m', 'init');
      }
      return dir;
    },
    writeFiles,
    commitAll(dir, message = 'change') {
      git(dir, 'add', '-A');
      git(dir, 'commit', '-q', '--allow-empty', '-m', message);
    },

    // Facts "on the web" for the fake brain.
    world(obj) {
      if (MODE !== 'fake') return;
      const file = service.env.FAKE_WORLD;
      let now = {};
      try { now = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { now = {}; }
      fs.writeFileSync(file, JSON.stringify({ ...now, ...obj }));
    },

    // `timeoutMs` for a call that legitimately runs longer than the default (a split writes one
    // hand-off run per part, which is minutes of model work on a loaded machine, not a hang).
    async tool(name, args = {}, client = first, { timeoutMs = null } = {}) {
      const got = await rawTool(client, name, args, timeoutMs);
      if (got.isError) throw new Error(`${name}：${oneLine(got.text, 240)}`);
      return { ...got, json: parseJson(got.text) };
    },

    async dispatch({ role, task, cwd = null, domain = null, seat = null, fork = null, client = first }) {
      const args = { role, task };
      if (cwd) args.cwd = cwd;
      if (domain) args.domain = domain;
      if (seat) args.seat = seat;
      if (fork) args.fork = fork;
      const mark = sc.mark();
      const at = Date.now();
      const got = await rawTool(client, 'seat_start', args);
      const elapsedMs = Date.now() - at;
      if (got.isError) throw new Error(oneLine(got.text, 260));
      const reply = parseJson(got.text);
      if (!reply || !reply.seat) throw new Error(`seat_start 的回复不是预期的 JSON：${oneLine(got.text, 160)}`);
      return { ...reply, at, elapsedMs, mark, task };
    },

    // Waits by run number: a reused seat may still read "done" from an earlier run.
    async waitRun(reply, timeoutMs = 60000) {
      if (reply.run === null || reply.run === undefined) throw new Error(`seat_start 的回复里没有运行号（座位 ${reply.seat}）`);
      const end = Date.now() + timeoutMs;
      for (;;) {
        const got = await http('GET', `/run?seat=${encodeURIComponent(reply.seat)}&run=${encodeURIComponent(reply.run)}`);
        if (got.status !== 200 || !got.json) throw new Error(`查不到座位 ${reply.seat} 的第 ${reply.run} 单：${oneLine(got.text, 160)}`);
        if (got.json.run?.ended) return got.json;
        if (Date.now() > end) throw new Error(`座位 ${reply.seat} 的第 ${reply.run} 单 ${Math.round(timeoutMs / 1000)} 秒还没结束`);
        await sleep(150);
      }
    },

    // The report of a finished run. A run that did not end well has no answer worth asserting on, so it
    // says how it ended instead of handing back an empty string.
    async answer(reply, timeoutMs = 60000) {
      const summary = await sc.waitRun(reply, timeoutMs);
      const run = summary.run;
      if (run.status && run.status !== 'done') {
        throw new Error(`座位 ${reply.seat} 的第 ${reply.run} 单没有正常结束（${run.status}）：${oneLine([...(run.problems ?? []), ...(run.stderr_tail ?? [])].join('；'), 160)}`);
      }
      return run.report?.text ?? '';
    },

    async seats(query = {}) {
      const params = new URLSearchParams({ view: 'compact' });
      for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== null) params.set(key, String(value));
      return getJson(`/seats?${params}`);
    },
    async listText(args = {}) {
      return (await sc.tool('seat_list', args)).text;
    },
    async seat(id) {
      return getJson(`/seats/${encodeURIComponent(id)}?tail=all`);
    },

    // ---- what the backend did ----
    mark() {
      try {
        return fs.readFileSync(service.env.FAKE_BRAIN_LOG ?? '', 'utf8').split('\n').filter(Boolean).length;
      } catch {
        return 0;
      }
    },
    brainSince(mark = 0) {
      let lines = [];
      try {
        lines = fs.readFileSync(service.env.FAKE_BRAIN_LOG ?? '', 'utf8').split('\n').filter(Boolean);
      } catch {
        return [];
      }
      return lines.slice(mark).map((line) => parseJson(line)).filter(Boolean);
    },
    // The brain's own record of one dispatched task (fake mode): the call that was handed this task text
    // after the dispatch. Empty in real mode, where checks on the prompt are skipped.
    brainOf(reply) {
      const taskText = String(reply.task ?? '').trim();
      return sc.brainSince(reply.mark ?? 0).filter((entry) => entry.phase === 'answer' && entry.kind === 'task' && entry.prompt.includes(taskText));
    },
    // The tools of a run that went to the web or to Hwiki. Entries are brain-log entries (their `tools`)
    // or, in real mode and when there is no brain log, the run's `· ` output lines.
    webCalls(entries) {
      const found = [];
      for (const entry of entries ?? []) {
        if (typeof entry === 'string') {
          if (WEB_CALL.test(entry)) found.push(entry);
        } else {
          for (const tool of entry.tools ?? []) if (WEB_CALL.test(String(tool.arg ?? ''))) found.push(tool);
        }
      }
      return found;
    },
    async toolLines(seat, run) {
      const shown = await getJson(`/seats/${encodeURIComponent(seat)}?run=${encodeURIComponent(run)}&tail=all`);
      return (shown.events ?? []).filter((event) => event.kind === 'stdout' && String(event.body ?? '').startsWith('· ')).map((event) => String(event.body));
    },
    // Web or Hwiki calls of one dispatched run, whichever mode: the brain log in fake mode, the run's
    // own tool lines in real mode.
    async webOf(reply) {
      if (MODE === 'fake') return sc.webCalls(sc.brainOf(reply));
      return sc.webCalls(await sc.toolLines(reply.seat, reply.run));
    },

    async setBackend(mode) {
      const got = await http('POST', '/backend', { mode, max: false });
      assert.equal(got.status, 200, `POST /backend ${mode} 回了 ${got.status}：${oneLine(got.text, 120)}`);
      return got.json;
    },

    sql(query, ...params) {
      const db = new DatabaseSync(service.env.SPECIALIST_SUBAGENTS_DB, { readOnly: true });
      try {
        db.exec('PRAGMA busy_timeout = 5000');
        return db.prepare(query).all(...params);
      } finally {
        db.close();
      }
    },

    async until(check, what, timeoutMs = 20000, everyMs = 100) {
      const end = Date.now() + timeoutMs;
      for (;;) {
        const value = await check();
        if (value) return value;
        if (Date.now() > end) throw new Error(`等不到${what}（${Math.round(timeoutMs / 1000)} 秒）`);
        await sleep(everyMs);
      }
    },
    sleep,

    close: closeAll,
  };
  return sc;
}
