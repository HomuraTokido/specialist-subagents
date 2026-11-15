// Phase 2, addressing (PRD 4.1, E-1 .. E-7): experts have names a lead can pick by, a task can be
// handed to one named expert, the reply says who took it and why, a renamed expert keeps its seat id,
// and one directory reached by two routes is one expert.
//
// The runtimes: explorer and web_researcher run the fake sleeper (tests/fakes/fake-sleeper.mjs:
// `finish-after:<ms>` ends at once, `hang` never ends); coder and tester run the real cli-runner
// against the fake Codex, which is what lets a second run be seen to `resume` the first one's session.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { startMcp } from './lib/mcp.mjs';
import { FAKE_SLEEPER, startService, tempDir } from './lib/sandbox.mjs';

const SLEEPERS = {
  explorer: { tools: 'read,grep,find,ls' },
  web_researcher: { tools: 'read,grep,find,ls,bash' },
};

function fakeRuntime(root) {
  fs.copyFileSync(FAKE_SLEEPER, path.join(root, 'src', 'fake-sleeper.mjs'));
  const file = path.join(root, 'roles.json');
  const roles = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const [id, edit] of Object.entries(SLEEPERS)) {
    roles[id].spawn.args = ['src/fake-sleeper.mjs', '--pi', '{runtime}', '--tools', edit.tools, '-p', '{task}'];
  }
  fs.writeFileSync(file, JSON.stringify(roles, null, 2));
}

// One service and one MCP shell for a group of tests, a scratch directory for the experts' dirs.
function world() {
  const ctx = {};
  before(async () => {
    ctx.service = await startService({ prepare: fakeRuntime });
    ctx.mcp = startMcp(ctx.service);
    ctx.scratch = tempDir('ssa-addr-');
  });
  after(async () => {
    await ctx.mcp?.close();
    await ctx.service?.stop();
    if (ctx.scratch) fs.rmSync(ctx.scratch, { recursive: true, force: true });
  });
  ctx.dir = (name) => {
    const dir = path.join(ctx.scratch, name);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  };
  // Dispatch through the MCP shell and wait for the run to end; the reply is the parsed seat_start answer.
  ctx.start = async (args, { wait = true } = {}) => {
    const out = await ctx.mcp.tool('seat_start', args);
    assert.equal(out.isError, false, out.text);
    const reply = JSON.parse(out.text);
    if (wait) await ctx.service.waitSeat(reply.seat);
    return reply;
  };
  // A dispatch that must be refused: the text of the refusal.
  ctx.refused = async (args) => {
    const out = await ctx.mcp.tool('seat_start', args);
    assert.equal(out.isError, true, `should have been refused: ${out.text}`);
    return out.text;
  };
  ctx.show = async (seat) => (await ctx.service.call('GET', `/seats/${seat}?tail=all`)).json;
  return ctx;
}

describe('[E-3] reuse experts without a session file', () => {
  const w = world();

  for (const scenario of [
    { name: 'a directory explorer', args: () => ({ role: 'explorer', cwd: w.dir('sessionless-directory') }) },
    { name: 'a topic-scoped directory explorer', args: () => ({ role: 'explorer', cwd: w.dir('sessionless-topic'), topic: 'routing' }) },
    { name: 'a domain web_researcher', args: () => ({ role: 'web_researcher', domain: 'sessionless-research' }) },
  ]) {
    it(`${scenario.name} keeps its identity through two failures and a successful retry`, async () => {
      const args = scenario.args();
      const first = await w.start({ ...args, task: 'fail-error' });
      assert.equal(first.reused, false);
      const failed = (await w.show(first.seat)).seat;
      assert.equal(failed.state, 'failed');
      assert.ok(!failed.session_file, 'the first failure leaves no session file');
      assert.ok(failed.name, 'the new expert has a name');

      const second = await w.start({ ...args, task: 'fail-error' });
      assert.equal(second.seat, first.seat);
      assert.equal(second.reused, true);
      const retried = (await w.show(second.seat)).seat;
      assert.equal(retried.state, 'failed');
      assert.ok(!retried.session_file, 'the second failure still leaves no session file');
      assert.equal(retried.name, failed.name);

      const third = await w.start({ ...args, task: 'finish-after:10' });
      assert.equal(third.seat, first.seat);
      assert.equal(third.reused, true);
      const finished = await w.show(third.seat);
      assert.equal(finished.seat.state, 'done');
      assert.ok(finished.seat.session_file, 'the successful retry saves a session file');
      assert.equal(finished.seat.name, failed.name);
      assert.equal(finished.events.filter((event) => event.kind === 'task').length, 3, 'all runs stay on the same expert');

      const query = new URLSearchParams({ view: 'compact', role: args.role });
      if (args.cwd) query.set('cwd', args.cwd);
      if (args.domain) query.set('domain', args.domain);
      const roster = await w.service.call('GET', `/seats?${query}`);
      assert.equal(roster.status, 200);
      assert.deepEqual(roster.json.map((row) => row.seat), [first.seat], 'the object has exactly one expert');
    });
  }
});

describe('[E-5] rename', () => {
  const w = world();

  it('shows in seat_list under the same seat id, and leaves a rename event', async () => {
    const seat = (await w.start({ role: 'explorer', task: 'finish-after:10', cwd: w.dir('rename-a') })).seat;
    const old = (await w.show(seat)).seat.name;

    const out = await w.mcp.tool('seat_rename', { seat, name: '  explorer · 座位与 skill 循环  ' });
    assert.equal(out.isError, false, out.text);
    const reply = JSON.parse(out.text);
    assert.equal(reply.ok, true);
    assert.equal(reply.seat, seat);
    assert.equal(reply.name, 'explorer · 座位与 skill 循环', 'outer whitespace is trimmed');
    assert.match(reply.note, new RegExp(seat));

    const list = (await w.mcp.tool('seat_list')).text;
    const line = list.split('\n').find((l) => l.includes(` · ${seat} · `));
    assert.ok(line?.startsWith('[explorer · 座位与 skill 循环] · '), list);
    assert.ok(!list.includes(`[${old}]`), 'the old name is gone from the list');

    const shown = await w.show(seat);
    assert.equal(shown.seat.id, seat);
    const event = shown.events.filter((e) => e.kind === 'rename').at(-1);
    assert.equal(event.body, `${old} → explorer · 座位与 skill 循环`);
  });

  it('refuses the name of another living expert, an empty name, an over-long one, and a closed seat', async () => {
    const a = (await w.start({ role: 'explorer', task: 'finish-after:10', cwd: w.dir('rename-b') })).seat;
    const b = (await w.start({ role: 'explorer', task: 'finish-after:10', cwd: w.dir('rename-c') })).seat;
    assert.equal((await w.mcp.tool('seat_rename', { seat: a, name: '读构建的专家' })).isError, false);

    const clash = await w.mcp.tool('seat_rename', { seat: b, name: '读构建的专家' });
    assert.equal(clash.isError, true);
    assert.match(clash.text, new RegExp(`Active expert ${a} already uses the name`));

    for (const name of ['', '   ']) {
      const empty = await w.mcp.tool('seat_rename', { seat: b, name });
      assert.equal(empty.isError, true, JSON.stringify(name));
    }
    const eighty = await w.mcp.tool('seat_rename', { seat: b, name: 'x'.repeat(80) });
    assert.equal(eighty.isError, false, 'exactly 80 characters is fine');
    const long = await w.mcp.tool('seat_rename', { seat: b, name: 'x'.repeat(81) });
    assert.equal(long.isError, true);
    assert.match(long.text, /80/);

    // The daemon route answers 400 with the reason.
    const http = await w.service.call('POST', '/seat/rename', { seat: b, name: '读构建的专家' });
    assert.equal(http.status, 400);
    assert.match(http.json.error, /already uses the name/);

    // A name freed by an archived expert can be taken again; a closed seat cannot be renamed.
    assert.equal((await w.service.call('POST', '/seat/close', { seat: a, reason: '测试' })).status, 200);
    const closed = await w.mcp.tool('seat_rename', { seat: a, name: '归档了还想改' });
    assert.equal(closed.isError, true);
    assert.match(closed.text, /closed and cannot be renamed/);
    assert.equal((await w.mcp.tool('seat_rename', { seat: b, name: '读构建的专家' })).isError, false);

    const unknown = await w.mcp.tool('seat_rename', { seat: 'seat-nope-9', name: 'x' });
    assert.equal(unknown.isError, true);
  });
});

describe('[E-1] names', () => {
  const w = world();

  it('no two living experts in the default list share a name, and no name carries a seat id', async () => {
    // Two directories share their last component: the second must not come out as the first's twin.
    const experts = [
      (await w.start({ role: 'explorer', task: 'finish-after:10', cwd: w.dir('one/proj') })).seat,
      (await w.start({ role: 'explorer', task: 'finish-after:10', cwd: w.dir('two/proj') })).seat,
      (await w.start({ role: 'explorer', task: 'finish-after:10', cwd: w.dir('three') })).seat,
      (await w.start({ role: 'web_researcher', task: 'finish-after:10', domain: 'AI' })).seat,
    ];
    const rows = (await w.service.call('GET', '/seats?view=compact')).json;
    assert.deepEqual(rows.map((r) => r.seat).sort(), [...experts].sort());
    const names = rows.map((r) => r.name);
    assert.equal(new Set(names).size, names.length, `duplicate names: ${names}`);
    for (const name of names) assert.doesNotMatch(name, /seat-/, name);
    assert.ok(names.includes('explorer · three'));
    assert.ok(names.includes('web_researcher · ai'));
  });
});

describe('[E-2] [E-3] point dispatch and the note', () => {
  const w = world();

  it('a second dispatch by seat id continues the first one\'s session, and the note says it was named', async () => {
    const cwd = w.dir('demo');
    const first = await w.start({ role: 'coder', task: 'TASK-ONE', cwd });
    assert.equal(first.reused, false);
    // [E-3] a new expert: who (name and seat id), new, first time here.
    assert.match(first.note, new RegExp(`"coder · demo" \\(${first.seat}\\)`));
    assert.match(first.note, /new expert/);
    assert.match(first.note, /first visit/);

    // [E-3] the same directory: returning, with its visit count.
    const again = await w.start({ role: 'coder', task: 'TASK-TWO', cwd });
    assert.equal(again.seat, first.seat);
    assert.match(again.note, /same directory/);
    assert.match(again.note, /1 prior visit\(s\)/);

    // [E-2] named: no cwd, no domain, just the seat id.
    const named = await w.start({ role: 'coder', task: 'TASK-THREE', seat: first.seat });
    assert.equal(named.seat, first.seat);
    assert.equal(named.reused, true);
    assert.match(named.note, /as named/);
    assert.match(named.note, new RegExp(`"coder · demo" \\(${first.seat}\\)`));
    assert.match(named.note, /2 prior run\(s\)/);

    // And with a cwd that is the expert's own, still fine.
    const withCwd = await w.start({ role: 'coder', task: 'TASK-FOUR', seat: first.seat, cwd });
    assert.equal(withCwd.seat, first.seat);
    assert.match(withCwd.note, /3 prior run\(s\)/);

    const calls = fs.readFileSync(w.service.env.FAKE_CODEX_CALLS, 'utf8').trim().split('\n').map((line) => JSON.parse(line)).filter((call) => !call.closing);
    assert.equal(calls.length, 4);
    assert.ok(!calls[0].args.includes('resume'));
    for (const call of calls.slice(1)) assert.ok(call.args.includes('resume'), 'the named run continues the expert\'s session');
    assert.match(calls[2].prompt, /TASK-THREE/);
    const shown = await w.show(first.seat);
    assert.equal(shown.events.filter((e) => e.kind === 'task').length, 4, 'all four runs are on one expert');
    assert.ok(shown.events.some((e) => e.kind === 'session' && /Continuing prior session/.test(e.body)));
  });

  it('[E-3] a dispatch with no cwd says it was a one-shot', async () => {
    const shot = await w.start({ role: 'tester', task: 'TASK-ONESHOT' });
    assert.match(shot.note, /one-shot seat/);
    assert.match(shot.note, /no cwd given/);
  });

  it('refuses a seat that does not exist, one of another role, a one-shot seat, and the wrong cwd or domain', async () => {
    const cwd = w.dir('refusals');
    const expert = (await w.start({ role: 'explorer', task: 'finish-after:10', cwd })).seat;
    const seatsBefore = (await w.service.call('GET', '/seats')).json.length;

    assert.match(await w.refused({ role: 'explorer', task: 'x', seat: 'seat-explorer-99' }), /Unknown seat "seat-explorer-99": call seat_list to see active experts/);

    const wrongRole = await w.refused({ role: 'coder', task: 'x', seat: expert });
    assert.match(wrongRole, /explorer/);
    assert.match(wrongRole, /coder/);
    assert.match(wrongRole, /not "coder"/);

    const wrongCwd = await w.refused({ role: 'explorer', task: 'x', seat: expert, cwd: w.dir('elsewhere') });
    assert.match(wrongCwd, new RegExp(`directory ${cwd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.match(wrongCwd, /does not match cwd/);

    const wrongDomain = await w.refused({ role: 'explorer', task: 'x', seat: expert, domain: 'ai' });
    assert.match(wrongDomain, /does not match domain/);

    const oneShot = (await w.start({ role: 'explorer', task: 'finish-after:10' })).seat;
    assert.match(await w.refused({ role: 'explorer', task: 'x', seat: oneShot }), new RegExp(`Seat ${oneShot} is a one-shot seat with no persistent object to resume`));

    assert.equal((await w.service.call('GET', '/seats')).json.length, seatsBefore + 1, 'refused dispatches open no seat (only the one-shot above did)');
    assert.equal((await w.show(expert)).events.filter((e) => e.kind === 'task').length, 1, 'and give the expert no run');
  });

  it('refuses an archived expert with its close reason, and points to the seat it was merged into', async () => {
    const gone = (await w.start({ role: 'explorer', task: 'finish-after:10', cwd: w.dir('merged-away') })).seat;
    const heir = (await w.start({ role: 'explorer', task: 'finish-after:10', cwd: w.dir('merged-into') })).seat;
    assert.equal((await w.service.call('POST', '/seat/close', { seat: gone, reason: `目录搬了，并入 ${heir}，原因写在这里` })).status, 200);
    const text = await w.refused({ role: 'explorer', task: 'x', seat: gone });
    assert.match(text, /is closed/);
    assert.match(text, /目录搬了/);
    assert.match(text, new RegExp(`dispatch to ${heir} instead`));

    const plain = (await w.start({ role: 'explorer', task: 'finish-after:10', cwd: w.dir('archived-plain') })).seat;
    await w.service.call('POST', '/seat/close', { seat: plain, reason: '不用了' });
    const plainText = await w.refused({ role: 'explorer', task: 'x', seat: plain });
    assert.match(plainText, /is closed/);
    assert.match(plainText, /不用了/);
    assert.doesNotMatch(plainText, /dispatch to .* instead/);
  });

  it('[C-3] an expert that is at work is not refused any more: the task goes to a fork of it', async () => {
    // Phase 2 refused here ("正在跑一单；分身还没做"); phase 3 opens a fork that starts from the expert's records.
    const cwd = w.dir('busy');
    const busy = await w.start({ role: 'explorer', task: 'hang', cwd }, { wait: false });
    await w.service.waitSeat(busy.seat, ['running']);
    const reply = await w.start({ role: 'explorer', task: 'finish-after:10', seat: busy.seat }, { wait: false });
    assert.notEqual(reply.seat, busy.seat, 'the second task has a seat of its own');
    assert.equal(reply.fork, true);
    assert.equal(reply.expert, busy.seat);
    assert.match(reply.note, /parallel fork/);
    assert.match(reply.note, new RegExp(reply.seat));
    const fork = await w.service.waitSeat(reply.seat, ['closed']);
    assert.equal(fork.seat.parent, busy.seat);
    assert.equal(fork.seat.fork, true);
    assert.equal((await w.show(busy.seat)).events.filter((e) => e.kind === 'task').length, 1, 'the expert is not given the fork\'s run');
    assert.equal((await w.service.call('POST', '/seat/close', { seat: busy.seat, reason: 'test over' })).status, 200);
  });

  it('a domain expert can be named too, and works in its own domain directory', async () => {
    const first = await w.start({ role: 'web_researcher', task: 'finish-after:10', domain: 'bio' });
    const named = await w.start({ role: 'web_researcher', task: 'finish-after:10', seat: first.seat });
    assert.equal(named.seat, first.seat);
    assert.match(named.note, /as named/);
    assert.match(named.note, /domain "bio"/);
    const shown = await w.show(first.seat);
    assert.equal(shown.events.filter((e) => e.kind === 'exit').length, 2);
    assert.match(shown.seat.cwd.replaceAll('\\', '/'), /\/\.data\/domains\/web_researcher\//);
    const wrong = await w.refused({ role: 'web_researcher', task: 'x', seat: first.seat, domain: 'ai' });
    assert.match(wrong, /domain "bio"/);
  });
});

describe('[E-7] one directory, one expert', () => {
  const w = world();

  it('a symlink (junction) to a directory and its real path land on the same expert, stored under the real path', async () => {
    const real = w.dir('real-dir');
    const link = path.join(w.scratch, 'link-to-real');
    fs.symlinkSync(real, link, 'junction');

    const viaLink = await w.start({ role: 'explorer', task: 'finish-after:10', cwd: link });
    const viaReal = await w.start({ role: 'explorer', task: 'finish-after:10', cwd: real });
    assert.equal(viaReal.seat, viaLink.seat, 'the second route finds the first route\'s expert');
    assert.equal(viaReal.reused, true);
    assert.equal((await w.show(viaLink.seat)).seat.cwd, fs.realpathSync.native(real), 'the expert is stored under the real path');

    const rows = (await w.service.call('GET', `/seats?view=compact&cwd=${encodeURIComponent(link)}`)).json;
    assert.deepEqual(rows.map((r) => r.seat), [viaLink.seat], 'the roster filter resolves the link too');
    const back = (await w.service.call('GET', `/seats?view=compact&cwd=${encodeURIComponent(real)}`)).json;
    assert.deepEqual(back.map((r) => r.seat), [viaLink.seat]);

    // Point dispatch with the link as cwd is the expert's own directory.
    const named = await w.start({ role: 'explorer', task: 'finish-after:10', seat: viaLink.seat, cwd: link });
    assert.equal(named.seat, viaLink.seat);
  });

  it('on a case-sensitive platform two directories that differ only in case are two experts', async (t) => {
    if (process.platform === 'win32' || process.platform === 'darwin') return t.skip('this platform folds case');
    const upper = w.dir('CaseDir');
    try {
      fs.mkdirSync(path.join(w.scratch, 'casedir'));
    } catch {
      return t.skip('this file system folds case');
    }
    const lower = path.join(w.scratch, 'casedir');
    const a = await w.start({ role: 'explorer', task: 'finish-after:10', cwd: upper });
    const b = await w.start({ role: 'explorer', task: 'finish-after:10', cwd: lower });
    assert.notEqual(a.seat, b.seat);
    assert.equal(b.reused, false);
  });
});

describe('[E-6] the roster', () => {
  const w = world();

  it('filters by role, and a line carries name, seat id, role, object, state, visits and backlog', async () => {
    const dir = w.dir('roster');
    const e = await w.start({ role: 'explorer', task: 'finish-after:10:- 还差 X', cwd: dir });
    await w.start({ role: 'explorer', task: 'finish-after:10:- 还差 X', cwd: dir });
    const c = await w.start({ role: 'coder', task: 'TASK-ROSTER', cwd: dir });
    assert.notEqual(c.seat, e.seat);

    const all = (await w.mcp.tool('seat_list')).text;
    assert.ok(all.includes(e.seat) && all.includes(c.seat));

    const only = (await w.mcp.tool('seat_list', { role: 'explorer' })).text;
    assert.ok(only.includes(e.seat), only);
    assert.ok(!only.includes(c.seat), only);
    // (while HSkills is missing in the sandbox, its error is the first line: find the header by content)
    assert.ok(only.split('\n').some((l) => /^1 expert\(s\) for role explorer/.test(l)), only);

    const line = only.split('\n').find((l) => l.includes(` · ${e.seat} · `));
    const parts = line.split(' · ');
    // name carries its own " · ", so read the fields from the seat id on.
    const at = parts.indexOf(e.seat);
    assert.equal(parts[0] + ' · ' + parts[1], '[explorer · roster]');
    assert.deepEqual(parts.slice(at + 1, at + 4), ['explorer', dir, 'done']);
    assert.equal(parts[at + 4], '2 visit(s)');
    assert.equal(parts[at + 5], 'backlog 1');

    const http = (await w.service.call('GET', '/seats?view=compact&role=coder')).json;
    assert.deepEqual(http.map((r) => r.seat), [c.seat]);
    assert.equal(http[0].visits, 1);
    assert.deepEqual((await w.service.call('GET', '/seats?view=compact&role=tester')).json, []);
  });
});
