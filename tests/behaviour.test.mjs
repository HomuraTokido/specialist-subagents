import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { REPO, FAKE_SLEEPER, sleep, startService, tempDir } from './lib/sandbox.mjs';
import { brief, openScenario, t } from './scenarios/driver.mjs';

await describe('behaviour', { concurrency: false }, async () => {
// PRD 4.4 (2026-10-11), how an expert behaves: B-1 (a contract does not prescribe the steps of every
// run — the expert first asks itself whether it knows), B-2 (what it found on the web is written back
// to Hwiki), B-3 (what another role's expert knows about the same object is read off disk, never
// dispatched).
//
// B-1 is read off the contract files themselves: the defect it fixes was a sentence in one of them.
// B-2 and B-3 run the whole chain on the scenario driver (its fake brain), the way T-1..T-8 do.








const services = [];
afterEach(async () => {
  while (services.length) await services.pop().close();
});
const open = async (options) => {
  const sc = await openScenario(options);
  services.push(sc);
  return sc;
};

// `git` without a shell, with an identity, so the service's own commit works in a temp repository.
const git = (dir, ...args) => execFileSync('git', ['-c', 'user.name=scenario', '-c', 'user.email=scenario@example.test', '-c', 'commit.gpgsign=false', ...args], {
  cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
});

const ROLES = path.join(REPO, 'roles');

describe('[B-1] the contract asks the expert what it knows before it sends it anywhere', () => {
  it('[B-1] web_researcher judges first, and no role contract prescribes the same steps every run', () => {
    const text = fs.readFileSync(path.join(ROLES, 'web_researcher.md'), 'utf8');
    const version = fs.readFileSync(path.join(ROLES, 'web_researcher.VERSION'), 'utf8').trim();
    assert.equal(version, '1.4.1', 'the contract that changed carries its new version');

    // The temporary worker's pipeline is gone: no contract orders the same steps every run.
    assert.doesNotMatch(text, /每次都按这个顺序/, 'the fixed order is what B-1 removes');
    // What replaces it: the first thing it does is ask itself whether it knows, and answering from
    // what it already has comes before any searching.
    assert.match(text, /先判断自己知不知道/, 'the first step is the judgement, not a search');
    // It is the first step, said before the numbered list starts, not one of the branches.
    const judged = text.indexOf('先判断自己知不知道');
    const firstStep = text.search(/^1\. /m);
    assert.ok(judged >= 0 && judged < firstStep, `the judgement is the first thing the contract says (${judged} vs step 1 at ${firstStep})`);
    // Searching is one of the answers to that question, not where the run starts: it is step 2.
    assert.match(text, /^2\. \*\*不知道，才去查。\*\*/m, 'searching is what it does when it does not know');
    // Knowing is enough to answer, and an answer that can go stale says when it was checked.
    assert.match(text, /知道，就直接答/);
    assert.match(text, /查证日期/);
    // Writing back what it learned on the web is unchanged.
    assert.match(text, /hwiki ai-note/);
    assert.match(text, /本机未安装 `hwiki` 时跳过本地检索/);
    assert.match(text, /本机未安装 `hwiki` 时跳过写回/);
    assert.match(text, /未安装 `hwiki` 不算未完成/);

    // The same check on every role: a contract that orders steps is a temporary worker's job sheet.
    for (const file of fs.readdirSync(ROLES).filter((name) => name.endsWith('.md'))) {
      assert.doesNotMatch(fs.readFileSync(path.join(ROLES, file), 'utf8'), /每次都按这个顺序/, `${file}: prescribes the same steps every run`);
    }
  });
});

describe('[B-2] what it learned on the web is written back', () => {
  // A temp git repository stands in for Hwiki: its `knowledge/ai` is where an ai-note goes. The
  // write-back itself is the service's own commit (K-1's mechanism) because the fake brain has no
  // `hwiki` binary to call; what the test asserts is the note that landed in the repository, and
  // that a web query came before it in the same run.
  it('[B-2] a web query is followed by a committed ai-note in that repository', async () => {
    const sc = await open({
      prepare: async (root) => {
        const file = path.join(root, 'roles.json');
        const roles = JSON.parse(fs.readFileSync(file, 'utf8'));
        // A directory expert here: the temp repository is Hwiki, not a field of knowledge.
        delete roles.web_researcher.expert_by;
        roles.web_researcher.commit_after_run = true;
        fs.writeFileSync(file, JSON.stringify(roles, null, 2));
      },
    });
    const repo = sc.workdir({ 'README.md': 'Hwiki\n' }, { git: true, name: 'hwiki' });
    git(repo, 'config', 'user.name', 'scenario');
    git(repo, 'config', 'user.email', 'scenario@example.test');
    const ai = path.join(repo, 'knowledge', 'ai');
    fs.mkdirSync(ai, { recursive: true });
    fs.writeFileSync(path.join(ai, '.keep'), '');
    sc.commitAll(repo, 'knowledge/ai');
    sc.world({ 'pi-5-hour-limit': '5 小时' });

    const reply = await sc.dispatch({
      role: 'web_researcher',
      cwd: ai,
      task: t('问：pi-5-hour-limit\n改文件：pi-limit.md=答：pi-5-hour-limit=5 小时', '查一下 pi-5-hour-limit，把结论写成笔记 knowledge/ai/pi-limit.md'),
    });
    const answer = await sc.answer(reply);
    const web = await sc.webOf(reply);
    assert.ok(web.length >= 1, `the run did not go to the web: ${brief(answer, 200)}`);

    // And the note it wrote back is committed, as an ai-note in Hwiki's own partition is.
    const files = await sc.until(() => {
      const shown = git(repo, 'show', '--name-only', '--format=%s', 'HEAD');
      return /knowledge\/ai\/pi-limit\.md/.test(shown) ? shown : null;
    }, 'the ai-note to be committed into the repository');
    assert.match(files, /tidy/, `the commit is the service's own: ${brief(files, 200)}`);
  });
});

describe('[B-3] another role\'s expert on the same object is read, not dispatched', () => {
  it('[B-3] the coder\'s task names the hand-off the explorer left in that same directory', async () => {
    const sc = await open();
    const dir = sc.workdir({ 'notes.txt': '事实：delta=4\n' });

    // An explorer comes to know something here and is then split, which leaves each part a hand-off
    // document of its own (L-3): the ordinary way a hand-off of this object comes to exist.
    const explorer = await sc.dispatch({ role: 'explorer', cwd: dir, task: t('读文件：notes.txt', '读 notes.txt，记住里面的事实。') });
    await sc.answer(explorer);
    await sc.tool('seat_split', {
      seat: explorer.seat,
      parts: [{ name: '读 delta 的专家', topic: 'delta' }, { name: '其余部分', topic: 'rest' }],
    }, undefined, { timeoutMs: 90000 });

    // The coder's expert starts in the same directory: its task says where the explorer's understanding is.
    const coder = await sc.dispatch({ role: 'coder', cwd: dir, task: t('noop', '看看这里有什么，读完就好。') });
    await sc.answer(coder);
    const entry = sc.brainOf(coder)[0];
    assert.ok(entry, 'no brain entry for the coder run');
    const line = entry.prompt.split('\n').find((text) => text.includes('explorer 的交接文档：'));
    assert.ok(line, `the coder's task names no other role's hand-off: ${brief(entry.prompt, 400)}`);
    const file = line.slice(line.indexOf('交接文档：') + '交接文档：'.length).trim();
    assert.match(file, /\.md$/, `the hand-off is named by its path: ${line}`);
    assert.ok(fs.existsSync(file), `the hand-off named is on disk: ${file}`);

    // A coder in another directory has no claim on it.
    const elsewhere = sc.workdir({ 'other.txt': 'x\n' });
    const stranger = await sc.dispatch({ role: 'coder', cwd: elsewhere, task: t('noop', '看看这里有什么，读完就好。') });
    await sc.answer(stranger);
    const other = sc.brainOf(stranger)[0];
    assert.ok(other);
    assert.doesNotMatch(other.prompt, /explorer 的交接文档/, 'a different object is not handed another object\'s hand-off');
  });
});
});

await describe('background-roles', { concurrency: false }, async () => {
// Background roles: a schedule (.schedules.json, daemon.mjs runSchedules) starts a post on a timer, and
// a post's `followed_by` hands the directory to a second post when the first one moved git HEAD.
// Both run against the real daemon with fake runtimes; the schedule tick is shortened with
// SPECIALIST_SUBAGENTS_SCHEDULE_TICK_MS (a real tick is a minute).







const services = [];
const scratches = [];
afterEach(async () => {
  while (services.length) await services.pop().stop();
  while (scratches.length) fs.rmSync(scratches.pop(), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

const scratch = (prefix) => {
  const dir = tempDir(prefix);
  scratches.push(dir);
  return dir;
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

const ARGS = (script, tools) => [script, '--pi', '{runtime}', '--tools', tools, '-p', '{task}'];

// Point a role at a script inside the sandbox (the gate still sees a whitelist that matches the role's grant:
// tester is read + shell, so its whitelist has bash).
function wire(root, role, script, extra = {}, tools = 'read,grep,find,ls') {
  const file = path.join(root, 'roles.json');
  const roles = JSON.parse(fs.readFileSync(file, 'utf8'));
  roles[role].spawn.args = ARGS(script, tools);
  Object.assign(roles[role], extra);
  fs.writeFileSync(file, JSON.stringify(roles, null, 2));
}

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=ssa-test', '-c', 'user.email=ssa-test@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', windowsHide: true }).trim();

describe('a scheduled role', () => {
  it('[K-2] starts from .schedules.json as owner "schedule", and is not started again within its interval', async () => {
    const cwd = scratch('ssa-k2-');
    const service = await startService({
      env: { SPECIALIST_SUBAGENTS_SCHEDULE_TICK_MS: '200' },
      prepare: (root) => {
        fs.copyFileSync(FAKE_SLEEPER, path.join(root, 'src', 'fake-sleeper.mjs'));
        wire(root, 'explorer', 'src/fake-sleeper.mjs');
        fs.writeFileSync(path.join(root, '.schedules.json'), JSON.stringify([{ role: 'explorer', cwd, every_hours: 1, task: 'finish-after:10' }]));
      },
    });
    services.push(service);

    const scheduled = await until(async () => {
      const { json } = await service.call('GET', '/seats');
      return (json ?? []).find((seat) => seat.role === 'explorer' && seat.owner === 'schedule');
    }, 'the schedule to start a run');
    const done = await service.waitSeat(scheduled.id, ['done', 'failed', 'interrupted']);
    assert.equal(done.seat.state, 'done', service.log());
    assert.equal(done.seat.owner, 'schedule');

    // Several more ticks pass (200 ms each) while the run is well inside its hour: nothing new starts.
    await sleep(1500);
    const { json: after } = await service.call('GET', `/seats/${done.seat.id}?tail=all`);
    assert.equal(after.events.filter((event) => event.kind === 'task').length, 1, 'one task event: the schedule did not fire again');
    const { json: all } = await service.call('GET', '/seats');
    const explorers = all.filter((seat) => seat.role === 'explorer');
    assert.equal(explorers.length, 1, 'and no second seat was opened');
  });
});

// A runtime that commits to the directory it runs in when its task says so, then finishes like a runner.
const FAKE_COMMITTER = `
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
const args = process.argv.slice(2);
const taskFileAt = args.indexOf('--task-file');
const task = taskFileAt === -1 ? String(args[args.indexOf('-p') + 1] ?? '') : fs.readFileSync(args[taskFileAt + 1], 'utf8');
if (task.includes('make-commit')) {
  execFileSync('git', ['-c', 'user.name=fake', '-c', 'user.email=fake@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'made by the fake runtime'], { cwd: process.cwd(), windowsHide: true });
}
process.stdout.write('done\\n');
fs.writeFileSync(process.env.SPECIALIST_SEAT_RESULT, JSON.stringify({
  tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 },
  expertise: 'fake-committer knows this directory',
  backlog: '',
  model: 'fake/fake-committer',
  difficulties: [],
}));
`;

describe('a post with followed_by', () => {
  it('[K-3] asks the named post to follow when the run moved HEAD, and records the follow event', async () => {
    const cwd = scratch('ssa-k3-');
    git(cwd, 'init', '-q');
    git(cwd, 'commit', '--allow-empty', '-q', '-m', 'start');
    const service = await startService({
      prepare: (root) => {
        fs.writeFileSync(path.join(root, 'src', 'fake-committer.mjs'), FAKE_COMMITTER);
        wire(root, 'explorer', 'src/fake-committer.mjs', { followed_by: { role: 'tester', when: 'new_commits' } });
        wire(root, 'tester', 'src/fake-committer.mjs', {}, 'read,grep,find,ls,bash');
      },
    });
    services.push(service);

    const started = await service.call('POST', '/seat/start', { role: 'explorer', task: 'make-commit', cwd });
    assert.equal(started.status, 200, started.text);
    const first = await service.waitSeat(started.json.seat, ['done', 'failed', 'interrupted']);
    assert.equal(first.seat.state, 'done', service.log());

    const followSeat = await until(async () => {
      const { json } = await service.call('GET', '/seats');
      return (json ?? []).find((seat) => seat.role === 'tester');
    }, 'the follow-up post to be started');
    assert.equal(followSeat.owner, `followed_by:${started.json.seat}`);
    assert.equal(followSeat.parent, started.json.seat);
    const second = await service.waitSeat(followSeat.id, ['done', 'failed', 'interrupted']);
    assert.equal(second.seat.state, 'done', service.log());
    assert.equal(second.seat.cwd, cwd, 'it works in the same directory');

    const { json: shown } = await service.call('GET', `/seats/${started.json.seat}?tail=all`);
    const follow = shown.events.filter((event) => event.kind === 'follow');
    assert.equal(follow.length, 1);
    assert.match(follow[0].body, /Queued follow-up for tester in /);
    // The follow-up did not commit, so it does not hand the directory on again.
    const { json: all } = await service.call('GET', '/seats');
    assert.equal(all.filter((seat) => seat.role === 'tester').length, 1);
  });

  it('[K-3] does not follow when the run left HEAD where it was', async () => {
    const cwd = scratch('ssa-k3-none-');
    git(cwd, 'init', '-q');
    git(cwd, 'commit', '--allow-empty', '-q', '-m', 'start');
    const service = await startService({
      prepare: (root) => {
        fs.writeFileSync(path.join(root, 'src', 'fake-committer.mjs'), FAKE_COMMITTER);
        wire(root, 'explorer', 'src/fake-committer.mjs', { followed_by: { role: 'tester', when: 'new_commits' } });
        wire(root, 'tester', 'src/fake-committer.mjs', {}, 'read,grep,find,ls,bash');
      },
    });
    services.push(service);

    const started = await service.call('POST', '/seat/start', { role: 'explorer', task: 'just look', cwd });
    await service.waitSeat(started.json.seat, ['done']);
    await sleep(500);
    const { json: all } = await service.call('GET', '/seats');
    assert.equal(all.filter((seat) => seat.role === 'tester').length, 0);
    const { json: shown } = await service.call('GET', `/seats/${started.json.seat}?tail=all`);
    assert.equal(shown.events.filter((event) => event.kind === 'follow').length, 0);
  });
});
});
