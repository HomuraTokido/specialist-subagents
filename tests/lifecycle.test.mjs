import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it, after } from 'node:test';
import { startMcp } from './lib/mcp.mjs';
import { FAKE_SLEEPER, sleep, startService, tempDir } from './lib/sandbox.mjs';
import { openScenario, step, t, brief } from './scenarios/driver.mjs';
import os from 'node:os';
import { sessionPressure, contextTokensFor, HANDOFF_NODE_LARGE_CHARS, CHARS_PER_TOKEN } from '../src/session-pressure.mjs';

await describe('lifecycle', { concurrency: false }, async () => {
// What happens to a seat that is cancelled, runs too long, or breaks the executor, against the real
// daemon with a fake runtime that hangs and has a grandchild (tests/fakes/fake-sleeper.mjs).







const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
};

async function until(check, what, timeoutMs = 15000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

// The explorer role, pointed at the fake runtime (the contract gate still sees a whitelist, a grant
// and the {runtime} placeholder, so the daemon starts).
function fakeRuntime({ timeoutMinutes } = {}) {
  return (root) => {
    fs.copyFileSync(FAKE_SLEEPER, path.join(root, 'src', 'fake-sleeper.mjs'));
    const file = path.join(root, 'roles.json');
    const roles = JSON.parse(fs.readFileSync(file, 'utf8'));
    roles.explorer.spawn.args = ['src/fake-sleeper.mjs', '--pi', '{runtime}', '--tools', 'read,grep,find,ls', '-p', '{task}'];
    if (timeoutMinutes !== undefined) roles.explorer.timeout_minutes = timeoutMinutes;
    fs.writeFileSync(file, JSON.stringify(roles, null, 2));
  };
}

const services = [];
afterEach(async () => {
  while (services.length) await services.pop().stop();
});

async function start(options = {}) {
  const scratch = tempDir('ssa-life-');
  const pidsFile = path.join(scratch, 'pids.json');
  let service;
  try {
    service = await startService({
      env: { FAKE_SLEEPER_PIDS: pidsFile, SPECIALIST_SUBAGENTS_MAX_CONCURRENCY: '1', ...options.env },
      prepare: options.prepare ?? fakeRuntime(options),
    });
  } catch (err) {
    fs.rmSync(scratch, { recursive: true, force: true });
    throw err;
  }
  services.push({ stop: async () => { await service.stop(); fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } });
  const pids = async () => until(() => { try { return JSON.parse(fs.readFileSync(pidsFile, 'utf8')); } catch { return null; } }, 'the runtime to report its pids');
  return { service, scratch, pids, pidsFile };
}

describe('seat_close on a running seat', () => {
  it('[L-5] kills the whole process tree, closes the seat, and the run ending later does not reopen it', async () => {
    const { service, scratch, pids, pidsFile } = await start();
    const cwd = path.join(scratch, 'project');
    fs.mkdirSync(cwd);

    // A finished run first, so the seat has a backlog that a cancelled run must leave alone.
    const first = await service.call('POST', '/seat/start', { role: 'explorer', task: 'finish-after:10:- 还差 X', cwd });
    assert.equal(first.status, 200, first.text);
    await service.waitSeat(first.json.seat, ['done']);
    assert.equal((await service.call('GET', `/seats/${first.json.seat}`)).json.seat.backlog, '- 还差 X');

    const started = await service.call('POST', '/seat/start', { role: 'explorer', task: 'hang', cwd });
    assert.equal(started.status, 200, started.text);
    assert.equal(started.json.seat, first.json.seat, 'the directory expert came back');
    const { runner, grandchild } = await pids();
    assert.ok(alive(runner) && alive(grandchild));

    const closed = await service.call('POST', '/seat/close', { seat: started.json.seat, reason: 'cancelled by the test' });
    assert.equal(closed.status, 200, closed.text);
    assert.equal(closed.json.killed, true);
    assert.equal(closed.json.state, 'closed');
    assert.match(closed.json.note, /process tree/);
    await until(() => !alive(runner) && !alive(grandchild), 'the runner and its grandchild to be gone');

    // settle() runs after the kill: wait for its exit event, then the seat must still be closed.
    const shown = await until(async () => {
      const { json } = await service.call('GET', `/seats/${started.json.seat}`);
      return json.events.some((e) => e.kind === 'exit') ? json : null;
    }, 'the run to be settled');
    assert.equal(shown.seat.state, 'closed');
    assert.ok(shown.seat.closed_at);
    assert.equal(shown.seat.backlog, '- 还差 X', 'no closing question ran, so the backlog is as it was');
    const cancelled = shown.events.filter((e) => e.kind === 'cancelled');
    assert.equal(cancelled.length, 1);
    assert.match(cancelled[0].body, /cancelled by the test/);
    assert.equal(shown.events.some((e) => e.kind === 'difficulty'), false, 'a cancel is the caller\'s choice, not a difficulty');
    fs.rmSync(pidsFile);

    // The concurrency slot (limit 1) is free again, and the retired seat is not handed the next task.
    const next = await until(async () => {
      const res = await service.call('POST', '/seat/start', { role: 'explorer', task: 'finish-after:10', cwd });
      return res.status === 200 ? res : null;
    }, 'the slot to be released');
    assert.notEqual(next.json.seat, started.json.seat);
    // Let that run finish before teardown: on Windows a runner still holding files under the sandbox
    // made removing it fail with EBUSY (CI, 2026-09-30 and 2026-10-01).
    await service.waitSeat(next.json.seat, ['done']);
  });

  it('a seat that is not running is only closed, and the reply says nothing was killed', async () => {
    const { service } = await start();
    const opened = await service.call('POST', '/seat/open', { role: 'explorer' });
    const closed = await service.call('POST', '/seat/close', { seat: opened.json.seat });
    assert.equal(closed.json.killed, false);
    assert.equal(closed.json.state, 'closed');
    assert.match(closed.json.note, /was not running/);
  });
});

describe('the run time limit', () => {
  it('[L-5] kills a run that outlives its role\'s timeout_minutes and records it as failed, without touching the backlog', async () => {
    const { service, pids } = await start({ timeoutMinutes: 0.03 });
    const started = await service.call('POST', '/seat/start', { role: 'explorer', task: 'hang' });
    assert.equal(started.status, 200, started.text);
    const { runner, grandchild } = await pids();

    const shown = await service.waitSeat(started.json.seat, ['failed', 'done', 'interrupted', 'closed'], 20000);
    assert.equal(shown.seat.state, 'failed');
    const timeout = shown.events.find((e) => e.kind === 'timeout');
    assert.ok(timeout, 'a timeout event says what happened');
    assert.match(timeout.body, /Timed out after/);
    assert.match(timeout.body, /timeout_minutes/);
    assert.equal(shown.events.some((e) => e.kind === 'cancelled'), false);
    await until(() => !alive(runner) && !alive(grandchild), 'the runner and its grandchild to be gone');
    assert.equal(shown.seat.backlog, null);
    // The slot (limit 1) is released.
    const next = await until(async () => {
      const res = await service.call('POST', '/seat/start', { role: 'explorer', task: 'finish-after:10' });
      return res.status === 200 ? res : null;
    }, 'the slot to be released');
    assert.equal(next.status, 200);
    await service.waitSeat(next.json.seat, ['done']);
  });

  it('roles.json refuses a timeout_minutes that is not a positive number', async () => {
    await assert.rejects(start({ timeoutMinutes: 'soon' }), /timeout_minutes/);
  });
});

describe('an exception while a run is being set up', () => {
  it('ends the seat failed with the message, and gives the concurrency slot back', async () => {
    // A file where the run directory should be: mkdirSync(.data/run/<seat>) then throws.
    const { service } = await start({
      prepare: (root) => {
        fakeRuntime()(root);
        fs.mkdirSync(path.join(root, '.data'), { recursive: true });
        fs.writeFileSync(path.join(root, '.data', 'run'), 'not a directory');
      },
    });
    const started = await service.call('POST', '/seat/start', { role: 'explorer', task: 'finish-after:10' });
    assert.equal(started.status, 200, started.text);
    const shown = await service.waitSeat(started.json.seat, ['failed', 'done', 'interrupted'], 10000);
    assert.equal(shown.seat.state, 'failed');
    assert.ok(shown.events.some((e) => e.kind === 'error' && /failed during startup or teardown/.test(e.body)));
    const again = await service.call('POST', '/seat/start', { role: 'explorer', task: 'finish-after:10' });
    assert.notEqual(again.status, 429, 'the slot was given back');
  });
});

describe('the concurrency limit', () => {
  it('[O-3] refuses over the limit with a 429 that says the numbers, and the MCP shell relays it as isError', async () => {
    const { service, pids } = await start();
    const first = await service.call('POST', '/seat/start', { role: 'explorer', task: 'hang' });
    assert.equal(first.status, 200, first.text);
    await pids();

    const refused = await service.call('POST', '/seat/start', { role: 'explorer', task: 'hang' });
    assert.equal(refused.status, 429, refused.text);
    assert.match(refused.json.error, /Concurrency limit reached \(1\/1 running\)/);
    assert.match(refused.json.error, /does not queue/);
    assert.deepEqual([refused.json.limit, refused.json.running], [1, 1]);
    assert.equal((await service.call('GET', '/seats')).json.length, 1, 'a refused submission opens no seat');

    const mcp = startMcp(service);
    try {
      const viaMcp = await mcp.tool('seat_start', { role: 'explorer', task: 'hang' });
      assert.equal(viaMcp.isError, true);
      assert.match(viaMcp.text, /Concurrency limit reached \(1\/1 running\)/);
    } finally {
      await mcp.close();
    }
    await service.call('POST', '/seat/close', { seat: first.json.seat, reason: 'test done' });
  });
});
});

await describe('lifecycle-handoff', { concurrency: false }, async () => {
// L-1 / L-2 / L-3 (2026-10-11) at the requirement level, on the fake brain the scenarios use.
// T-4 already covers the whole merge end to end; these are the requirement-tagged checks the prd-check
// tag scan (tests/**/*.test.mjs) reads.






const services = [];
afterEach(async () => {
  while (services.length) await services.pop().close();
});

describe('[L-2] every retirement leaves a close event', () => {
  it('[L-2] closeSeat with no reason records a close event saying 未说明原因', async () => {
    const sc = await openScenario();
    services.push(sc);
    // Open a seat without dispatching anything, then retire it with no reason at all.
    const opened = await sc.service.call('POST', '/seat/open', { role: 'explorer' });
    const seat = opened.json.seat;
    const closed = await sc.tool('seat_close', { seat });
    assert.equal(closed.json.state, 'closed', closed.text);
    const shown = await sc.seat(seat);
    const close = (shown.events ?? []).filter((e) => e.kind === 'close').map((e) => String(e.body ?? ''));
    assert.equal(close.length, 1, `expected exactly one close event, got: ${brief(close.join('｜'))}`);
    assert.match(close[0], /No reason given/, `a reason-less close must say so, got: ${close[0]}`);
  });
});

describe('[L-1] seat_merge folds A into B', () => {
  it('[L-1] archives A (并入 B), keeps B living, and attaches the hand-off to B once', async () => {
    const sc = await openScenario();
    services.push(sc);
    const dirX = sc.workdir({ 'secret.txt': '事实：delta=4\n' });
    const dirY = sc.workdir({ 'other.txt': '事实：eps=5\n' });

    const a = await step(1, 'A learns a fact', async () => {
      const reply = await sc.dispatch({ role: 'explorer', cwd: dirX, task: t('读文件：secret.txt', '读 secret.txt，记住里面的事实。') });
      await sc.answer(reply);
      return reply;
    });
    const b = await step(2, 'B learns its own fact', async () => {
      const reply = await sc.dispatch({ role: 'explorer', cwd: dirY, task: t('读文件：other.txt', '读 other.txt，记住里面的事实。') });
      await sc.answer(reply);
      return reply;
    });

    await step(3, 'merge A into B', async () => {
      await sc.tool('seat_merge', { from: a.seat, into: b.seat });
    });

    await step(4, 'A retired with 并入, B alive', async () => {
      const shown = await sc.seat(a.seat);
      assert.equal(shown.seat.state, 'closed', `A is ${shown.seat.state}`);
      const close = (shown.events ?? []).filter((e) => e.kind === 'close').map((e) => String(e.body ?? ''));
      assert.ok(close.some((body) => body.includes('Merged into')), `A's close reason: ${brief(close.join('｜'))}`);
      const rows = await sc.seats();
      assert.equal(rows.some((row) => row.seat === a.seat), false, 'A still in roster');
      assert.ok(rows.some((row) => row.seat === b.seat), 'B gone from roster');
    });

    await step(5, "B's next run answers A's fact (hand-off attached once)", async () => {
      const reply = await sc.dispatch({ role: 'explorer', seat: b.seat, task: t('问：delta', 'delta 是多少？凭你现在知道的回答。') });
      const answer = await sc.answer(reply);
      assert.match(answer, /delta=4/, `B could not answer A's fact: ${brief(answer, 120)}`);
      const entry = sc.brainOf(reply)[0];
      assert.ok(entry, 'no brain entry for the run');
      assert.match(entry.prompt, /## 懂了什么/, 'the four-section hand-off was not attached');
      // The run after that must not carry the hand-off again.
      const again = await sc.dispatch({ role: 'explorer', seat: b.seat, task: t('问：eps', 'eps 是多少？凭你记得的回答。') });
      await sc.answer(again);
      const againEntry = sc.brainOf(again)[0];
      assert.ok(againEntry);
      assert.doesNotMatch(againEntry.prompt, /## 懂了什么/, 'the hand-off body was attached a second time');
    });
  });

  it('[L-1] refuses to merge two experts of different roles', async () => {
    const sc = await openScenario();
    services.push(sc);
    const dirX = sc.workdir({});
    const a = await sc.dispatch({ role: 'explorer', cwd: dirX, task: t('noop', '读完就好。') });
    await sc.answer(a);
    const coder = await sc.service.call('POST', '/seat/open', { role: 'coder' });
    const refused = await sc.tool('seat_merge', { from: a.seat, into: coder.json.seat }).then(
      () => { throw new Error('seat_merge should have refused different roles'); },
      (err) => err,
    );
    assert.match(String(refused?.message ?? refused), /岗位|角色|role/, `refusal should say the roles differ: ${String(refused?.message ?? refused).slice(0, 160)}`);
  });
});

// S-4, the second layer: what is peculiar to one object is written into that expert's hand-off, never
// into a role's skill. The document the service asks for and writes is four sections, the third of them
// the pitfalls (PRD 2026-10-11), and that is what L-1 and L-3 hand the next expert.
describe('[S-4] a hand-off carries the pitfalls of this object', () => {
  it('[S-4] the hand-off a merge writes, and the ones a split writes, have the 坑 section', async () => {
    const sc = await openScenario();
    services.push(sc);
    const dirX = sc.workdir({ 'secret.txt': '事实：delta=4\n' });
    const dirY = sc.workdir({ 'other.txt': '事实：eps=5\n' });

    const a = await step(1, 'A learns a fact', async () => {
      const reply = await sc.dispatch({ role: 'explorer', cwd: dirX, task: t('读文件：secret.txt', '读 secret.txt，记住里面的事实。') });
      await sc.answer(reply);
      return reply;
    });
    const b = await step(2, 'B learns its own fact', async () => {
      const reply = await sc.dispatch({ role: 'explorer', cwd: dirY, task: t('读文件：other.txt', '读 other.txt，记住里面的事实。') });
      await sc.answer(reply);
      return reply;
    });

    const merged = await step(3, 'merge A into B', () => sc.tool('seat_merge', { from: a.seat, into: b.seat }));
    const mergedFile = merged.json?.file ?? merged.file;
    assert.ok(mergedFile, `the merge says where it wrote the hand-off: ${brief(JSON.stringify(merged.json ?? merged), 200)}`);
    const body = fs.readFileSync(mergedFile, 'utf8');
    assert.match(body, /## 懂了什么/, `the four sections: ${brief(body, 200)}`);
    assert.match(body, /## 踩过的坑/, `the pitfalls of this object are a section of their own: ${brief(body, 200)}`);
    assert.match(body, /## 原始记录路径/);

    // B's next run carries it, pitfalls included.
    await step(4, "B's next run carries the hand-off", async () => {
      const reply = await sc.dispatch({ role: 'explorer', seat: b.seat, task: t('问：delta', 'delta 是多少？凭你现在知道的回答。') });
      await sc.answer(reply);
      const entry = sc.brainOf(reply)[0];
      assert.ok(entry, 'no brain entry for the run');
      assert.match(entry.prompt, /## 踩过的坑/);
    });

    // L-3 writes one per part, and each carries the same section.
    const split = await step(5, 'split B', () => sc.tool('seat_split', { seat: b.seat, parts: [{ name: '读 delta 的专家', topic: 'delta' }, { name: '读 eps 的专家', topic: 'eps' }] }, undefined, { timeoutMs: 90000 }));
    const parts = split.json?.parts ?? split.parts;
    assert.equal(parts.length, 2);
    const handoffs = parts.map((part) => fs.readdirSync(path.join(sc.root, '.data', 'handoffs', part.seat)).filter((name) => name.endsWith('.md')));
    for (const [i, names] of handoffs.entries()) {
      assert.ok(names.length >= 1, `part ${i} has no hand-off document`);
      const text = fs.readFileSync(path.join(sc.root, '.data', 'handoffs', parts[i].seat, names.sort().reverse()[0]), 'utf8');
      assert.match(text, /## 踩过的坑/, `part ${i}'s hand-off: ${brief(text, 200)}`);
    }
  });
});

describe('[L-3] seat_split divides one expert into topic-tagged parts', () => {
  it('[L-3] archives the original (拆为 …), opens a named topic expert per part', async () => {
    const sc = await openScenario();
    services.push(sc);
    const dir = sc.workdir({ 'notes.txt': '事实：delta=4\n事实：eps=5\n' });
    const expert = await step(1, 'one expert reads both facts', async () => {
      const reply = await sc.dispatch({ role: 'explorer', cwd: dir, task: t('读文件：notes.txt', '读 notes.txt，记住里面的两个事实。') });
      await sc.answer(reply);
      return reply;
    });

    const split = await step(2, 'split into delta and eps experts', async () => {
      return sc.tool('seat_split', {
        seat: expert.seat,
        parts: [
          { name: '读 delta 的专家', topic: 'delta' },
          { name: '读 eps 的专家', topic: 'eps' },
        ],
      }, undefined, { timeoutMs: 90000 });
    });

    await step(3, 'original retired 拆为', async () => {
      const shown = await sc.seat(expert.seat);
      assert.equal(shown.seat.state, 'closed', `original is ${shown.seat.state}`);
      const close = (shown.events ?? []).filter((e) => e.kind === 'close').map((e) => String(e.body ?? ''));
      assert.ok(close.some((body) => body.includes('Split into')), `original close reason: ${brief(close.join('｜'))}`);
    });

    await step(4, 'each new expert answers its own fact (its first task carried its hand-off)', async () => {
      const parts = split.json?.parts ?? split.parts;
      const deltaSeat = parts.find((p) => p.topic === 'delta').seat;
      const epsSeat = parts.find((p) => p.topic === 'eps').seat;
      const deltaReply = await sc.dispatch({ role: 'explorer', seat: deltaSeat, task: t('问：delta', 'delta 是多少？凭你现在知道的回答。') });
      assert.match(await sc.answer(deltaReply), /delta=4/, 'delta expert could not answer');
      const epsReply = await sc.dispatch({ role: 'explorer', seat: epsSeat, task: t('问：eps', 'eps 是多少？凭你现在知道的回答。') });
      assert.match(await sc.answer(epsReply), /eps=5/, 'eps expert could not answer');
    });

    await step(5, 'the two topic experts are listed in the roster, the original is gone', async () => {
      const rows = await sc.seats();
      const delta = rows.find((row) => row.name === '读 delta 的专家');
      const eps = rows.find((row) => row.name === '读 eps 的专家');
      assert.ok(delta, 'delta expert missing from roster');
      assert.ok(eps, 'eps expert missing from roster');
      assert.equal(delta.topic, 'delta', `delta expert topic: ${delta.topic}`);
      assert.equal(eps.topic, 'eps', `eps expert topic: ${eps.topic}`);
      assert.equal(rows.some((row) => row.seat === expert.seat), false, 'original still in roster');
    });
  });
});
});

await describe('session-pressure', { concurrency: false }, async () => {
// L-4 (2026-10-11): an expert's roster line flags 建议拆分 when its session has already compacted, or
// when its estimated token count passes half the backend's context window. The context length comes from
// presets (never hard-coded here); a pi/DeepSeek session window is the deepseek one.







const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ssa-pressure-'));
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

// A pi session file name: <timestamp>_<uuid>.jsonl (sessionKind resolves it to kind 'pi').
const piSession = (name, lines) => {
  const file = path.join(scratch, name);
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n'));
  return file;
};
const user = (text) => ({ type: 'user', payload: { type: 'message', role: 'user', content: [{ type: 'text', text }] } });
const assistant = (text) => ({ type: 'assistant', payload: { type: 'message', role: 'assistant', content: [{ type: 'text', text }] } });

it('knows a pi session uses the deepseek context window', () => {
  const file = piSession('1728000000000_11111111-2222-3333-4444-555555555555.jsonl', [user('你好')]);
  assert.equal(contextTokensFor(file), 1_000_000);
});

it('a short session suggests no split', () => {
  const file = piSession('1728000000000-aaa.jsonl'.replace('-', '_'), [user('你好'), assistant('你好呀')]);
  const p = sessionPressure(file);
  assert.equal(p.hasCompaction, false);
  assert.equal(p.overHalf, false);
  assert.equal(p.suggest, false);
});

it('[L-4] a session that already compacted suggests a split even when short', () => {
  const file = piSession('1728000000000_bbb.jsonl', [
    user('开工'),
    assistant('好'),
    { type: 'compaction', summary: '更早的对话被压缩成了摘要。' },
  ]);
  const p = sessionPressure(file);
  assert.equal(p.hasCompaction, true);
  assert.equal(p.suggest, true);
});

it('[L-4] a session past half the backend window suggests a split by length', () => {
  // deepseek window is 1,000,000 tokens; half is 500,000 tokens. chars/3 must exceed that.
  const halfTokens = 1_000_000 / 2;
  const overHalfChars = Math.floor(halfTokens * CHARS_PER_TOKEN) + 10_000;
  const file = piSession('1728000000000_ccc.jsonl', [user('x'.repeat(overHalfChars))]);
  const p = sessionPressure(file);
  assert.equal(p.overHalf, true);
  assert.ok(p.estTokens > halfTokens, `estTokens ${p.estTokens} should exceed half window ${halfTokens}`);
  assert.equal(p.suggest, true);
});

it('the 60k-char active hand-off node threshold is the C-1 budget', () => {
  assert.equal(HANDOFF_NODE_LARGE_CHARS, 60_000);
});
});
