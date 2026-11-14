import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, it, afterEach } from 'node:test';
import { sleep, startService } from './lib/sandbox.mjs';
import { loadStore } from './lib/store.mjs';

await describe('ledger', { concurrency: false }, async () => {
// Ledger behaviour that fails quietly: which verdicts reach the difficulty ledger, and which moment
// counts as "the current run started" for a seat that is reused.






// store.mjs is a per-process singleton, so both suites share one temp ledger and use seats of their own.
let env;
let store;
before(async () => {
  env = await loadStore();
  store = env.store;
});
after(() => env?.cleanup());

describe('recordSeatVerdict', () => {
  const difficulties = () => {
    const db = new DatabaseSync(env.file, { readOnly: true });
    try {
      return db.prepare('SELECT seat, expert, run, role, kind, detail FROM difficulties ORDER BY seq').all();
    } finally {
      db.close();
    }
  };

  it('writes revised and rejected as difficulties of that run, with the note as evidence', () => {
    const { seat } = store.openSeat({ role: 'coder' });
    const task = store.recordEvent({ seat, kind: 'task', body: 'do it' });

    store.recordSeatVerdict({ seat, verdict: 'revised', note: '改了测试的路径' });
    store.recordSeatVerdict({ seat, verdict: 'rejected', note: '方向错了' });

    const rows = difficulties().filter((row) => row.seat === seat);
    assert.deepEqual(rows.map((row) => row.kind), ['revised', 'rejected']);
    assert.deepEqual(rows.map((row) => row.detail), ['改了测试的路径', '方向错了']);
    for (const row of rows) {
      assert.equal(row.role, 'coder');
      assert.equal(row.run, `${seat}#${task.seq}`, 'the difficulty is tied to the run the verdict is about');
    }
    const classes = store.difficultyClasses().map((klass) => klass.class);
    assert.ok(classes.includes('coder|revised|-') && classes.includes('coder|rejected|-'));
  });

  it('records accepted as an event only, never as a difficulty', () => {
    const { seat } = store.openSeat({ role: 'explorer' });
    store.recordEvent({ seat, kind: 'task', body: 'look' });
    const event = store.recordSeatVerdict({ seat, verdict: 'accepted' });
    assert.equal(event.kind, 'verdict');
    assert.equal(event.body, 'accepted');
    assert.equal(difficulties().filter((row) => row.seat === seat).length, 0);
    assert.ok(store.listEvents(seat).some((ev) => ev.kind === 'verdict'));

    // A note on an accepted run is kept in the event and still is not a difficulty.
    store.recordSeatVerdict({ seat, verdict: 'accepted', note: '很好' });
    assert.equal(store.listEvents(seat).at(-1).body, 'accepted: 很好');
    assert.equal(difficulties().filter((row) => row.seat === seat).length, 0);
  });

  it('refuses revised and rejected without a note, and writes nothing for them', () => {
    const { seat } = store.openSeat({ role: 'tester' });
    store.recordEvent({ seat, kind: 'task', body: 'x' });
    for (const note of [undefined, '', '   ']) {
      assert.throws(() => store.recordSeatVerdict({ seat, verdict: 'revised', note }), /note/);
      assert.throws(() => store.recordSeatVerdict({ seat, verdict: 'rejected', note }), /note/);
    }
    assert.equal(store.listEvents(seat).filter((ev) => ev.kind === 'verdict').length, 0);
    assert.equal(difficulties().filter((row) => row.seat === seat).length, 0);
  });

  it('refuses an unknown verdict word and an unknown seat', () => {
    const { seat } = store.openSeat({ role: 'tester' });
    assert.throws(() => store.recordSeatVerdict({ seat, verdict: 'great', note: 'x' }), /accepted.*revised.*rejected/);
    assert.throws(() => store.recordSeatVerdict({ seat: 'seat-nope-9', verdict: 'accepted' }), /unknown seat/);
  });

  it('a verdict on a seat that has no task event still records, with no run key', () => {
    const { seat } = store.openSeat({ role: 'handyman' });
    store.recordSeatVerdict({ seat, verdict: 'rejected', note: '没派活就退回' });
    const row = difficulties().find((r) => r.seat === seat);
    assert.equal(row.run, null);
  });
});

describe('seat run_started_at', () => {
  it('is the latest task event, not the time the seat was opened', async () => {
    const { seat } = store.openSeat({ role: 'coder' });
    await sleep(15);
    const first = store.recordEvent({ seat, kind: 'task', body: 'one' });
    await sleep(15);
    const second = store.recordEvent({ seat, kind: 'task', body: 'two' });
    // Other event kinds after the task do not move it.
    await sleep(15);
    store.recordEvent({ seat, kind: 'stdout', body: 'output' });

    const shown = store.showSeat(seat).seat;
    assert.equal(shown.run_started_at, second.at);
    assert.notEqual(shown.run_started_at, shown.opened_at);
    assert.notEqual(shown.run_started_at, first.at);
    assert.ok(shown.opened_at < first.at);
    assert.equal(store.listSeats().find((s) => s.id === seat).run_started_at, second.at);
  });

  it('stays the same seat and follows the reuse: claimSeat then a new task moves it forward', async () => {
    const cwd = env.file.replace(/ledger\.sqlite3$/, '');
    const { seat } = store.claimSeat({ role: 'coder', cwd });
    const first = store.recordEvent({ seat, kind: 'task', body: 'one' });
    store.setSeatProfile({ seat, sessionFile: 'session.jsonl' });
    store.setSeatState({ seat, state: 'done' });

    await sleep(15);
    const again = store.claimSeat({ role: 'coder', cwd });
    assert.equal(again.seat, seat);
    assert.equal(again.reused, true);
    const second = store.recordEvent({ seat, kind: 'task', body: 'two' });

    const shown = store.showSeat(seat).seat;
    assert.equal(shown.run_started_at, second.at);
    assert.notEqual(shown.run_started_at, first.at);
    assert.equal(shown.opened_at <= first.at, true);
  });

  it('is null for a seat that has not been given a task', () => {
    const { seat } = store.openSeat({ role: 'explorer' });
    assert.equal(store.showSeat(seat).seat.run_started_at, null);
  });
});

// S-1 (2026-10-11): a difficulty is filed under an expert, not only under the seat that paid it. A
// fork is not an expert: what it ran into belongs to the expert it was forked from, the same way its
// run does. Without the column a fork's trouble is a seat that no longer exists when the fork closes,
// and the expert's own ledger never hears of it.
describe('[S-1] the expert a difficulty belongs to', () => {
  const rowsOf = () => {
    const db = new DatabaseSync(env.file, { readOnly: true });
    try {
      return db.prepare('SELECT seq, seat, expert, role, kind, detail FROM difficulties ORDER BY seq').all();
    } finally {
      db.close();
    }
  };

  it('[S-1] an expert\'s own difficulty is filed under itself, and a fork\'s under its expert', () => {
    const expert = store.openSeat({ role: 'coder', cwd: '/work/a' }).seat;
    const fork = store.openSeat({ role: 'coder', cwd: '/work/a', parent: expert, fork: true }).seat;

    store.recordDifficulty({ seat: expert, role: 'coder', kind: 'failed', detail: '专家自己的问题' });
    store.recordDifficulty({ seat: fork, role: 'coder', kind: 'error', tool: 'bash', detail: '分身遇到的问题' });

    const rows = rowsOf().filter((row) => row.seat === expert || row.seat === fork);
    const bySeat = Object.fromEntries(rows.map((row) => [row.seat, row]));
    assert.equal(bySeat[expert].expert, expert, 'its own difficulty is its own');
    assert.equal(bySeat[fork].expert, expert, "a fork's difficulty is filed under its expert");
    assert.equal(bySeat[fork].seat, fork, 'the seat that paid it is still on the row');
  });

  it('[S-1] a seat the ledger no longer holds is its own expert, and an explicit expert wins', () => {
    const { seat } = store.openSeat({ role: 'tester' });
    store.recordDifficulty({ seat: 'seat-tester-999', role: 'tester', kind: 'failed', detail: '座位已经不在台账里' });
    store.recordDifficulty({ seat, expert: 'seat-tester-1', role: 'tester', kind: 'failed', detail: '写明属于哪个专家' });

    const bySeat = Object.fromEntries(rowsOf().filter((row) => row.detail === '写明属于哪个专家').map((row) => [row.seat, row]));
    assert.equal(bySeat[seat].expert, 'seat-tester-1', 'what the caller says is written');
    const gone = rowsOf().find((row) => row.detail === '座位已经不在台账里');
    assert.equal(gone.expert, 'seat-tester-999', 'a seat that is gone is filed under itself, not left empty');
  });
});
});

await describe('data', { concurrency: false }, async () => {
// Input validation and data correctness (2026-09-30 review): memory limits and roles, the cost_report
// `since`, a verdict aimed at an earlier run, and the event kinds a caller may not write.
// The first describe runs the ledger module in this process; the second runs the daemon over HTTP.






describe('the ledger', () => {
  let env;
  let store;
  before(async () => {
    env = await loadStore();
    store = env.store;
  });
  after(() => env?.cleanup());

  describe('memory', () => {
    it('[S-5] keeps the older facts when one fact is bigger than the whole digest, and clips only that one', () => {
      store.memoryWrite({ role: 'coder', kind: 'fact', body: 'small fact A' });
      store.memoryWrite({ role: 'coder', kind: 'fact', body: 'small fact B' });
      store.memoryWrite({ role: 'coder', kind: 'fact', body: '长'.repeat(3900) });
      const digest = store.memoryDigest('coder');
      assert.match(digest, /small fact A/);
      assert.match(digest, /small fact B/);
      assert.match(digest, /这条记忆太长.*memory_read/, 'the clipped entry says so and says where the whole text is');
      assert.ok(Buffer.byteLength(digest, 'utf8') <= 4096, `digest is ${Buffer.byteLength(digest, 'utf8')} bytes`);
      assert.doesNotMatch(digest, /\uFFFD/, 'the cut did not stop inside a character');
      assert.doesNotMatch(digest, /未注入/, 'nothing was dropped');
    });

    it('[S-5] refuses a memory over 4000 characters and says to split it', () => {
      assert.throws(() => store.memoryWrite({ role: 'coder', kind: 'note', body: 'x'.repeat(4001) }), /at most 4000 characters.*Split it/);
      assert.equal(store.memoryWrite({ role: 'coder', kind: 'note', body: 'x'.repeat(4000) }).body.length, 4000);
    });

    it('refuses an unknown role and lists the valid ones, writing nothing', () => {
      assert.throws(() => store.memoryWrite({ role: 'web-researcher', kind: 'fact', body: 'x' }), /unknown role "web-researcher".*web_researcher/);
      assert.equal(store.listMemories({ role: 'web-researcher' }).length, 0);
    });

    it('takes a fractional limit instead of failing inside SQLite', () => {
      for (let i = 0; i < 4; i++) store.memoryWrite({ role: 'tester', kind: 'note', body: `n${i}` });
      assert.equal(store.listMemories({ role: 'tester', limit: 2.5 }).length, 2);
      assert.equal(store.listMemories({ role: 'tester', limit: 0.5 }).length, 1, 'a fraction below 1 still returns something, never everything');
    });
  });

  describe('cost_report since', () => {
    it('reads a bare date as the start of that day in local time, and an offset timestamp as that instant', () => {
      assert.equal(store.parseSince('2026-09-30'), new Date(2026, 8, 30).getTime());
      assert.equal(store.parseSince('2026-09-30T11:35:00+08:00'), Date.parse('2026-09-30T03:35:00Z'));
      assert.equal(store.parseSince('2026-09-30T03:35:00Z'), Date.parse('2026-09-30T03:35:00Z'));
      assert.equal(store.parseSince('2026-09-30 11:35:00+0800'), Date.parse('2026-09-30T03:35:00Z'));
    });

    it('rejects what it cannot read, saying what to write instead of returning an empty report', () => {
      for (const bad of ['yesterday', '2026-9-1', '2026-02-31', 'March 5', '30/09/2026']) {
        assert.throws(() => store.costRuns({ since: bad }), /since must be a date.*2026-09-30/, bad);
      }
    });

    it('compares instants, so a timestamp in another offset still finds the run', () => {
      const { seat } = store.openSeat({ role: 'explorer' });
      store.recordEvent({ seat, kind: 'task', body: 'since test' });
      const label = (offsetMs) => `${new Date(Date.now() + offsetMs + 8 * 3600000).toISOString().slice(0, 19)}+08:00`;
      const has = (since) => store.costRuns({ since }).some((run) => run.seat === seat);
      assert.equal(has(label(-3600000)), true, 'one hour before the run, written in +08:00');
      assert.equal(has(label(3600000)), false, 'one hour after it');
    });
  });

  describe('a verdict on an earlier run', () => {
    const difficulties = () => {
      const db = new DatabaseSync(env.file, { readOnly: true });
      try {
        return db.prepare('SELECT seat, run, kind FROM difficulties ORDER BY seq').all();
      } finally {
        db.close();
      }
    };

    it('lands on the run it names, in the difficulty ledger and in cost_report, and defaults to the newest', () => {
      const { seat } = store.openSeat({ role: 'coder' });
      const first = store.recordEvent({ seat, kind: 'task', body: 'run one' });
      const second = store.recordEvent({ seat, kind: 'task', body: 'run two' });

      assert.deepEqual(store.showSeat(seat).runs.map((r) => r.run), [first.seq, second.seq], 'seat_show lists the run ids');
      store.recordSeatVerdict({ seat, verdict: 'rejected', note: 'wrong direction', run: first.seq });
      const runs = store.costRuns().filter((r) => r.seat === seat);
      assert.deepEqual(runs.map((r) => r.verdict), ['rejected', null], 'run one is judged, run two is not');
      assert.ok(difficulties().some((row) => row.seat === seat && row.run === `${seat}#${first.seq}` && row.kind === 'rejected'));

      store.recordSeatVerdict({ seat, verdict: 'accepted' });
      assert.deepEqual(store.costRuns().filter((r) => r.seat === seat).map((r) => r.verdict), ['rejected', 'accepted'], 'no run: the newest one');
    });

    it('refuses a run that is not a task event of that seat', () => {
      const { seat } = store.openSeat({ role: 'coder' });
      const other = store.openSeat({ role: 'coder' }).seat;
      const foreign = store.recordEvent({ seat: other, kind: 'task', body: 'not mine' });
      store.recordEvent({ seat, kind: 'task', body: 'mine' });
      assert.throws(() => store.recordSeatVerdict({ seat, verdict: 'accepted', run: foreign.seq }), /has no run starting at event/);
      assert.throws(() => store.recordSeatVerdict({ seat, verdict: 'accepted', run: 1.5 }), /task event seq/);
    });
  });
});

describe('the daemon over HTTP', () => {
  const services = [];
  afterEach(async () => {
    while (services.length) await services.pop().stop();
  });

  it('refuses the event kinds the service writes itself, and takes a note', async () => {
    const service = await startService();
    services.push(service);
    const { seat } = (await service.call('POST', '/seat/open', { role: 'coder' })).json;
    for (const kind of ['task', 'usage', 'exit', 'verdict', 'runner']) {
      const res = await service.call('POST', '/seat/record', { seat, kind, body: 'forged' });
      assert.equal(res.status, 400, kind);
      assert.match(res.json.error, /task, usage, exit, verdict, runner.*note.*seat_verdict/);
    }
    assert.equal((await service.call('GET', `/seats/${seat}`)).json.events.length, 0, 'nothing was written');
    assert.equal((await service.call('POST', '/seat/record', { seat, kind: 'note', body: 'fine' })).status, 200);
  });

  it('answers memory and cost queries it cannot honour with a reason, not a database error', async () => {
    const service = await startService();
    services.push(service);
    assert.equal((await service.call('GET', '/memory/read?role=coder&limit=2.5')).status, 200);
    const zero = await service.call('GET', '/memory/read?role=coder&limit=0');
    assert.equal(zero.status, 400);
    assert.match(zero.json.error, /at least 1/);
    const role = await service.call('POST', '/memory/write', { role: 'Coder', kind: 'fact', body: 'x' });
    assert.equal(role.status, 400);
    assert.match(role.json.error, /Valid roles: .*coder/);
    const since = await service.call('GET', '/costs?since=yesterday');
    assert.equal(since.status, 400);
    assert.match(since.json.error, /2026-09-30/);
  });

  it('refuses a verdict whose run is not one of the seat runs', async () => {
    const service = await startService();
    services.push(service);
    const { seat } = (await service.call('POST', '/seat/open', { role: 'coder' })).json;
    const bad = await service.call('POST', '/seat/verdict', { seat, verdict: 'accepted', run: 999 });
    assert.equal(bad.status, 400);
    assert.match(bad.json.error, /has no run starting at event #999/);
  });
});
});

await describe('transaction', { concurrency: false }, async () => {
// G-1: a run's output lines go into the ledger a read at a time, one commit for the whole read
// (store.inTransaction), still one event per line.




describe('[G-1] store.inTransaction', () => {
  let env;
  before(async () => {
    env = await loadStore();
  });
  after(() => env?.cleanup());

  const events = (seat) => env.store.listEvents(seat).map((e) => e.body);

  it('commits the writes together, can be nested, and keeps one event per line', () => {
    const { store } = env;
    const { seat } = store.openSeat({ role: 'explorer' });
    const result = store.inTransaction(() => {
      store.recordEvent({ seat, kind: 'stdout', body: 'one' });
      store.inTransaction(() => store.recordEvent({ seat, kind: 'stdout', body: 'two' }));
      store.recordEvent({ seat, kind: 'stdout', body: 'three' });
      return 'value';
    });
    assert.equal(result, 'value');
    assert.deepEqual(events(seat), ['one', 'two', 'three']);
  });

  it('rolls everything back when the function throws, and the next transaction works', () => {
    const { store } = env;
    const { seat } = store.openSeat({ role: 'explorer' });
    assert.throws(() => store.inTransaction(() => {
      store.recordEvent({ seat, kind: 'stdout', body: 'lost' });
      throw new Error('boom');
    }), /boom/);
    assert.deepEqual(events(seat), []);
    store.inTransaction(() => store.recordEvent({ seat, kind: 'stdout', body: 'kept' }));
    assert.deepEqual(events(seat), ['kept']);
  });

  it('3000 lines in one transaction take a fraction of the time one commit each does', () => {
    const { store } = env;
    const { seat } = store.openSeat({ role: 'explorer' });
    const at = Date.now();
    store.inTransaction(() => {
      for (let n = 0; n < 3000; n += 1) store.recordEvent({ seat, kind: 'stdout', body: `line ${n}` });
    });
    assert.equal(events(seat).length, 3000);
    assert.ok(Date.now() - at < 5000, `took ${Date.now() - at} ms`);
  });
});
});
