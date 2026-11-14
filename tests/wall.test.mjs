import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it, afterEach } from 'node:test';
import { REPO, startService, tempDir, FAKE_SLEEPER, freePort, sleep } from './lib/sandbox.mjs';
import { loadStore } from './lib/store.mjs';
import { execFileSync } from 'node:child_process';
import { startMcp } from './lib/mcp.mjs';
import { DatabaseSync } from 'node:sqlite';

await describe('wall', { concurrency: false }, async () => {
  it('daemon language default follows the environment and explicit queries override it', async () => {
    const service = await startService({ env: { SPECIALIST_SUBAGENTS_LANG: 'zh' } });
    try {
      assert.match((await service.call('GET', '/')).text, /<html lang="zh">/);
      assert.match((await service.call('GET', '/settings')).text, /<html lang="zh">/);
      assert.match((await service.call('GET', '/pool')).json.text, /^池：/);
      assert.match((await service.call('GET', '/?lang=en')).text, /<html lang="en">/);
      assert.match((await service.call('GET', '/pool?lang=en')).json.text, /^pool: /);
    } finally { await service.stop(); }
  });
// The role wall (GET /) and the one view it reads (GET /wall, store.wallView): roles with their
// contract version, runs in flight and what each role's card shows, the runs in flight and the newest
// finished ones, and the difficulty classes. The page is the wall of portrait cards with the log
// beside it, in Homura Interface's red-black colours inline (it works offline), and it must not poll
// the full /seats any more.







describe('store.wallView', () => {
  let ctx;
  let store;
  let dir;
  before(async () => {
    ctx = await loadStore();
    store = ctx.store;
    dir = tempDir('ssa-wall-');
  });
  after(() => {
    ctx?.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('lists every role once with its contract version and how many of its runs are in flight', () => {
    const roles = JSON.parse(fs.readFileSync(path.join(REPO, 'roles.json'), 'utf8'));
    const busy = store.claimSeat({ role: 'coder', cwd: dir }).seat;
    store.recordEvent({ seat: busy, kind: 'task', body: '改一处   东西\n第二行' });
    store.recordEvent({ seat: busy, kind: 'stdout', body: '· read a.md' });
    store.recordEvent({ seat: busy, kind: 'stdout', body: '正在改 b.mjs' });
    store.setSeatState({ seat: busy, state: 'running' });

    const view = store.wallView();
    assert.deepEqual(view.roles.map((r) => r.role).sort(), Object.keys(roles).sort());
    for (const r of view.roles) assert.equal(r.contract_version, roles[r.role].contract_version, r.role);
    assert.equal(view.roles.find((r) => r.role === 'coder').running, 1);
    assert.equal(view.roles.find((r) => r.role === 'explorer').running, 0);
    assert.equal(view.roles.at(-1).role, 'handyman', 'wall_order 1 puts handyman last');

    assert.equal(view.running.length, 1);
    const run = view.running[0];
    assert.equal(run.seat, busy);
    assert.equal(run.status, 'running');
    assert.equal(run.task, '改一处 东西 第二行', 'the task is flattened to one line');
    assert.equal(run.last_output, '正在改 b.mjs');
    assert.equal(run.ended_at, null);
    assert.equal(view.ledger_seq, store.maxEventSeq());
  });

  it('lists finished runs newest first, capped, with their verdict and unfinished count', () => {
    const seat = store.claimSeat({ role: 'explorer', cwd: dir }).seat;
    const runs = [];
    for (let i = 0; i < 4; i += 1) {
      runs.push(store.recordEvent({ seat, kind: 'task', body: `第 ${i} 单` }).seq);
      if (i === 1) store.recordEvent({ seat, kind: 'backlog', body: '它报告没做完的部分：\n- 一\n- 二' });
      store.recordEvent({ seat, kind: 'exit', body: i === 2 ? '1' : '0' });
    }
    store.setSeatState({ seat, state: 'done' });
    store.recordSeatVerdict({ seat, verdict: 'revised', note: '改了标题', run: runs[1] });

    const view = store.wallView({ recent: 3 });
    assert.equal(view.recent.length, 3);
    assert.deepEqual(view.recent.map((r) => r.run), [runs[3], runs[2], runs[1]]);
    assert.equal(view.recent[1].status, 'failed');
    assert.equal(view.recent[2].verdict, 'revised');
    assert.equal(view.recent[2].backlog_items, 2);
    assert.equal(view.recent[0].verdict, null);
    assert.ok(view.running.every((r) => r.status === 'running'));
  });

  it("gives each role its card: seats by state, the newest seat, the newest failure and each running seat's last line", () => {
    const view = store.wallView({ role: 'coder' });
    const coder = view.roles.find((r) => r.role === 'coder');
    assert.equal(coder.seats, 1);
    assert.deepEqual(coder.states, { running: 1 });
    assert.equal(coder.live.length, 1);
    assert.equal(coder.live[0].last_line, '正在改 b.mjs');
    assert.ok(coder.live[0].run_started_at, 'the run started at its task event');
    assert.equal(coder.latest.state, 'running');
    assert.equal(coder.last_failed_at, null);

    const explorer = view.roles.find((r) => r.role === 'explorer');
    assert.deepEqual(explorer.live, []);
    assert.equal(explorer.latest.state, 'done');
    const unused = view.roles.find((r) => r.seats === 0);
    assert.ok(unused, 'a role nobody called is listed with no seats');
    assert.equal(unused.latest, null);

    const failing = store.claimSeat({ role: 'librarian', cwd: dir }).seat;
    store.recordEvent({ seat: failing, kind: 'task', body: '整理' });
    store.setSeatState({ seat: failing, state: 'failed' });
    const after = store.wallView();
    const librarian = after.roles.find((r) => r.role === 'librarian');
    assert.deepEqual(librarian.states, { failed: 1 });
    assert.ok(librarian.last_failed_at);
    assert.equal(after.totals.seats, store.listSeats().length);
    assert.equal(after.totals.running, store.listSeats({ state: 'running' }).length);
    assert.equal(after.totals.failed, 1);
    assert.equal(after.instances, undefined, 'the seats of a role only come when asked for');

    assert.equal(view.instances.role, 'coder');
    assert.deepEqual(view.instances.seats.map((s) => s.seat), store.listSeats().filter((s) => s.role === 'coder').map((s) => s.id));
    for (const seat of store.listSeats()) {
      if (seat.name) assert.equal(after.names[seat.id], seat.name, seat.id);
    }
  });

  it('carries the difficulty classes and how many are due', () => {
    const seat = store.claimSeat({ role: 'tester', cwd: dir }).seat;
    for (const run of ['a', 'b']) store.recordDifficulty({ seat, run: `${seat}#${run}`, role: 'tester', kind: 'retry', tool: 'bash', detail: `换法重试 ${run}` });
    const { difficulties } = store.wallView();
    assert.equal(difficulties.remind_at, store.DIFFICULTY_REMIND_AT);
    const retry = difficulties.classes.find((c) => c.class === 'tester|retry|bash');
    assert.ok(retry, 'the class is listed');
    assert.equal(retry.runs, 2);
    assert.equal(retry.due, true);
    assert.equal(retry.sample, '换法重试 a');
    assert.equal(difficulties.due, difficulties.classes.filter((c) => c.due).length);
  });

  it('[W-1] each role carries its experts: name, object, how many runs it has had, its newest run and 建议拆分', () => {
    const dirA = path.join(dir, 'object-a');
    const dirB = path.join(dir, 'object-b');
    fs.mkdirSync(dirA, { recursive: true });
    fs.mkdirSync(dirB, { recursive: true });
    const one = store.claimSeat({ role: 'handyman', cwd: dirA }).seat;
    store.recordEvent({ seat: one, kind: 'task', body: '第一单' });
    const two = store.claimSeat({ role: 'handyman', cwd: dirB }).seat;
    store.recordEvent({ seat: two, kind: 'task', body: '第二单' });
    store.recordEvent({ seat: two, kind: 'task', body: '第三单' });

    const card = store.wallView().roles.find((r) => r.role === 'handyman');
    const first = card.experts.find((e) => e.seat === one);
    const second = card.experts.find((e) => e.seat === two);
    assert.ok(first && second, `both experts are listed: ${JSON.stringify(card.experts.map((e) => e.seat))}`);
    assert.equal(first.runs, 1, 'how many times it has been there');
    assert.equal(second.runs, 2);
    assert.equal(first.object, 'object-a', 'the object is the directory it is the expert of');
    assert.equal(second.object, 'object-b');
    assert.match(second.last_task, /第三单/, 'its newest run, not its first');
    assert.equal(first.suggest_split, false, 'a session that has not grown long is not flagged');
    assert.equal(card.experts[0].seat, two, 'the expert last given work comes first');

    // An archived expert is not on the wall: it is not one of this role's experts any more.
    store.closeSeat({ seat: two, reason: '不用了' });
    const after = store.wallView().roles.find((r) => r.role === 'handyman');
    assert.deepEqual(after.experts.map((e) => e.seat), [one]);
  });
});

describe('GET / and GET /wall', () => {
  let service;
  before(async () => {
    service = await startService();
  });
  after(async () => {
    await service?.stop();
  });

  it('serves the wall view, and refuses a bad `recent` in words', async () => {
    const { status, json } = await service.call('GET', '/wall');
    assert.equal(status, 200);
    for (const key of ['ledger_seq', 'roles', 'running', 'recent', 'difficulties']) assert.ok(key in json, key);
    assert.ok(json.roles.some((r) => r.role === 'coder' && r.contract_version));
    const bad = await service.call('GET', '/wall?recent=0');
    assert.equal(bad.status, 400);
    assert.match(bad.json.error, /recent must be an integer between 1 and 100/);
  });

  it('answers ?role= with the seats of that role', async () => {
    const { status, json } = await service.call('GET', '/wall?recent=1&role=coder');
    assert.equal(status, 200);
    assert.equal(json.instances.role, 'coder');
    assert.ok(Array.isArray(json.instances.seats));
    for (const key of ['totals', 'names']) assert.ok(key in json, key);
  });

  it('serves the wall of portrait cards in red-black, reading /wall after a wait instead of polling /seats', async () => {
    const html = (await service.call('GET', '/')).text;
    assert.match(html, /<img src="\/assets\/roles\/' \+ role \+ '\.png"/, 'every card shows its portrait');
    assert.match(html, /\.art img \{ display: block; width: 100%; height: auto; \}/, 'the portrait is shown whole');
    assert.match(html, /--panel: 50vw;/, 'the log takes half the width');
    assert.match(html, /--colors-background-dark: #090909;/, 'Homura Interface red-black tokens are inlined');
    assert.match(html, /--bg: var\(--colors-background-dark\)/, 'the page colours point at them');
    assert.doesNotMatch(html, /--colors-background:/, 'there is no white theme');
    assert.doesNotMatch(html, /prefers-color-scheme/, 'red-black does not depend on the system setting');
    assert.doesNotMatch(html, /<(?:link|script)[^>]+(?:href|src)=/i, 'no external stylesheet or script');
    assert.doesNotMatch(html, /url\(\s*["']?(?:https?:)?\/\//, 'no remote url() in the styles');
    assert.match(html, /'\/wall\?recent=1'/);
    assert.match(html, /\/events\/wait\?since=/);
    assert.doesNotMatch(html, /getJson\('\/seats'\)/, 'the full seat list is no longer polled');
    assert.doesNotMatch(html, /\?tail=20/, 'running seats are no longer read one by one');
    assert.doesNotMatch(html, /setInterval\(tick/, 'nothing is fetched on a timer');
    for (const words of ['Specialists', 'All activity', 'Follow', 'difficulties to decide']) assert.ok(html.includes(words), words);
    assert.match(html, /<html lang="en">/);
    assert.doesNotMatch(html, /[\u4e00-\u9fff]/, 'English HTML and inline JS contain no Chinese copy');
    for (const lang of ['en', 'zh']) assert.ok(html.includes(`?lang=${lang}`));
    const chinese = (await service.call('GET', '/?lang=zh')).text;
    assert.match(chinese, /<html lang="zh">/);
    for (const words of ['专家', '全部流水', '跟随', '困难待裁决']) assert.ok(chinese.includes(words), words);
    assert.match(html, /data-mode="best"/, 'the best-default button');
    for (const backend of ['codex', 'grok', 'claude', 'deepseek']) {
      assert.match(html, new RegExp(`data-mode="${backend}"`));
      assert.match(html, new RegExp(`data-bolt="${backend}" aria-pressed=`), 'each backend carries its lightning bolt');
    }
    assert.match(html, /href="\/settings"/, 'the capsule links to the settings page');
  });

  it('settings renders English by default and preserves Chinese on request', async () => {
    const english = (await service.call('GET', '/settings?lang=en')).text;
    assert.match(english, /<html lang="en">/);
    assert.doesNotMatch(english, /[\u4e00-\u9fff]/);
    for (const copy of ['Settings · specialist-subagents', 'Two tiers per provider', 'Best default: who handles each role', 'Fallback order', 'Save', 'Refresh provider model lists', 'Also use standard for lightning']) assert.ok(english.includes(copy), copy);
    const chinese = (await service.call('GET', '/settings?lang=zh')).text;
    assert.match(chinese, /<html lang="zh">/);
    assert.match(chinese, /最佳默认：每个岗位用谁/);
  });
});
});

await describe('hosts', { concurrency: false }, async () => {
// PRD 4.9 (2026-10-11), the service's side of working across hosts: H-3 (every dispatch says which
// host asked for it, and the host is whoever the client says it is) and H-4 (the pool, in one line,
// which a host can put into every turn of its lead).
//
// The runs themselves are the fake sleeper's, so a dispatch is a real run that ends when it is told to.
// The CLI is run from the sandbox copy of the service, against the sandbox's own port.








const services = [];
const clients = [];
const scratches = [];
afterEach(async () => {
  while (clients.length) await clients.pop().close();
  while (services.length) await services.pop().stop();
  while (scratches.length) fs.rmSync(scratches.pop(), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

async function open() {
  const service = await startService({
    prepare: (root) => {
      fs.copyFileSync(FAKE_SLEEPER, path.join(root, 'src', 'fake-sleeper.mjs'));
      const file = path.join(root, 'roles.json');
      const roles = JSON.parse(fs.readFileSync(file, 'utf8'));
      roles.explorer.spawn.args = ['src/fake-sleeper.mjs', '--pi', '{runtime}', '--tools', 'read,grep,find,ls', '-p', '{task}'];
      fs.writeFileSync(file, JSON.stringify(roles, null, 2));
    },
  });
  services.push(service);
  return service;
}

const client = (service, env = {}) => {
  const mcp = startMcp(service, env);
  clients.push(mcp);
  return mcp;
};
const workdir = () => {
  const dir = tempDir('ssa-host-');
  scratches.push(dir);
  return dir;
};
const dispatch = async (mcp, extra = {}) => JSON.parse((await mcp.tool('seat_start', { role: 'explorer', task: 'finish-after:10', cwd: workdir(), ...extra })).text);
const ownerOf = async (service, seat) => (await service.call('GET', `/seats/${seat}`)).json.seat.owner ?? null;
// The sandbox is a copy of src/ and roles/ only, so the CLI is run from the checkout, talking to the
// sandbox's port. `pool` needs nothing but the port: no ledger, no home, no daemon file.
const cli = (service, ...args) => execFileSync(process.execPath, [path.join(REPO, 'bin', 'specialist-subagents.mjs'), ...args], {
  cwd: REPO,
  env: { ...process.env, SPECIALIST_SUBAGENTS_PORT: String(service.port) },
  encoding: 'utf8',
}).trim();

// R-6: a seat dispatching through the bridge it starts. The bridge is given the seat's id and dispatch
// flag the way cli-runner hands them to a backend; the daemon checks the role behind the id.
describe('[R-6] a Lead seat dispatches members, and nobody dispatches a Lead', () => {
  const seatOf = async (service, role) => (await service.call('POST', '/seat/open', { role })).json.seat;

  it('[R-6] a Leader sees only its tools, its dispatch is filed under it, and it cannot dispatch a Leader', async () => {
    const service = await open();
    const leadSeat = await seatOf(service, 'leader');
    const lead = client(service, { SPECIALIST_CALLER_SEAT: leadSeat, SPECIALIST_CALLER_DISPATCH: '1' });
    await lead.init({ name: 'claude-code' });
    const listed = (await lead.request('tools/list', {})).result.tools.map((tool) => tool.name).sort();
    assert.deepEqual(listed, ['dispatch_guide', 'role_list', 'seat_list', 'seat_show', 'seat_start', 'seat_verdict', 'task_result', 'task_wait']);

    const sent = await dispatch(lead);
    const row = (await service.call('GET', `/seats/${sent.seat}`)).json.seat;
    assert.equal(row.parent, leadSeat, 'the member seat is filed under the Leader that asked');

    const nested = await lead.tool('seat_start', { role: 'leader', task: 'split it again', cwd: workdir() });
    assert.equal(nested.isError, true);
    assert.match(nested.text, /never other leads/);
    const hidden = await lead.tool('seat_close', { seat: sent.seat });
    assert.equal(hidden.isError, true);
    assert.match(hidden.text, /unavailable/);
    // The member's run is let finish before the sandbox goes: on Windows CI (2026-10-22) teardown
    // stopped the daemon while that run was still being wrapped up, and removing the sandbox hit EBUSY.
    await service.waitSeat(sent.seat);
  });

  it('[R-6] a member seat sees no tools, and the daemon refuses its dispatch and an unknown seat', async () => {
    const service = await open();
    const member = await seatOf(service, 'explorer');
    const mcp = client(service, { SPECIALIST_CALLER_SEAT: member, SPECIALIST_CALLER_DISPATCH: '0' });
    await mcp.init({ name: 'codex' });
    assert.deepEqual((await mcp.request('tools/list', {})).result.tools, []);

    // Straight to the daemon, as a bridge would ask: the role behind the id decides, not the bridge.
    const direct = await service.call('POST', '/seat/start', { role: 'explorer', task: 'finish-after:10', cwd: workdir(), caller_seat: member });
    assert.equal(direct.status, 403);
    assert.match(direct.json.error, /cannot dispatch/);
    const stranger = await service.call('POST', '/seat/start', { role: 'explorer', task: 'finish-after:10', cwd: workdir(), caller_seat: 'seat-nobody-1' });
    assert.equal(stranger.status, 403);
    assert.match(stranger.json.error, /not in the ledger/);
  });
});

describe('[H-3] every dispatch says which host asked for it', () => {
  it('[H-3] two clients that introduce themselves differently are written on the seats they open', async () => {
    const service = await open();
    const a = client(service);
    const b = client(service);
    await a.init({ name: 'host-a', version: '1.2' });
    await b.init({ name: 'host-b' });

    const one = await dispatch(a);
    const two = await dispatch(b);
    assert.equal(await ownerOf(service, one.seat), 'host-a 1.2', 'the first client, name and version');
    assert.equal(await ownerOf(service, two.seat), 'host-b', 'the second client, name only');
    assert.notEqual(one.seat, two.seat, 'each directory keeps its own expert');

    // What the caller says wins: the host is who asked, not which shell it came through.
    const named = await dispatch(a, { owner: 'lead' });
    assert.equal(await ownerOf(service, named.seat), 'lead');

    // A client that never said who it is leaves the owner empty, exactly as before H-3.
    const quiet = client(service);
    const anon = await dispatch(quiet);
    assert.equal(await ownerOf(service, anon.seat), null);
  });
});

describe('[H-4] the pool in one line', () => {
  it('[H-4] GET /pool says what is running and what is still open, and the CLI says 池：未知 when the service is not there', async () => {
    const service = await open();
    const empty = (await service.call('GET', '/pool')).json.text;
    assert.match(empty, /^pool: /, `an empty pool still answers in words, got: ${empty}`);

    const mcp = client(service);
    const started = JSON.parse((await mcp.tool('seat_start', { role: 'explorer', task: 'finish-after:4000', cwd: workdir() })).text);
    const busy = await (async () => {
      const end = Date.now() + 15000;
      for (;;) {
        const { json } = await service.call('GET', '/pool');
        if (/running 1/.test(json.text)) return json.text;
        if (Date.now() > end) throw new Error(`the run never showed as running, the pool said: ${json.text}`);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    })();
    assert.match(busy, /^pool: /, busy);
    assert.match(busy, /explorer running 1 \/ open 1/, busy);
    const chinese = (await service.call('GET', '/pool?lang=zh')).json.text;
    assert.match(chinese, /池：explorer 在跑 1 \/ 未关闭 1/, chinese);

    // When it is over the role still holds the expert: open, not closed.
    await service.waitSeat(started.seat);
    const settled = (await service.call('GET', '/pool')).json.text;
    assert.match(settled, /explorer running 0 \/ open 1/, settled);

    // The CLI prints the same line, for a host that can run a background command.
    const line = cli(service, 'pool');
    assert.match(line, /^pool: /, line);
    assert.match(line, /open/, line);

    // And a service it cannot read is not a failure: it says 未知 and goes on. A port with nothing
    // behind it is the same thing to the CLI, and stopping the sandbox service here would only add a
    // directory this machine is slow to let go of.
    assert.equal(cli({ port: await freePort() }, 'pool'), 'pool: unknown');
  });
});
});

await describe('responsiveness', { concurrency: false }, async () => {
// What keeps the daemon answering: bounded seat_show, a long poll that ends with its client, git
// questions that do not hold the event loop, and a ledger handle that is only published once it works.









async function until(check, what, timeoutMs = 15000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

// store.mjs is a per-process singleton: the first test below has to be the first thing that touches it.
describe('the ledger handle', () => {
  let env;
  before(async () => {
    env = await loadStore();
  });
  after(() => env?.cleanup());

  it('is not kept when its initialisation failed, so the next call starts over instead of using a half-built one', () => {
    // A view that takes the name of a table the schema wants to alter: init throws half way through.
    const seed = new DatabaseSync(env.file);
    seed.exec('CREATE VIEW difficulties AS SELECT 1 AS seq');
    seed.close();
    assert.throws(() => env.store.listRoles(), /view/i);
    const fix = new DatabaseSync(env.file);
    fix.exec('DROP VIEW difficulties');
    fix.close();
    assert.ok(env.store.listRoles().length > 0, 'the retry ran the whole init, roles included');
  });

  it('showSeat returns the newest events only, says how many it left out, and can be asked for a run or for all', () => {
    const { store } = env;
    const { seat } = store.openSeat({ role: 'coder' });
    store.recordEvent({ seat, kind: 'task', body: 'first run' });
    for (let i = 0; i < 300; i++) store.recordEvent({ seat, kind: 'stdout', body: `old ${i}` });
    const second = store.recordEvent({ seat, kind: 'task', body: 'second run' });
    for (let i = 0; i < 5; i++) store.recordEvent({ seat, kind: 'stdout', body: `new ${i}` });

    const shown = store.showSeat(seat);
    assert.equal(shown.events.length, store.SEAT_EVENTS_DEFAULT);
    assert.equal(shown.events_total, 307);
    assert.equal(shown.events_omitted, 107);
    assert.equal(shown.events.at(-1).body, 'new 4', 'the newest events are the ones kept');
    assert.match(shown.events_note, /107/);
    assert.ok(shown.events.every((ev, i, all) => i === 0 || all[i - 1].seq < ev.seq), 'still oldest first');

    assert.equal(store.showSeat(seat, { tail: Infinity }).events.length, 307);
    assert.equal(store.showSeat(seat, { tail: Infinity }).events_note, undefined, 'nothing omitted, nothing to explain');
    assert.equal(store.showSeat(seat, { tail: 0 }).events.length, 0);

    const run = store.showSeat(seat, { run: second.seq });
    assert.deepEqual(run.events.map((ev) => ev.body), ['second run', 'new 0', 'new 1', 'new 2', 'new 3', 'new 4']);
    assert.equal(run.events_omitted, 0);
    assert.throws(() => store.showSeat(seat, { run: second.seq + 1 }), /task event seq/);
  });
});

const services = [];
afterEach(async () => {
  while (services.length) await services.pop().stop();
});

async function start(options = {}) {
  const service = await startService(options);
  services.push(service);
  return service;
}

describe('seat_show over HTTP', () => {
  it('bounds the events by default and takes tail and run', async () => {
    const service = await start();
    const opened = await service.call('POST', '/seat/open', { role: 'coder' });
    const seat = opened.json.seat;
    // task and stdout events belong to the service (/seat/record refuses them), so they go straight
    // into the daemon's ledger file, the way a real run's would.
    const ledger = new DatabaseSync(service.env.SPECIALIST_SUBAGENTS_DB);
    const put = (kind, body) => Number(ledger.prepare('INSERT INTO events (seat, kind, body, at) VALUES (?, ?, ?, ?)').run(seat, kind, body, new Date().toISOString()).lastInsertRowid);
    put('task', 'one');
    for (let i = 0; i < 230; i++) put('stdout', `line ${i}`);
    const two = { json: { event: { seq: put('task', 'two') } } };
    put('stdout', 'tail line');
    ledger.close();

    const shown = await service.call('GET', `/seats/${seat}`);
    assert.equal(shown.json.events.length, 200);
    assert.equal(shown.json.events_omitted, shown.json.events_total - 200);
    assert.ok(shown.json.events_omitted > 0);
    assert.match(shown.json.events_note, /tail="all"/);
    assert.equal(shown.json.events.at(-1).body, 'tail line');

    const all = await service.call('GET', `/seats/${seat}?tail=all`);
    assert.equal(all.json.events.length, all.json.events_total);
    assert.equal((await service.call('GET', `/seats/${seat}?tail=2`)).json.events.length, 2);
    const run = await service.call('GET', `/seats/${seat}?run=${two.json.event.seq}`);
    assert.deepEqual(run.json.events.map((ev) => ev.body), ['two', 'tail line']);

    assert.equal((await service.call('GET', `/seats/${seat}?tail=lots`)).status, 400);
    assert.equal((await service.call('GET', `/seats/${seat}?run=1.5`)).status, 400);
    assert.equal((await service.call('GET', `/seats/${seat}?run=999999`)).status, 400);
  });
});

describe('/events/wait', () => {
  it('[O-2] stops polling when its client hangs up, and still answers a client that stays', async () => {
    const service = await start();
    const watchers = async () => (await service.call('GET', '/health')).json.watchers;
    assert.equal(await watchers(), 0);

    const gone = new AbortController();
    const abandoned = fetch(`${service.base}/events/wait?since=99999999&timeoutMs=120000`, { signal: gone.signal }).catch(() => null);
    await until(async () => (await watchers()) === 1, 'the wait to be polling');
    gone.abort();
    await abandoned;
    await until(async () => (await watchers()) === 0, 'the abandoned wait to stop');

    const staying = fetch(`${service.base}/events/wait?timeoutMs=20000`).then((res) => res.json());
    await until(async () => (await watchers()) === 1, 'the second wait to be polling');
    const { json } = await service.call('POST', '/seat/open', { role: 'coder' });
    const answer = await staying;
    assert.equal(answer.changed, true);
    assert.equal(answer.seat.id, json.seat);
    assert.equal(await watchers(), 0);
  });
});

describe('dispatch into a git repository', () => {
  it('asks git about the directory without blocking, and tells a returning expert what changed', async () => {
    const scratch = tempDir('ssa-git-');
    const repo = path.join(scratch, 'repo');
    fs.mkdirSync(repo);
    const git = (...args) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { stdio: 'ignore', windowsHide: true });
    git('init', '-q');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'first');
    try {
      const service = await start({
        env: { SPECIALIST_SUBAGENTS_MAX_CONCURRENCY: '1' },
        prepare: (root) => {
          fs.copyFileSync(FAKE_SLEEPER, path.join(root, 'src', 'fake-sleeper.mjs'));
          const file = path.join(root, 'roles.json');
          const roles = JSON.parse(fs.readFileSync(file, 'utf8'));
          roles.explorer.spawn.args = ['src/fake-sleeper.mjs', '--pi', '{runtime}', '--tools', 'read,grep,find,ls', '-p', '{task}'];
          fs.writeFileSync(file, JSON.stringify(roles, null, 2));
        },
      });
      const first = await service.call('POST', '/seat/start', { role: 'explorer', task: 'finish-after:10', cwd: repo });
      assert.equal(first.status, 200, first.text);
      const done = await service.waitSeat(first.json.seat, ['done']);
      assert.equal(done.seat.dir_state.git, true, 'git answered for the directory');
      assert.match(done.seat.dir_state.head, /^[0-9a-f]{40}$/);

      fs.writeFileSync(path.join(repo, 'b.txt'), 'b\n');
      git('add', '-A');
      git('commit', '-q', '-m', 'second');
      const again = await service.call('POST', '/seat/start', { role: 'explorer', task: 'finish-after:10', cwd: repo });
      assert.equal(again.json.seat, first.json.seat, 'the directory expert came back');
      // The seat still says 'done' from the first run until the second one starts: wait for its second exit.
      const shown = await until(async () => {
        const { json } = await service.call('GET', `/seats/${again.json.seat}?tail=all`);
        return json.events.filter((ev) => ev.kind === 'exit').length === 2 ? json : null;
      }, 'the second run to end');
      assert.ok(shown.events.some((ev) => ev.kind === 'session' && /Continuing prior session; directory changes attached/.test(ev.body)), 'the change since last time was found through git');
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  });
});
});
