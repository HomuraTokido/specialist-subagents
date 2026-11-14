import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { startMcp } from './lib/mcp.mjs';
import { FAKE_SLEEPER, REPO, sleep, startService, tempDir } from './lib/sandbox.mjs';
import { loadStore } from './lib/store.mjs';
import { createHash } from 'node:crypto';

await describe('c6', { concurrency: false }, async () => {
// C-6: the share of runs that began with nothing is measured from the ledger, not guessed from the code.
// A sandbox service runs a few dispatches (a new object, a returning expert, a fork of a busy one, a
// second new object); then tools/prd-check.mjs reads the sandbox's runs table and prints the numbers.








describe('[C-6] the numbers prd-check reads from the runs table', () => {
  let service;
  let mcp;
  let scratch;
  before(async () => {
    scratch = tempDir('ssa-c6-');
    service = await startService({
      prepare: (root) => {
        fs.copyFileSync(FAKE_SLEEPER, path.join(root, 'src', 'fake-sleeper.mjs'));
        const file = path.join(root, 'roles.json');
        const roles = JSON.parse(fs.readFileSync(file, 'utf8'));
        roles.explorer.spawn.args = ['src/fake-sleeper.mjs', '--pi', '{runtime}', '--tools', 'read,grep,find,ls', '-p', '{task}'];
        fs.writeFileSync(file, JSON.stringify(roles, null, 2));
      },
    });
    mcp = startMcp(service);
  });
  after(async () => {
    mcp?.close();
    await service?.stop();
    if (scratch) fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  const dispatch = async (cwd, task) => {
    const out = await mcp.tool('seat_start', { role: 'explorer', cwd, task });
    assert.equal(out.isError, false, out.text);
    return JSON.parse(out.text);
  };
  const settled = async (seat) => {
    const end = Date.now() + 30000;
    for (;;) {
      const { json } = await service.call('GET', `/seats/${seat}?tail=all`);
      if (!['running', 'open'].includes(json.seat.state) && json.events.filter((e) => e.kind === 'exit').length >= json.events.filter((e) => e.kind === 'task').length) return json;
      if (Date.now() > end) throw new Error(`${seat} did not settle`);
      await sleep(100);
    }
  };

  it('counts the loads of the last runs and finds no returning expert that started blank', async () => {
    const a = path.join(scratch, 'a');
    const b = path.join(scratch, 'b');
    fs.mkdirSync(a);
    fs.mkdirSync(b);
    const first = await dispatch(a, 'finish-after:10');
    await settled(first.seat);
    const second = await dispatch(a, 'finish-after:1500'); // the expert returns and stays busy for a while
    assert.equal(second.seat, first.seat);
    const fork = await dispatch(a, 'finish-after:10'); // ...so this one is a fork
    assert.equal(fork.fork, true);
    await settled(fork.seat);
    await settled(first.seat);
    const other = await dispatch(b, 'finish-after:10');
    await settled(other.seat);

    const ran = spawnSync(process.execPath, [
      path.join(REPO, 'tools', 'prd-check.mjs'), '--ledger', service.env.SPECIALIST_SUBAGENTS_DB,
      '--scenarios', 'tests/none/*.scenario.mjs', '--tests', 'tests/none/*.test.mjs', '--json',
    ], { cwd: REPO, encoding: 'utf8', windowsHide: true });
    // Exit 1: the requirements without tests here are unimplemented; only the c6 part is read.
    const report = JSON.parse(ran.stdout);
    assert.equal(report.c6.available, true, JSON.stringify(report.c6));
    assert.equal(report.c6.total, 4);
    assert.deepEqual(report.c6.byLoad, { resumed: 2, loaded: 0, fresh: 2 });
    assert.equal(report.c6.blankOnExisting, 0, '派给已有专家却空白开工 = 0');
    assert.equal(report.c6.other, 0);
  });
});
});

await describe('cost', { concurrency: false }, async () => {
// cost_report / costRuns: rebuilt from task / usage / exit / verdict events only. Nothing checks the
// dollar figures at run time, so a regex that stops matching or a run boundary drawn wrongly just
// produces a plausible-looking wrong report.




const usage = (input, cached, output, cost, label) =>
  `本次用量：输入 ${input} token（另有缓存命中 ${cached}），输出 ${output} token${cost === null ? '' : `，约 $${cost}`}（${label}）`;

describe('costRuns and costReportText', () => {
  let env;
  let store;
  const runs = {};

  const seat = (role) => store.openSeat({ role }).seat;
  const event = (id, kind, body) => store.recordEvent({ seat: id, kind, body });

  before(async () => {
    env = await loadStore();
    store = env.store;

    // 1. pay-per-token DeepSeek run, adopted: real money, no equivalent.
    const a = seat('coder');
    event(a, 'task', 'a');
    event(a, 'usage', usage(1000, 200, 50, '0.0123', 'deepseek/deepseek-flash'));
    event(a, 'exit', '0');
    event(a, 'verdict', 'accepted');

    // 2. subscription run whose label states its own equivalent: it must win over the computed one.
    const b = seat('coder');
    event(b, 'task', 'b');
    event(b, 'usage', usage(1000, 200, 50, null, 'openai-codex/gpt-5.6-terra，订阅额度（按 API 价折合 $0.0100）'));
    event(b, 'exit', '0');
    event(b, 'verdict', 'revised：改了两处');

    // 3. subscription run with no stated equivalent: priced from the token counts (1000 in, 200 cached,
    //    50 out at $2 / $0.2 / $12 per million = $0.00264).
    const c = seat('explorer');
    event(c, 'task', 'c');
    event(c, 'usage', usage(1000, 200, 50, null, 'openai-codex/gpt-5.6-terra，订阅额度'));
    event(c, 'exit', '0');

    // 4. a model the price table does not know: unpriced, not priced at zero.
    const d = seat('explorer');
    event(d, 'task', 'd');
    event(d, 'usage', usage(10, 0, 5, null, 'acme-cli/mystery-9，订阅额度'));
    event(d, 'exit', '0');

    // 5. never got a model: exit code 1, no usage.
    const e = seat('tester');
    event(e, 'task', 'e');
    event(e, 'exit', '1');
    event(e, 'verdict', 'rejected：没跑起来');

    // 6. one reused seat, two runs: usage belongs to the run whose task event came before it.
    const f = seat('handyman');
    event(f, 'task', 'f1');
    event(f, 'usage', usage(100, 0, 10, '0.0010', 'deepseek/deepseek-flash'));
    event(f, 'exit', '0');
    event(f, 'verdict', 'accepted');
    event(f, 'task', 'f2');
    event(f, 'usage', usage(300, 0, 30, '0.0030', 'deepseek/deepseek-flash'));
    event(f, 'exit', '0');

    Object.assign(runs, { a, b, c, d, e, f });
  });
  after(() => env?.cleanup());

  const byTask = () => new Map(store.costRuns().map((run) => [store.listEvents(run.seat).find((ev) => `${run.seat}#${ev.seq}` === run.run)?.body, run]));

  it('reads tokens, real cost, model, exit and verdict off the events of each run', () => {
    const a = byTask().get('a');
    assert.equal(a.role, 'coder');
    assert.equal(a.model, 'deepseek/deepseek-flash');
    assert.deepEqual([a.input, a.cacheRead, a.output], [1000, 200, 50]);
    assert.equal(a.real, 0.0123);
    assert.equal(a.equivalent, null, 'a pay-per-token run has no subscription equivalent');
    assert.equal(a.exit, '0');
    assert.equal(a.verdict, 'accepted');
  });

  it('prefers the equivalent stated in the label over one computed from tokens', () => {
    const b = byTask().get('b');
    assert.equal(b.equivalent, 0.01);
    assert.equal(b.real, 0);
    assert.equal(b.verdict, 'revised');
  });

  it('computes the equivalent from the price table when the label states none', () => {
    const c = byTask().get('c');
    assert.ok(Math.abs(c.equivalent - 0.00264) < 1e-12, String(c.equivalent));
  });

  it('leaves an unknown model unpriced (null), not zero', () => {
    const d = byTask().get('d');
    assert.equal(d.model, 'acme-cli/mystery-9');
    assert.equal(d.equivalent, null);
  });

  it('starts a new run at each task event of a reused seat', () => {
    const [first, second] = store.costRuns().filter((run) => run.seat === runs.f);
    assert.equal(first.real, 0.001);
    assert.equal(first.verdict, 'accepted');
    assert.equal(second.real, 0.003);
    assert.equal(second.verdict, null, 'the earlier verdict does not carry into the next run');
  });

  it('report: per role x model line with money, verdict counts and cost per adopted run', () => {
    const text = store.costReportText();
    assert.match(text, /all records, 7 run\(s\)/);
    // coder x deepseek: one run, adopted, $0.0123 real.
    assert.match(text, /- coder · deepseek\/deepseek-flash: 1 run\(s\) \(accepted 1, revised 0, rejected 0, unjudged 0\), real \$0\.0123; per accepted: \$0\.0123/);
    // coder x codex: the stated $0.0100, revised, so nothing adopted to divide by.
    assert.match(text, /- coder · openai-codex\/gpt-5\.6-terra: 1 run\(s\) \(accepted 0, revised 1, rejected 0, unjudged 0\), API-equiv \$0\.0100; per accepted: no accepted runs yet/);
    // explorer x codex: computed $0.00264 prints as $0.0026.
    assert.match(text, /- explorer · openai-codex\/gpt-5\.6-terra: 1 run\(s\) \(accepted 0, revised 0, rejected 0, unjudged 1\), API-equiv \$0\.0026/);
    // explorer x unknown model: says it is unpriced instead of printing $0.
    assert.match(text, /- explorer · acme-cli\/mystery-9: 1 run\(s\).*1 run\(s\) unpriced/);
    // the failed run with no model is grouped as not started, and counted as failed.
    assert.match(text, /- tester · failed to start: 1 run\(s\) \(accepted 0, revised 0, rejected 1, unjudged 0; 1 failed\)/);
    // reused seat, both runs in one group: $0.0040 over one adopted run.
    assert.match(text, /- handyman · deepseek\/deepseek-flash: 2 run\(s\) \(accepted 1, revised 0, rejected 0, unjudged 1\), real \$0\.0040; per accepted: \$0\.0040/);
    assert.match(store.costReportText({}, 'zh'), /全部记录，7 单/);
  });

  it('report: states how many runs carry a verdict', () => {
    // Runs 1, 2, 5 and the first run of the reused seat: 4 of 7, which is more than half.
    assert.match(store.costReportText(), /Verdicts cover 4\/7 runs\./);
  });

  it('since keeps only runs at or after that time', () => {
    assert.equal(store.costRuns({ since: '2999-01-01' }).length, 0);
    assert.match(store.costReportText({ since: '2999-01-01' }), /No runs recorded since 2999-01-01/);
    assert.equal(store.costRuns({ since: '2000-01-01' }).length, store.costRuns().length);
  });
});
});

await describe('report-size', { concurrency: false }, async () => {
// O-4: a run's final report is kept whole in a file, the reply carries only a bounded part, and the
// size and sha256 it names are those of the whole file (so the file can be checked against them).








// The report is multi-byte on purpose: characters and bytes differ, so a count of the wrong one shows.
const LONG_REPORT = `${'长文报告。'.repeat(1200)}THE-END`;
const SHORT_REPORT = '很短的报告。';

// A runtime that answers with the report named by its task, the way a runner's result file carries it.
const FAKE_REPORTER = (long, short) => `
import fs from 'node:fs';
const args = process.argv.slice(2);
const task = String(args[args.indexOf('-p') + 1] ?? '');
const report = task.includes('long') ? ${JSON.stringify(long)} : ${JSON.stringify(short)};
process.stdout.write('working\\n');
fs.writeFileSync(process.env.SPECIALIST_SEAT_RESULT, JSON.stringify({
  report,
  tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 },
  expertise: 'fake-reporter knows this directory',
  backlog: '',
  model: 'fake/fake-reporter',
  difficulties: [],
}));
`;

describe('a long report', () => {
  let service;
  let mcp;
  let cwd;
  before(async () => {
    cwd = tempDir('ssa-o4-');
    service = await startService({
      prepare: (root) => {
        fs.writeFileSync(path.join(root, 'src', 'fake-reporter.mjs'), FAKE_REPORTER(LONG_REPORT, SHORT_REPORT));
        const file = path.join(root, 'roles.json');
        const roles = JSON.parse(fs.readFileSync(file, 'utf8'));
        roles.explorer.spawn.args = ['src/fake-reporter.mjs', '--pi', '{runtime}', '--tools', 'read,grep,find,ls', '-p', '{task}'];
        fs.writeFileSync(file, JSON.stringify(roles, null, 2));
      },
    });
    mcp = startMcp(service);
  });
  after(async () => {
    mcp?.close();
    await service?.stop();
    fs.rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  const dispatch = async (task) => {
    const started = await service.call('POST', '/seat/start', { role: 'explorer', task, cwd });
    assert.equal(started.status, 200, started.text);
    const done = await service.waitSeat(started.json.seat, ['done', 'failed', 'interrupted']);
    assert.equal(done.seat.state, 'done', service.log());
    return { seat: started.json.seat, run: started.json.run };
  };

  it('[O-4] task_result is bounded, names the full-text file, and the file matches the size and sha256 it reports', async () => {
    const { seat } = await dispatch('long report please');

    const { json } = await service.call('GET', `/run?seat=${seat}&budget=500`);
    const report = json.run.report;
    assert.equal(report.truncated, true);
    assert.equal(report.text.length, 500, 'only the budget comes back');
    assert.equal(report.chars, LONG_REPORT.length);
    assert.ok(report.file && fs.existsSync(report.file), 'the full text is on disk');
    const onDisk = fs.readFileSync(report.file);
    assert.equal(report.bytes, onDisk.length, 'bytes are the file\'s, not the character count');
    assert.ok(report.bytes > report.chars, 'the fixture is multi-byte');
    assert.equal(report.sha256, createHash('sha256').update(onDisk).digest('hex'));
    assert.ok(onDisk.toString('utf8').includes('THE-END'), 'the file holds the end that the reply cut off');

    // What the model is handed: a bounded text that names the file and carries the size and the hash.
    const result = await mcp.tool('task_result', { seat, max_chars: 500 });
    assert.equal(result.isError, false, result.text);
    assert.ok(result.text.length < 500 + 1500, `the reply stays near its budget (${result.text.length} chars)`);
    assert.doesNotMatch(result.text, /THE-END/);
    assert.ok(result.text.includes(report.file), 'names the full-text file');
    assert.ok(result.text.includes(`Full text ${report.bytes} bytes, sha256 ${report.sha256.slice(0, 12)}…`), result.text);
  });

  it('[O-4] a report that fits is returned whole, with the same size and hash fields', async () => {
    const { seat } = await dispatch('short report please');
    const { json } = await service.call('GET', `/run?seat=${seat}`);
    const report = json.run.report;
    assert.equal(report.truncated, false);
    assert.equal(report.text, SHORT_REPORT);
    const onDisk = fs.readFileSync(report.file);
    assert.equal(report.bytes, onDisk.length);
    assert.equal(report.sha256, createHash('sha256').update(onDisk).digest('hex'));
  });
});
});
