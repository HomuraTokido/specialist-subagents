// What a role's contract asks it to do is not that role's difficulty (roles.json expected_traces,
// src/expected-traces.mjs). Four layers: the matcher and the startup gate's check on their own; the
// ledger's counting over rows already written (difficulty_report, the skill loop's batch); seat-runner
// (DeepSeek) against the fake pi SDK; and the whole service with the fake Codex CLI, where cli-runner
// and exec.mjs decide what is written. Each rule in roles.json is exercised, and so is a role without one.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import { FAKE_PI_CLI, REPO, isolatedEnv, startService, tempDir } from './lib/sandbox.mjs';
import { loadStore } from './lib/store.mjs';

const { checkExpectedTraces, commandMissing, expectedRule, MISSING_MARK, soleCommand } = await import(pathToFileURL(path.join(REPO, 'src', 'expected-traces.mjs')).href);
const ROLES = JSON.parse(fs.readFileSync(path.join(REPO, 'roles.json'), 'utf8'));
const rulesOf = (role) => ROLES[role].expected_traces;
// How Codex reports a command on this machine: every one goes through PowerShell.
const PWSH = '"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -NoProfile -Command';
const readLines = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []);

describe('the matcher on the rules in roles.json', () => {
  it('[S-1] web_researcher and explorer: an honest 查不到 / 推断 is not a difficulty; a role without the rule still has one', () => {
    const uncertain = { kind: 'uncertain', tool: null, detail: '最终回答里有"查不到"：…查不到的写查不到…' };
    assert.ok(expectedRule(rulesOf('web_researcher'), uncertain));
    assert.ok(expectedRule(rulesOf('explorer'), uncertain));
    for (const role of ['tester', 'coder', 'handyman', 'librarian', 'refiner']) assert.equal(expectedRule(rulesOf(role), uncertain), null, role);
    assert.equal(
      expectedRule(rulesOf('web_researcher'), { kind: 'error', tool: 'bash', command: 'node tools/web-search.mjs x', exit_code: 1 }),
      null,
      'the uncertain rule makes nothing else normal',
    );
  });

  it('[S-1] tester: a test command that ran and failed is normal; 126/127, signals, missing commands, timeouts and other commands are not', () => {
    const run = (command, exit_code, extra = {}) => expectedRule(rulesOf('tester'), { kind: 'error', tool: 'bash', command, exit_code, ...extra });
    for (const command of [`${PWSH} 'npm test'`, 'node --test tests/*.test.mjs', 'python -m pytest -q', 'npx vitest run', 'cargo test', 'go test ./...', 'pnpm run test']) {
      assert.ok(run(command, 1), command);
    }
    assert.ok(run('pytest -q', 5));
    assert.ok(run('npm test', 125));
    assert.equal(run('npm test', 126), null);
    assert.equal(run('npm test', 127), null);
    assert.equal(run('npm test', 137), null, 'killed by a signal');
    assert.equal(run('npm test', null), null, 'no exit code: a timeout or an abort');
    assert.equal(run(`${PWSH} 'pytest'`, 1, { missing: true }), null, 'PowerShell could not find the command');
    assert.equal(run('git log no-such-ref', 128), null);
    assert.equal(run('cat tests/a.test.mjs', 1), null, 'reading a test file is not running a test');
    assert.equal(expectedRule(rulesOf('tester'), { kind: 'empty', tool: 'bash', command: 'rg x', exit_code: 1 }), null, 'only failing tests are normal for it');
  });

  // 2026-10-01 review: each output below was read off this machine; all four exit 1.
  it('[S-1] tester: a test command that never got to run a test is not normal, nor is one chained after another command', () => {
    const run = (command, output) => expectedRule(rulesOf('tester'), { kind: 'error', tool: 'bash', command, exit_code: 1, missing: commandMissing(output) });
    assert.equal(run('npm test', 'npm error Missing script: "test"\nnpm error\nnpm error To see a list of scripts, run:'), null, 'no test script');
    assert.equal(run('node --test tests/nope.test.mjs', "Could not find 'tests/nope.test.mjs'"), null, 'no such test file');
    assert.equal(run('python -m pytest -q', 'C:\\Users\\x\\Python314\\python.exe: No module named pytest'), null, 'pytest not installed');
    assert.equal(run('npm ci && npm test', 'npm error code ENOENT\nnpm error syscall open\nnpm error path package-lock.json'), null, 'npm ci failed first');
    assert.equal(run('npm run build && npm test', 'not ok 1 - adds'), null, 'two statements: the exit code may be the build');
    assert.equal(run(`${PWSH} 'npm ci; npm test'`, 'not ok 1 - adds'), null, 'chained inside the PowerShell wrapper');
    assert.ok(run('npm test', 'not ok 1 - adds\n# fail 1'), 'the test ran and failed');
    assert.ok(run('npm test 2>&1 | tail -n 50', 'not ok 1 - adds'), 'a pipeline that bounds the output is still the test');
    assert.ok(run(`${PWSH} 'npm test 2>&1 | Select-Object -Last 50'`, 'not ok 1 - adds'));
  });

  it('[S-1] coder: a search that finds nothing is normal; any other failure is not', () => {
    const c = rulesOf('coder');
    assert.ok(expectedRule(c, { kind: 'empty', tool: 'grep', detail: '第 1 次调用 grep oldName 没有结果' }));
    assert.ok(expectedRule(c, { kind: 'empty', tool: 'find', detail: '第 2 次调用 find **/old*.mjs 没有结果' }));
    assert.ok(expectedRule(c, { kind: 'empty', tool: 'bash', command: `${PWSH} 'rg oldName'`, exit_code: 1 }));
    assert.equal(expectedRule(c, { kind: 'empty', tool: 'read', detail: '第 3 次调用 read a.mjs 没有结果' }), null, 'a file that is not there is not a search');
    assert.ok(expectedRule(c, { kind: 'error', tool: 'bash', command: 'rg -n oldName src', exit_code: 1 }), 'pi reports rg with no match as an error');
    assert.equal(expectedRule(c, { kind: 'error', tool: 'bash', command: 'rg -n "(" src', exit_code: 2 }), null, 'rg exit 2 is a real error');
    assert.equal(expectedRule(c, { kind: 'error', tool: 'bash', command: 'npm run build', exit_code: 1 }), null);
    assert.equal(expectedRule(c, { kind: 'error', tool: 'edit', detail: '第 4 次调用 edit a.mjs 报错：oldText not found' }), null);
    assert.equal(expectedRule(c, { kind: 'blocked', tool: 'write', detail: '第 5 次调用 write ../x 被写入边界拦下' }), null);
  });

  it('[S-1] coder: only a line that is one search counts as a search; the word grep somewhere in it does not', () => {
    const c = rulesOf('coder');
    const exit1 = (command) => expectedRule(c, { kind: 'error', tool: 'bash', command, exit_code: 1 });
    assert.ok(exit1(`${PWSH} 'rg -n oldName src'`), 'Codex wraps the search in PowerShell');
    assert.ok(exit1('grep -rn "old_name|OldName" src'), 'a | inside the pattern is not a pipe that matters');
    assert.ok(exit1('rg -n "import oldName;" src'), 'nor a ; inside it');
    assert.ok(exit1('rg -n oldName src | head -20'));
    assert.equal(exit1('npm run build && rg -n oldName src'), null, 'the build may be what failed');
    assert.equal(exit1(`${PWSH} 'npm run build && rg -n oldName src'`), null);
    assert.equal(exit1('git commit -m "drop grep fallback"'), null, 'nothing to commit, with grep in the message');
    assert.equal(exit1('node scripts/build.mjs | grep -v warn'), null, 'a build piped into grep is a build');
    assert.equal(exit1('cd src && rg oldName'), null, 'two statements count, cd included');
    assert.equal(exit1('rg oldName\nrg old_name'), null, 'a script of several lines');
  });

  it('soleCommand: the wrapper comes off, a pipeline keeps its first command, several statements give null', () => {
    assert.equal(soleCommand(`${PWSH} 'rg -n x src'`), 'rg -n x src');
    assert.equal(soleCommand(`"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command "rg -n x src"`), 'rg -n x src');
    assert.equal(soleCommand(`pwsh.exe -NoProfile -ExecutionPolicy Bypass -Command 'npm test'`), 'npm test');
    assert.equal(soleCommand(`/bin/bash -lc 'pytest -q'`), 'pytest -q');
    assert.equal(soleCommand('cmd.exe /d /s /c "findstr /s x *.mjs"'), 'findstr /s x *.mjs');
    assert.equal(soleCommand('npm test 2>&1 | tail -n 50'), 'npm test 2>&1');
    assert.equal(soleCommand('cd a; npm test'), null);
    assert.equal(soleCommand('false || npm test'), null);
    assert.equal(soleCommand(''), null);
    assert.equal(soleCommand(null), null);
  });

  it('[S-1] reads the command and the exit code of rows already in the ledger from their sentence', () => {
    const t = rulesOf('tester');
    const row = (detail) => ({ kind: 'error', tool: 'bash', detail });
    assert.ok(expectedRule(t, row(`命令 ${PWSH} 'npm test' 退出码 1`)), 'Codex');
    assert.equal(expectedRule(t, row(`命令 ${PWSH} 'npm test' 退出码 127`)), null);
    assert.equal(expectedRule(t, row(`命令 ${PWSH} 'pytest' 退出码 1${MISSING_MARK}`)), null);
    assert.equal(expectedRule(t, row(`命令 ${PWSH} 'npm ci && npm test' 退出码 1`)), null, 'chained');
    assert.equal(expectedRule(t, row("第 2 次调用 bash node --test tests/nope.test.mjs 报错：Could not find 'tests/nope.test.mjs'\n\nCommand exited with code 1")), null, 'a row from before the mark: read from its output');
    assert.ok(expectedRule(t, row('第 2 次调用 bash node --test tests 报错：not ok 1 - adds\n\nCommand exited with code 1')), 'DeepSeek');
    assert.ok(expectedRule(t, row('第 2 次调用 bash node --test tests 报错（退出码 1）：not ok 1 - adds')), 'the code seat-runner now writes into the sentence');
    assert.equal(expectedRule(t, row('第 2 次调用 bash npm test 报错：\n\nCommand timed out after 30 seconds')), null);
    assert.equal(expectedRule(t, row(`第 2 次调用 bash npm test 报错：${'x'.repeat(120)}`)), null, 'output cut before the exit code: unknown, so it keeps counting');
    const c = rulesOf('coder');
    assert.ok(expectedRule(c, { kind: 'empty', tool: 'bash', detail: `命令 ${PWSH} 'rg -n oldName src' 没有结果（退出码 1）` }));
    assert.ok(expectedRule(c, row('第 3 次调用 bash rg -n oldName src 报错：(no output)\n\nCommand exited with code 1')));
  });

  it('[S-1] never makes a failed run, a blocked write, a retry, a compaction, a costly run or a verdict normal, whatever a rule says', () => {
    const greedy = ['failed', 'blocked', 'retry', 'compaction', 'costly', 'revised', 'rejected'].map((kind) => ({ kind, why: 'x' }));
    for (const { kind } of greedy) assert.equal(expectedRule(greedy, { kind, tool: 'bash', detail: 'x' }), null, kind);
    assert.equal(expectedRule([{ kind: 'error', why: 'x' }], { kind: 'error', tool: 'bash', command: 'npm test', exit_code: 1 }), null, 'an error rule without command and max_exit hides nothing');
    assert.equal(expectedRule([{ kind: 'error', command: '.', max_exit: 200, why: 'x' }], { kind: 'error', tool: 'bash', command: 'x', exit_code: 127 }), null, 'max_exit stops at 125');
  });

  it('knows a shell saying the command is not there', () => {
    assert.ok(commandMissing("pytest: The term 'pytest' is not recognized as a name of a cmdlet, function, script file, or executable program."));
    assert.ok(commandMissing("'pytest' is not recognized as an internal or external command,"));
    assert.ok(commandMissing("'pytest' 不是内部或外部命令，也不是可运行的程序"));
    assert.ok(commandMissing('无法将“pytest”项识别为 cmdlet、函数、脚本文件或可运行程序的名称。'));
    assert.ok(commandMissing('bash: pytest: command not found'));
    assert.equal(commandMissing('not ok 1 - adds'), false);
  });

  it('knows a package manager or a test runner saying what it was asked to run is not there', () => {
    assert.ok(commandMissing('npm error Missing script: "test"'));
    assert.ok(commandMissing('npm ERR! Missing script: "test"'), 'older npm');
    assert.ok(commandMissing(' ERR_PNPM_NO_SCRIPT  Missing script: test'));
    assert.ok(commandMissing('error Command "test" not found.'), 'yarn 1');
    assert.ok(commandMissing('Usage Error: Couldn\'t find a script named "test".'), 'yarn 2+');
    assert.ok(commandMissing('error: Script not found "test"'), 'bun');
    assert.ok(commandMissing('npm error code ENOENT\nnpm error syscall open\nnpm error path package-lock.json'));
    assert.ok(commandMissing("Could not find 'tests/nope.test.mjs'"));
    assert.ok(commandMissing('ERROR: file or directory not found: tests/nope.py'));
    assert.ok(commandMissing('/usr/bin/python3: No module named pytest'));
    // A test that fails because the product is missing a module did run: that is the test's result.
    assert.equal(commandMissing("E   ModuleNotFoundError: No module named 'app.parser'"), false);
    assert.equal(commandMissing("  error: Could not find 'config.json'"), false, 'an assertion message inside a failing test');
  });
});

describe('the startup gate on expected_traces', () => {
  it('[R-3] accepts every rule in roles.json', () => {
    for (const [id, spec] of Object.entries(ROLES)) assert.deepEqual(checkExpectedTraces(id, spec.expected_traces), [], id);
  });

  it('[R-3] refuses a rule that would hide real difficulties or silently match nothing', () => {
    const said = (rules) => checkExpectedTraces('x', rules).join('\n');
    assert.match(said({ kind: 'uncertain', why: 'w' }), /expected_traces must be an array of rule objects/);
    assert.match(said([{ kind: 'retry', why: 'w' }]), /\.kind must be one of uncertain \/ empty \/ error/);
    assert.match(said([{ kind: 'uncertain' }]), /is missing why/);
    assert.match(said([{ kind: 'error', tools: ['bash'], why: 'w' }]), /requires both command and max_exit/);
    assert.match(said([{ kind: 'error', command: 'npm test', max_exit: 127, why: 'w' }]), /\.max_exit must be an integer from 1 to 125/);
    assert.match(said([{ kind: 'error', command: '(', max_exit: 1, why: 'w' }]), /not a valid regular expression/);
    assert.match(said([{ kind: 'empty', exit_below: 2, why: 'w' }]), /unknown field\(s\) exit_below/);
    assert.match(said([{ kind: 'uncertain', tools: ['bash'], why: 'w' }]), /set only kind and why/);
    assert.match(said([{ kind: 'empty', tools: [], why: 'w' }]), /\.tools must be a non-empty array/);
  });

  it('[R-3] keeps the service from starting with such a rule', async () => {
    const prepare = (root) => {
      const file = path.join(root, 'roles.json');
      const roles = JSON.parse(fs.readFileSync(file, 'utf8'));
      roles.tester.expected_traces = [{ kind: 'error', why: '所有报错都算本职' }];
      fs.writeFileSync(file, JSON.stringify(roles, null, 2));
    };
    await assert.rejects(startService({ prepare }), /tester: expected_traces\[0\] is an error rule and requires both command and max_exit/);
  });
});

describe('the ledger counts only what is not normal for the role', () => {
  let t;
  before(async () => {
    t = await loadStore();
  });
  after(() => t?.cleanup());

  it('[S-1] leaves rows already written out of difficulty_report and the skill loop, and says how many and why', () => {
    const { store } = t;
    const plant = (role, kind, tool, detail, run) => store.recordDifficulty({ seat: `seat-${role}-1`, run: `seat-${role}-1#${run}`, role, kind, tool, detail });
    for (let i = 1; i <= 6; i += 1) plant('web_researcher', 'uncertain', null, `最终回答里有"查不到"：…第 ${i} 次…`, i);
    plant('tester', 'error', 'bash', `命令 ${PWSH} 'npm test' 退出码 1`, 1);
    plant('tester', 'error', 'bash', `命令 ${PWSH} 'npm test' 退出码 1`, 2);
    plant('tester', 'error', 'bash', `命令 ${PWSH} 'npm test' 退出码 127`, 3);
    plant('tester', 'retry', 'bash', 'bash 连续 2 次失败或没结果', 4);
    plant('coder', 'empty', 'bash', `命令 ${PWSH} 'rg oldName' 没有结果（退出码 1）`, 1);
    plant('coder', 'error', 'bash', '第 3 次调用 bash rg oldName 报错：(no output)\n\nCommand exited with code 1', 2);
    plant('coder', 'blocked', 'write', '第 5 次调用 write ../x 被写入边界拦下', 3);
    plant('handyman', 'uncertain', null, '最终回答里有"无法确认"', 1);
    plant('handyman', 'uncertain', null, '最终回答里有"无法确认"', 2);

    const classes = new Map(store.difficultyClasses().map((g) => [g.class, g]));
    assert.equal(classes.has('web_researcher|uncertain|-'), false);
    assert.equal(classes.get('tester|error|bash').count, 1, 'only the exit 127 is left');
    assert.equal(classes.get('tester|retry|bash').count, 1, 'a retry always counts');
    assert.equal(classes.has('coder|empty|bash'), false);
    assert.equal(classes.has('coder|error|bash'), false);
    assert.equal(classes.get('coder|blocked|write').count, 1, 'a blocked write always counts');
    assert.equal(classes.get('handyman|uncertain|-').runs, 2, 'a role without a rule is unchanged');

    assert.deepEqual(store.newDifficulties('web_researcher'), [], 'six honest 查不到 no longer fill a batch');
    assert.deepEqual(store.newDifficulties('tester').map((row) => row.kind), ['error', 'retry']);
    assert.match(store.newDifficulties('tester')[0].detail, /退出码 127/);
    assert.deepEqual(store.newDifficulties('coder').map((row) => row.kind), ['blocked']);
    assert.equal(store.newDifficulties('handyman').length, 2);

    const report = store.difficultyReportText();
    assert.match(report, /Another 10 trace\(s\) matched expected_traces in roles\.json/);
    assert.match(report, /\[web_researcher\|uncertain\|-\] 6 trace\(s\) \(合同要它查不到的写查不到/);
    assert.match(report, /\[tester\|error\|bash\] 2 trace\(s\)/);
    assert.doesNotMatch(report, /- \[web_researcher\|uncertain/);
    assert.match(report, /- \[handyman\|uncertain\|-\]/);
  });
});

describe('seat-runner (DeepSeek) leaves out what the role makes normal', () => {
  const failingTest = { tool: 'bash', args: { command: 'npm test' }, isError: true, text: 'not ok 1 - adds\n\nCommand exited with code 1' };
  const otherFailingTest = { tool: 'bash', args: { command: 'node --test tests/a.test.mjs' }, isError: true, text: 'not ok 1 - adds\n\nCommand exited with code 1' };
  const missingRunner = { tool: 'bash', args: { command: 'pytest -q' }, isError: true, text: 'bash: pytest: command not found\n\nCommand exited with code 127' };

  function runSeatRunner({ tools = [], answer, rules }) {
    const dir = tempDir('ssa-pi-');
    const resultFile = path.join(dir, 'result.json');
    const callsFile = path.join(dir, 'calls.jsonl');
    const env = isolatedEnv(dir, { SPECIALIST_SEAT_RESULT: resultFile, SPECIALIST_SEAT_SESSION_DIR: dir, FAKE_PI_MODE: 'ok', FAKE_PI_CALLS: callsFile, FAKE_PI_TOOLS: JSON.stringify(tools) });
    if (answer) env.FAKE_PI_ANSWER = answer;
    delete env.SPECIALIST_SEAT_EXPECTED_TRACES;
    if (rules) env.SPECIALIST_SEAT_EXPECTED_TRACES = JSON.stringify(rules);
    const res = spawnSync(
      process.execPath,
      [path.join(REPO, 'src', 'seat-runner.mjs'), '--pi', FAKE_PI_CLI, '--provider', 'fake', '--model', 'm', '--tools', 'read,bash', '-p', 'TASK'],
      { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env },
    );
    const result = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
    const calls = readLines(callsFile);
    fs.rmSync(dir, { recursive: true, force: true });
    assert.equal(res.status, 0, res.stderr);
    return { result, calls };
  }

  it('[S-1] tester: failing tests are neither recorded nor asked about, and do not make a retry; a missing test runner is', () => {
    // Two different test commands: the same one run again unchanged is a retry (the tests below).
    const { result, calls } = runSeatRunner({ tools: [failingTest, otherFailingTest, missingRunner], answer: 'PI-ANSWER，覆盖率无法确认', rules: rulesOf('tester') });
    assert.deepEqual(result.difficulties.map((d) => d.kind), ['error', 'uncertain'], JSON.stringify(result.difficulties));
    assert.match(result.difficulties[0].detail, /pytest -q.*failed \(exit code 127\)/);
    const followUp = calls.find((c) => c.text.includes('刚才的运行里有这几处'));
    assert.ok(followUp, 'the seat is asked about what is left');
    assert.match(followUp.text, /pytest/);
    assert.doesNotMatch(followUp.text, /npm test/, 'never about a failing test');
  });

  it('[S-1] tester: npm with no test script is recorded and asked about, marked as never having run', () => {
    const noScript = { tool: 'bash', args: { command: 'npm test' }, isError: true, text: 'npm error Missing script: "test"\nnpm error\n\nCommand exited with code 1' };
    const { result, calls } = runSeatRunner({ tools: [noScript], answer: 'PI-ANSWER', rules: rulesOf('tester') });
    assert.deepEqual(result.difficulties.map((d) => d.kind), ['error'], JSON.stringify(result.difficulties));
    assert.ok(result.difficulties[0].detail.endsWith(MISSING_MARK), result.difficulties[0].detail);
    assert.ok(calls.some((c) => c.text.includes('刚才的运行里有这几处')), 'the seat is asked about it');
  });

  it('[S-1] a role without rules records the same run as before: one retry over the three bash failures, and the uncertain answer', () => {
    const { result } = runSeatRunner({ tools: [failingTest, failingTest, missingRunner], answer: 'PI-ANSWER，覆盖率无法确认' });
    assert.deepEqual(result.difficulties.map((d) => d.kind), ['retry', 'uncertain']);
  });

  // 2026-10-01: a normal failure run again unchanged is going round in place, not the job.
  it('[S-1] tester: the same failing test run again unchanged is one retry, and the seat is asked about it', () => {
    const passing = { tool: 'bash', args: { command: 'npm test' }, isError: false, text: 'ok 1 - adds' };
    const { result, calls } = runSeatRunner({ tools: [failingTest, failingTest, failingTest, passing], rules: rulesOf('tester') });
    assert.deepEqual(result.difficulties.map((d) => d.kind), ['retry'], JSON.stringify(result.difficulties));
    assert.equal(result.difficulties[0].tool, 'bash');
    assert.match(result.difficulties[0].detail, /repeated the identical call 3 times.*calls #1, #2, #3:.*npm test.*; succeeded at step #4/);
    const followUp = calls.find((c) => c.text.includes('刚才的运行里有这几处'));
    assert.ok(followUp, 'the seat is asked about the retry');
    assert.match(followUp.text, /repeated the identical call/);
  });

  it('[S-1] tester: the same arguments in another key order are the same call', () => {
    const a = { tool: 'bash', args: { command: 'npm test', timeout: 60 }, isError: true, text: 'not ok 1\n\nCommand exited with code 1' };
    const b = { ...a, args: { timeout: 60, command: 'npm test' } };
    const { result } = runSeatRunner({ tools: [a, b], rules: rulesOf('tester') });
    assert.deepEqual(result.difficulties.map((d) => d.kind), ['retry'], JSON.stringify(result.difficulties));
    assert.match(result.difficulties[0].detail, /not retried afterward/);
  });

  it('[S-1] coder: several spellings of a search that find nothing leave no trace; the same search word for word is a retry', () => {
    const rg = (word) => ({ tool: 'bash', args: { command: `rg -n ${word} src` }, isError: true, text: '(no output)\n\nCommand exited with code 1' });
    const grep = (pattern) => ({ tool: 'grep', args: { pattern }, isError: false, text: 'No matches found' });
    const spellings = runSeatRunner({ tools: [rg('oldName'), rg('old_name'), rg('OldName'), grep('oldName'), grep('old_name')], rules: rulesOf('coder') });
    assert.deepEqual(spellings.result.difficulties, []);
    assert.equal(spellings.calls.filter((c) => c.text.includes('刚才的运行里有这几处')).length, 0);

    const same = runSeatRunner({ tools: [rg('oldName'), rg('oldName'), rg('old_name'), grep('oldName'), grep('oldName')], rules: rulesOf('coder') });
    assert.deepEqual(same.result.difficulties.map((d) => `${d.kind}|${d.tool}`), ['retry|bash', 'retry|grep'], JSON.stringify(same.result.difficulties));
    assert.match(same.result.difficulties[0].detail, /repeated the identical call 2 times.*calls #1, #2.*; call changed at step #3/);
    assert.match(same.result.difficulties[1].detail, /calls #4, #5.*; not retried afterward/);
  });

  it('[S-1] a failure that counts and a normal one never form one retry, even of the same command; without rules all three are one retry, as before', () => {
    const timedOut = { tool: 'bash', args: { command: 'npm test' }, isError: true, text: 'Command timed out after 120 seconds' };
    const tester = runSeatRunner({ tools: [timedOut, failingTest, failingTest], rules: rulesOf('tester') });
    assert.deepEqual(tester.result.difficulties.map((d) => d.kind), ['error', 'retry'], JSON.stringify(tester.result.difficulties));
    assert.match(tester.result.difficulties[0].detail, /^Call #1 .*npm test.*failed/);
    assert.match(tester.result.difficulties[1].detail, /calls #2, #3/);
    const none = runSeatRunner({ tools: [timedOut, failingTest, failingTest] });
    assert.deepEqual(none.result.difficulties.map((d) => d.kind), ['retry']);
    assert.match(none.result.difficulties[0].detail, /bash failed or returned nothing 3 times in a row/);
  });

  it('[S-1] web_researcher: an answer that says 查不到 leaves no trace, so the seat is not asked about one', () => {
    const { result, calls } = runSeatRunner({ answer: '查不到 2026 年的价格；推断仍是 $20。', rules: rulesOf('web_researcher') });
    assert.deepEqual(result.difficulties, []);
    assert.equal(calls.filter((c) => c.text.includes('刚才的运行里有这几处')).length, 0);
  });

  it('[S-1] coder: rg and grep finding nothing are normal, an rg that broke is not', () => {
    const tools = [
      { tool: 'bash', args: { command: 'rg -n oldName src' }, isError: true, text: '(no output)\n\nCommand exited with code 1' },
      { tool: 'grep', args: { pattern: 'oldName' }, isError: false, text: 'No matches found' },
      { tool: 'bash', args: { command: 'rg -n "(" src' }, isError: true, text: 'regex parse error\n\nCommand exited with code 2' },
    ];
    const { result } = runSeatRunner({ tools, rules: rulesOf('coder') });
    assert.deepEqual(result.difficulties.map((d) => d.kind), ['error']);
    assert.match(result.difficulties[0].detail, /exit code 2/);
  });
});

describe('the service writes only what counts (Codex through cli-runner, DeepSeek through seat-runner)', () => {
  const COMMANDS = [
    { command: `${PWSH} 'npm test'`, exit_code: 1, aggregated_output: 'not ok 1 - adds' },
    { command: `${PWSH} 'rg -n oldName src'`, exit_code: 1, aggregated_output: '' },
    { command: `${PWSH} 'pytest -q'`, exit_code: 1, aggregated_output: "pytest: The term 'pytest' is not recognized as a name of a cmdlet, function, script file, or executable program." },
    { command: `${PWSH} 'node build.mjs'`, exit_code: 127, aggregated_output: '' },
    // 2026-10-01 review: the build failed, not the search; it was "no result" and then nothing at all.
    { command: `${PWSH} 'npm run build && rg -n oldName src'`, exit_code: 1, aggregated_output: "src/a.ts(3,1): error TS2304: Cannot find name 'x'." },
  ];
  let service;
  const dirs = [];

  before(async () => {
    service = await startService({
      env: {
        FAKE_CODEX_COMMANDS: JSON.stringify(COMMANDS),
        SPECIALIST_SUBAGENTS_RUNTIME: FAKE_PI_CLI,
        FAKE_PI_ANSWER: '查不到这个版本的发布日期，只找到第三方报道。',
      },
    });
  });
  after(async () => {
    await service?.stop();
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  });

  const run = async (role) => {
    const cwd = tempDir('ssa-work-');
    dirs.push(cwd);
    // web_researcher is found by domain, not by directory: it refuses a cwd.
    const where = role === 'web_researcher' ? { domain: 'ai' } : { cwd };
    const started = await service.call('POST', '/seat/start', { role, task: 'TASK', ...where });
    assert.equal(started.status, 200, started.text);
    const shown = await service.waitSeat(started.json.seat);
    assert.equal(shown.seat.state, 'done', service.log());
    return shown.events.filter((e) => e.kind === 'difficulty').map((e) => e.body);
  };

  const chained = (line) => line.includes('npm run build && rg');

  it('[S-1] tester: the failing test is not written; the empty search, the missing runner, exit 127 and the chained build are', async () => {
    const said = await run('tester');
    assert.equal(said.length, 4, said.join('\n'));
    assert.equal(said.some((line) => line.includes("'npm test'")), false);
    assert.ok(said.some((line) => line.includes('pytest -q') && line.includes(MISSING_MARK)), 'PowerShell exit 1 for a missing command is a real error');
    assert.ok(said.some((line) => line.includes('exit code 127')));
    assert.ok(said.some(chained), said.join('\n'));
  });

  it('[S-1] coder: the search with no match is not written; the failing build-or-test, the missing runner, exit 127 and the build before a search are', async () => {
    const said = await run('coder');
    assert.equal(said.length, 4, said.join('\n'));
    assert.equal(said.some((line) => line.includes("'rg -n oldName src'")), false);
    assert.ok(said.some((line) => line.includes('npm test')), 'a failing test is a coder difficulty');
    const build = said.find(chained);
    assert.ok(build, said.join('\n'));
    assert.match(build, /exit code 1/);
    assert.doesNotMatch(build, /returned no results/, 'a chained line is not a search that found nothing');
  });

  it('[S-1] handyman, a role without rules: everything counts and the first four are written, as before', async () => {
    assert.equal((await run('handyman')).length, 4);
  });

  it('[S-1] web_researcher on DeepSeek: the rules reach seat-runner, so its honest 查不到 is not written', async () => {
    assert.deepEqual(await run('web_researcher'), []);
    const { json } = await service.call('GET', '/difficulties');
    assert.equal(json.classes.some((c) => c.role === 'web_researcher'), false);
    assert.ok(json.classes.some((c) => c.class === 'tester|error|bash'), 'what counts is still in the ledger');
  });
});
