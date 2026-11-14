import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, it, afterEach } from 'node:test';
import { startMcp } from './lib/mcp.mjs';
import { sleep, startService, tempDir, FAKE_CODEX_BRAIN, FAKE_SLEEPER } from './lib/sandbox.mjs';
import { forkNote } from '../src/cli-runner.mjs';
import { spawn } from 'node:child_process';
import { loadStore } from './lib/store.mjs';

await describe('forks', { concurrency: false }, async () => {
// C-3: an expert that is busy gets a fork, not a blank second instance. The fork starts from the
// expert's records, runs beside it, and when it ends its session and report are filed under the expert
// and the fork seat is closed.
//
// The runtime is a stand-in written here (like tests/ledger-events.test.mjs does): it logs what it was
// handed (the task, the session file it was told to continue and that file's content), appends a turn to
// the session it continues, and leaves a result file with a session and a report. Task text after
// "任务：" is `run:<ms>[:codex]`; `:codex` makes the session it creates look like a Codex rollout.








const FAKE_FORKER = `
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
const taskFile = args.indexOf('--task-file');
const task = taskFile === -1 ? String(args[args.indexOf('-p') + 1] ?? '') : fs.readFileSync(args[taskFile + 1], 'utf8');
const mode = task.split('任务：\\n').pop().trim();
const [, ms, kind] = mode.split(':');
const seat = process.env.SPECIALIST_SEAT_NAME;
const given = process.env.SPECIALIST_SEAT_SESSION_FILE || '';
const log = { seat, task, given, givenExists: given ? fs.existsSync(given) : false, givenText: given && fs.existsSync(given) ? fs.readFileSync(given, 'utf8') : '', record: process.env.SPECIALIST_SEAT_RECORD_FILE || '', handoff: process.env.SPECIALIST_SEAT_HANDOFF_FILE || '', fresh: process.env.SPECIALIST_SEAT_FRESH || '', expertise: process.env.SPECIALIST_SEAT_EXPERTISE || '', closingBacklog: JSON.parse(fs.readFileSync(process.env.SPECIALIST_SEAT_CLOSING_CONTEXT, 'utf8')).backlog };
fs.appendFileSync(process.env.FAKE_FORKER_LOG, JSON.stringify(log) + '\\n');
process.stdout.write('working\\n');
setTimeout(() => {
  let session = given && fs.existsSync(given) ? given : null;
  if (!session) {
    const id = crypto.randomUUID();
    session = path.join(process.env.SPECIALIST_SEAT_SESSION_DIR, kind === 'codex' ? 'rollout-2026-01-01T00-00-00-' + id + '.jsonl' : id.slice(0, 8) + '_' + id + '.jsonl');
    fs.mkdirSync(path.dirname(session), { recursive: true });
  }
  fs.appendFileSync(session, JSON.stringify({ role: 'assistant', text: 'turn of ' + seat + ' ' + mode }) + '\\n');
  fs.writeFileSync(process.env.SPECIALIST_SEAT_RESULT, JSON.stringify({
    tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 },
    expertise: 'fake-forker', backlog: kind === 'backlog' ? '- 还差一件事' : '', model: 'fake/fake-forker', sessionFile: session,
    report: 'report of ' + seat + ' ' + mode, difficulties: [],
  }));
  process.exit(0);
}, Number(ms));
`;

function world() {
  const ctx = {};
  before(async () => {
    ctx.scratch = tempDir('ssa-fork-');
    ctx.log = path.join(ctx.scratch, 'forker.jsonl');
    ctx.service = await startService({
      env: { FAKE_FORKER_LOG: ctx.log },
      prepare: (root) => {
        fs.writeFileSync(path.join(root, 'src', 'fake-forker.mjs'), FAKE_FORKER);
        const file = path.join(root, 'roles.json');
        const roles = JSON.parse(fs.readFileSync(file, 'utf8'));
        roles.explorer.spawn.args = ['src/fake-forker.mjs', '--pi', '{runtime}', '--tools', 'read,grep,find,ls', '-p', '{task}'];
        fs.writeFileSync(file, JSON.stringify(roles, null, 2));
      },
    });
    ctx.mcp = startMcp(ctx.service);
  });
  after(async () => {
    await ctx.mcp?.close();
    await ctx.service?.stop();
    if (ctx.scratch) fs.rmSync(ctx.scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });
  ctx.dir = (name) => {
    const dir = path.join(ctx.scratch, name);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  };
  ctx.start = async (args) => {
    const out = await ctx.mcp.tool('seat_start', { role: 'explorer', ...args });
    assert.equal(out.isError, false, out.text);
    return JSON.parse(out.text);
  };
  ctx.show = async (seat) => (await ctx.service.call('GET', `/seats/${seat}?tail=all`)).json;
  // A run has ended when its seat has as many exits as tasks (a fork's seat is closed by then).
  ctx.ended = async (seat) => {
    const end = Date.now() + 30000;
    for (;;) {
      const shown = await ctx.show(seat);
      if (shown.events.filter((e) => e.kind === 'exit').length >= shown.events.filter((e) => e.kind === 'task').length && !['running', 'open'].includes(shown.seat.state)) return shown;
      if (Date.now() > end) throw new Error(`${seat} did not end: ${shown.seat.state}`);
      await sleep(100);
    }
  };
  ctx.running = async (seat) => {
    const end = Date.now() + 15000;
    while (Date.now() < end) {
      if ((await ctx.show(seat)).seat.state === 'running') return;
      await sleep(50);
    }
    throw new Error(`${seat} never ran`);
  };
  ctx.logged = () => fs.readFileSync(ctx.log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  ctx.sql = (query, ...params) => {
    const db = new DatabaseSync(ctx.service.env.SPECIALIST_SUBAGENTS_DB, { readOnly: true });
    try {
      return db.prepare(query).all(...params);
    } finally {
      db.close();
    }
  };
  return ctx;
}

describe('[C-3] a busy expert gets a fork of itself', () => {
  const w = world();

  it('a pi expert: the fork continues a copy of its session, carries its records, runs beside it, and is filed under it', async () => {
    const cwd = w.dir('pi-expert');
    const run0 = await w.start({ cwd, task: 'run:10' });
    await w.ended(run0.seat);
    const expert = run0.seat;
    const before = (await w.show(expert)).seat.session_file;
    assert.ok(before && fs.existsSync(before), 'the expert has a session');

    const slow = await w.start({ cwd, task: 'run:1500' });
    assert.equal(slow.seat, expert);
    await w.running(expert);
    const forked = await w.start({ cwd, task: 'run:10' });
    assert.notEqual(forked.seat, expert, 'the second task did not wait and did not take the expert\'s seat');
    assert.equal(forked.fork, true);
    assert.equal(forked.expert, expert);
    assert.equal(forked.reused, true, 'it is the expert, so it is not a new object');
    const expertName = (await w.show(expert)).seat.name;
    assert.equal(forked.note, `Dispatched to a parallel fork of "${expertName}" (${forked.seat}): the expert is currently busy, so this fork started from its records and will file events back under it`);

    // The fork's seat: a child of the expert, flagged, named after it, not in the roster.
    const forkSeat = (await w.show(forked.seat)).seat;
    assert.equal(forkSeat.parent, expert);
    assert.equal(forkSeat.fork, true);
    assert.equal(forkSeat.name, `${expertName} (fork)`);
    const roster = (await w.service.call('GET', '/seats?view=compact')).json.map((row) => row.seat);
    assert.ok(roster.includes(expert) && !roster.includes(forked.seat), `the roster lists the expert only: ${roster.join(', ')}`);
    const listed = (await w.mcp.tool('seat_list')).text;
    assert.ok(!listed.includes(forked.seat), listed);

    // What the fork was handed: a copy of the expert's session (not the file itself) with its history, and the records note.
    const forkEnded = await w.ended(forked.seat);
    const got = w.logged().find((entry) => entry.seat === forkSeat.name);
    assert.ok(got, 'the fork ran');
    assert.notEqual(got.given, before, 'not the expert\'s own file');
    assert.equal(path.basename(got.given), path.basename(before), 'a copy of it');
    assert.ok(got.givenExists);
    assert.match(got.givenText, /turn of .* run:10/, 'with the history the expert had at that moment');
    assert.ok(got.task.startsWith('服务提示：你的原始记录'), got.task.slice(0, 120));
    for (const line of got.task.split('\n').filter((l) => /^- (会话记录|报告（原文）)：/.test(l))) {
      const file = /：(.+?)（/.exec(line)[1];
      assert.ok(path.isAbsolute(file) && fs.existsSync(file), file);
    }
    assert.ok(forkEnded.events.some((e) => e.kind === 'session' && /Fork/.test(e.body)));

    // It ended while the expert was still at work: closed with the reason, the expert's own run goes on.
    assert.equal(forkEnded.seat.state, 'closed');
    assert.equal(forkEnded.events.filter((e) => e.kind === 'close').at(-1).body, `Fork completed; records filed under ${expert}`);
    assert.equal((await w.show(expert)).seat.state, 'running', 'the expert is still at work');
    const expertEnded = await w.ended(expert);

    // Both runs are in the runs table under the expert, with the fork's session and report.
    const runs = w.sql('SELECT * FROM runs WHERE expert = ? ORDER BY id', expert);
    assert.deepEqual(runs.map((r) => r.seat), [expert, expert, forked.seat]);
    assert.ok(runs.every((r) => r.ended_at && r.state === 'done' && r.session_file && r.report_file), JSON.stringify(runs));
    assert.deepEqual(runs.map((r) => r.load), ['fresh', 'resumed', 'resumed']);
    assert.deepEqual(runs.map((r) => r.had_records), [0, 1, 1]);
    assert.notEqual(runs[2].session_file, runs[1].session_file);
    assert.ok(fs.existsSync(runs[2].report_file));

    // The expert ended last, so its own session is the one it continues; the fork's stays in the records.
    assert.equal(expertEnded.seat.session_file, runs[1].session_file);
    const next = await w.start({ cwd, task: 'run:10' });
    assert.equal(next.seat, expert, 'a following dispatch lands on the expert');
    assert.ok(!next.fork);
    await w.ended(expert);
    const third = w.logged().filter((entry) => entry.seat === expertName).at(-1);
    assert.ok(third.task.includes(runs[2].session_file), 'the fork\'s session is listed for the expert');
    assert.ok(third.task.includes(runs[2].report_file), 'and its report');
  });

  it('when the fork ends after the expert, the expert\'s session becomes the fork\'s', async () => {
    const cwd = w.dir('fork-last');
    const first = await w.start({ cwd, task: 'run:10' });
    await w.ended(first.seat);
    const expert = first.seat;
    await w.start({ cwd, task: 'run:200' });
    await w.running(expert);
    const forked = await w.start({ cwd, task: 'run:1500' });
    assert.equal(forked.fork, true);
    await w.ended(expert);
    const forkEnded = await w.ended(forked.seat);
    const fileOfFork = w.sql('SELECT session_file FROM runs WHERE seat = ?', forked.seat)[0].session_file;
    assert.equal((await w.show(expert)).seat.session_file, fileOfFork, 'the last one to end leaves the session the next run continues');
    assert.equal(forkEnded.seat.state, 'closed');
  });

  it('a Codex/Claude/Grok expert: the fork gets no session to continue (it would write the expert\'s), only its records', async () => {
    const cwd = w.dir('codex-expert');
    const first = await w.start({ cwd, task: 'run:10:codex' });
    await w.ended(first.seat);
    const expert = first.seat;
    const session = (await w.show(expert)).seat.session_file;
    assert.match(path.basename(session), /^rollout-.*\.jsonl$/);
    await w.start({ cwd, task: 'run:1000:codex' });
    await w.running(expert);
    const forked = await w.start({ cwd, task: 'run:10:codex' });
    assert.equal(forked.fork, true);
    const forkEnded = await w.ended(forked.seat);
    const got = w.logged().find((entry) => entry.seat === forkEnded.seat.name);
    assert.equal(got.given, '', 'no session file');
    assert.equal(got.record, session, 'the expert\'s session is named as a record to read');
    assert.ok(got.task.includes(session), 'and listed in the task');
    assert.ok(forkEnded.events.some((e) => e.kind === 'session' && /backend session cannot be shared concurrently/.test(e.body)));
    await w.ended(expert);
  });

  it('a busy expert that has no session yet (its first run) still gets a fork', async () => {
    const cwd = w.dir('first-run');
    const first = await w.start({ cwd, task: 'run:800' });
    await w.running(first.seat);
    const forked = await w.start({ cwd, task: 'run:10' });
    assert.equal(forked.fork, true);
    assert.equal(forked.expert, first.seat);
    const forkEnded = await w.ended(forked.seat);
    assert.equal(forkEnded.seat.state, 'closed');
    const row = w.sql('SELECT load, had_records FROM runs WHERE seat = ?', forked.seat)[0];
    assert.deepEqual({ ...row }, { load: 'fresh', had_records: 0 }, 'nothing to load yet, and it is not counted as a blank start on an expert with records');
    await w.ended(first.seat);
  });

  it('point dispatch (seat) to a busy expert forks instead of refusing', async () => {
    const cwd = w.dir('named');
    const first = await w.start({ cwd, task: 'run:10' });
    await w.ended(first.seat);
    await w.start({ cwd, task: 'run:800' });
    await w.running(first.seat);
    const forked = await w.start({ seat: first.seat, task: 'run:10' });
    assert.equal(forked.fork, true);
    assert.equal(forked.expert, first.seat);
    assert.match(forked.note, /fork/);
    // A fork cannot be named: it lives one run.
    const refused = await w.mcp.tool('seat_start', { role: 'explorer', task: 'run:10', seat: forked.seat });
    assert.equal(refused.isError, true);
    assert.match(refused.text, /fork/);
    await w.ended(forked.seat);
    await w.ended(first.seat);
  });

  it('a fork does not count in the duplicate-name check (E-1)', async () => {
    // The fork is named after its expert; renaming the expert to that very name is allowed: the fork is no expert.
    const cwd = w.dir('rename');
    const first = await w.start({ cwd, task: 'run:10' });
    await w.ended(first.seat);
    await w.start({ cwd, task: 'run:600' });
    await w.running(first.seat);
    const forked = await w.start({ cwd, task: 'run:10' });
    assert.equal(forked.fork, true);
    const renamed = await w.mcp.tool('seat_rename', { seat: first.seat, name: `${(await w.show(forked.seat)).seat.name}` });
    assert.equal(renamed.isError, false, 'a fork\'s name is not a living expert\'s name');
    await w.ended(forked.seat);
    await w.ended(first.seat);
  });
});

// C-7 (2026-10-24): the caller chooses a fork, with the expert's records or with none of its history.
describe('[C-7] seat_start fork: a fork with or without the expert\'s context', () => {
  const w = world();
  // An expert with a session, an expertise note and a backlog, idle.
  const expertIn = async (name) => {
    const cwd = w.dir(name);
    const first = await w.start({ cwd, task: 'run:10:backlog' });
    const shown = await w.ended(first.seat);
    assert.ok(shown.seat.session_file && shown.seat.expertise && shown.seat.backlog, 'the expert has a session, an expertise note and a backlog');
    return { cwd, expert: first.seat, session: shown.seat.session_file };
  };

  it('[C-7] "fresh": the fork is handed nothing of the expert\'s, and the expert keeps its own session', async () => {
    const { cwd, expert, session } = await expertIn('fresh');
    const forked = await w.start({ cwd, fork: 'fresh', task: 'run:10' });
    assert.notEqual(forked.seat, expert);
    assert.equal(forked.fork, true);
    assert.equal(forked.fresh, true);
    assert.equal(forked.expert, expert);
    assert.match(forked.note, /fresh-context fork/);
    const ended = await w.ended(forked.seat);
    const got = w.logged().find((entry) => entry.seat === ended.seat.name);
    assert.equal(got.fresh, '1', 'the runner is told to start without history');
    assert.equal(got.given, '', 'no session to continue');
    assert.equal(got.record, '', 'no expert session to read');
    assert.equal(got.handoff, '', 'no hand-off document');
    assert.equal(got.expertise, '', 'no expertise note');
    assert.equal(got.closingBacklog, null, 'no backlog');
    assert.equal(got.task.includes(session), false, 'no records note naming the expert\'s files');
    assert.equal(got.task.includes('还差一件事'), false, 'no backlog in front of the task');
    assert.ok(ended.events.some((e) => e.kind === 'session' && /Fresh fork/.test(e.body)));
    assert.equal(ended.seat.state, 'closed');
    assert.ok(ended.events.some((e) => e.kind === 'close' && /Fresh fork completed; records filed under/.test(e.body)));
    // It ended last, and still the expert's next run continues the expert's own session.
    assert.equal((await w.show(expert)).seat.session_file, session);
    // C-6: a blank start by request, counted with the new objects.
    const row = w.sql('SELECT expert, load, had_records FROM runs WHERE seat = ?', forked.seat)[0];
    assert.deepEqual({ ...row }, { expert, load: 'fresh', had_records: 0 });
  });

  it('[C-7] "fresh" by seat id, and while the expert is busy', async () => {
    const { expert, session } = await expertIn('fresh-named');
    await w.start({ seat: expert, task: 'run:800' });
    await w.running(expert);
    const forked = await w.start({ seat: expert, fork: 'fresh', task: 'run:10' });
    assert.equal(forked.fresh, true);
    const ended = await w.ended(forked.seat);
    const got = w.logged().find((entry) => entry.seat === ended.seat.name);
    assert.equal(got.given, '');
    assert.equal(got.record, '', 'not even the busy expert\'s session as a record');
    await w.ended(expert);
    assert.equal((await w.show(expert)).seat.session_file, session);
  });

  it('[C-7] "context": a fork with the expert\'s records even when the expert is idle', async () => {
    const { cwd, expert } = await expertIn('context');
    const forked = await w.start({ cwd, fork: 'context', task: 'run:10' });
    assert.equal(forked.fork, true);
    assert.equal(forked.fresh, undefined);
    assert.match(forked.note, /opened as requested with access to the expert/);
    const ended = await w.ended(forked.seat);
    const got = w.logged().find((entry) => entry.seat === ended.seat.name);
    assert.equal(got.fresh, '');
    assert.ok(got.givenExists, 'a pi expert\'s fork continues a copy of its session');
    assert.equal(got.expertise, 'fake-forker');
  });

  it('[C-7] a fork asked for where there is no expert yet opens the expert; a wrong value is refused', async () => {
    const cwd = w.dir('no-expert');
    const opened = await w.start({ cwd, fork: 'fresh', task: 'run:10' });
    assert.equal(opened.fork, undefined);
    assert.match(opened.note, /new expert/);
    assert.match(opened.note, /fork requested, but no existing expert existed yet/);
    await w.ended(opened.seat);
    const refused = await w.mcp.tool('seat_start', { role: 'explorer', cwd, fork: 'blank', task: 'run:10' });
    assert.equal(refused.isError, true);
    assert.match(refused.text, /fork must be/);
  });
});
});

await describe('fork-loading', { concurrency: false }, async () => {
// C-3 with C-1: a fork of a busy expert on Codex (or Claude, Grok) cannot continue the expert's session,
// which the expert's own run is still writing, and no copy of it would be a session of its own either. It
// starts fresh and is handed the expert's session as text, the same loading C-1 does across backends.
// Driven through the real cli-runner with the fake Codex brain, which knows only what is in its context.







const services = [];
const scratches = [];
afterEach(async () => {
  while (services.length) await services.pop().stop();
  while (scratches.length) fs.rmSync(scratches.pop(), { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

async function until(check, what, timeoutMs = 30000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(150);
  }
}

const readLog = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []);

describe('a fork on a backend that resumes by id', () => {
  it('[C-3][C-1] is handed the busy expert\'s session as text and never continues it', async () => {
    const scratch = tempDir('ssa-forkload-');
    scratches.push(scratch);
    const work = path.join(scratch, 'work');
    fs.mkdirSync(work);
    fs.writeFileSync(path.join(work, 'f1.txt'), '事实：alpha=1\n');
    const brainLog = path.join(scratch, 'brain.jsonl');
    fs.writeFileSync(path.join(scratch, 'world.json'), '{}');
    const service = await startService({
      env: { SPECIALIST_CODEX_JS: FAKE_CODEX_BRAIN, FAKE_BRAIN_LOG: brainLog, FAKE_WORLD: path.join(scratch, 'world.json'), FAKE_TODAY: '2026-10-11' },
    });
    services.push(service);
    const start = async (task) => (await service.call('POST', '/seat/start', { role: 'explorer', cwd: work, task })).json;
    const ended = async (reply) => until(async () => {
      const { json } = await service.call('GET', `/run?seat=${reply.seat}&run=${reply.run}`);
      return json?.run?.ended ? json : null;
    }, `run ${reply.seat}#${reply.run}`);

    const first = await start('读文件：f1.txt');
    await ended(first);
    const busy = await start('慢：4000');
    await until(() => readLog(brainLog).some((e) => e.phase === 'slow'), 'the expert to be busy');
    const fork = await start('问：alpha');
    assert.equal(fork.fork, true, `the second dispatch should be a fork: ${JSON.stringify(fork)}`);
    const summary = await ended(fork);
    assert.match(summary.run.report.text, /alpha=1/, 'the fork answers from the expert\'s records');

    const entry = readLog(brainLog).find((e) => e.phase === 'answer' && e.kind === 'task' && /问：alpha/.test(e.prompt));
    assert.ok(entry, 'the fork\'s task reached the brain');
    assert.equal(entry.resumed, false, 'the fork did not continue the expert\'s Codex session');
    assert.match(entry.prompt, /专家到目前为止的会话记录/, 'the fork is told whose session it is reading');
    assert.match(entry.prompt, /事实：alpha=1/, 'the expert\'s session reached the fork as text');
    assert.ok(!entry.tools.some((t) => t.tool === 'read'), 'no record file had to be read: the text was loaded');
    assert.ok(!entry.tools.some((t) => /web-search/.test(t.arg)), 'no web search');
    await ended(busy);
  });

  it('[C-3] names the expert\'s session file when it cannot be read as text', () => {
    const note = forkNote('/nonexistent/session.jsonl', '', null, '');
    assert.match(note, /分身/);
    assert.match(note, /\/nonexistent\/session\.jsonl/);
  });
});
});

await describe('adopt', { concurrency: false }, async () => {
// A seat whose runtime outlived the daemon that started it (on Windows the watchdog starts the daemon
// outside any job, so this happens on `stop` or a crash): the next daemon adopts it, waits for the
// process to end and then post-processes the result file like a normal exit.
//
// The orphan is made by hand: a ledger seeded with a running seat, and a detached fake runtime whose
// pid the seat carries, before the daemon starts.








describe('a daemon starting over a seat that is still running', () => {
  let env;
  let service;
  let scratch;
  let seat;

  before(async () => {
    env = await loadStore();
    scratch = tempDir('ssa-adopt-');
    const cwd = path.join(scratch, 'project');
    fs.mkdirSync(cwd);
    service = await startService({
      env: { SPECIALIST_SUBAGENTS_DB: env.file, SPECIALIST_SUBAGENTS_MAX_CONCURRENCY: '1' },
      prepare: (root) => {
        // What the previous daemon left: a running seat with its task, one output line already in the
        // ledger, and the runtime still going (it prints "before" at once, "after" and its result later).
        ({ seat } = env.store.openSeat({ role: 'explorer', cwd }));
        env.store.recordEvent({ seat, kind: 'task', body: 'the task the previous daemon was given' });
        env.store.recordEvent({ seat, kind: 'stdout', body: 'before' });
        const runDir = path.join(root, '.data', 'run', seat);
        fs.mkdirSync(runDir, { recursive: true });
        const out = fs.openSync(path.join(runDir, 'stdout.log'), 'a');
        const orphan = spawn(process.execPath, [FAKE_SLEEPER, '--pi', 'x', '-p', 'finish-after:3000:- 接管后的清单'], {
          cwd,
          env: { ...process.env, SPECIALIST_SEAT_RESULT: path.join(runDir, 'result.json'), SPECIALIST_SEAT_SESSION_DIR: scratch },
          stdio: ['ignore', out, out],
          windowsHide: true,
        });
        env.store.bindSeat({ seat, handle: 'pid', pid: orphan.pid });
      },
    });
  });

  after(async () => {
    await service?.stop();
    env?.cleanup();
    // Windows frees the adopted orphan's handles on scratch a moment after the process tree is killed;
    // the removal hit EBUSY on .data/nowhere under load. Retry like lifecycle.test.mjs (b00e3a8).
    fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it('[G-2] counts the adopted seat against the cap, then post-processes it once the process is gone', async () => {
    // Adopted and still running: it holds the only slot (cap 1).
    const busy = await service.call('POST', '/seat/start', { role: 'explorer', task: 'finish-after:10' });
    assert.equal(busy.status, 429, busy.text);
    assert.equal((await service.call('GET', `/seats/${seat}`)).json.seat.state, 'running', 'reading the ledger does not reconcile it away');

    const shown = await service.waitSeat(seat, ['done', 'failed', 'interrupted'], 30000);
    assert.equal(shown.seat.state, 'done');
    assert.equal(shown.seat.expertise, 'fake-sleeper knows this directory');
    assert.equal(shown.seat.backlog, '- 接管后的清单');
    assert.ok(shown.seat.session_file, 'the session file the run reported is saved');
    const kinds = shown.events.map((e) => e.kind);
    assert.ok(kinds.includes('usage'), 'usage recorded');
    assert.ok(shown.events.some((e) => e.kind === 'note' && /Adopted seat after daemon restart/.test(e.body)));
    assert.equal(shown.events.find((e) => e.kind === 'exit').body, '0');
    // The line the previous daemon already recorded is not recorded again; the one after it is.
    assert.deepEqual(shown.events.filter((e) => e.kind === 'stdout').map((e) => e.body), ['before', 'after']);
    assert.equal(fs.existsSync(path.join(service.root, '.data', 'run', seat)), false, 'the run directory is cleaned up');

    // The slot is free again.
    const next = await service.call('POST', '/seat/start', { role: 'explorer', task: 'finish-after:10' });
    assert.notEqual(next.status, 429);
  });
});
});
