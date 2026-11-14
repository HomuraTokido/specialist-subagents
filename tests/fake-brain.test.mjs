import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, it, after, before } from 'node:test';
import { respond } from './fakes/fake-brain.mjs';
import { CLOSING_PROMPT } from '../src/closing.mjs';
import { FAKE_CLAUDE, FAKE_CODEX_BRAIN, FAKE_PI_CLI, isolatedEnv, sleep, startService, tempDir, REPO } from './lib/sandbox.mjs';
import { execFileSync, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

await describe('fake-brain', { concurrency: false }, async () => {
// The fake model the end-to-end scenarios run on (tests/fakes/fake-brain.mjs): it knows only what is in
// its context. First the brain on its own, then through the real service on both backend stand-ins,
// Codex (fake-codex-brain.mjs) and DeepSeek (fake-pi with FAKE_PI_BRAIN=1): a fact read in one run has
// to be answered in the next from the session, without going to "the web".








const rm = (dir) => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
const readLog = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []);
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function until(check, what, timeoutMs = 20000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

describe('the brain on its own', () => {
  const ENV_KEYS = ['FAKE_WORLD', 'FAKE_BRAIN_LOG', 'FAKE_TODAY', 'SPECIALIST_SEAT_NAME'];
  let dir;
  let saved;
  let log;
  const ask = (prompt, history = []) => respond({ backend: 'codex', history, prompt, cwd: dir });

  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    dir = tempDir('ssa-brain-');
    log = path.join(dir, 'brain.jsonl');
    fs.writeFileSync(path.join(dir, 'world.json'), JSON.stringify({ colour: 'teal', size: '42' }));
    process.env.FAKE_WORLD = path.join(dir, 'world.json');
    process.env.FAKE_BRAIN_LOG = log;
    process.env.FAKE_TODAY = '2026-10-11';
    process.env.SPECIALIST_SEAT_NAME = 'seat-test-1';
  });
  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    rm(dir);
  });

  it('goes to the web for a fact it does not have, and says where it found it', async () => {
    const got = await ask('任务：\n问：colour');
    assert.equal(got.tools.length, 1);
    assert.equal(got.tools[0].tool, 'bash');
    assert.match(got.tools[0].arg, /web-search\.mjs "colour"/);
    assert.equal(got.answer, '答：colour=teal（出处：联网 https://example.test/colour；查证：2026-10-11）');
    const none = await ask('问：weight');
    assert.equal(none.answer, '答：weight 查不到（查证：2026-10-11）');
  });

  it('answers the same question from its own earlier answer, with no web call and the original source kept', async () => {
    const first = await ask('问：colour');
    process.env.FAKE_TODAY = '2026-12-31';
    const second = await ask('问：colour', ['问：colour', first.answer]);
    assert.deepEqual(second.tools, []);
    assert.match(second.answer, /colour=teal/);
    assert.match(second.answer, /出自上一单/);
    assert.match(second.answer, /联网 https:\/\/example\.test\/colour/);
    assert.match(second.answer, /查证：2026-10-11/, 'the date it was checked, not today');
    const third = await ask('问：colour', ['问：colour', first.answer, '问：colour', second.answer]);
    assert.equal(third.answer.split('出自上一单').length, 2, 'the origin does not nest');
  });

  it('knows a fact only once it has read the file that holds it', async () => {
    fs.writeFileSync(path.join(dir, 'facts.txt'), '备注\n事实：colour=teal\n');
    const blind = await ask('问：colour');
    assert.equal(blind.tools[0].tool, 'bash', 'without the file it has to search');
    const got = await ask('读文件：facts.txt\n问：colour');
    assert.deepEqual(got.tools.map((t) => [t.tool, t.isError]), [['read', false]]);
    assert.equal(got.tools[0].arg, path.join(dir, 'facts.txt'));
    assert.equal(got.answer, '答：colour=teal（出处：读文件 facts.txt；查证：2026-10-11）');
    const missing = await ask('读文件：nope.txt');
    assert.deepEqual(missing.tools.map((t) => [t.tool, t.isError, t.output]), [['read', true, 'ENOENT']]);
    assert.equal(missing.answer, '好的。');
  });

  it('keeps what its tools returned: a file read in one call is still known in the next, from the session', async () => {
    fs.writeFileSync(path.join(dir, 'facts.txt'), '备注\n事实：colour=teal\n');
    const first = await ask('读文件：facts.txt');
    assert.equal(first.answer, '好的。', 'it only read');
    assert.equal(first.transcript, '备注\n事实：colour=teal\n', 'the whole file is the tool result, not a preview');
    const second = await ask('问：colour', ['读文件：facts.txt', first.transcript, first.answer]);
    assert.deepEqual(second.tools, [], 'no web, no re-read');
    assert.equal(second.answer, '答：colour=teal（出处：出自上一单；查证：2026-10-11）');
    const without = await ask('问：colour', ['读文件：facts.txt', first.answer]);
    assert.equal(without.tools[0].tool, 'bash', 'without the tool result in the session the fact is gone');
    const several = await ask('读文件：facts.txt\n读文件：nope.txt\n改文件：b.txt=x');
    assert.equal(several.transcript, '备注\n事实：colour=teal\n\nENOENT\nwrote b.txt', 'every tool result, in order');
  });

  it('writes the hand-off in four sections, with every fact it knows, when the service asks for one', async () => {
    const history = ['读文件：secret.txt', '事实：delta=4\n另一行', '答：delta=4（出处：读文件 secret.txt；查证：2026-10-11）'];
    const got = await ask('（服务消息，不是新任务）写交接：只写 api 那一块', history);
    assert.deepEqual(got.tools, []);
    assert.equal(got.answer, [
      '## 懂了什么', '事实：delta=4',
      '## 没做完什么', '无',
      '## 踩过的坑', '无',
      '## 原始记录路径', '（见服务附上的清单）',
    ].join('\n'));
    assert.match((await ask('写交接')).answer, /^## 懂了什么\n## 没做完什么\n无\n## 踩过的坑\n无\n## 原始记录路径\n/, 'a session that knows nothing lists nothing');
    // The receiver of the hand-off reads the facts out of it as out of any text in its prompt.
    const receiver = await ask(`交接：\n${got.answer}\n\n任务：\n问：delta`);
    assert.deepEqual(receiver.tools, []);
    assert.match(receiver.answer, /delta=4/);
  });

  it('follows a record path in the prompt to the fact, without the web', async () => {
    const record = path.join(dir, 'old-session.jsonl');
    fs.writeFileSync(record, `${JSON.stringify({ role: 'user', text: '读文件：facts.txt' })}\n${JSON.stringify({ role: 'assistant', text: '背景\n事实：colour=teal\n结束' })}\n`);
    const prompt = `（服务消息）你是这个目录的常驻专家，但上一段会话没有沿用。\n上一段会话的完整记录在 ${record}，需要时可以读，不需要就别读。\n\n---\n\n任务：\n问：colour`;
    const got = await ask(prompt);
    assert.deepEqual(got.tools.map((t) => [t.tool, t.arg]), [['read', record]]);
    assert.equal(got.answer, `答：colour=teal（出处：出自记录 ${record}；查证：2026-10-11）`);
  });

  it('gives the closing question a fixed answer that carries no facts', async () => {
    const got = await ask(`${CLOSING_PROMPT}`, ['问：colour', '答：colour=teal（出处：x；查证：y）']);
    assert.equal(got.answer, '我是这里的常驻专家，读过这里的一些文件。\n未完成：无');
    assert.deepEqual(got.tools, []);
    const followup = await ask('（服务消息，不是新任务）不要调用任何工具。刚才的运行里有这几处：\n1. x');
    assert.equal(followup.answer, '1. 任务需要。');
  });

  it('writes a file, and lists what it changed when asked in a later call', async () => {
    const first = await ask('任务：\n改文件：sub/a.txt=hello\n改文件：b.txt=x');
    assert.equal(fs.readFileSync(path.join(dir, 'sub', 'a.txt'), 'utf8'), 'hello');
    assert.deepEqual(first.tools.map((t) => t.tool), ['write', 'write']);
    assert.equal(first.answer, '改动：sub/a.txt\n改动：b.txt');
    const second = await ask('问上次改动', ['任务：\n改文件：sub/a.txt=hello\n改文件：b.txt=x', first.answer]);
    assert.equal(second.answer, '上次改动：sub/a.txt,b.txt');
    assert.equal((await ask('问上次改动')).answer, '上次改动：不知道');
  });

  it('reads the files the service listed as changed from this prompt only', async () => {
    const note = '服务提示：目录有变化。\n\n提交里改动的文件（路径相对仓库根 /r，共 2 个、3 行）：\nsub/a.txt\nsub/b.txt\n\n现在未提交的改动：\n?? sub/c.txt\n\n用到这些文件时重新读一下。\n\n任务：\n问目录变化';
    const got = await ask(note, ['提交里改动的文件（x）：\nold.txt\n']);
    assert.equal(got.answer, '目录变化：3 个文件：sub/a.txt,sub/b.txt,?? sub/c.txt');
    assert.equal((await ask('问目录变化')).answer, '目录变化：不知道');
  });

  it('stays busy with a real child under it for 慢, then takes the child down', async () => {
    const begun = Date.now();
    const got = await ask('慢：200');
    assert.ok(Date.now() - begun >= 190, 'it waited');
    assert.equal(got.answer, '好的。');
    const slow = readLog(log).find((line) => line.phase === 'slow');
    assert.ok(slow, 'the slow line is in the log');
    assert.equal(slow.pid, process.pid);
    assert.ok(Number.isInteger(slow.grandchild) && slow.grandchild !== process.pid);
    await until(() => !alive(slow.grandchild), 'the grandchild to be gone', 3000);
    const answered = readLog(log).find((line) => line.phase === 'answer');
    assert.equal(answered.seatName, 'seat-test-1');
    assert.equal(answered.kind, 'task');
    assert.equal(answered.resumed, false);
  });

  it('logs one line per call with the tools it used', async () => {
    await ask('问：colour');
    await ask(CLOSING_PROMPT, ['x']);
    const lines = readLog(log);
    assert.deepEqual(lines.map((l) => [l.phase, l.kind, l.resumed]), [['answer', 'task', false], ['answer', 'closing', true]]);
    assert.deepEqual(lines[0].tools, [{ tool: 'bash', arg: 'node tools/web-search.mjs "colour"', isError: false }]);
  });
});

describe('through the real service', () => {
  const services = [];
  const dirs = [];
  afterEach(async () => {
    while (services.length) await services.pop().stop();
    while (dirs.length) rm(dirs.pop());
  });

  // Two runs of the same expert in the same directory. The first only reads the file; the second only
  // asks, so the fact can come from nowhere but the first run's session (its tool result is in it). Only a service that continues the session (or hands over the record) lets the
  // second answer without going to the web. `runs` is how many runs of the seat have ended by then: a
  // reused seat shows its old `done` at once.
  async function twoRuns(options) {
    const scratch = tempDir('ssa-brain-it-');
    dirs.push(scratch);
    const work = path.join(scratch, 'work');
    fs.mkdirSync(work);
    fs.writeFileSync(path.join(work, 'facts.txt'), '事实：colour=teal\n');
    fs.writeFileSync(path.join(scratch, 'world.json'), JSON.stringify({ colour: 'WEB-colour' }));
    const log = path.join(scratch, 'brain.jsonl');
    const service = await startService({
      ...options,
      env: { ...options.env, FAKE_WORLD: path.join(scratch, 'world.json'), FAKE_BRAIN_LOG: log },
    });
    services.push(service);

    const runToEnd = async (task, runs) => {
      const started = await service.call('POST', '/seat/start', { role: 'coder', task, cwd: work });
      assert.equal(started.status, 200, started.text);
      await until(async () => {
        const { json } = await service.call('GET', `/seats/${started.json.seat}?tail=all`);
        return json.events.filter((ev) => ev.kind === 'exit').length === runs && json.seat.state !== 'running';
      }, `run ${runs} of ${started.json.seat} to end\n${service.log()}`);
      const report = await service.call('GET', `/run?seat=${started.json.seat}`);
      return { seat: started.json.seat, report: JSON.stringify(report.json) };
    };
    const first = await runToEnd('读文件：facts.txt', 1);
    const before = readLog(log).length;
    const second = await runToEnd('问：colour', 2);
    assert.equal(second.seat, first.seat, 'the same expert came back');
    return { first, second, ran: readLog(log).slice(before).filter((line) => line.phase === 'answer' && line.kind === 'task') };
  }

  const check = ({ first, second, ran }, backend) => {
    assert.doesNotMatch(first.report, /colour=teal/, 'the first run only read the file');
    assert.match(second.report, /colour=teal/);
    assert.match(second.report, /出自上一单/);
    assert.equal(ran.length, 1, 'one task call in the second run');
    assert.equal(ran[0].backend, backend);
    assert.equal(ran[0].resumed, true, 'the session was continued');
    assert.equal(ran[0].tools.some((t) => t.tool === 'bash'), false, 'no web search in the second run');
    assert.doesNotMatch(second.report, /WEB-colour/);
  };

  it('a Codex expert answers from what it read in the earlier run', async () => {
    check(await twoRuns({ env: { SPECIALIST_CODEX_JS: FAKE_CODEX_BRAIN } }), 'codex');
  });

  it('a DeepSeek expert answers from what it read in the earlier run', async () => {
    check(await twoRuns({
      env: { SPECIALIST_SUBAGENTS_RUNTIME: FAKE_PI_CLI, FAKE_PI_BRAIN: '1' },
      prepare: (root) => {
        fs.mkdirSync(path.join(root, '.data'), { recursive: true });
        fs.writeFileSync(path.join(root, '.data', 'backend-prefer.json'), JSON.stringify({ mode: 'deepseek', max: false }));
      },
    }), 'pi');
  });

  it('[O-5] keeps an earlier real backlog and the main answer when the closing-context file is damaged', async () => {
    const scratch = tempDir('ssa-closing-context-');
    dirs.push(scratch);
    const work = path.join(scratch, 'work');
    const switchFile = path.join(scratch, 'break-closing-context');
    fs.mkdirSync(work);
    fs.writeFileSync(switchFile, '');
    const service = await startService({
      env: {
        SPECIALIST_CODEX_JS: FAKE_CODEX_BRAIN,
        FAKE_CLOSING_CONTEXT_BREAK_FILE: switchFile,
      },
    });
    services.push(service);
    const dispatch = async (task) => {
      const started = await service.call('POST', '/seat/start', { role: 'coder', task, cwd: work });
      assert.equal(started.status, 200, started.text);
      return service.waitSeat(started.json.seat);
    };

    const first = await dispatch('缺输入：验证码');
    assert.match(first.seat.backlog, /验证码/, 'the first task left one genuine item');
    fs.writeFileSync(switchFile, '1');
    const second = await dispatch('hello');
    assert.equal(second.seat.id, first.seat.id, 'the same expert received the unrelated hello');
    assert.match(second.seat.backlog, /验证码/, 'a failed closing context does not clear the earlier item');
    assert.ok(second.events.some((event) => event.kind === 'stdout' && event.body.includes('好的')), 'the main answer survived even though closing was skipped');
  });

  it('[O-5] carries a task over 32K into the closing JSON by file, without treating service wrapping as its task', async () => {
    const scratch = tempDir('ssa-closing-large-');
    dirs.push(scratch);
    const work = path.join(scratch, 'work');
    const callsFile = path.join(scratch, 'codex-calls.jsonl');
    fs.mkdirSync(work);
    const service = await startService({ env: { SPECIALIST_CODEX_JS: FAKE_CODEX_BRAIN, FAKE_CODEX_CALLS: callsFile } });
    services.push(service);
    const task = `${'x'.repeat(33_000)}\nhello`;
    const started = await service.call('POST', '/seat/start', { role: 'coder', task, cwd: work });
    assert.equal(started.status, 200, started.text);
    const shown = await service.waitSeat(started.json.seat);
    assert.equal(shown.seat.state, 'done', service.log());
    const calls = fs.readFileSync(callsFile, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
    const closing = calls.find((call) => call.closing);
    assert.ok(closing, 'the runner asked exactly one closing question');
    const scope = JSON.parse(closing.prompt.slice(closing.prompt.lastIndexOf('服务收尾依据（JSON）：') + '服务收尾依据（JSON）：'.length).trim());
    assert.equal(scope.task, task, 'the file carries the original task, including its large body');
    assert.equal(scope.backlog, null);
    assert.doesNotMatch(scope.task, /服务提示：你上次|任务正文 .*超过/);
  });
});
});

await describe('run-failure', { concurrency: false }, async () => {
// What a single run does when a model call fails, and what that does to the seat's backlog.
//
// Two layers, both on fakes: seat-runner against a fake pi SDK (tests/fakes/fake-pi, which ends a
// failed prompt with an 'error' assistant message instead of throwing, like the real one), and the
// whole service with the fake Codex CLI, where the mode file switches the failure between calls.







const readLines = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []);

function runSeatRunner({ mode, backlog }) {
  const dir = tempDir('ssa-pi-');
  const resultFile = path.join(dir, 'result.json');
  const callsFile = path.join(dir, 'calls.jsonl');
  const res = spawnSync(
    process.execPath,
    [path.join(REPO, 'src', 'seat-runner.mjs'), '--pi', FAKE_PI_CLI, '--provider', 'fake', '--model', 'm', '--tools', 'read', '-p', 'TASK'],
    {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: isolatedEnv(dir, {
        SPECIALIST_SEAT_RESULT: resultFile,
        SPECIALIST_SEAT_SESSION_DIR: dir,
        FAKE_PI_MODE: mode,
        FAKE_PI_CALLS: callsFile,
        ...(backlog ? { FAKE_PI_BACKLOG: backlog } : {}),
      }),
    },
  );
  const result = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
  const calls = readLines(callsFile);
  fs.rmSync(dir, { recursive: true, force: true });
  return { status: res.status, stderr: res.stderr, result, calls };
}

describe('seat-runner on a provider failure', () => {
  it('fails the run when the task prompt ends in an error message, and does not ask the closing question', () => {
    const run = runSeatRunner({ mode: 'main-error' });
    assert.equal(run.status, 1);
    assert.match(run.result.error, /quota exceeded \(fake pi\)/);
    assert.match(run.result.error, /inspect and redispatch/, 'the message says what to do next');
    assert.equal(run.result.backlog, null, 'a failed run says nothing about the backlog');
    assert.deepEqual(run.calls.map((c) => c.closing), [false], 'only the task was asked');
    assert.ok(run.result.tokens, 'what the failed run cost is still reported');
  });

  it('keeps the task result but reports the backlog as unknown when the closing prompt fails', () => {
    const run = runSeatRunner({ mode: 'closing-error' });
    assert.equal(run.status, 0);
    assert.equal(run.result.error, undefined);
    assert.equal(run.result.backlog, null, 'null, never "" (which would mean nothing left)');
    assert.ok(run.result.tokens);
    assert.match(run.stderr, /Closing round failed/);
  });

  it('reports the backlog when the closing prompt answers', () => {
    assert.equal(runSeatRunner({ mode: 'ok', backlog: '- 还差 X' }).result.backlog, '- 还差 X');
    assert.equal(runSeatRunner({ mode: 'ok' }).result.backlog, '');
  });
});

describe('the service around a failing Codex', () => {
  let service;
  let scratch;
  let modeFile;
  let piCalls;

  before(async () => {
    scratch = tempDir('ssa-fail-');
    modeFile = path.join(scratch, 'codex-mode');
    piCalls = path.join(scratch, 'pi-calls.jsonl');
    service = await startService({
      env: {
        FAKE_CODEX_MODE_FILE: modeFile,
        // The DeepSeek fallback runs seat-runner, and seat-runner runs against the fake SDK.
        SPECIALIST_SUBAGENTS_RUNTIME: FAKE_PI_CLI,
        FAKE_PI_CALLS: piCalls,
      },
    });
  });
  after(async () => {
    await service?.stop();
    if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
  });

  const dispatch = async (mode, cwd) => {
    fs.writeFileSync(modeFile, mode);
    const { json } = await service.call('POST', '/seat/start', { role: 'coder', task: 'TASK', cwd });
    return service.waitSeat(json.seat);
  };

  it('a failed closing question leaves the stored backlog alone', async () => {
    const cwd = tempDir('ssa-work-');
    const first = await dispatch('', cwd);
    assert.equal(first.seat.state, 'done', service.log());
    assert.match(first.seat.backlog, /还没读 docs\//);

    const second = await dispatch('closing-fail', cwd);
    assert.equal(second.seat.id, first.seat.id, 'same directory, same expert');
    assert.equal(second.seat.state, 'done', 'the task itself succeeded');
    assert.match(second.seat.backlog, /还没读 docs\//, 'the backlog survives a closing question that failed');
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('keeps every character of a huge answer that the pipe delivers in chunks cut through multi-byte characters', async () => {
    const cwd = tempDir('ssa-work-');
    const shown = await dispatch('closing-big', cwd);
    assert.equal(shown.seat.state, 'done', service.log());
    // 200000 characters in one JSON line: chunk boundaries at 64KB fall inside a 3-byte character.
    assert.equal(shown.seat.expertise, '专长'.repeat(100000));
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('[O-6] a backend that failed after tool activity is not replaced by the next one, and the result lists what it changed', async () => {
    const cwd = tempDir('ssa-work-');
    const shown = await dispatch('main-fail-after-tools', cwd);
    assert.equal(shown.seat.state, 'failed');
    const said = shown.events.filter((e) => e.kind === 'stderr' || e.kind === 'difficulty').map((e) => e.body).join('\n');
    assert.match(said, /codex failed after starting work/);
    assert.match(said, /Work already started/, 'says how far it got');
    assert.match(said, /not retried on another backend/);
    assert.match(said, /Files changed by this run/, 'the changed files are listed (none here)');
    assert.equal(shown.events.some((e) => e.kind === 'takeover'), false, 'only a refusal is taken over');
    assert.equal(readLines(piCalls).length, 0, 'the DeepSeek fallback did not run');
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('a backend that failed before doing anything hands the task to the next one', async () => {
    const cwd = tempDir('ssa-work-');
    const shown = await dispatch('main-fail-early', cwd);
    assert.equal(shown.seat.state, 'done', service.log());
    assert.ok(shown.events.some((e) => e.kind === 'stdout' && e.body.includes('running on deepseek/')), 'the fallback is announced');
    assert.ok(shown.events.some((e) => e.kind === 'stdout' && e.body.includes('PI-ANSWER')));
    assert.ok(readLines(piCalls).length >= 1, 'the fallback ran');
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('a Codex run whose sandbox started no command counts as not started, though it exited 0', async () => {
    const cwd = tempDir('ssa-work-');
    const before = readLines(piCalls).length;
    const shown = await dispatch('sandbox-unstarted', cwd);
    assert.equal(shown.seat.state, 'done', service.log());
    const said = shown.events.filter((e) => e.kind === 'stdout').map((e) => e.body).join('\n');
    assert.match(said, /sandbox startup failed; none of 2 commands executed/);
    assert.ok(said.includes('PI-ANSWER'), 'the next backend did the task');
    assert.ok(readLines(piCalls).length > before, 'the fallback ran');
    fs.rmSync(cwd, { recursive: true, force: true });
  });
});

// O-6 (2026-10-24): a Claude seat whose model's safety filter stops it after it has used tools. The fake
// Claude (tests/fakes/fake-claude.mjs) writes half.js cut off inside a function and a line into notes.txt,
// then reports model_refusal_no_fallback; Claude is the wall's pick, so the chain is Claude, Codex, ...
describe('a Claude seat that the safety filter stops halfway', () => {
  let service;
  let scratch;
  let claudeMode;
  let codexMode;
  let claudeCalls;
  const dirs = [];

  before(async () => {
    scratch = tempDir('ssa-refuse-');
    claudeMode = path.join(scratch, 'claude-mode.json');
    codexMode = path.join(scratch, 'codex-mode');
    claudeCalls = path.join(scratch, 'claude-calls.jsonl');
    service = await startService({
      env: { SPECIALIST_CLAUDE_BIN: FAKE_CLAUDE, FAKE_CLAUDE_MODE_FILE: claudeMode, FAKE_CLAUDE_CALLS: claudeCalls, FAKE_CODEX_MODE_FILE: codexMode },
      prepare: (root) => {
        fs.mkdirSync(path.join(root, '.data'), { recursive: true });
        fs.writeFileSync(path.join(root, '.data', 'backend-prefer.json'), JSON.stringify({ mode: 'claude', max: false }));
      },
    });
  });
  after(async () => {
    await service?.stop();
    for (const dir of [scratch, ...dirs]) if (dir) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  const git = (dir, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.test', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
  // A repository with notes.txt committed, and an expert that has run there once on Claude and was told
  // a fact only its session holds.
  const expertRepo = async () => {
    const dir = tempDir('ssa-refuse-work-');
    dirs.push(dir);
    fs.writeFileSync(path.join(dir, 'notes.txt'), '第一行\n');
    git(dir, 'init', '-q');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'init');
    const first = await dispatch({}, '', dir, '事实：kestrel=7\n问：kestrel');
    assert.equal(first.shown.seat.state, 'done', service.log());
    assert.match(first.report, /kestrel=7/);
    return { dir, first };
  };
  const dispatch = async (claude, codex, cwd, task) => {
    fs.writeFileSync(claudeMode, JSON.stringify(claude));
    fs.writeFileSync(codexMode, codex);
    const marks = { claude: readLines(claudeCalls).length, codex: readLines(service.env.FAKE_CODEX_CALLS).length };
    const { json } = await service.call('POST', '/seat/start', { role: 'coder', task, cwd });
    const shown = await service.waitSeat(json.seat);
    const run = (await service.call('GET', `/run?seat=${json.seat}&run=${json.run}`)).json?.run;
    return {
      reply: json,
      shown,
      report: run?.report?.text ?? '',
      said: (kinds) => shown.events.filter((e) => e.seq > json.run && kinds.includes(e.kind)).map((e) => e.body).join('\n'),
      claude: readLines(claudeCalls).slice(marks.claude).filter((c) => !c.closing),
      codex: readLines(service.env.FAKE_CODEX_CALLS).slice(marks.codex).filter((c) => !c.closing),
    };
  };
  // The difficulty rows of one seat's run (2026-10-25: each refusal is a row of kind 'refused').
  const rowsOf = (seat, run) => {
    const db = new DatabaseSync(path.join(service.root, '.data', 'ledger.sqlite3'), { readOnly: true });
    try {
      return db.prepare('SELECT kind, tool, detail FROM difficulties WHERE seat = ? AND run = ? ORDER BY seq').all(seat, `${seat}#${run}`);
    } finally {
      db.close();
    }
  };

  it('[O-6] lists what it changed and has a Codex session without the seat\'s history finish the task', async () => {
    const { dir, first } = await expertRepo();
    const second = await dispatch({ main: 'refuse-after-tools' }, '', dir, 'TASK-TWO 把 half.js 写完');
    assert.equal(second.shown.seat.state, 'done', service.log());
    assert.equal(second.reply.seat, first.reply.seat, 'the same expert');
    // (a) the changed files, relative to the working directory, with the lines they gained.
    assert.match(second.report, /Files already changed when stopped/);
    assert.match(second.report, /- half\.js \(\+2 -0\)/);
    assert.match(second.report, /- notes\.txt \(\+1 -0\)/);
    // (b) its result is the takeover's, and the events say a refusal and a takeover happened.
    assert.match(second.report, /FAKE-CODEX-ANSWER/);
    const takeover = second.said(['takeover']);
    assert.match(takeover, /Blocked mid-run \(claude failed after starting work \(Stopped by the backend model.+safety filter: model_refusal_no_fallback/);
    assert.match(takeover, /completed by a fresh openai-codex.* session/);
    assert.match(second.said(['stdout']), /\(Stopped: /);
    // One Codex session, fresh, handed the original brief, the list and how to go on, and nothing of the seat's history.
    assert.equal(second.codex.length, 1, 'taken over once');
    const [handed] = second.codex;
    assert.equal(handed.args.includes('resume'), false, 'a new session');
    assert.match(handed.prompt, /从现场接着做/);
    assert.match(handed.prompt, /TASK-TWO 把 half\.js 写完/);
    assert.match(handed.prompt, /half\.js \(\+2 -0\)/);
    assert.match(handed.prompt, /不要重做已经完成的部分/);
    assert.doesNotMatch(handed.prompt, /kestrel/, 'the expert\'s session is not in it');
    assert.doesNotMatch(handed.prompt, /你的原始记录/, 'nor the records note the service put in front of the task');
    // The refusal is a difficulty of its own kind even though the task got done, and the report shows the task.
    const rows = rowsOf(second.reply.seat, second.reply.run).filter((r) => r.kind === 'refused' || r.kind === 'failed');
    assert.deepEqual(rows.map((r) => [r.kind, r.tool]), [['refused', 'claude']]);
    assert.match(rows[0].detail, /blocked halfway; handed off to fresh session: .*model_refusal_no_fallback.*; run completed/);
    const report = (await service.call('GET', '/difficulties')).json.text;
    assert.match(report, /\[coder\|refused\|claude\] coder · blocked by model safety filter/);
    assert.match(report, /Task snippet \(first 300 chars\): .*TASK-TWO 把 half\.js 写完/);
    // The expert keeps its own session: the next run resumes the Claude session, not the takeover's.
    assert.equal(second.shown.seat.session_file, first.shown.seat.session_file);
    const third = await dispatch({}, '', dir, '问：kestrel');
    assert.match(third.report, /kestrel=7/, 'the expert still knows what its session holds');
    assert.equal(third.claude[0]?.resumed, true);
    assert.match(third.claude[0].prompt, /half\.js/, 'and is told the directory changed under it (C-2)');
  });

  it('[O-6] when Codex cannot start, a new Claude session without the history takes over', async () => {
    const { dir } = await expertRepo();
    const second = await dispatch({ main: 'refuse-after-tools' }, 'main-fail-early', dir, 'TASK-THREE');
    assert.equal(second.shown.seat.state, 'done', service.log());
    assert.match(second.said(['stdout']), /trying the next takeover backend/);
    assert.match(second.report, /A fresh claude session without this seat.+history continued from disk and completed the task/);
    const takeovers = second.claude.filter((c) => c.takeover);
    assert.equal(takeovers.length, 1);
    assert.equal(takeovers[0].resumed, false, 'a new Claude session, not the refused one');
    assert.doesNotMatch(takeovers[0].prompt, /kestrel/);
  });

  it('[O-6] a takeover that fails after using tools stops the run, with the list, and is not tried again', async () => {
    const { dir } = await expertRepo();
    const second = await dispatch({ main: 'refuse-after-tools' }, 'main-fail-after-tools', dir, 'TASK-FOUR');
    assert.equal(second.shown.seat.state, 'failed');
    const said = second.said(['stderr']);
    assert.match(said, /attempted the single allowed takeover and also failed: codex failed after starting work/);
    assert.match(said, /single allowed takeover/);
    assert.match(said, /- half\.js \(\+2 -0\)/);
    assert.equal(second.claude.filter((c) => c.takeover).length, 0, 'no second takeover');
    assert.match(second.said(['takeover']), /takeover failed:/);
  });

  it('[O-6] a takeover the filter stops again stops the run and reports the list', async () => {
    const { dir } = await expertRepo();
    const second = await dispatch({ main: 'refuse-after-tools', takeover: 'refuse-after-tools' }, 'main-fail-early', dir, 'TASK-FIVE');
    assert.equal(second.shown.seat.state, 'failed');
    const said = second.said(['stderr']);
    assert.match(said, /fresh claude session without this seat.+history attempted the single allowed takeover and also failed: claude failed after starting work \(Stopped by the backend model/);
    assert.match(said, /- half\.js/);
    assert.match(said, /- notes\.txt/);
    assert.equal(second.claude.filter((c) => c.takeover).length, 1, 'taken over exactly once');
    // Two stops, the seat's and the takeover's, and no plain run failure counting the same thing again.
    const rows = rowsOf(second.reply.seat, second.reply.run).filter((r) => r.kind === 'refused' || r.kind === 'failed');
    assert.deepEqual(rows.map((r) => r.kind), ['refused', 'refused']);
    assert.match(rows[1].detail, /; run incomplete$/);
  });

  it('[O-6] a refusal before any tool call still hands the task to the next backend, with the seat\'s history loaded', async () => {
    const { dir } = await expertRepo();
    const second = await dispatch({ main: 'refuse-early' }, '', dir, 'TASK-SIX');
    assert.equal(second.shown.seat.state, 'done', service.log());
    const out = second.said(['stdout']);
    assert.match(out, /claude did not start \(Stopped by the backend model.+safety filter: model_refusal_no_fallback/);
    assert.match(out, /switching to codex/);
    assert.doesNotMatch(out, /\(Stopped: /);
    assert.equal(second.said(['takeover']), '');
    assert.equal(second.codex.length, 1);
    assert.match(second.codex[0].prompt, /kestrel=7/, 'C-1: the next backend is handed the session as text');
    // Stopped before any tool call: until 2026-10-25 this left no trace at all.
    const rows = rowsOf(second.reply.seat, second.reply.run).filter((r) => r.kind === 'refused' || r.kind === 'failed');
    assert.deepEqual(rows.map((r) => [r.kind, r.tool]), [['refused', 'claude']]);
    assert.match(rows[0].detail, /blocked before tools; switched to next backend: .*; run completed/);
  });
});
});
