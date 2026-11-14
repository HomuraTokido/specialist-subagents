import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it, after, before } from 'node:test';
import { sleep, startService, tempDir } from './lib/sandbox.mjs';
import { DatabaseSync } from 'node:sqlite';
import { loadStore } from './lib/store.mjs';

await describe('ledger-events', { concurrency: false }, async () => {
// G-1: the ledger records a run line by line, so any run can be restored from it.
//
// The runtime here prints more than 64KB (the cap exec.mjs puts on the output it keeps in memory,
// capped()) in numbered lines. The ledger is not capped that way: every line is its own event, in order.
// The capped copy of the output is only the value the executor's promise resolves with, and nothing
// serves it (no HTTP route, no MCP tool reads it), so the cap is not observable from outside; what a
// caller can observe, and what this asserts, is that the events past the cap are all there.






const LINES = 3000;
const LINE_WIDTH = 40;
const expectedLine = (n) => `line-${String(n).padStart(4, '0')}-`.padEnd(LINE_WIDTH, 'x');

// A runtime that waits until the test creates the gate file (so the test can see the seat running
// however loaded the machine is), prints LINES lines and leaves the result file a real runner leaves.
const FAKE_LINES = `
import fs from 'node:fs';
const say = (text) => process.stdout.write(text);
const waitForGate = setInterval(() => {
  if (!fs.existsSync(process.env.FAKE_LINES_GATE)) return;
  clearInterval(waitForGate);
  let out = '';
  for (let n = 0; n < ${LINES}; n += 1) out += \`line-\${String(n).padStart(4, '0')}-\`.padEnd(${LINE_WIDTH}, 'x') + '\\n';
  say(out);
  fs.writeFileSync(process.env.SPECIALIST_SEAT_RESULT, JSON.stringify({
    tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 },
    expertise: 'fake-lines knows this directory',
    backlog: '',
    model: 'fake/fake-lines',
    difficulties: [],
  }));
  process.exit(0);
}, 50);
`;

function fakeRuntime(root) {
  fs.writeFileSync(path.join(root, 'src', 'fake-lines.mjs'), FAKE_LINES);
  const file = path.join(root, 'roles.json');
  const roles = JSON.parse(fs.readFileSync(file, 'utf8'));
  roles.explorer.spawn.args = ['src/fake-lines.mjs', '--pi', '{runtime}', '--tools', 'read,grep,find,ls', '-p', '{task}'];
  fs.writeFileSync(file, JSON.stringify(roles, null, 2));
}

const services = [];
const scratches = [];
afterEach(async () => {
  while (services.length) await services.pop().stop();
  while (scratches.length) fs.rmSync(scratches.pop(), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe('the ledger keeps a long run line by line', () => {
  it('[G-1] a run printing more than 64KB is restorable event by event, and the seat goes open, running, done', async () => {
    assert.ok(LINES * (LINE_WIDTH + 1) > 64 * 1024, 'the fixture has to exceed the cap');
    const cwd = tempDir('ssa-g1-');
    scratches.push(cwd);
    const gate = path.join(cwd, 'gate');
    const service = await startService({ prepare: fakeRuntime, env: { FAKE_LINES_GATE: gate } });
    services.push(service);

    // A seat starts life open, before any run.
    const opened = await service.call('POST', '/seat/open', { role: 'explorer' });
    assert.equal(opened.status, 200, opened.text);
    assert.equal((await service.call('GET', `/seats/${opened.json.seat}`)).json.seat.state, 'open');

    const started = await service.call('POST', '/seat/start', { role: 'explorer', task: 'print many lines', cwd });
    assert.equal(started.status, 200, started.text);
    const seat = started.json.seat;

    // The seat is open for an instant while the runtime is being spawned (the reply does not wait for
    // that), then running for as long as the runtime waits at its gate; then the gate opens.
    const end = Date.now() + 15000;
    let state;
    do {
      state = (await service.call('GET', `/seats/${seat}`)).json.seat.state;
      if (state !== 'running') await sleep(50);
    } while (state !== 'running' && Date.now() < end);
    assert.equal(state, 'running', service.log());
    fs.writeFileSync(gate, 'go\n');

    const done = await service.waitSeat(seat, ['done', 'failed', 'interrupted']);
    assert.equal(done.seat.state, 'done', service.log());

    const { json: all } = await service.call('GET', `/seats/${seat}?tail=all`);
    assert.equal(all.events_omitted, 0);
    const kinds = all.events.map((event) => event.kind);
    assert.equal(kinds[0], 'task', 'a run opens with its task event');
    assert.equal(kinds.at(-1), 'exit', 'and closes with its exit event');

    const stdout = all.events.filter((event) => event.kind === 'stdout');
    assert.equal(stdout.length, LINES, 'one event per line, none lost after the cap');
    assert.deepEqual(stdout.map((event) => event.body), Array.from({ length: LINES }, (_, n) => expectedLine(n)), 'in the order they were printed');
    const seqs = all.events.map((event) => event.seq);
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), 'event numbers only go up');

    // The same run, asked for by its task event, restores the same lines.
    const run = all.runs.at(-1).run;
    const { json: one } = await service.call('GET', `/seats/${seat}?tail=all&run=${run}`);
    assert.equal(one.events.filter((event) => event.kind === 'stdout').length, LINES);
  });
});
});

await describe('guards', { concurrency: false }, async () => {
// Two ledger guards that fail quietly when missing: the index that keeps /seats cheap as the events
// table grows, and closed staying closed, and the reconcile rules for a running seat.





let env;
let store;
before(async () => {
  env = await loadStore();
  store = env.store;
});
after(() => env?.cleanup());

describe('events index', () => {
  it('seatRow\'s latest-task lookup is answered from an index, not a scan of the events table', () => {
    store.openSeat({ role: 'coder' }); // opening a seat makes the store create its schema
    const db = new DatabaseSync(env.file, { readOnly: true });
    try {
      const plan = db
        .prepare("EXPLAIN QUERY PLAN SELECT MAX(at) AS at FROM events WHERE seat = ? AND kind = 'task'")
        .all('seat-coder-1')
        .map((row) => row.detail)
        .join('\n');
      assert.match(plan, /USING (COVERING )?INDEX events_seat_kind_at/);
      assert.doesNotMatch(plan, /SCAN events/);
    } finally {
      db.close();
    }
  });
});

describe('closeSeat and a run that ends afterwards', () => {
  it('[G-1] closes a running row (killing the process is left to exec.mjs) and no later write moves it off closed', () => {
    const { seat } = store.openSeat({ role: 'coder' });
    store.bindSeat({ seat, handle: 'pid', pid: process.pid });
    const closed = store.closeSeat({ seat, reason: 'cancel it' });
    assert.equal(closed.state, 'closed');
    assert.ok(closed.closed_at);
    // What a cancelled run still does when it ends: settle() writes done/failed, and the child's late
    // 'spawn' event binds its pid. Neither may bring the retired seat back.
    store.setSeatState({ seat, state: 'done' });
    store.bindSeat({ seat, handle: 'pid', pid: process.pid });
    assert.equal(store.showSeat(seat).seat.state, 'closed');
    assert.equal(store.claimSeat({ role: 'coder', cwd: env.file.replace(/ledger\.sqlite3$/, '') }).seat === seat, false);
  });

  it('closes a seat that has finished', () => {
    const { seat } = store.openSeat({ role: 'coder' });
    store.bindSeat({ seat, handle: 'pid', pid: process.pid });
    store.setSeatState({ seat, state: 'done' });
    const closed = store.closeSeat({ seat, reason: 'done with it' });
    assert.equal(closed.state, 'closed');
    assert.ok(closed.closed_at);
  });
});

describe('reconcileRunning', () => {
  const dead = 2147483000; // no such process

  it('[G-2] marks a running seat whose pid is gone as interrupted', () => {
    const { seat } = store.openSeat({ role: 'coder' });
    store.bindSeat({ seat, handle: 'pid', pid: dead });
    assert.ok(store.reconcileRunning().includes(seat));
    assert.equal(store.showSeat(seat).seat.state, 'interrupted');
  });

  it('[G-2] leaves a seat alone while a supervisor in this process is settling it', () => {
    const { seat } = store.openSeat({ role: 'coder' });
    store.bindSeat({ seat, handle: 'pid', pid: dead });
    store.superviseSeat(seat);
    assert.deepEqual(store.reconcileRunning().filter((id) => id === seat), []);
    assert.equal(store.showSeat(seat).seat.state, 'running');
    store.superviseSeat(seat, false);
    assert.ok(store.reconcileRunning().includes(seat));
  });

  it('[G-2] reads EPERM as alive, the same as the daemon does', () => {
    const { seat } = store.openSeat({ role: 'coder' });
    store.bindSeat({ seat, handle: 'pid', pid: 1234567 });
    const original = process.kill;
    process.kill = (pid, signal) => {
      if (pid === 1234567) throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
      return original.call(process, pid, signal);
    };
    try {
      assert.equal(store.reconcileRunning().includes(seat), false);
    } finally {
      process.kill = original;
    }
    assert.equal(store.showSeat(seat).seat.state, 'running');
  });
});
});

await describe('views', { concurrency: false }, async () => {
// The ledger's views for a model reader (store.listSeatsCompact, store.runSummary): who counts as a
// living directory expert, and what one run comes back as — status, verdict, unfinished list and a
// report cut to its budget, taken from the output when no report file exists.






describe('views for the lead', () => {
  let ctx;
  let store;
  let dirA;
  let dirB;
  before(async () => {
    ctx = await loadStore();
    store = ctx.store;
    dirA = tempDir('ssa-view-a-');
    dirB = tempDir('ssa-view-b-');
  });
  after(() => {
    ctx?.cleanup();
    for (const dir of [dirA, dirB]) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('[E-6] seat_list keeps only living directory experts, and cwd narrows to one directory', () => {
    const expert = store.claimSeat({ role: 'coder', cwd: dirA }).seat;
    store.recordEvent({ seat: expert, kind: 'task', body: 'work' });
    store.setSeatProfile({ seat: expert, expertise: '我熟悉这个目录的构建。也读过测试。还看过文档。', backlog: '- 一\n- 二\n- 三' });
    store.setSeatState({ seat: expert, state: 'done' });

    const neverRan = store.claimSeat({ role: 'explorer', cwd: dirB }).seat;
    const oneShot = store.openSeat({ role: 'coder' }).seat;
    store.recordEvent({ seat: oneShot, kind: 'task', body: 'no cwd' });
    const closed = store.claimSeat({ role: 'tester', cwd: dirA }).seat;
    store.recordEvent({ seat: closed, kind: 'task', body: 'x' });
    store.closeSeat({ seat: closed });

    const rows = store.listSeatsCompact();
    assert.deepEqual(rows.map((r) => r.seat), [expert]);
    assert.equal(rows[0].backlog_items, 3);
    assert.equal(rows[0].expertise, '我熟悉这个目录的构建。也读过测试。…', 'two sentences, marked as cut');
    for (const gone of [neverRan, oneShot, closed]) assert.ok(!rows.some((r) => r.seat === gone), gone);

    assert.deepEqual(store.listSeatsCompact({ cwd: dirB }), []);
    assert.deepEqual(store.listSeatsCompact({ cwd: dirA }).map((r) => r.seat), [expert]);
    assert.deepEqual(store.listSeatsCompact({ state: 'closed' }).map((r) => r.seat), [closed], 'an explicit state lists every seat in it');
    assert.throws(() => store.listSeatsCompact({ cwd: 'relative/dir' }), /absolute path/);
  });

  it('[O-5][O-4] a run summary reads its end, verdict and backlog off the events, and its report off the output past the last tool line', () => {
    const seat = store.claimSeat({ role: 'coder', cwd: dirB }).seat;
    const task = store.recordEvent({ seat, kind: 'task', body: 'FIRST' });
    for (const line of ['先看看', '· read a.md', '结论第一行', '结论第二行']) store.recordEvent({ seat, kind: 'stdout', body: line });
    store.recordEvent({ seat, kind: 'usage', body: '输入 10 token（另有缓存命中 0），输出 5 token（fake/model）' });
    store.recordEvent({ seat, kind: 'backlog', body: '它报告没做完的部分：\n- 还差一步' });
    store.recordEvent({ seat, kind: 'exit', body: '0' });
    store.setSeatState({ seat, state: 'done' });

    let s = store.runSummary({ seat });
    assert.equal(s.run.run, task.seq);
    assert.equal(s.run.status, 'done');
    assert.equal(s.run.ended, true);
    assert.equal(s.run.report.text, '结论第一行\n结论第二行');
    assert.equal(s.run.report.source, 'output');
    assert.equal(s.run.backlog, '- 还差一步');
    assert.equal(s.run.backlog_items, 1);
    assert.equal(s.run.verdict, null);

    // A newer run starts; a verdict that names the first run still lands on it.
    const second = store.recordEvent({ seat, kind: 'task', body: 'SECOND' });
    store.setSeatState({ seat, state: 'running' });
    store.recordSeatVerdict({ seat, verdict: 'accepted', run: task.seq });
    s = store.runSummary({ run: task.seq });
    assert.match(s.run.verdict, /^accepted/);
    assert.equal(s.run.latest, false);
    assert.equal(store.runSummary({ seat }).run.run, second.seq);
    assert.equal(store.runSummary({ seat }).run.status, 'running', 'the seat is still open for the second run');

    // Over the budget: cut, and saved to a file whose path comes back.
    store.recordEvent({ seat, kind: 'stdout', body: 'x'.repeat(500) });
    store.recordEvent({ seat, kind: 'exit', body: '1' });
    s = store.runSummary({ seat, budget: 200 });
    assert.equal(s.run.status, 'failed');
    assert.equal(s.run.report.truncated, true);
    assert.equal(s.run.report.text.length, 200);
    assert.equal(fs.readFileSync(s.run.report.file, 'utf8').trim().length, 500);

    // The runner's own report file wins over the output.
    store.saveReport({ seat, run: second.seq, text: 'RUNNER REPORT' });
    s = store.runSummary({ run: second.seq });
    assert.equal(s.run.report.text, 'RUNNER REPORT');
    assert.equal(s.run.report.source, 'runner');

    assert.throws(() => store.runSummary({ run: 999999 }), /No run numbered 999999/);
    assert.throws(() => store.runSummary({}), /Pass at least one of seat or run/);
  });
});
});
