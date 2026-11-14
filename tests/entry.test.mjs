import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { startMcp } from './lib/mcp.mjs';
import { REPO, startService, tempDir, FAKE_SLEEPER } from './lib/sandbox.mjs';

await describe('entry', { concurrency: false }, async () => {
// Entry smoke: the daemon boots on a temp port with a temp ledger, serves the page, the MCP shell
// lists its tools, and one whole dispatch (MCP seat_start -> daemon -> real roles.json coder spec ->
// real cli-runner -> fake Codex) leaves task / stdout / usage / exit in the ledger.
//
// Only the Codex CLI is faked (tests/fakes/fake-codex.mjs, reached through SPECIALIST_CODEX_JS).
// Grok and Claude are found under $HOME, which the sandbox points at an empty directory, so they
// read as "not installed" and never run.







// The whole tool surface, exactly. doc/connect.md's heading counts these and README's table lists them, so a
// tool added, dropped or renamed without touching the docs has to fail here (2026-09-30: the SKILL.md
// heading said 11 while the shell served 13, and difficulty_decide was missing from this very list).
const TOOLS_EXPECTED = ['candidate_decide', 'candidates', 'difficulty_decide', 'difficulty_report', 'dispatch_guide', 'memory_read', 'memory_write', 'role_list', 'seat_close', 'seat_list', 'seat_merge', 'seat_rename', 'seat_show', 'seat_split', 'seat_start', 'seat_verdict', 'task_cancel', 'task_result', 'task_wait'];

describe('daemon + MCP shell + one dispatch', () => {
  let service;
  let mcp;
  let workdir;
  let seatId;

  before(async () => {
    service = await startService();
    mcp = startMcp(service);
    workdir = tempDir('ssa-work-');
  });
  after(async () => {
    await mcp?.close();
    await service?.stop();
    if (workdir) fs.rmSync(workdir, { recursive: true, force: true });
  });

  it('serves the monitor page on GET /', async () => {
    const res = await fetch(`${service.base}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    const html = await res.text();
    assert.match(html, /<html/i);
    assert.match(html, /\/backend/, 'the page carries the backend-preference buttons');
  });

  it('runs on the temp ledger, not the real one', async () => {
    const { json } = await service.call('GET', '/health');
    assert.equal(json.ok, true);
    assert.equal(path.resolve(json.db), path.join(service.root, '.data', 'ledger.sqlite3'));
    assert.notEqual(service.port, 43130);
  });

  it('[R-1] the shipped roles.json passes the startup gate and is served', async () => {
    const { json } = await service.call('GET', '/roles');
    const ids = json.map((role) => role.id);
    for (const id of ['explorer', 'coder', 'tester', 'librarian', 'web_researcher']) assert.ok(ids.includes(id), id);
    assert.match(service.log(), /contract ok: coder /);
  });

  it('[O-1] MCP tools/list serves exactly the documented 19 tools', async () => {
    const init = await mcp.request('initialize', {});
    assert.equal(init.result.serverInfo.name, 'specialist-subagents');
    const list = await mcp.request('tools/list', {});
    const names = list.result.tools.map((tool) => tool.name);
    assert.deepEqual([...names].sort(), TOOLS_EXPECTED, 'the tool set changed: update doc/connect.md (heading and table) and README along with this list');
    assert.equal(names.length, 19);

    // The connection guide is what models read to learn the tools: its count and its table follow the shell.
    const skill = fs.readFileSync(path.join(REPO, 'doc', 'connect.md'), 'utf8');
    assert.match(skill, new RegExp(`Tool surface \\(${names.length} tools\\)`), 'doc/connect.md heading count');
    for (const name of names) assert.ok(skill.includes(`\`${name}\``), `doc/connect.md does not mention ${name}`);
    for (const tool of list.result.tools) assert.equal(tool.inputSchema?.type, 'object', tool.name);
  });

  it('--profile core hides the 4 skill-refinement tools and refuses calling them', async () => {
    const coreMcp = startMcp(service, {}, ['--profile', 'core']);
    try {
      await coreMcp.request('initialize', {});
      const list = await coreMcp.request('tools/list', {});
      const names = list.result.tools.map((tool) => tool.name).sort();
      const hidden = ['candidate_decide', 'candidates', 'difficulty_decide', 'difficulty_report'];
      assert.deepEqual(names, TOOLS_EXPECTED.filter((name) => !hidden.includes(name)));
      const refused = await coreMcp.tool('difficulty_report', {});
      assert.equal(refused.isError, true);
      assert.match(refused.text, /disabled under tool profile "core"/);
    } finally {
      await coreMcp.close();
    }
  });

  it('SPECIALIST_SUBAGENTS_CALLER_TITLE customizes the caller title in instructions and tool descriptions', async () => {
    const titledMcp = startMcp(service, { SPECIALIST_SUBAGENTS_CALLER_TITLE: '「マスター」' });
    try {
      const init = await titledMcp.request('initialize', {});
      assert.match(init.result.instructions, /Once 「マスター」 authorizes a task/);
      const list = await titledMcp.request('tools/list', {});
      const diff = list.result.tools.find((t) => t.name === 'difficulty_report');
      assert.match(diff.description, /when 「マスター」 asks to look at the ledger/);
    } finally {
      await titledMcp.close();
    }
  });

  it('the handshake carries the lead manual as instructions, and dispatch_guide serves it and the role guides', async () => {
    const manual = fs.readFileSync(path.join(REPO, 'dispatch', 'team-leader.md'), 'utf8');
    const init = await mcp.request('initialize', {});
    assert.equal(init.result.instructions, manual, 'instructions is the manual file as it stands');
    const again = await mcp.tool('dispatch_guide', {});
    assert.equal(again.text, manual);
    const coder = await mcp.tool('dispatch_guide', { role: 'coder' });
    assert.equal(coder.isError, false, coder.text);
    assert.match(coder.text, /Using coder/);
    // refiner is dispatched by the service, not by the lead; a path-like name must not reach the disk.
    for (const role of ['refiner', '../SKILL']) {
      const refused = await mcp.tool('dispatch_guide', { role });
      assert.equal(refused.isError, true, role);
      assert.match(refused.text, /Available:/);
    }
  });

  it('Chinese MCP mode serves the complete Chinese manual and customizes its caller title', async () => {
    const chinese = startMcp(service, { SPECIALIST_SUBAGENTS_LANG: 'zh' });
    const titled = startMcp(service, { SPECIALIST_SUBAGENTS_LANG: 'zh-CN', SPECIALIST_SUBAGENTS_CALLER_TITLE: 'operator' });
    try {
      const manual = fs.readFileSync(path.join(REPO, 'dispatch', 'zh-CN', 'team-leader.md'), 'utf8').replace(/^\uFEFF/, '');
      assert.equal((await chinese.request('initialize', {})).result.instructions, manual);
      assert.equal((await chinese.tool('dispatch_guide', {})).text, manual);
      assert.match((await chinese.tool('dispatch_guide', { role: 'coder' })).text, /怎么用 coder/);
      const customized = (await titled.request('initialize', {})).result.instructions;
      assert.equal(customized, manual.replaceAll('用户', 'operator'));
      const invalid = await chinese.tool('dispatch_guide', { role: 'zh-CN' });
      assert.equal(invalid.isError, true);
      assert.match(invalid.text, /有的是：/);
    } finally {
      await chinese.close();
      await titled.close();
    }
  });

  it('MCP reports an unknown tool as a JSON-RPC error and a bad call as isError', async () => {
    const unknown = await mcp.request('tools/call', { name: 'nope', arguments: {} });
    assert.equal(unknown.error.code, -32602);
    const bad = await mcp.tool('seat_start', { role: 'coder' });
    assert.equal(bad.isError, true);
  });

  it('seat_start refuses a cwd that does not exist and opens no seat', async () => {
    const seatsBefore = (await service.call('GET', '/seats')).json.length;
    const refused = await mcp.tool('seat_start', { role: 'coder', task: 'x', cwd: path.join(workdir, 'missing') });
    assert.equal(refused.isError, true);
    assert.match(refused.text, /does not exist or is not a directory/);
    assert.equal((await service.call('GET', '/seats')).json.length, seatsBefore);
  });

  it('[E-4] a domain role is refused without a domain and with a cwd; a directory role is refused a domain', async () => {
    const seatsBefore = (await service.call('GET', '/seats')).json.length;
    // web_researcher recognises its expert by domain (roles.json expert_by): no domain, no seat.
    const missing = await mcp.tool('seat_start', { role: 'web_researcher', task: 'x' });
    assert.equal(missing.isError, true, missing.text);
    assert.match(missing.text, /tracks experts by domain/);
    assert.match(missing.text, /domain/);
    assert.match(missing.text, /instead of cwd/);
    // cwd is not its identity, so sending one is refused too, with the same instruction.
    const withCwd = await mcp.tool('seat_start', { role: 'web_researcher', task: 'x', cwd: workdir });
    assert.equal(withCwd.isError, true, withCwd.text);
    assert.match(withCwd.text, /domain/);
    assert.match(withCwd.text, /creates and assigns a fixed domain directory/);
    // A directory role takes no domain and says which roles do.
    const wrongRole = await mcp.tool('seat_start', { role: 'coder', task: 'x', domain: 'ai' });
    assert.equal(wrongRole.isError, true, wrongRole.text);
    assert.match(wrongRole.text, /tracks experts by directory/);
    assert.match(wrongRole.text, /web_researcher/);
    assert.equal((await service.call('GET', '/seats')).json.length, seatsBefore, 'a refused dispatch opens no seat');
  });

  it('[O-1][G-1] a whole dispatch through the fake Codex leaves task, stdout, usage and exit in seat_show', async () => {
    const started = await mcp.tool('seat_start', { role: 'coder', task: 'TASK-ONE 修一个 bug', cwd: workdir });
    assert.equal(started.isError, false, started.text);
    const reply = JSON.parse(started.text);
    assert.equal(reply.state, 'running');
    assert.equal(reply.reused, false);
    seatId = reply.seat;
    assert.match(seatId, /^seat-coder-\d+$/);

    const shown = await service.waitSeat(seatId);
    assert.equal(shown.seat.state, 'done', service.log());
    const kinds = shown.events.map((event) => event.kind);
    for (const kind of ['task', 'runner', 'stdout', 'usage', 'exit']) assert.ok(kinds.includes(kind), `no ${kind} event in ${kinds}`);
    assert.equal(shown.events.find((event) => event.kind === 'task').body, 'TASK-ONE 修一个 bug');
    assert.ok(shown.events.some((event) => event.kind === 'stdout' && event.body.includes('FAKE-CODEX-ANSWER')));
    assert.equal(shown.events.find((event) => event.kind === 'exit').body, '0');
    const usage = shown.events.find((event) => event.kind === 'usage').body;
    assert.match(usage, /openai-codex\/gpt-6\.1-sol/);
    assert.match(usage, /input 1600 tokens \(cache hit 400\), output 100 tokens/);

    // What the closing question brought back: the expertise note and the unfinished list, split.
    assert.match(shown.seat.expertise, /demo 目录/);
    assert.doesNotMatch(shown.seat.expertise, /未完成/);
    assert.match(shown.seat.backlog, /还没读 docs\//);
    assert.ok(shown.seat.session_file, 'the seat keeps the session it ran in');
  });

  it('[O-5] seat_show through MCP answers with the newest run\'s report, and with raw events only when asked', async () => {
    const view = await mcp.tool('seat_show', { seat: seatId });
    assert.equal(view.isError, false, view.text);
    assert.match(view.text, new RegExp(`Seat ${seatId}`));
    assert.match(view.text, /done \(exit code 0\)/);
    assert.match(view.text, /FAKE-CODEX-ANSWER/);
    assert.doesNotMatch(view.text, /Usage: Usage:/);
    assert.match(view.text, /还没读 docs\//, 'the unfinished list it handed back');
    assert.match(view.text, /Verdict: not recorded/);
    assert.doesNotMatch(view.text, /"kind"/, 'no raw events by default');

    const raw = JSON.parse((await mcp.tool('seat_show', { seat: seatId, events: true })).text);
    assert.equal(raw.seat.id, seatId);
    assert.ok(raw.events.length > 0);
    const missing = await mcp.tool('seat_show', { seat: 'seat-nope-1' });
    assert.equal(missing.isError, true);
  });

  it('[O-5][O-4] task_result returns the runner\'s own report, apart from its output lines, and points at the full text past the budget', async () => {
    const result = await mcp.tool('task_result', { seat: seatId });
    assert.equal(result.isError, false, result.text);
    assert.match(result.text, /Report \(\d+ characters\):\n\(Full text \d+ bytes, sha256 [0-9a-f]{12}…\)\nFAKE-CODEX-ANSWER/, 'from the runner\'s result file, not from the output');
    assert.match(result.text, /Usage:.*openai-codex/);
    const runId = Number(/run #(\d+)/i.exec(result.text)[1]);
    const file = path.join(service.root, '.data', 'reports', seatId, `${runId}.md`);
    assert.equal(fs.readFileSync(file, 'utf8').trim(), 'FAKE-CODEX-ANSWER');

    // Over the budget: the head, and the file that holds all of it.
    fs.writeFileSync(file, `${'长'.repeat(500)}TAIL\n`);
    const cut = await mcp.tool('task_result', { run: runId, max_chars: 200 });
    assert.match(cut.text, /504 characters, first 200 characters shown/);
    assert.ok(cut.text.includes(file), cut.text);
    assert.doesNotMatch(cut.text, /TAIL/);
    fs.writeFileSync(file, 'FAKE-CODEX-ANSWER\n');

    const unknown = await mcp.tool('task_result', { run: 999999 });
    assert.equal(unknown.isError, true);
    assert.match(unknown.text, /No run numbered 999999/);
    const neither = await mcp.tool('task_result', {});
    assert.equal(neither.isError, true);
  });

  it('[E-6] seat_list lists living directory experts one line each, by directory on request, raw rows only with full', async () => {
    const list = await mcp.tool('seat_list');
    assert.equal(list.isError, false, list.text);
    // [E-6] the line starts with the name, then the seat id, role, object, state, visits, backlog.
    const line = list.text.split('\n').find((l) => l.includes(` · ${seatId} · `));
    assert.ok(line, list.text);
    assert.ok(line.startsWith('[coder · '), line);
    assert.ok(line.includes(workdir), line);
    assert.match(line, /· coder ·/);
    assert.match(line, /· 1 visit\(s\) ·/);
    assert.match(line, /backlog 2/);
    assert.match(line, /expertise: 我读过 demo 目录/);
    assert.doesNotMatch(list.text, /session_file|dir_state/);

    const mine = await mcp.tool('seat_list', { cwd: workdir });
    assert.match(mine.text, /1 seat\(s\) for directory/);
    const nobody = await mcp.tool('seat_list', { cwd: path.join(workdir, 'elsewhere') });
    assert.match(nobody.text, /No living expert for directory/);

    const full = JSON.parse((await mcp.tool('seat_list', { full: true })).text);
    assert.ok(Array.isArray(full));
    assert.ok(full.some((row) => row.id === seatId && 'session_file' in row));

    // The compact HTTP view the wall can use; the plain route is unchanged.
    const compact = (await service.call('GET', `/seats?view=compact&cwd=${encodeURIComponent(workdir)}`)).json;
    // L-4 (2026-10-11): the compact row also carries the session path (to compute 建议拆分 from) and the
    // topic the expert was opened under, plus the suggest_split flag the roster line renders.
    assert.deepEqual(Object.keys(compact[0]).sort(), ['backlog_items', 'cwd', 'domain', 'expertise', 'last_run', 'last_run_at', 'name', 'role', 'seat', 'session_file', 'state', 'suggest_split', 'topic', 'visits']);
    assert.equal(compact[0].seat, seatId);
    assert.ok('dir_state' in (await service.call('GET', '/seats')).json[0]);
    assert.equal((await service.call('GET', '/seats?view=nope')).status, 400);
  });

  it('answers without indentation', async () => {
    const { text } = await mcp.tool('role_list');
    assert.doesNotMatch(text, /\n /);
    assert.ok(Array.isArray(JSON.parse(text)));
  });

  it('cost_report prices the run at API list price and divides by adopted runs', async () => {
    // Tokens over both Codex calls: 1600 input, 400 cached, 100 output at $2 / $0.2 / $12 per million.
    const unjudged = (await service.call('GET', '/costs')).json.text;
    assert.match(unjudged, /coder · openai-codex\/gpt-6\.1-sol: 1 run\(s\)/);
    assert.match(unjudged, /API-equiv \$0\.0042/);
    assert.match(unjudged, /no accepted runs yet/);

    const verdict = await mcp.tool('seat_verdict', { seat: seatId, verdict: 'accepted' });
    assert.equal(verdict.isError, false);
    const judged = (await service.call('GET', '/costs')).json.text;
    assert.match(judged, /accepted 1, revised 0, rejected 0, unjudged 0/);
    assert.match(judged, /per accepted: \$0\.0042/);
  });

  it('[E-3] a second dispatch to the same directory reuses the seat and carries the backlog forward', async () => {
    const reply = JSON.parse((await mcp.tool('seat_start', { role: 'coder', task: 'TASK-TWO 接着做', cwd: workdir })).text);
    assert.equal(reply.seat, seatId);
    assert.equal(reply.reused, true);
    assert.match(reply.note, /same directory \(1 prior visit\(s\)\)/);
    assert.match(reply.next, /task_wait/);
    // task_wait blocks until this run ends and brings its report back.
    const waited = await mcp.tool('task_wait', { seat: seatId, timeout_seconds: 30 });
    assert.equal(waited.isError, false, waited.text);
    assert.match(waited.text, /^Run #\d+ ended/);
    assert.match(waited.text, /Task:.*TASK-TWO/);
    assert.match(waited.text, /FAKE-CODEX-ANSWER/);
    const shown = await service.waitSeat(seatId);
    assert.equal(shown.seat.state, 'done', service.log());

    const tasks = shown.events.filter((event) => event.kind === 'task');
    assert.equal(tasks.length, 2);
    // The current run began at the latest task event, not when the seat was first opened.
    assert.equal(shown.seat.run_started_at, tasks[1].at);

    const calls = fs.readFileSync(service.env.FAKE_CODEX_CALLS, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    const work = calls.filter((call) => !call.closing);
    assert.equal(work.length, 2);
    assert.ok(work[1].args.includes('resume'), 'the second run resumes the Codex thread');
    // The developer instruction that sets the user's global AGENTS.md aside rides on every run,
    // fresh and resumed, as one TOML basic string.
    for (const call of work) {
      const at = call.args.findIndex((arg) => typeof arg === 'string' && arg.startsWith('developer_instructions='));
      assert.ok(at > 0 && call.args[at - 1] === '-c', 'developer_instructions is passed with -c');
      const value = JSON.parse(call.args[at].slice('developer_instructions='.length));
      assert.match(value, /AGENTS\.md/);
      assert.match(value, /以岗位合同为准/);
    }
    assert.match(work[1].prompt, /还没读 docs\//, 'the last run unfinished list is put in front of the task');
    assert.match(work[1].prompt, /TASK-TWO/);
    assert.ok(shown.events.some((event) => event.kind === 'backlog' && /Prepended unfinished backlog from previous run/.test(event.body)));
  });

  it('the backend choice is stored, validated and reflected in the run label', async () => {
    assert.deepEqual((await service.call('GET', '/backend')).json, { mode: 'best', max: false });
    const bad = await service.call('POST', '/backend', { mode: 'gpt' });
    assert.equal(bad.status, 400);
    assert.deepEqual((await service.call('GET', '/backend')).json, { mode: 'best', max: false });

    assert.deepEqual((await service.call('POST', '/backend', { mode: 'grok' })).json, { mode: 'grok', max: false });
    assert.deepEqual((await service.call('GET', '/backend')).json, { mode: 'grok', max: false });
    assert.ok(fs.existsSync(path.join(service.root, '.data', 'backend-prefer.json')));

    // Grok is preferred but not installed under the sandbox's $HOME: the run falls through to Codex
    // and the ledger's model label says why.
    const other = tempDir('ssa-work-');
    try {
      const reply = JSON.parse((await mcp.tool('seat_start', { role: 'tester', task: 'grok first', cwd: other })).text);
      const shown = await service.waitSeat(reply.seat);
      assert.equal(shown.seat.state, 'done', service.log());
      const usage = shown.events.find((event) => event.kind === 'usage').body;
      assert.match(usage, /openai-codex\/gpt-6\.1-sol/);
      assert.match(usage, /Selected Grok/);
      assert.match(usage, /grok did not start \(Grok CLI not found\)/);
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  it('the bolt runs the heavy level, except for a role that stays standard', async () => {
    assert.deepEqual((await service.call('POST', '/backend', { mode: 'codex', max: true })).json, { mode: 'codex', max: true });
    const other = tempDir('ssa-work-');
    try {
      const heavy = JSON.parse((await mcp.tool('seat_start', { role: 'tester', task: 'heavy one', cwd: other })).text);
      const heavyShown = await service.waitSeat(heavy.seat);
      assert.equal(heavyShown.seat.state, 'done', service.log());
      const heavyUsage = heavyShown.events.find((event) => event.kind === 'usage').body;
      assert.match(heavyUsage, /openai-codex\/gpt-6\.1-sol/);
      assert.match(heavyUsage, /Selected Codex heavy, reasoning xhigh/);
      const readCalls = () => fs.readFileSync(service.env.FAKE_CODEX_CALLS, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      assert.ok(readCalls().at(-1).args.includes('model_reasoning_effort="xhigh"'), 'the effort reaches codex as a config override');

      const light = JSON.parse((await mcp.tool('seat_start', { role: 'handyman', task: 'stays light', cwd: other })).text);
      const lightShown = await service.waitSeat(light.seat);
      assert.equal(lightShown.seat.state, 'done', service.log());
      const lightUsage = lightShown.events.find((event) => event.kind === 'usage').body;
      assert.match(lightUsage, /openai-codex\/gpt-6\.1-sol/);
      assert.match(lightUsage, /also uses standard for lightning\)/);
      assert.ok(readCalls().at(-1).args.includes('model_reasoning_effort="medium"'), 'the standard effort for the role that stays standard');
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });
});
});

await describe('task-wait', { concurrency: false }, async () => {
// task_wait and task_result against the real daemon with a fake runtime (tests/fakes/fake-sleeper.mjs):
// a run that ends while the caller waits, a run that outlasts the wait, the bridge answering other
// calls while a wait is blocked, and the report taken from the output when a runner left none.







function fakeRuntime(root) {
  fs.copyFileSync(FAKE_SLEEPER, path.join(root, 'src', 'fake-sleeper.mjs'));
  const file = path.join(root, 'roles.json');
  const roles = JSON.parse(fs.readFileSync(file, 'utf8'));
  roles.explorer.spawn.args = ['src/fake-sleeper.mjs', '--pi', '{runtime}', '--tools', 'read,grep,find,ls', '-p', '{task}'];
  fs.writeFileSync(file, JSON.stringify(roles, null, 2));
}

describe('task_wait / task_result', () => {
  let service;
  let mcp;
  let workdir;
  let scratch;

  before(async () => {
    scratch = tempDir('ssa-wait-');
    workdir = tempDir('ssa-work-');
    service = await startService({ env: { FAKE_SLEEPER_PIDS: path.join(scratch, 'pids.json') }, prepare: fakeRuntime });
    mcp = startMcp(service);
  });
  after(async () => {
    await mcp?.close();
    await service?.stop();
    for (const dir of [workdir, scratch]) if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('[O-5] waits for a run to end and hands back its result, the report taken from the output when the runner left none', async () => {
    const started = JSON.parse((await mcp.tool('seat_start', { role: 'explorer', task: 'finish-after:1500', cwd: workdir })).text);
    assert.ok(Number.isSafeInteger(started.run) && started.run > 0, 'dispatch returns the admitted task event id');
    const t0 = Date.now();
    const waited = await mcp.tool('task_wait', { seat: started.seat, run: started.run, timeout_seconds: 20 });
    assert.equal(waited.isError, false, waited.text);
    assert.ok(Date.now() - t0 >= 1000, 'it actually waited');
    assert.match(waited.text, /^Run #\d+ ended/);
    assert.match(waited.text, /done \(exit code 0\)/);
    // The fake sleeper writes no report field: the report is the output after the last tool line.
    assert.match(waited.text, /last section extracted from output/);
    assert.match(waited.text, /before\nafter/);
    assert.match(waited.text, /Verdict: not recorded\. After review, use seat_verdict/);

    // An ended run is answered at once.
    const again = await mcp.tool('task_wait', { seat: started.seat, timeout_seconds: 1 });
    assert.match(again.text, /ended/);
    const result = await mcp.tool('task_result', { seat: `${started.seat}#${/run #(\d+)/i.exec(waited.text)[1]}` });
    assert.match(result.text, /before\nafter/);

    const reused = JSON.parse((await mcp.tool('seat_start', { role: 'explorer', task: 'finish-after:100', cwd: workdir })).text);
    assert.equal(reused.seat, started.seat);
    assert.ok(Number.isSafeInteger(reused.run) && reused.run > started.run, 'a reused seat has a distinct run id');
    const second = await mcp.tool('task_wait', { run: reused.run, timeout_seconds: 20 });
    assert.equal(second.isError, false, second.text);
    assert.ok(second.text.includes(`run #${reused.run}`));
    const first = await mcp.tool('task_result', { run: started.run });
    assert.ok(first.text.includes(`run #${started.run}`), 'the previous run remains addressable after reuse');
  });

  it('says a run outlasting the wait is still going, and the bridge keeps answering other calls meanwhile', async () => {
    const started = JSON.parse((await mcp.tool('seat_start', { role: 'explorer', task: 'hang' })).text);
    const waiting = mcp.tool('task_wait', { seat: started.seat, timeout_seconds: 3 });
    // Asked while the wait is blocked: answered before it, not queued behind it.
    const t0 = Date.now();
    const ping = await mcp.request('ping');
    assert.deepEqual(ping.result, {});
    const result = await mcp.tool('task_result', { seat: started.seat });
    assert.ok(Date.now() - t0 < 2500, 'other calls did not wait for task_wait');
    assert.match(result.text, /running/);
    assert.match(result.text, /task_wait/);

    const waited = await waiting;
    assert.equal(waited.isError, false, waited.text);
    assert.match(waited.text, /running/);
    assert.match(waited.text, /call task_wait \(run=\d+\)/);
    assert.match(waited.text, /Last output: hanging/);

    await mcp.tool('seat_close', { seat: started.seat, reason: 'test over' });
    const closed = await mcp.tool('task_wait', { seat: started.seat, timeout_seconds: 10 });
    assert.match(closed.text, /cancelled/);
  });

  it('refuses a call that names no run', async () => {
    const reply = await mcp.tool('task_wait', {});
    assert.equal(reply.isError, true);
    assert.match(reply.text, /at least one of seat or run/);
  });
});
});
