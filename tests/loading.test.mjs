import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { afterEach, describe, it, after, before } from 'node:test';
import { HANDOFF_BUDGET, handoffNote, sessionText } from '../src/cli-runner.mjs';
import { FAKE_CODEX_BRAIN, FAKE_PI_CLI, copyService, sleep, startService, tempDir } from './lib/sandbox.mjs';

await describe('loading', { concurrency: false }, async () => {
// [C-1] A session that cannot be continued is loaded as text. Two layers: sessionText on each log format
// (a unit test of the reading), then the whole service on the brain fakes, switching the backend between
// two runs of the same expert and checking that the second answers from the first's conversation, as text
// in its prompt and not as a path it has to go and read.








const rm = (dir) => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
const readLog = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []);

async function until(check, what, timeoutMs = 20000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

describe('sessionText', () => {
  const dirs = [];
  afterEach(() => {
    while (dirs.length) rm(dirs.pop());
  });
  const logOf = (lines) => {
    const dir = tempDir('ssa-load-');
    dirs.push(dir);
    const file = path.join(dir, 'session.jsonl');
    fs.writeFileSync(file, `${lines.map((line) => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n')}\n`);
    return file;
  };

  it('[C-1] reads the fake format: { role, text } with user, assistant and tool lines', () => {
    const file = logOf([
      '{}',
      { role: 'user', text: '读文件：f1.txt' },
      { role: 'tool', text: '事实：zeta=6' },
      { role: 'assistant', text: '好的。' },
      { prompt: 'a line of another shape' },
      'not json at all',
    ]);
    assert.equal(sessionText(file, 'codex'), '【用户】读文件：f1.txt\n\n【工具结果】事实：zeta=6\n\n【助手】好的。');
  });

  it('[C-1] reads a Codex rollout: messages and tool outputs, not the event_msg copies or the metadata', () => {
    const file = logOf([
      { timestamp: 't', type: 'session_meta', payload: { id: 'x', cwd: '/w', instructions: 'SHOULD NOT APPEAR' } },
      { type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'SHOULD NOT APPEAR (developer)' }] } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '把 zeta 记下来' }] } },
      { type: 'event_msg', payload: { type: 'user_message', message: '把 zeta 记下来' } },
      { type: 'response_item', payload: { type: 'reasoning', summary: [{ type: 'summary_text', text: 'SHOULD NOT APPEAR (thinking)' }] } },
      { type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: '{"command":["cat","f1.txt"]}', call_id: 'c1' } },
      { type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: '事实：zeta=6' } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '记下了。' }] } },
      { type: 'event_msg', payload: { type: 'agent_message', message: '记下了。' } },
      { type: 'turn_context', payload: { model: 'm' } },
    ]);
    const text = sessionText(file, 'codex');
    assert.equal(text, '【用户】把 zeta 记下来\n\n【工具结果】事实：zeta=6\n\n【助手】记下了。');
    assert.doesNotMatch(text, /SHOULD NOT APPEAR/);
  });

  it('[C-1] reads a Claude Code log: text, text parts, and the tool_result inside a user message', () => {
    const file = logOf([
      { type: 'summary', summary: 'a title line' },
      { type: 'user', message: { role: 'user', content: '读一下 f1.txt' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'SHOULD NOT APPEAR' }, { type: 'text', text: '我来读。' }, { type: 'tool_use', id: 'u1', name: 'Read', input: { file_path: 'f1.txt' } }] } },
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'u1', content: '事实：zeta=6' }] } },
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'u2', content: [{ type: 'text', text: '第二个结果' }] }] } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'zeta 是 6。' }] } },
    ]);
    const text = sessionText(file, 'claude');
    assert.equal(text, '【用户】读一下 f1.txt\n\n【助手】我来读。\n\n【工具结果】事实：zeta=6\n\n【工具结果】第二个结果\n\n【助手】zeta 是 6。');
  });

  it('[C-1] reads a pi log: message entries by role, tool results, and a compaction summary', () => {
    const file = logOf([
      { type: 'session', version: 3, id: 'x', cwd: '/w' },
      { type: 'compaction', summary: '早先聊过 alpha=1', firstKeptEntryId: 'e1', tokensBefore: 9 },
      { type: 'message', message: { role: 'user', content: [{ type: 'text', text: '读 f1.txt' }] } },
      { type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: 't', name: 'read', arguments: {} }] } },
      { type: 'message', message: { role: 'toolResult', toolCallId: 't', content: [{ type: 'text', text: '事实：zeta=6' }] } },
      { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: '读过了。' }] } },
    ]);
    assert.equal(sessionText(file, 'pi'), '【压缩摘要】早先聊过 alpha=1\n\n【用户】读 f1.txt\n\n【工具结果】事实：zeta=6\n\n【助手】读过了。');
  });

  it('[C-1] gives nothing for a log it cannot read, and for a file that is not there', () => {
    assert.equal(sessionText(logOf([{ weird: true }, 'x']), 'grok'), '');
    assert.equal(sessionText(path.join(tempDir('ssa-load-'), 'gone.jsonl'), 'codex'), '');
  });

  it('[C-1] over the budget keeps the newest turns that fit and says how much was left out and where the file is', () => {
    const turns = Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: `第${i}轮：${'字'.repeat(4000)}` }));
    const file = logOf(turns);
    const text = sessionText(file, 'codex');
    const body = text.slice(text.indexOf('\n\n') + 2);
    assert.ok(body.length <= HANDOFF_BUDGET, `the turns are ${body.length} characters, over ${HANDOFF_BUDGET}`);
    assert.ok(body.length > HANDOFF_BUDGET - 4100, 'it keeps as many as fit');
    assert.match(body, /第29轮/, 'the newest turn is there');
    assert.doesNotMatch(body, /第0轮/, 'the oldest is not');
    // The kept ones are a run of the newest, in order, none skipped.
    const kept = [...body.matchAll(/第(\d+)轮/g)].map((m) => Number(m[1]));
    assert.deepEqual(kept, Array.from({ length: kept.length }, (_, i) => 30 - kept.length + i));
    const total = turns.reduce((sum, turn) => sum + `【用户】${turn.text}`.length, 0) + 2 * 29;
    const left = Number(text.match(/更早的 (\d+) 个字/)[1]);
    assert.ok(left > 0 && left <= total, 'it says how many characters are not there');
    assert.ok(text.includes(file), 'it names the file with the whole of it');
    assert.doesNotMatch(text, /交接文档在/, 'no hand-off document was given');
    assert.match(sessionText(file, 'codex', { handoffFile: '/h/doc.md' }), /交接文档在 \/h\/doc\.md/);
  });

  it('[C-1] a single turn longer than the budget is kept by its end', () => {
    const file = logOf([{ role: 'user', text: 'a'.repeat(100) }, { role: 'assistant', text: `${'x'.repeat(HANDOFF_BUDGET + 500)}END` }]);
    const text = sessionText(file, 'codex');
    assert.ok(text.endsWith('xEND'));
    assert.ok(text.length < HANDOFF_BUDGET + 400, 'it is cut');
  });
});

describe('handoffNote', () => {
  it('[C-1] carries the previous conversation as text with its path, then the expertise note', () => {
    const dir = tempDir('ssa-load-');
    try {
      const file = path.join(dir, 'rollout.jsonl');
      fs.writeFileSync(file, `${JSON.stringify({ role: 'user', text: '问：zeta' })}\n${JSON.stringify({ role: 'assistant', text: '答：zeta=6' })}\n`);
      const note = handoffNote(file, '会读 f1.txt', 'codex');
      assert.match(note, /^（服务消息）你是这个对象的常驻专家；上一段会话是用另一个模型跑的，接不上，这是一个新会话。/);
      assert.ok(note.includes(`（原文在 ${file}），就当是你自己读过、说过的：\n\n【用户】问：zeta\n\n【助手】答：zeta=6`));
      assert.ok(note.endsWith('你上次留下的专长说明：\n会读 f1.txt'));
    } finally {
      rm(dir);
    }
  });

  it('[C-1] without a previous file it keeps the old wording and names no path', () => {
    assert.equal(handoffNote(null, '', null), '');
    const note = handoffNote(null, '会读 f1.txt', null);
    assert.match(note, /上一段会话没有沿用/);
    assert.match(note, /会读 f1.txt/);
    assert.doesNotMatch(note, /完整记录在|原文在/);
  });

  it('[C-1] a log it cannot read falls back to the path to read it by', () => {
    const dir = tempDir('ssa-load-');
    try {
      const file = path.join(dir, 'odd.jsonl');
      fs.writeFileSync(file, '{"weird":true}\n');
      assert.match(handoffNote(file, '', 'grok'), new RegExp(`上一段会话的完整记录在 ${file.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}`));
    } finally {
      rm(dir);
    }
  });
});

describe('loading through the real service', () => {
  const services = [];
  const dirs = [];
  afterEach(async () => {
    while (services.length) await services.pop().stop();
    while (dirs.length) rm(dirs.pop());
  });

  async function open() {
    const scratch = tempDir('ssa-load-it-');
    dirs.push(scratch);
    const work = path.join(scratch, 'work');
    fs.mkdirSync(work);
    fs.writeFileSync(path.join(work, 'f1.txt'), '事实：zeta=6\n');
    fs.writeFileSync(path.join(scratch, 'world.json'), JSON.stringify({ zeta: 'WEB-zeta' }));
    const log = path.join(scratch, 'brain.jsonl');
    const service = await startService({
      env: {
        SPECIALIST_CODEX_JS: FAKE_CODEX_BRAIN,
        SPECIALIST_SUBAGENTS_RUNTIME: FAKE_PI_CLI,
        FAKE_PI_BRAIN: '1',
        FAKE_WORLD: path.join(scratch, 'world.json'),
        FAKE_BRAIN_LOG: log,
      },
    });
    services.push(service);
    const backend = async (mode) => {
      const got = await service.call('POST', '/backend', { mode, max: false });
      assert.equal(got.status, 200, got.text);
    };
    // One run of the coder in `work`, to its end. `runs` is how many runs of the seat have ended by then.
    const runToEnd = async (task, runs) => {
      const before = readLog(log).length;
      const started = await service.call('POST', '/seat/start', { role: 'coder', task, cwd: work });
      assert.equal(started.status, 200, started.text);
      const seat = started.json.seat;
      const view = await until(async () => {
        const { json } = await service.call('GET', `/seats/${seat}?tail=all`);
        return json.events.filter((ev) => ev.kind === 'exit').length === runs && json.seat.state !== 'running' ? json : null;
      }, `run ${runs} of ${seat} to end\n${service.log()}`);
      const report = await service.call('GET', `/run?seat=${seat}`);
      const brain = readLog(log).slice(before).filter((line) => line.phase === 'answer' && line.kind === 'task');
      // The stdout lines of this run only: the events after the previous run's exit.
      const exits = view.events.filter((ev) => ev.kind === 'exit');
      const from = runs > 1 ? view.events.indexOf(exits[runs - 2]) : -1;
      const stdout = view.events.slice(from + 1).filter((ev) => ev.kind === 'stdout').map((ev) => String(ev.text ?? ev.body ?? ev.detail ?? '')).join('\n');
      return { seat, report: JSON.stringify(report.json), brain, stdout };
    };
    return { work, service, backend, runToEnd };
  }

  // Run 1 on one backend, then the other backend for run 2, which asks for what run 1 read.
  async function switchOver(first, second) {
    const { backend, runToEnd } = await open();
    await backend(first.mode);
    const one = await runToEnd('读文件：f1.txt', 1);
    assert.equal(one.brain.length, 1);
    assert.equal(one.brain[0].backend, first.brain);
    assert.match(one.stdout, /\(Loading mode: fresh\)/, 'the first run starts with nothing');
    await backend(second.mode);
    const two = await runToEnd('问：zeta', 2);
    assert.equal(two.seat, one.seat, 'the same expert came back');
    assert.equal(two.brain.length, 1, 'one task call in the second run');
    const [entry] = two.brain;
    assert.equal(entry.backend, second.brain);
    assert.equal(entry.resumed, false, 'the second backend could not continue the first one\'s session');
    assert.ok(entry.prompt.includes('事实：zeta=6'), 'the first run\'s conversation is in the prompt as text');
    assert.ok(entry.prompt.includes('【用户】') && entry.prompt.includes('【工具结果】'), 'as a transcript');
    assert.equal(entry.tools.some((tool) => tool.tool === 'read'), false, 'it read no record file: the text was already there');
    assert.equal(entry.tools.some((tool) => tool.tool === 'bash'), false, 'it did not go to the web');
    assert.match(two.report, /zeta=6/);
    assert.doesNotMatch(two.report, /WEB-zeta/);
    assert.match(two.stdout, /\(Loading mode: loaded\)/);
    return { backend, runToEnd, two };
  }

  it('[C-1] Codex first, then DeepSeek: the second run answers from the first one\'s conversation, loaded as text', async () => {
    await switchOver({ mode: 'codex', brain: 'codex' }, { mode: 'deepseek', brain: 'pi' });
  });

  it('[C-1] DeepSeek first, then Codex: the same in the other direction, and a third run on Codex resumes', async () => {
    const { backend, runToEnd } = await switchOver({ mode: 'deepseek', brain: 'pi' }, { mode: 'codex', brain: 'codex' });
    // Back on the backend whose session the seat now holds: continued, not loaded again.
    await backend('codex');
    const three = await runToEnd('问：zeta', 3);
    assert.equal(three.brain.length, 1);
    assert.equal(three.brain[0].resumed, true);
    assert.match(three.stdout, /\(Loading mode: resumed\)/);
  });
});

describe('the result file says how the session was loaded', () => {
  const roots = [];
  afterEach(() => {
    while (roots.length) rm(roots.pop());
  });

  let root;
  let work;
  const setup = () => {
    root = tempDir('ssa-load-rr-');
    roots.push(root);
    copyService(root);
    work = path.join(root, 'work');
    fs.mkdirSync(work);
    fs.writeFileSync(path.join(work, 'f1.txt'), '事实：zeta=6\n');
    fs.mkdirSync(path.join(root, '.data'), { recursive: true });
  };
  // cli-runner as the daemon runs it, in a copy of the service so the backend choice is the test's own.
  const run = async ({ mode, sessionFile = '', expertise = '', task = '读文件：f1.txt', handoffFile = '', fresh = false }) => {
    fs.writeFileSync(path.join(root, '.data', 'backend-prefer.json'), JSON.stringify({ mode, max: false }));
    const resultFile = path.join(root, `result-${Math.random().toString(36).slice(2)}.json`);
    const env = {
      ...process.env,
      CODEX_HOME: path.join(root, 'home', '.codex'),
      SPECIALIST_CODEX_JS: FAKE_CODEX_BRAIN,
      FAKE_CODEX_CALLS: path.join(root, 'codex-calls.jsonl'),
      FAKE_PI_BRAIN: '1',
      FAKE_WORLD: path.join(root, 'world.json'),
      SPECIALIST_SEAT_RESULT: resultFile,
      SPECIALIST_SEAT_SESSION_DIR: path.join(root, 'sessions'),
      SPECIALIST_SEAT_SESSION_FILE: sessionFile,
      SPECIALIST_SEAT_EXPERTISE: expertise,
      SPECIALIST_SEAT_HANDOFF_FILE: handoffFile,
      SPECIALIST_SEAT_FRESH: fresh ? '1' : '',
    };
    fs.writeFileSync(path.join(root, 'world.json'), '{}');
    const child = spawn(process.execPath, [path.join(root, 'src', 'cli-runner.mjs'), '--pi', FAKE_PI_CLI, '--role', 'coder', '--tools', 'read,grep,find,ls,bash,edit,write', '-p', task], { cwd: work, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { out += chunk; });
    const code = await new Promise((resolve) => child.on('close', resolve));
    assert.equal(code, 0, out);
    return { ...JSON.parse(fs.readFileSync(resultFile, 'utf8')), stdout: out };
  };

  it('[C-1] Codex: fresh, then resumed from its own rollout, then loaded from a log another backend wrote', async () => {
    setup();
    const one = await run({ mode: 'codex' });
    assert.equal(one.load, 'fresh');
    assert.match(one.stdout, /\(Loading mode: fresh\)/);
    const two = await run({ mode: 'codex', sessionFile: one.sessionFile, task: '问：zeta' });
    assert.equal(two.load, 'resumed');
    assert.match(two.report, /zeta=6/);
    const piLog = path.join(root, 'sessions', 'other_pi.jsonl');
    fs.mkdirSync(path.dirname(piLog), { recursive: true });
    fs.writeFileSync(piLog, `${JSON.stringify({ role: 'user', text: '读文件：f1.txt' })}\n${JSON.stringify({ role: 'tool', text: '事实：zeta=6' })}\n`);
    const three = await run({ mode: 'codex', sessionFile: piLog, task: '问：zeta' });
    assert.equal(three.load, 'loaded');
    assert.match(three.report, /zeta=6/);
    // An expertise note and no previous session is not "nothing": the fresh session was given something.
    assert.equal((await run({ mode: 'codex', expertise: '会读文件' })).load, 'loaded');
  });

  it('[C-7] a fresh fork neither resumes nor loads the session it is given, on Codex or DeepSeek, and is told why', async () => {
    setup();
    const one = await run({ mode: 'codex' });
    const calls = path.join(root, 'codex-calls.jsonl');
    const before = fs.readFileSync(calls, 'utf8').split('\n').filter(Boolean).length;
    const codex = await run({ mode: 'codex', sessionFile: one.sessionFile, expertise: '会读文件', task: '问：zeta', fresh: true });
    assert.equal(codex.load, 'fresh');
    assert.doesNotMatch(codex.report, /zeta=6/, 'it does not know what the expert read');
    assert.notEqual(codex.sessionFile, one.sessionFile, 'a new session');
    const [handed] = fs.readFileSync(calls, 'utf8').split('\n').filter(Boolean).slice(before).map((line) => JSON.parse(line));
    assert.equal(handed.args.includes('resume'), false);
    assert.match(handed.prompt, /不带历史的新实例/);
    assert.doesNotMatch(handed.prompt, /会读文件/, 'no expertise note');
    const pi = await run({ mode: 'deepseek', sessionFile: one.sessionFile, task: '问：zeta', fresh: true });
    assert.equal(pi.load, 'fresh');
    assert.doesNotMatch(pi.report, /zeta=6/);
  });

  it('[C-1] DeepSeek: fresh, then resumed from its own session file, then loaded from a Codex rollout', async () => {
    setup();
    const one = await run({ mode: 'deepseek' });
    assert.equal(one.load, 'fresh');
    const two = await run({ mode: 'deepseek', sessionFile: one.sessionFile, task: '问：zeta' });
    assert.equal(two.load, 'resumed');
    const codex = await run({ mode: 'codex' });
    const three = await run({ mode: 'deepseek', sessionFile: codex.sessionFile, task: '问：zeta' });
    assert.equal(three.load, 'loaded');
    assert.match(three.report, /zeta=6/);
    assert.match(three.stdout, /\(Loading mode: loaded\)/);
  });

  it('[C-1] a text that had to be cut names the hand-off document when the service gave one', async () => {
    setup();
    const log = path.join(root, 'sessions', 'long_pi.jsonl');
    fs.mkdirSync(path.dirname(log), { recursive: true });
    const lines = Array.from({ length: 20 }, (_, i) => JSON.stringify({ role: i % 2 ? 'assistant' : 'user', text: `第${i}轮：${'字'.repeat(5000)}` }));
    fs.writeFileSync(log, `${lines.join('\n')}\n`);
    const doc = path.join(root, 'handoff.md');
    const got = await run({ mode: 'codex', sessionFile: log, task: '问：nothing', handoffFile: doc });
    assert.equal(got.load, 'loaded');
    const [call] = readLog(path.join(root, 'codex-calls.jsonl'));
    assert.match(call.prompt, /更早的 \d+ 个字没有放进来/);
    assert.ok(call.prompt.includes(`完整原文在 ${log}，交接文档在 ${doc}`), 'the prompt says where the whole log and the hand-off document are');
    assert.match(call.prompt, /第19轮/);
    assert.doesNotMatch(call.prompt, /第0轮/);
    // No document given: the file alone.
    await run({ mode: 'codex', sessionFile: log, task: '问：nothing' });
    const calls = readLog(path.join(root, 'codex-calls.jsonl'));
    assert.doesNotMatch(calls.at(-1).prompt, /交接文档在/);
  });
});
});

await describe('continuity', { concurrency: false }, async () => {
// Phase 3, continuity (PRD 4.2): a returning expert always continues its session however far the
// directory moved (C-2), and every run is told where the expert's raw records are (C-5).
//
// coder runs the real cli-runner against the fake Codex, which writes every prompt it is given to
// $FAKE_CODEX_CALLS, so what the runtime was really handed can be read back.







async function until(check, what, timeoutMs = 30000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

function world() {
  const ctx = {};
  before(async () => {
    ctx.service = await startService();
    ctx.scratch = tempDir('ssa-cont-');
  });
  after(async () => {
    await ctx.service?.stop();
    if (ctx.scratch) fs.rmSync(ctx.scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });
  // Dispatch a coder task and wait until that run has ended.
  ctx.run = async (cwd, task, extra = {}) => {
    const got = await ctx.service.call('POST', '/seat/start', { role: 'coder', cwd, task, ...extra });
    assert.equal(got.status, 200, got.text);
    const seat = got.json.seat;
    const ended = await until(async () => {
      const { json } = await ctx.service.call('GET', `/seats/${seat}?tail=all`);
      return json.events.filter((e) => e.kind === 'exit').length >= json.events.filter((e) => e.kind === 'task').length ? json : null;
    }, `the run of ${seat} to end`);
    return { ...got.json, shown: ended };
  };
  // The prompts the fake Codex was handed for tasks (not for the closing question), oldest first.
  ctx.prompts = () => fs.readFileSync(ctx.service.env.FAKE_CODEX_CALLS, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((c) => !c.closing).map((c) => c.prompt);
  return ctx;
}

describe('[C-2] a directory that moved a lot does not cost the expert its session', () => {
  const w = world();

  it('30 changed files and 600 lines later the expert continues the same session, and the change note comes with the task', async () => {
    const repo = path.join(w.scratch, 'repo');
    fs.mkdirSync(repo);
    const git = (...args) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { stdio: 'ignore', windowsHide: true });
    git('init', '-q');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'first');

    const first = await w.run(repo, 'FIRST-TASK');
    for (let i = 1; i <= 30; i += 1) fs.writeFileSync(path.join(repo, `m${String(i).padStart(2, '0')}.txt`), `${Array.from({ length: 20 }, (_, n) => `line ${i}-${n}`).join('\n')}\n`);
    git('add', '-A');
    git('commit', '-q', '-m', 'thirty files');

    const second = await w.run(repo, 'SECOND-TASK');
    assert.equal(second.seat, first.seat, 'the same expert');
    const sessions = second.shown.events.filter((e) => e.kind === 'session').map((e) => e.body);
    assert.ok(sessions.some((body) => /Continuing prior session; directory changes attached/.test(body)), `the session was continued: ${sessions.join(' | ')}`);
    assert.ok(!sessions.slice(1).some((body) => /fresh session/i.test(body)), 'and not restarted');

    const prompt = w.prompts().at(-1);
    assert.match(prompt, /SECOND-TASK/);
    assert.doesNotMatch(prompt, /换了一个新会话/);
    // The change note stands in front of the task (after the service's records note, C-5, which is first).
    const noteAt = prompt.indexOf('目录有变化（30 个文件');
    assert.ok(noteAt >= 0, `the note names the 30 files: ${prompt.slice(0, 400)}`);
    assert.ok(noteAt < prompt.indexOf('SECOND-TASK'), 'before the task');
    assert.ok(prompt.indexOf('服务提示：你的原始记录') < noteAt, 'after the records note');
    assert.match(prompt, /m01\.txt/);
    assert.match(prompt, /接着的是原来的会话/);
    // The codex call really was a resume of the first thread.
    const calls = fs.readFileSync(w.service.env.FAKE_CODEX_CALLS, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((c) => !c.closing);
    assert.ok(calls.at(-1).args.includes('resume'), 'codex exec resume');
  });
});

describe('[C-5] the expert is told where its records are', () => {
  const w = world();

  it('from the second run on, the task starts with the list of session logs and reports, and every listed file exists', async () => {
    const dir = path.join(w.scratch, 'proj');
    fs.mkdirSync(dir);
    await w.run(dir, 'ONE');
    await w.run(dir, 'TWO');
    const third = await w.run(dir, 'THREE');
    const prompts = w.prompts();
    assert.equal(prompts.length, 3);
    assert.doesNotMatch(prompts[0], /你的原始记录/, 'a first visit has nothing to list');

    const prompt = prompts[2];
    assert.ok(prompt.startsWith('服务提示：你的原始记录（需要时自己读或 grep；原文都在磁盘上）：\n'), prompt.slice(0, 200));
    assert.ok(prompt.indexOf('你的原始记录') < prompt.indexOf('THREE'));
    const block = prompt.slice(0, prompt.indexOf('\n\n')).split('\n').slice(1);
    assert.ok(block.length >= 2, `session and report are listed: ${block.join(' / ')}`);
    assert.ok(block.some((line) => line.startsWith('- 会话记录：')));
    assert.ok(block.some((line) => line.startsWith('- 报告（原文）：')));
    for (const line of block) {
      assert.match(line, /记录|报告|交接/);
      const file = /：(.+?)（/.exec(line)?.[1] ?? /：(.+)$/.exec(line)[1];
      assert.ok(path.isAbsolute(file), `absolute: ${file}`);
      assert.ok(fs.existsSync(file), `exists: ${file}`);
    }
    assert.equal(third.shown.events.filter((e) => e.kind === 'task').length, 3);
  });

  it('a hand-off document under the expert\'s handoffs directory is listed too (newest listed)', async () => {
    const dir = path.join(w.scratch, 'proj2');
    fs.mkdirSync(dir);
    const first = await w.run(dir, 'ONE');
    const handoffs = path.join(w.service.root, '.data', 'handoffs', first.seat);
    fs.mkdirSync(handoffs, { recursive: true });
    fs.writeFileSync(path.join(handoffs, '2026-10-11T00-00-00.md'), '## 懂了什么\n');
    fs.writeFileSync(path.join(handoffs, '2026-10-11T00-00-01.md'), '## 懂了什么\n');
    await w.run(dir, 'TWO');
    const prompt = w.prompts().at(-1);
    assert.match(prompt, new RegExp(`- 交接文档：${handoffs.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\\\/]2026-10-11T00-00-01\\.md`));
  });
});
});
