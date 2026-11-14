// What the service does around a run in a git directory (2026-09-30 review): committing for a role
// without git (non-ASCII file names, the shared lock), and the directory baseline a seat carries to its
// next visit (a seat's own edits are not news to it, a failed run does not advance it).
//
// The runtime is tests/fakes/fake-sleeper.mjs: `write-file:<name>` creates a file in the seat's
// directory and finishes, `fail-error` dies early with an error report.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, afterEach, before, describe, it } from 'node:test';
import { FAKE_SLEEPER, sleep, startService, tempDir } from './lib/sandbox.mjs';
import { loadStore } from './lib/store.mjs';

const services = [];
const scratches = [];
afterEach(async () => {
  while (services.length) await services.pop().stop();
  while (scratches.length) fs.rmSync(scratches.pop(), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

async function until(check, what, timeoutMs = 20000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

// A repository whose seat directory is a subdirectory (rel = "sub"), the shape of Hwiki's knowledge/ai.
function makeRepo() {
  const scratch = tempDir('ssa-dir-');
  scratches.push(scratch);
  const top = path.join(scratch, 'repo');
  const dir = path.join(top, 'sub');
  fs.mkdirSync(dir, { recursive: true });
  const git = (...args) => execFileSync('git', ['-C', top, '-c', 'core.quotepath=false', '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  git('init', '-q');
  // The service commits with whatever identity the repository has; the test home has none.
  git('config', 'user.name', 't');
  git('config', 'user.email', 't@example.com');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'first');
  return { top, dir, git };
}

// roles.json for the tests: the named roles run the fake runtime instead of a model. The tool list
// has to keep matching the role's grant (the startup gate checks it).
function withFakeRuntime(edits) {
  return (root) => {
    fs.copyFileSync(FAKE_SLEEPER, path.join(root, 'src', 'fake-sleeper.mjs'));
    const file = path.join(root, 'roles.json');
    const roles = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const [id, edit] of Object.entries(edits)) {
      roles[id].spawn.args = ['src/fake-sleeper.mjs', '--pi', '{runtime}', '--tools', edit.tools, '-p', '{task}'];
      if (edit.commit_lock) roles[id].commit_lock = edit.commit_lock;
      if (edit.expert_by) roles[id].expert_by = edit.expert_by;
      if (edit.move_plan) roles[id].move_plan = edit.move_plan;
    }
    fs.writeFileSync(file, JSON.stringify(roles, null, 2));
  };
}

async function start(options) {
  const service = await startService(options);
  services.push(service);
  return service;
}

// Dispatch, then wait until the run has ended: `runs` is how many runs of this seat have ended by then.
async function runToEnd(service, body, runs) {
  const started = await service.call('POST', '/seat/start', body);
  assert.equal(started.status, 200, started.text);
  return until(async () => {
    const { json } = await service.call('GET', `/seats/${started.json.seat}?tail=all`);
    return json.events.filter((ev) => ev.kind === 'exit').length === runs && json.seat.state !== 'running' ? json : null;
  }, `run ${runs} of ${started.json.seat} to end`);
}

const LIBRARIAN = { librarian: { tools: 'read,grep,find,ls,edit,write' } };
const commitEvent = (shown) => shown.events.find((ev) => ev.kind === 'commit')?.body ?? '';

describe('commit_after_run', () => {
  it('[K-1] commits a file with a non-ASCII name instead of calling it "outside my directory"', async () => {
    const { dir, git } = makeRepo();
    const service = await start({ prepare: withFakeRuntime(LIBRARIAN) });
    const shown = await runToEnd(service, { role: 'librarian', task: 'write-file:笔记.md', cwd: dir }, 1);
    assert.match(commitEvent(shown), /Committed locally/, commitEvent(shown));
    assert.match(git('show', '--name-only', '--format=%s', 'HEAD'), /sub\/笔记\.md/);
  });

  it('[K-1] breaks a lock older than ten minutes and says so', async () => {
    const { top, dir, git } = makeRepo();
    const lock = path.join(top, '.git', 'test-ai-note.lock');
    fs.writeFileSync(lock, 'left behind by a dead process\n');
    const old = new Date(Date.now() - 20 * 60000);
    fs.utimesSync(lock, old, old);
    const service = await start({ prepare: withFakeRuntime({ librarian: { ...LIBRARIAN.librarian, commit_lock: '.git/test-ai-note.lock' } }) });
    const shown = await runToEnd(service, { role: 'librarian', task: 'write-file:note.md', cwd: dir }, 1);
    assert.match(commitEvent(shown), /Committed locally .* \(broke stale lock .* aged \d+ min\)/, commitEvent(shown));
    assert.match(git('show', '--name-only', '--format=%s', 'HEAD'), /sub\/note\.md/);
    assert.equal(fs.existsSync(lock), false, 'the lock is released afterwards');
  });

  it('[K-1] reports a lock it cannot create as an error at once, not as a busy lock to wait 30 seconds for', async () => {
    const { dir, git } = makeRepo();
    // sub/a.txt is a file, so nothing can be created under it: ENOTDIR (ENOENT on some platforms), never EEXIST.
    const service = await start({ prepare: withFakeRuntime({ librarian: { ...LIBRARIAN.librarian, commit_lock: 'sub/a.txt/x.lock' } }) });
    const begun = Date.now();
    const shown = await runToEnd(service, { role: 'librarian', task: 'write-file:note.md', cwd: dir }, 1);
    assert.match(commitEvent(shown), /Could not acquire lock sub\/a\.txt\/x\.lock \(E\w+\).*Not lock contention/, commitEvent(shown));
    assert.ok(Date.now() - begun < 15000, 'it did not wait out the 30 second deadline');
    assert.doesNotMatch(git('log', '--format=%s'), /整理|tidy/, 'nothing was committed');
  });
});

describe('sync_remote', () => {
  // The seat's repository is a clone of a bare "remote"; a second clone stands for the other machine.
  function makeSynced() {
    const { top, dir, git } = makeRepo();
    const remote = path.join(path.dirname(top), 'remote.git');
    git('init', '-q', '--bare', remote);
    git('remote', 'add', 'origin', remote);
    git('push', '-q', '-u', 'origin', 'HEAD');
    git('config', 'claude.allowPush', 'true');
    const other = path.join(path.dirname(top), 'other');
    execFileSync('git', ['clone', '-q', remote, other], { windowsHide: true, stdio: 'ignore' });
    const otherGit = (...args) => execFileSync('git', ['-C', other, '-c', 'user.name=o', '-c', 'user.email=o@example.com', ...args], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const remoteLog = () => execFileSync('git', ['-C', remote, 'log', '--format=%s', '--all'], { encoding: 'utf8', windowsHide: true });
    return { top, dir, git, other, otherGit, remoteLog };
  }
  const syncEvents = (shown) => shown.events.filter((ev) => ev.kind === 'sync').map((ev) => ev.body).join('\n');

  it('[K-4] merges what the other machine pushed before the run and pushes its own commit after', async () => {
    const { top, git, dir, other, otherGit, remoteLog } = makeSynced();
    fs.writeFileSync(path.join(other, 'sub', 'theirs.md'), 'from the other machine\n');
    otherGit('add', '-A');
    otherGit('commit', '-q', '-m', 'other machine note');
    otherGit('push', '-q');
    const service = await start({ prepare: withFakeRuntime(LIBRARIAN) });
    const shown = await runToEnd(service, { role: 'librarian', task: 'write-file:mine.md', cwd: dir }, 1);
    const said = syncEvents(shown);
    assert.match(said, /Merged 1 commit\(s\) from origin\/\S+/, said);
    assert.match(said, /pushed \d+ commit\(s\)/, said);
    assert.ok(fs.existsSync(path.join(top, 'sub', 'theirs.md')), 'the other machine\'s note is here');
    assert.match(remoteLog(), /tidy sub/, 'the seat\'s commit reached the remote');
    assert.equal(git('status', '--short', '--branch').split('\n')[0].includes('ahead'), false, 'nothing left unpushed');
  });

  // Both machines changed sub/a.txt, or (outside) a file outside the seat's directory.
  function conflicting(setup, file = path.join('sub', 'a.txt')) {
    const { top, git, other, otherGit } = setup;
    if (!file.startsWith('sub')) {
      fs.writeFileSync(path.join(top, file), 'base\n');
      git('add', file);
      git('commit', '-q', '-m', 'add outside file');
      git('push', '-q');
      otherGit('pull', '-q');
    }
    fs.writeFileSync(path.join(other, file), 'theirs\n');
    otherGit('commit', '-q', '-am', 'other machine edit');
    otherGit('push', '-q');
    fs.writeFileSync(path.join(top, file), 'mine\n');
    git('commit', '-q', '-am', 'local edit');
  }

  it('[K-4] hands a conflict in its directory to the seat, then merges and pushes what the seat wrote', async () => {
    const setup = makeSynced();
    const { top, git, dir, remoteLog } = setup;
    conflicting(setup);
    const service = await start({ prepare: withFakeRuntime(LIBRARIAN) });
    const shown = await runToEnd(service, { role: 'librarian', task: 'write-file:a.txt', cwd: dir }, 1);
    const said = syncEvents(shown);
    assert.match(said, /1 file\(s\) diverged when merging .* \(sub\/a\.txt\); handed to this run to resolve semantically/, said);
    assert.match(said, /Merged upstream keeping resolved content \(1 file\(s\): sub\/a\.txt\)/, said);
    assert.match(said, /pushed \d+ commit\(s\)/, said);
    // git may write the file back with CRLF on Windows (core.autocrlf); the text is what matters.
    assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8').replace(/\r\n/g, '\n'), 'written by the fake sleeper\n', 'the seat\'s version wins');
    assert.match(remoteLog(), /other machine edit/);
    assert.match(remoteLog(), /tidy sub/, 'the merged result reached the remote');
    assert.equal(fs.existsSync(path.join(dir, '.conflicts')), false, 'the conflict copies are gone');
    assert.doesNotMatch(git('log', '--name-only', '--format='), /\.conflicts/, 'and were never committed');
    assert.equal(fs.existsSync(path.join(top, '.git', 'MERGE_HEAD')), false, 'no merge left half done');
  });

  it('[K-4] a handed-over conflict the seat did not touch is not merged and not pushed', async () => {
    const setup = makeSynced();
    const { top, dir, remoteLog } = setup;
    conflicting(setup);
    const service = await start({ prepare: withFakeRuntime(LIBRARIAN) });
    const shown = await runToEnd(service, { role: 'librarian', task: 'write-file:mine.md', cwd: dir }, 1);
    const said = syncEvents(shown);
    assert.match(said, /Run did not modify sub\/a\.txt; conflicts unmerged, push skipped/, said);
    assert.equal(fs.existsSync(path.join(top, '.git', 'MERGE_HEAD')), false, 'no merge left half done');
    assert.doesNotMatch(remoteLog(), /整理|tidy|local edit/, 'nothing reached the remote');
  });

  it('[K-4] takes a conflict outside its directory back whole and does not push', async () => {
    const setup = makeSynced();
    const { top, dir, remoteLog } = setup;
    conflicting(setup, 'top.txt');
    const service = await start({ prepare: withFakeRuntime(LIBRARIAN) });
    const shown = await runToEnd(service, { role: 'librarian', task: 'write-file:mine.md', cwd: dir }, 1);
    const said = syncEvents(shown);
    assert.match(said, /Merge from origin\/\S+ failed \(conflicts: top\.txt; some outside this seat.+directory\).*aborted without pushing/, said);
    assert.equal(fs.existsSync(path.join(dir, '.conflicts')), false, 'nothing was handed over');
    assert.equal(fs.existsSync(path.join(top, '.git', 'MERGE_HEAD')), false, 'no merge left half done');
    assert.doesNotMatch(remoteLog(), /整理|tidy|local edit/, 'nothing reached the remote');
  });

  // K-5: the seat writes a plan file; the service hands it to the repository's mover. The fake
  // mover renames sub/a.txt to sub/b.txt, or fails when told to, and checks it got the plan's path.
  const MOVER = `import fs from 'node:fs';
if (!fs.existsSync(process.argv[2])) { console.log('no plan at ' + process.argv[2]); process.exit(2); }
if (process.env.FAIL_MOVE || fs.existsSync('fail-move')) { console.log('refused: target exists'); process.exit(1); }
fs.renameSync('sub/a.txt', 'sub/b.txt');
console.log('moved 1');
`;
  const MOVING = (plan = '.moves.json') => ({ librarian: { ...LIBRARIAN.librarian, move_plan: { file: plan, run: ['node', 'mover.mjs', '{plan}'] } } });

  it('[K-5] hands the seat\'s move plan to the repository\'s mover and keeps the plan out of the commit', async () => {
    const { top, dir, git } = makeRepo();
    fs.writeFileSync(path.join(top, 'mover.mjs'), MOVER);
    git('add', 'mover.mjs');
    git('commit', '-q', '-m', 'mover');
    const service = await start({ prepare: withFakeRuntime(MOVING()) });
    const shown = await runToEnd(service, { role: 'librarian', task: 'write-file:.moves.json', cwd: dir }, 1);
    const moved = shown.events.find((ev) => ev.kind === 'move')?.body ?? '';
    assert.match(moved, /Applied move plan: moved 1/, moved);
    assert.ok(fs.existsSync(path.join(dir, 'b.txt')) && !fs.existsSync(path.join(dir, '.moves.json')));
    const committed = git('show', '--name-status', '--format=', 'HEAD');
    assert.match(committed, /sub\/b\.txt/, committed);
    assert.doesNotMatch(committed, /\.moves\.json/, 'the plan is not committed');
  });

  it('[K-5] a mover that fails moves nothing, and the plan is reported, not committed', async () => {
    const { top, dir, git } = makeRepo();
    fs.writeFileSync(path.join(top, 'mover.mjs'), MOVER);
    fs.writeFileSync(path.join(top, 'fail-move'), '');
    git('add', 'mover.mjs', 'fail-move');
    git('commit', '-q', '-m', 'mover');
    const service = await start({ prepare: withFakeRuntime(MOVING()) });
    const shown = await runToEnd(service, { role: 'librarian', task: 'write-file:.moves.json', cwd: dir }, 1);
    const moved = shown.events.find((ev) => ev.kind === 'move')?.body ?? '';
    assert.match(moved, /Move plan failed \(exit 1\); nothing moved: refused: target exists\nPlan:\nwritten by the fake sleeper/, moved);
    assert.ok(fs.existsSync(path.join(dir, 'a.txt')) && !fs.existsSync(path.join(dir, '.moves.json')));
    assert.doesNotMatch(git('log', '--name-only', '--format='), /\.moves\.json/, 'the plan is not committed');
  });

  it('[K-4] does nothing to a repository that has not allowed pushing', async () => {
    const { dir, git } = makeSynced();
    git('config', '--unset', 'claude.allowPush');
    const service = await start({ prepare: withFakeRuntime(LIBRARIAN) });
    const shown = await runToEnd(service, { role: 'librarian', task: 'write-file:mine.md', cwd: dir }, 1);
    assert.equal(syncEvents(shown), '');
    assert.match(git('status', '--short', '--branch').split('\n')[0], /ahead 1/);
  });
});

describe('the directory baseline', () => {
  const CODER = { coder: { tools: 'read,grep,find,ls,edit,write,bash' } };

  it('is the state after a run for a seat that writes, and does not move when the run failed', async () => {
    const { dir } = makeRepo();
    const service = await start({ prepare: withFakeRuntime(CODER) });
    const first = await runToEnd(service, { role: 'coder', task: 'finish-after:10', cwd: dir }, 1);
    assert.deepEqual(first.seat.dir_state.dirty, [], 'a clean directory before and after');

    // Its own edit: part of what it has seen once the run is over.
    const second = await runToEnd(service, { role: 'coder', task: 'write-file:mine.txt', cwd: dir }, 2);
    assert.equal(second.seat.id, first.seat.id, 'the same expert');
    assert.ok(second.seat.dir_state.dirty.some((line) => line.includes('mine.txt')), `its own new file is in the baseline: ${JSON.stringify(second.seat.dir_state.dirty)}`);

    // Somebody else adds a file, then the run dies early with an error report: the baseline stays put,
    // so the seat is told about that file again on its next visit.
    fs.writeFileSync(path.join(dir, 'theirs.txt'), 'x\n');
    const third = await runToEnd(service, { role: 'coder', task: 'fail-error', cwd: dir }, 3);
    assert.equal(third.seat.state, 'failed');
    assert.deepEqual(third.seat.dir_state, second.seat.dir_state, 'a failed run leaves the baseline alone');
  });
});

describe('a domain expert', () => {
  // web_researcher (roles.json expert_by "domain") is recognised by its field of knowledge, not by a
  // directory: the caller passes a domain, the service gives the seat a directory of its own under
  // .data/domains, and the directory-change notices do not apply. The runtime is the fake sleeper.
  const WEB = { web_researcher: { tools: 'read,grep,find,ls,bash', expert_by: 'domain' } };

  it('[E-3][E-4][E-6] sends the same domain to the same seat, ignores cwd, and carries no directory baseline', async () => {
    const cwd = tempDir('ssa-domain-');
    scratches.push(cwd);
    const service = await start({ prepare: withFakeRuntime(WEB) });

    const first = await service.call('POST', '/seat/start', { role: 'web_researcher', task: 'finish-after:10', domain: 'AI' });
    assert.equal(first.status, 200, first.text);
    const seat = first.json.seat;
    assert.equal(first.json.reused, false);
    assert.match(first.json.note, /domain/);
    const done1 = await until(async () => {
      const { json } = await service.call('GET', `/seats/${seat}?tail=all`);
      return json.seat.state === 'done' ? json : null;
    }, 'the first domain run to end');
    // The seat works in a service-given directory under .data/domains, not in any caller's.
    assert.match(done1.seat.cwd.replaceAll('\\', '/'), /\/\.data\/domains\/web_researcher\//);
    assert.equal(done1.seat.domain, 'ai', 'the domain is normalised (AI -> ai) and recorded');
    assert.ok(done1.events.some((e) => e.kind === 'cwd' && /domain-tracked/.test(String(e.body))), 'the ledger says why the directory was chosen');
    assert.equal(done1.seat.dir_state, null, 'a domain seat keeps no directory baseline');

    // The second dispatch, same domain spelled differently, returns to the same seat.
    const again = await service.call('POST', '/seat/start', { role: 'web_researcher', task: 'finish-after:10', domain: ' ai ' });
    assert.equal(again.status, 200, again.text);
    assert.equal(again.json.seat, seat);
    assert.equal(again.json.reused, true);
    assert.match(again.json.note, /domain/);
    await until(async () => {
      const { json } = await service.call('GET', `/seats/${seat}?tail=all`);
      return json.events.filter((e) => e.kind === 'exit').length === 2 ? json : null;
    }, 'the second domain run to end');

    // A cwd is not this role's identity: refused, in words, with the existing domains named.
    const seatsBefore = (await service.call('GET', '/seats')).json.length;
    const refused = await service.call('POST', '/seat/start', { role: 'web_researcher', task: 'x', cwd });
    assert.notEqual(refused.status, 200, refused.text);
    assert.match(refused.text, /domain/);
    assert.match(refused.text, /service creates and assigns a fixed domain directory/);
    assert.match(refused.text, /Existing domains: ai/);
    assert.equal((await service.call('GET', '/seats')).json.length, seatsBefore, 'a refused dispatch opens no seat');

    // The domain is shown where a directory would be, and the list can filter by it.
    const byDomain = (await service.call('GET', '/seats?view=compact&domain=ai')).json;
    assert.deepEqual(byDomain.map((r) => r.seat), [seat]);
    assert.equal(byDomain[0].domain, 'ai');
    assert.deepEqual((await service.call('GET', '/seats?view=compact&domain=bio')).json, []);
  });
});

// E-3 (2026-10-24, todo.md): the object is the directory plus the topic. In D:\repos\app a tester with
// no topic took a dispatch with topic "falsify-r17-r19" (run 46086), because a directory with one
// expert used it whatever topic came along; no expert for the topic was ever opened.
describe('[E-3] a topic picks its own expert, also beside a single expert', () => {
  let env;
  let store;
  const dirs = [];
  before(async () => {
    env = await loadStore();
    store = env.store;
  });
  after(() => {
    env?.cleanup();
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });
  const dir = () => {
    const made = tempDir('ssa-topic-');
    dirs.push(made);
    return made;
  };
  // A finished run: the seat holds a session and is free again.
  const finish = (opened) => {
    store.setSeatProfile({ seat: opened.seat, sessionFile: path.join(dirs[0], `${opened.seat}.jsonl`) });
    store.setSeatState({ seat: opened.seat, state: 'done' });
    return opened;
  };

  it('[E-3] a new topic beside a topic-less expert opens a new expert for it; no topic still goes to the old one', () => {
    const cwd = dir();
    const old = finish(store.claimSeat({ role: 'tester', cwd }));
    const topical = store.claimSeat({ role: 'tester', cwd, topic: 'falsify-r17-r19' });
    assert.notEqual(topical.seat, old.seat, 'the topic did not land on the topic-less expert');
    assert.equal(topical.reused, false);
    assert.equal(topical.topic, 'falsify-r17-r19');
    assert.match(topical.name, /falsify-r17-r19/);
    assert.deepEqual(topical.others.map((o) => o.seat), [old.seat], 'the reply can name the directory\'s other expert');
    finish(topical);
    assert.equal(store.claimSeat({ role: 'tester', cwd }).seat, old.seat, 'without a topic: the one without a topic');
    finish(old);
    assert.equal(store.claimSeat({ role: 'tester', cwd, topic: ' falsify-r17-r19 ' }).seat, topical.seat, 'the same topic comes back to its expert');
  });

  it('[E-3] without a topic: a lone topic expert is used; several with none topic-less are refused with candidates', () => {
    const cwd = dir();
    const delta = finish(store.claimSeat({ role: 'tester', cwd, topic: 'delta' }));
    assert.equal(store.claimSeat({ role: 'tester', cwd }).seat, delta.seat, 'the only expert of the directory');
    finish(delta);
    finish(store.claimSeat({ role: 'tester', cwd, topic: 'eps' }));
    assert.throws(() => store.claimSeat({ role: 'tester', cwd }), (err) => /pass topic/.test(err.message) && err.payload?.candidates?.length === 2);
  });
});
