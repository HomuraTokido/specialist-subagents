// The second half of the skill loop (architecture-v2 step 4): five new difficulties of one role start
// the refiner on their own, its candidate waits for review, the lead judges each difficulty and
// enables or rejects it, and only enabling writes a skill into HSkills.
//
// Everything runs on a throwaway copy of the service. The refiner's runtime is
// tests/fakes/fake-refiner.mjs, which writes SKILL.md and why.md into the batch's scratch directory the
// way the real one is told to. HSkills is a temp directory, named through SPECIALIST_SUBAGENTS_HSKILLS:
// no test touches the real one.
//
// The last part is what every run carries (architecture 4.5, I4): the role's skill in its system
// prompt, a seat event naming the version, and the new text in front of the task of a continued session
// when the skill changed. Codex is the fake one, DeepSeek runs seat-runner against the fake pi SDK.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { checkSkillText, skillBody } from '../src/skill-text.mjs';
import { startMcp } from './lib/mcp.mjs';
import { FAKE_PI_CLI, REPO, sleep, startService, tempDir } from './lib/sandbox.mjs';

const FAKE_REFINER = path.join(REPO, 'tests', 'fakes', 'fake-refiner.mjs');

const cleanups = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()();
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

// A service whose refiner is the fake one, an empty HSkills with a `skills` directory, and a mode file
// the test can rewrite between runs. `skills` seeds existing skills: { 'h-explorer': 'text' }.
async function start({ skills = {}, env = {}, mutateRoles = null } = {}) {
  const hskills = tempDir('ssa-hskills-');
  fs.mkdirSync(path.join(hskills, 'skills'), { recursive: true });
  for (const [name, text] of Object.entries(skills)) {
    fs.mkdirSync(path.join(hskills, 'skills', name), { recursive: true });
    fs.writeFileSync(path.join(hskills, 'skills', name, 'SKILL.md'), text);
  }
  const modeFile = path.join(hskills, 'mode');
  // Registered first: a service that refuses to start still leaves this directory behind.
  cleanups.push(() => fs.rmSync(hskills, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  const service = await startService({
    env: { SPECIALIST_SUBAGENTS_HSKILLS: hskills, FAKE_REFINER_MODE_FILE: modeFile, ...env },
    prepare: (root) => {
      fs.copyFileSync(FAKE_REFINER, path.join(root, 'src', 'fake-refiner.mjs'));
      const file = path.join(root, 'roles.json');
      const roles = JSON.parse(fs.readFileSync(file, 'utf8'));
      roles.refiner.spawn.args = ['src/fake-refiner.mjs', '--pi', '{runtime}', '--tools', 'read,grep,find,ls,edit,write', '-p', '{task}'];
      if (mutateRoles) mutateRoles(roles);
      fs.writeFileSync(file, JSON.stringify(roles, null, 2));
    },
  });
  cleanups.push(() => service.stop());
  const dbFile = path.join(service.root, '.data', 'ledger.sqlite3');
  const query = (sql, ...args) => {
    const db = new DatabaseSync(dbFile, { readOnly: true });
    try {
      return db.prepare(sql).all(...args);
    } finally {
      db.close();
    }
  };
  // For planting a row the service would only leave behind after a crash.
  const write = (fn) => {
    const db = new DatabaseSync(dbFile);
    try {
      db.exec('PRAGMA busy_timeout = 5000');
      return fn(db);
    } finally {
      db.close();
    }
  };
  const mcp = startMcp(service);
  cleanups.push(() => mcp.close());
  const skillFile = (name) => path.join(hskills, 'skills', name, 'SKILL.md');
  return { service, hskills, modeFile, query, write, mcp, skillFile };
}

// One difficulty of `role`: a verdict of "revised" on a seat of that role is written to the difficulty
// ledger. A seat is opened once per role and reused.
async function addDifficulty(t, role, n) {
  t.seats ??= {};
  if (!t.seats[role]) {
    const opened = await t.service.call('POST', '/seat/open', { role });
    assert.equal(opened.status, 200, opened.text);
    t.seats[role] = opened.json.seat;
  }
  const verdict = await t.service.call('POST', '/seat/verdict', { seat: t.seats[role], verdict: 'revised', note: `difficulty ${n} of ${role}` });
  assert.equal(verdict.status, 200, verdict.text);
}

const refinerSeats = async (t) => (await t.service.call('GET', '/seats')).json.filter((seat) => seat.role === 'refiner');
const candidateRows = (t, role) => t.query('SELECT * FROM candidates WHERE role = ? ORDER BY id', role);
const waitForCandidate = (t, role, count = 1) => until(() => (candidateRows(t, role).length >= count ? candidateRows(t, role) : null), `${count} candidate(s) of ${role}`);

describe('the trigger', () => {
  it('[S-2] four new difficulties start nothing, the fifth starts one refiner, and one batch makes one candidate', async () => {
    const t = await start();
    for (let n = 1; n <= 4; n += 1) await addDifficulty(t, 'explorer', n);
    await sleep(600);
    assert.equal((await refinerSeats(t)).length, 0, 'four difficulties must not start the refiner');
    assert.match((await t.service.call('GET', '/candidates')).json.text, /- explorer: 4\/5 new difficulties since last candidate/);

    await addDifficulty(t, 'explorer', 5);
    const rows = await waitForCandidate(t, 'explorer');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].state, 'pending', 'a candidate is not enabled');
    // Five rows of one class: the candidate records the class once, by its newest row, and the refiner
    // was told how often it came up.
    const ids = JSON.parse(rows[0].difficulty_ids);
    assert.deepEqual(ids, [Math.max(...t.query("SELECT seq FROM difficulties WHERE role = 'explorer'").map((r) => Number(r.seq)))]);
    const [run] = t.query('SELECT work_dir FROM candidate_runs');
    assert.match(fs.readFileSync(path.join(run.work_dir, 'evidence.md'), 'utf8'), /共 5 次/);
    assert.equal(fs.existsSync(rows[0].file), true, 'the body is a file');
    assert.match(fs.readFileSync(rows[0].file, 'utf8'), /^---\nname: h-explorer\n/);
    assert.equal(t.query('SELECT * FROM skill_versions').length, 0, 'nothing is written to a skill by the trigger');
    assert.equal(fs.existsSync(t.skillFile('h-explorer')), false);
    assert.equal((await refinerSeats(t)).length, 1);
    // The refiner's scratch seat is not a directory expert a dispatch could land on: the lead's listing
    // leaves it out, and only asking for its state finds it.
    assert.equal((await t.service.call('GET', '/seats?view=compact')).json.filter((row) => row.role === 'refiner').length, 0);
    assert.equal((await t.service.call('GET', '/seats?view=compact&state=done')).json.filter((row) => row.role === 'refiner').length, 1);

    // Two more difficulties while the candidate waits: no second refiner, no second candidate.
    await addDifficulty(t, 'explorer', 6);
    await addDifficulty(t, 'explorer', 7);
    await sleep(600);
    assert.equal(candidateRows(t, 'explorer').length, 1);
    assert.equal((await refinerSeats(t)).length, 1);
    assert.match((await t.service.call('GET', '/candidates')).json.text, /- explorer: 2\/5 new difficulties since last candidate \(has a candidate awaiting review/);
  });

  it('[S-2] counts per role: five spread over two roles start nothing', async () => {
    const t = await start();
    for (let n = 1; n <= 3; n += 1) await addDifficulty(t, 'coder', n);
    for (let n = 1; n <= 2; n += 1) await addDifficulty(t, 'tester', n);
    await sleep(600);
    assert.equal((await refinerSeats(t)).length, 0);
  });

  it('[S-2] handyman does not get the loop: five difficulties are recorded and no refiner is sent', async () => {
    const t = await start();
    for (let n = 1; n <= 5; n += 1) await addDifficulty(t, 'handyman', n);
    await sleep(600);
    assert.equal((await refinerSeats(t)).length, 0, 'no refiner is dispatched for handyman');
    assert.equal(candidateRows(t, 'handyman').length, 0, 'no candidate is written for handyman');
    assert.equal(t.query("SELECT * FROM difficulties WHERE role = 'handyman'").length, 5, 'the five difficulties are still recorded');
    assert.match((await t.service.call('GET', '/difficulties')).json.text, /handyman/);
    assert.match((await t.service.call('GET', '/candidates')).json.text, /- handyman: excluded from skill loop/);
  });

  it('the first candidate for a post with no skill yet is the first version of that skill', async () => {
    const t = await start();
    for (let n = 1; n <= 5; n += 1) await addDifficulty(t, 'explorer', n);
    const [row] = await waitForCandidate(t, 'explorer');
    assert.equal(row.base_sha, null);
    assert.match(fs.readFileSync(row.file, 'utf8'), /First version/);
  });

  it('dispatches whichever post roles.json marks skill_refiner, and says so when none is marked', async () => {
    const t = await start({ mutateRoles: (roles) => { delete roles.refiner.skill_refiner; } });
    for (let n = 1; n <= 5; n += 1) await addDifficulty(t, 'explorer', n);
    await sleep(600);
    assert.equal((await refinerSeats(t)).length, 0, 'nothing is dispatched without a marked post');
    assert.equal(candidateRows(t, 'explorer').length, 0);
    assert.match((await t.service.call('GET', '/candidates')).json.text, /- explorer: 5\/5 new difficulties since last candidate \(no skill_refiner role in roles\.json/);
  });

  it('refuses to start when two posts claim to be the refiner', async () => {
    await assert.rejects(
      start({ mutateRoles: (roles) => { roles.coder.skill_refiner = true; } }),
      /skill_refiner/
    );
  });

  it('[R-3] refuses to start on a skill_loop that is not a boolean', async () => {
    await assert.rejects(
      start({ mutateRoles: (roles) => { roles.coder.skill_loop = 'no'; } }),
      /skill_loop/
    );
  });

  it('refuses to start on a skill name HSkills\' lint would refuse', async () => {
    await assert.rejects(start({ mutateRoles: (roles) => { roles.coder.skill = 'h--coder'; } }), /skill must be an HSkills directory name/);
  });
});

describe('a backlog of difficulties', () => {
  it('[S-2] hands the refiner the whole backlog by class, and does not chain a second candidate after a decision', async () => {
    const t = await start({ env: { SPECIALIST_SUBAGENTS_REFINE_RETRY_MS: '800' } });
    fs.writeFileSync(t.modeFile, 'fail');
    // Twelve pile up behind a refiner that fails: the five that started it, then seven more.
    for (let n = 1; n <= 12; n += 1) await addDifficulty(t, 'coder', n);
    await until(() => t.query("SELECT * FROM candidate_runs WHERE status = 'failed'")[0] ?? null, 'the failed attempt');
    await sleep(900);
    fs.writeFileSync(t.modeFile, 'ok');
    await addDifficulty(t, 'coder', 13);
    const [candidate] = await waitForCandidate(t, 'coder');
    const all = t.query("SELECT seq FROM difficulties WHERE role = 'coder' ORDER BY seq").map((row) => Number(row.seq));
    assert.equal(all.length, 13);
    assert.deepEqual(JSON.parse(candidate.difficulty_ids), all.slice(-1), 'one class, recorded by its newest row');
    // The newest attempt is the one that made the candidate. Not "status = 'done'": the candidate row is
    // written a moment before its run row is marked done, and a read in between finds none (Windows CI).
    const [run] = t.query('SELECT work_dir FROM candidate_runs ORDER BY id DESC LIMIT 1');
    assert.match(fs.readFileSync(path.join(run.work_dir, 'evidence.md'), 'utf8'), /共 13 次/, 'the refiner sees the whole backlog, not the newest five');
    assert.doesNotMatch((await t.service.call('GET', '/candidates')).json.text, /coder：上次候选版本之后的新困难/, 'everything the refiner was shown counts as looked at');

    const real = JSON.parse(candidate.difficulty_ids).map((difficulty) => ({ difficulty, verdict: 'real' }));
    assert.equal((await t.mcp.tool('candidate_decide', { id: candidate.id, verdicts: real, decision: 'reject', note: 'not now' })).isError, false);
    await sleep(600);
    assert.equal(candidateRows(t, 'coder').length, 1, 'a decision does not start a second candidate from older evidence');
    assert.equal(t.query('SELECT * FROM candidate_runs').length, 2, 'one failed attempt and one that made the candidate');
  });
});

describe('the refiner counts toward its own loop only for what it did, not for what the service did to it', () => {
  it('a failed refiner run is not a difficulty of the refiner, but the lead\'s verdict on its seat is', async () => {
    const t = await start();
    fs.writeFileSync(t.modeFile, 'fail');
    for (let n = 1; n <= 5; n += 1) await addDifficulty(t, 'tester', n);
    const failed = await until(() => t.query("SELECT * FROM candidate_runs WHERE status = 'failed'")[0] ?? null, 'the failed attempt');
    // The premise: the failed run did leave a run-failure difficulty on the refiner's seat.
    await until(() => t.query("SELECT * FROM difficulties WHERE role = 'refiner' AND kind = 'failed'")[0] ?? null, 'the failure in the difficulty ledger');
    assert.doesNotMatch((await t.service.call('GET', '/candidates')).json.text, /- refiner: .*new difficulties since/);

    const verdict = await t.service.call('POST', '/seat/verdict', { seat: failed.seat, verdict: 'revised', note: 'what it did needed fixing' });
    assert.equal(verdict.status, 200, verdict.text);
    assert.match((await t.service.call('GET', '/candidates')).json.text, /- refiner: 1\/5 new difficulties since last candidate/);
  });
});

// A row the service only writes from a run's traces, planted directly: `at` defaults to now.
function plantDifficulty(t, { seat, role, kind, tool = null, run = null, detail = null, at = new Date().toISOString() }) {
  return t.write((db) => Number(db
    .prepare('INSERT INTO difficulties (seat, run, role, kind, tool, detail, at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(seat, run, role, kind, tool, detail ?? `planted ${kind}`, at).lastInsertRowid));
}

// Four difficulties of four different classes (tool errors), then a fifth of a fifth class through a
// verdict, which is what starts the refiner: a candidate with five classes to judge.
async function addFiveClasses(t, role) {
  for (const tool of ['read', 'grep', 'find', 'edit']) plantDifficulty(t, { seat: `seat-${role}-planted`, role, kind: 'error', tool });
  await addDifficulty(t, role, 5);
}

describe('what counts toward a batch', () => {
  it('[S-2] counts the run failures of a seat started without an owner, and of a seat that is gone', async () => {
    const t = await start();
    await addDifficulty(t, 'coder', 1);
    const seat = t.seats.coder;
    assert.equal(t.query('SELECT owner FROM seats WHERE id = ?', seat)[0].owner, null, 'the premise: a seat opened without an owner');
    const planted = [
      plantDifficulty(t, { seat, role: 'coder', kind: 'failed' }),
      plantDifficulty(t, { seat, role: 'coder', kind: 'failed', tool: 'timeout' }),
      plantDifficulty(t, { seat: 'seat-coder-gone', role: 'coder', kind: 'failed' }),
    ];
    await addDifficulty(t, 'coder', 2);
    const [candidate] = await waitForCandidate(t, 'coder');
    const ids = JSON.parse(candidate.difficulty_ids);
    // Three classes: revised, failed, failed × timeout. The run failures are in, each class by its newest row.
    assert.equal(ids.length, 3);
    assert.ok(ids.includes(planted[1]), 'the timeout failure is in the batch');
    assert.ok(ids.includes(planted[2]), 'the failures of a seat without an owner and of a seat that is gone are in the batch');
  });

  it('leaves out the run failures that are not the post\'s craft: a model refusal, a quota, a process that could not start', async () => {
    const t = await start();
    const seat = 'seat-coder-infra';
    for (const detail of ['运行失败：claude 干到一半失败了（{"subtype":"model_refusal_no_fallback"}）', 'You\'ve hit your usage limit.', '运行失败：spawn ENAMETOOLONG', '进程未能启动（helper_unknown_error: setup refresh had errors）']) {
      plantDifficulty(t, { seat, role: 'coder', kind: 'failed', detail });
    }
    // The lead's own words in a rejected verdict, with no error code in them.
    plantDifficulty(t, { seat, role: 'coder', kind: 'rejected', detail: '缩短任务仍在spawn失败，未执行；本单收回main。' });
    // A stop by the model's safety filter is its own kind, and stays out by its kind, whatever its text.
    for (let n = 1; n <= 5; n += 1) plantDifficulty(t, { seat, role: 'coder', kind: 'refused', tool: 'claude', detail: `还没动手就被拦 ${n}` });
    await addDifficulty(t, 'coder', 1);
    await sleep(600);
    assert.equal(candidateRows(t, 'coder').length, 0, 'five infrastructure failures and one real difficulty are not a batch');
    assert.match((await t.service.call('GET', '/candidates')).json.text, /- coder: 1\/5 new difficulties since last candidate/);
  });

  it('[S-2] leaves out the classes the lead already closed with difficulty_decide, and counts what came after', async () => {
    const t = await start();
    const earlier = new Date(Date.now() - 60 * 1000).toISOString();
    const closed = [1, 2, 3, 4].map(() => plantDifficulty(t, { seat: 'seat-explorer-old', role: 'explorer', kind: 'empty', tool: 'bash', at: earlier }));
    const decided = await t.service.call('POST', '/difficulties/decide', { class: 'explorer|empty|bash', decision: 'accept', note: 'rg exit 1 is no match' });
    assert.equal(decided.status, 200, decided.text);
    const after = plantDifficulty(t, { seat: 'seat-explorer-old', role: 'explorer', kind: 'empty', tool: 'bash', at: new Date(Date.now() + 1000).toISOString() });
    for (let n = 1; n <= 3; n += 1) await addDifficulty(t, 'explorer', n);
    await sleep(600);
    assert.equal(candidateRows(t, 'explorer').length, 0, 'four open ones are not a batch, however many closed ones there are');
    assert.match((await t.service.call('GET', '/candidates')).json.text, /- explorer: 4\/5 new difficulties since last candidate/);

    await addDifficulty(t, 'explorer', 4);
    const [candidate] = await waitForCandidate(t, 'explorer');
    const ids = JSON.parse(candidate.difficulty_ids);
    for (const id of closed) assert.equal(ids.includes(id), false, `closed #${id} is not evidence`);
    assert.ok(ids.includes(after), 'a recurrence after the verdict is new evidence');
  });

  it('takes the difficulties judged in a candidate that was decided out of the class report', async () => {
    const t = await start();
    for (let n = 1; n <= 5; n += 1) await addDifficulty(t, 'tester', n);
    const [candidate] = await waitForCandidate(t, 'tester');
    const before = (await t.service.call('GET', '/difficulties')).json;
    assert.ok(before.classes.some((g) => g.class === 'tester|revised|-'), 'the premise: the class waits for a verdict');
    const judged = JSON.parse(candidate.difficulty_ids).map((difficulty) => ({ difficulty, verdict: 'invalid' }));
    assert.equal((await t.mcp.tool('candidate_decide', { id: candidate.id, verdicts: judged, decision: 'reject', note: 'all wrong briefs' })).isError, false);
    const afterDecision = (await t.service.call('GET', '/difficulties')).json;
    assert.equal(afterDecision.classes.some((g) => g.class === 'tester|revised|-'), false, 'judged once, not asked again');
    assert.equal(afterDecision.reminder, null);
  });
});

describe('what the refiner is given', () => {
  it('copies the reports and HSkills\' writing spec into its directory, since it may not read outside it', async () => {
    const spec = '---\nname: skill-creator\ndescription: how to write a skill\n---\n\nAssertions not run here are marked 未验.\n';
    const t = await start({ skills: { 'skill-creator': spec } });
    const reportDir = path.join(t.service.root, '.data', 'reports', 'seat-explorer-77');
    fs.mkdirSync(reportDir, { recursive: true });
    fs.writeFileSync(path.join(reportDir, '1234.md'), 'THE REPORT TEXT');
    plantDifficulty(t, { seat: 'seat-explorer-77', role: 'explorer', kind: 'error', tool: 'read', run: 'seat-explorer-77#1234' });
    for (let n = 1; n <= 4; n += 1) await addDifficulty(t, 'explorer', n);
    await waitForCandidate(t, 'explorer');
    const [run] = t.query('SELECT work_dir FROM candidate_runs');
    const evidence = fs.readFileSync(path.join(run.work_dir, 'evidence.md'), 'utf8');
    assert.match(evidence, /这一单的报告：reports\/seat-explorer-77-1234\.md/);
    assert.equal(evidence.includes(path.join('.data', 'reports')), false, 'no path outside the directory');
    assert.equal(fs.readFileSync(path.join(run.work_dir, 'reports', 'seat-explorer-77-1234.md'), 'utf8'), 'THE REPORT TEXT');
    assert.equal(fs.readFileSync(path.join(run.work_dir, 'skill-spec.md'), 'utf8'), spec);
    assert.match(evidence, /未验/);
  });
});

describe('a refiner that judges no change is needed', () => {
  it('records the batch as looked at, files the reasons, makes no candidate and does not retry it', async () => {
    const original = '---\nname: h-tester\ndescription: the original\n---\n\n# h-tester\n\nOriginal.\n';
    const t = await start({ skills: { 'h-tester': original }, env: { SPECIALIST_SUBAGENTS_REFINE_RETRY_MS: '0' } });
    fs.writeFileSync(t.modeFile, 'same');
    for (let n = 1; n <= 5; n += 1) await addDifficulty(t, 'tester', n);
    const run = await until(() => t.query("SELECT * FROM candidate_runs WHERE status = 'nochange'")[0] ?? null, 'the no-change answer');
    assert.equal(candidateRows(t, 'tester').length, 0, 'no candidate');
    assert.match(run.detail, /judged no skill change needed/);
    const whyFile = /\(rationale in (.+?)\)\./.exec(run.detail)[1];
    assert.match(fs.readFileSync(whyFile, 'utf8'), /没有改动/);
    assert.equal(fs.readFileSync(t.skillFile('h-tester'), 'utf8'), original, 'nothing is written to the skill');
    assert.doesNotMatch((await t.service.call('GET', '/candidates')).json.text, /- tester: .*new difficulties since/, 'the batch counts as looked at');

    // One more difficulty is new evidence, not a retry of the batch the refiner already answered.
    await addDifficulty(t, 'tester', 6);
    await sleep(500);
    assert.equal(t.query('SELECT * FROM candidate_runs').length, 1);
    assert.match((await t.service.call('GET', '/candidates')).json.text, /- tester: 1\/5 new difficulties since last candidate \(previous batch judged no change needed/);
  });
});

describe('a manual trigger', () => {
  it('asks the loop now with the usual checks: says why when a role is not due, and starts the refiner when it is', async () => {
    const t = await start();
    // Rows the service only reads off traces, planted: no run ended and no verdict was given, so none of
    // the other three moments came.
    for (let n = 1; n <= 3; n += 1) plantDifficulty(t, { seat: 'seat-coder-planted', role: 'coder', kind: 'error', tool: 'bash' });
    const short = await t.service.call('POST', '/skill-loop/refine', { role: 'coder' });
    assert.equal(short.status, 200, short.text);
    assert.equal(short.json.started, false);
    assert.match(short.json.text, /3 new difficulties accumulated; 5 required/);

    for (let n = 4; n <= 5; n += 1) plantDifficulty(t, { seat: 'seat-coder-planted', role: 'coder', kind: 'error', tool: 'bash' });
    await sleep(400);
    assert.equal(t.query('SELECT * FROM candidate_runs').length, 0, 'planting alone starts nothing');
    const due = await t.service.call('POST', '/skill-loop/refine', { role: 'coder' });
    assert.equal(due.json.started, true, due.text);
    assert.match(due.json.text, /Refiner dispatched for coder/);
    await waitForCandidate(t, 'coder');

    const unknown = await t.service.call('POST', '/skill-loop/refine', { role: 'nobody' });
    assert.equal(unknown.json.started, false);
    assert.match(unknown.json.text, /Role does not exist/);
  });
});

describe('a supersede', () => {
  it('sets an old candidate aside unjudged, puts its difficulties back in the count, and hands its summary and files to the next refiner', async () => {
    const t = await start();
    for (let n = 1; n <= 5; n += 1) await addDifficulty(t, 'explorer', n);
    const [old] = await waitForCandidate(t, 'explorer');

    const noNote = await t.mcp.tool('candidate_decide', { id: old.id, decision: 'supersede' });
    assert.equal(noNote.isError, true, 'a supersede needs the summary');
    const done = await t.mcp.tool('candidate_decide', { id: old.id, decision: 'supersede', note: 'KEEP THE ANCHOR RULE' });
    assert.equal(done.isError, false, done.text);
    assert.equal(t.query('SELECT state FROM candidates WHERE id = ?', old.id)[0].state, 'superseded');
    assert.equal(t.query('SELECT * FROM difficulty_verdicts').length, 0, 'nothing was judged');

    // Its five count again, so the decision itself starts the next refiner, which reads the summary.
    const rows = await waitForCandidate(t, 'explorer', 2);
    assert.equal(rows[1].state, 'pending');
    const [, run] = t.query('SELECT work_dir FROM candidate_runs ORDER BY id');
    const evidence = fs.readFileSync(path.join(run.work_dir, 'evidence.md'), 'utf8');
    assert.match(evidence, /共 5 次/, 'the whole backlog again');
    assert.match(evidence, /KEEP THE ANCHOR RULE/);
    assert.equal(fs.existsSync(path.join(run.work_dir, 'superseded', `v${old.version}.SKILL.md`)), true, 'the old body is copied in');
    assert.equal((await t.mcp.tool('candidate_decide', { id: old.id, decision: 'enable' })).isError, true, 'a superseded candidate is final');
  });
});

describe('a defer', () => {
  it('lets a batch that filled while the candidate waited start right away', async () => {
    const t = await start();
    for (let n = 1; n <= 5; n += 1) await addDifficulty(t, 'explorer', n);
    const [first] = await waitForCandidate(t, 'explorer');
    for (let n = 6; n <= 10; n += 1) await addDifficulty(t, 'explorer', n);
    await sleep(400);
    assert.equal(candidateRows(t, 'explorer').length, 1, 'the pending one holds the role');
    assert.match((await t.service.call('GET', '/candidates')).json.text, /- explorer: 5\/5 new difficulties since last candidate \(has a candidate awaiting review/);
    assert.equal((await t.mcp.tool('candidate_decide', { id: first.id, decision: 'defer' })).isError, false);
    const rows = await waitForCandidate(t, 'explorer', 2);
    assert.equal(rows[1].state, 'pending');
  });
});

describe('a refiner run nobody is watching', () => {
  it('stops blocking the role once its seat has sat open without a process, and closes that seat', async () => {
    const t = await start({ env: { SPECIALIST_SUBAGENTS_REFINE_RETRY_MS: '0' } });
    // The service went down between claiming the seat and starting it, an hour ago.
    const opened = await t.service.call('POST', '/seat/open', { role: 'refiner' });
    assert.equal(opened.status, 200, opened.text);
    t.write((db) => db
      .prepare("INSERT INTO candidate_runs (role, difficulty_ids, seat, status, started_at) VALUES ('tester', '[1,2,3,4,5]', ?, 'running', ?)")
      .run(opened.json.seat, new Date(Date.now() - 60 * 60 * 1000).toISOString()));

    for (let n = 1; n <= 5; n += 1) await addDifficulty(t, 'tester', n);
    await waitForCandidate(t, 'tester');
    const [lost] = t.query('SELECT * FROM candidate_runs ORDER BY id');
    assert.equal(lost.status, 'failed');
    assert.match(lost.detail, /stayed open/);
    assert.equal((await t.service.call('GET', `/seats/${opened.json.seat}`)).json.seat.state, 'closed');
  });
});

describe('a refiner run that fails', () => {
  it('leaves the five counted, does not retry in a tight loop, and tries again once the wait is over', async () => {
    const t = await start({ env: { SPECIALIST_SUBAGENTS_REFINE_RETRY_MS: '1500' } });
    fs.writeFileSync(t.modeFile, 'fail');
    for (let n = 1; n <= 5; n += 1) await addDifficulty(t, 'tester', n);
    const failed = await until(() => t.query("SELECT * FROM candidate_runs WHERE status = 'failed'")[0] ?? null, 'the failed attempt');
    assert.match(failed.detail, /without producing a candidate/);
    assert.equal(candidateRows(t, 'tester').length, 0);
    const text = (await t.service.call('GET', '/candidates')).json.text;
    assert.match(text, /- tester: 5\/5 new difficulties since last candidate \(last refinement failed/, text);

    // A sixth difficulty right away is inside the wait: no new attempt.
    await addDifficulty(t, 'tester', 6);
    await sleep(500);
    assert.equal((await refinerSeats(t)).length, 1);
    assert.equal(t.query('SELECT * FROM candidate_runs').length, 1);

    // After the wait, with a refiner that works, the next difficulty retries: with all seven that are
    // counted by then (one class, recorded by its newest row), not with what the failed attempt had.
    await sleep(1300);
    fs.writeFileSync(t.modeFile, 'ok');
    await addDifficulty(t, 'tester', 7);
    const [row] = await waitForCandidate(t, 'tester');
    const all = t.query("SELECT seq FROM difficulties WHERE role = 'tester' ORDER BY seq").map((r) => Number(r.seq));
    assert.deepEqual(JSON.parse(row.difficulty_ids), all.slice(-1));
    assert.notDeepEqual(JSON.parse(row.difficulty_ids), JSON.parse(failed.difficulty_ids));
    assert.equal(t.query('SELECT * FROM candidate_runs').length, 2);
  });

  it('counts a SKILL.md that HSkills would refuse (no frontmatter) as a failed attempt, not a candidate', async () => {
    const t = await start();
    fs.writeFileSync(t.modeFile, 'bad');
    for (let n = 1; n <= 5; n += 1) await addDifficulty(t, 'librarian', n);
    const failed = await until(() => t.query("SELECT * FROM candidate_runs WHERE status = 'failed'")[0] ?? null, 'the failed attempt');
    assert.match(failed.detail, /frontmatter/);
    assert.equal(candidateRows(t, 'librarian').length, 0);
  });

  it('refuses a description that HSkills lint would refuse, when the refiner writes it and again when the lead enables an edited file', async () => {
    const t = await start({ env: { SPECIALIST_SUBAGENTS_REFINE_RETRY_MS: '0' } });
    fs.writeFileSync(t.modeFile, 'desc');
    for (let n = 1; n <= 5; n += 1) await addDifficulty(t, 'explorer', n);
    const failed = await until(() => t.query("SELECT * FROM candidate_runs WHERE status = 'failed'")[0] ?? null, 'the failed attempt');
    assert.match(failed.detail, /angle brackets/);
    assert.equal(candidateRows(t, 'explorer').length, 0);

    // A good candidate whose file the lead then edits into a bad one: the enable looks at the file as it is.
    fs.writeFileSync(t.modeFile, 'ok');
    await addDifficulty(t, 'explorer', 6);
    const [candidate] = await waitForCandidate(t, 'explorer');
    const edited = fs.readFileSync(candidate.file, 'utf8').replace('description: written by the fake refiner', 'description: "see <this>"');
    assert.notEqual(edited, fs.readFileSync(candidate.file, 'utf8'));
    fs.writeFileSync(candidate.file, edited);
    const real = JSON.parse(candidate.difficulty_ids).map((difficulty) => ({ difficulty, verdict: 'real' }));
    const refused = await t.mcp.tool('candidate_decide', { id: candidate.id, verdicts: real, decision: 'enable' });
    assert.equal(refused.isError, true);
    assert.match(refused.text, /angle brackets/);
    assert.equal(fs.existsSync(t.skillFile('h-explorer')), false, 'nothing was written into HSkills');
    assert.equal(t.query('SELECT * FROM skill_versions').length, 0);
  });
});

describe('what a SKILL.md has to be to go into HSkills', () => {
  const skill = (description, extra = '') => `---\nname: h-demo\ndescription: ${description}\n${extra}---\n\n# h-demo\n\nBody.\n`;
  const check = (text) => checkSkillText(text, 'h-demo');

  it('passes a plain, a quoted and a block description, with LF or CRLF line ends', () => {
    assert.deepEqual(check(skill('Use when the user asks for a demo.')), []);
    assert.deepEqual(check(skill('"Use when: the user asks for a demo."')), []);
    assert.deepEqual(check(skill(">\n  Use when: the user\n  asks for a demo.")), []);
    assert.deepEqual(check(skill('Use when the user\n  asks for a demo.')), []);
    assert.deepEqual(check(skill('Use when the user asks for a demo.', 'metadata:\n  verified:\n    - by: x\n      at: 2026-10-01\n').replace(/\n/g, '\r\n')), []);
  });

  it('refuses what the lint refuses: a description over 1024 characters, angle brackets, an empty or missing one', () => {
    assert.match(check(skill('x'.repeat(1025))).join(), /1025 chars; host limit is 1024/);
    assert.deepEqual(check(skill('x'.repeat(1024))), []);
    assert.match(check(skill('"Use the <role> post"')).join(), /angle brackets/);
    assert.match(check(skill('>\n  a > b')).join(), /angle brackets/);
    assert.match(check('---\nname: h-demo\n---\n\nBody.\n').join(), /missing description/);
    assert.match(check(skill('""')).join(), /description is empty/);
    assert.match(check(skill('"[TODO fill this in]"')).join(), /TODO/);
    assert.match(check(`${skill('fine')}\n[TODO: finish]\n`).join(), /\[TODO:/);
  });

  it('refuses a frontmatter YAML could not read: a colon in a plain description, an open quote, a stray line', () => {
    assert.match(check(skill('Use when: the user asks')).join(), /unquoted and contains ": "/);
    assert.match(check(skill('Ends with a colon:')).join(), /unquoted and contains ": "/);
    assert.match(check(skill('"never closed')).join(), /without a closing "/);
    assert.match(check(skill('"closed" and more')).join(), /trailing text after its closing quote/);
    assert.match(check(skill('[a list, not text]')).join(), /starts with YAML indicator "\["/);
    assert.match(check(skill('fine', 'stray words here\n')).join(), /is not "key: value"/);
    assert.match(check(skill('fine', '\tindented: with a tab\n')).join(), /tab/);
  });

  it('keeps the earlier rules: name, frontmatter at all, and fewer than 500 lines', () => {
    assert.match(check(skill('fine').replace('name: h-demo', 'name: h-other')).join(), /frontmatter name must be h-demo/);
    assert.deepEqual(check(skill('fine').replace('name: h-demo', 'name: "h-demo"')), []);
    assert.match(check('# no frontmatter\n').join(), /Missing opening frontmatter/);
    assert.match(check(`${skill('fine')}${'line\n'.repeat(500)}`).join(), /fewer than 500 lines/);
    assert.deepEqual(check(''), ['Skill text is empty']);
  });

  it('counts lines the way the lint does: a final line break does not start another line', () => {
    const head = skill('fine');
    const headLines = head.split('\n').length - 1;
    const withLines = (n, eol = '\n') => `${head}${'line\n'.repeat(n - headLines)}`.replace(/\n/g, eol);
    assert.deepEqual(check(withLines(499)), [], '499 lines ending in a newline pass');
    assert.deepEqual(check(withLines(499, '\r\n')), [], 'with CRLF too');
    assert.match(check(withLines(500)).join(), /Skill text is 500 lines/);
  });

  it('stays fast on a long run of blank lines, and refuses a body far too large before looking at it', () => {
    // No placeholder anywhere: the case where a regex that lets ^\s* run across line breaks is quadratic.
    const started = Date.now();
    const problems = check(`${skill('fine')}${'\n'.repeat(100_000)}end\n`);
    assert.ok(Date.now() - started < 1000, `took ${Date.now() - started} ms`);
    assert.doesNotMatch(problems.join(), /TODO/);
    assert.match(check(`${skill('fine')}\n\n\n  [TODO: x]\n`).join(), /\[TODO:/, 'a placeholder after blank lines is still found');
    assert.match(check(`${skill('fine')}${'x'.repeat(400_000)}`).join(), /exceeding the limit/);
  });

  it('refuses what the lint refuses in Skill links: two parents, or a target that is not a skill', () => {
    const skillsDir = tempDir('ssa-skills-');
    cleanups.push(() => fs.rmSync(skillsDir, { recursive: true, force: true }));
    fs.mkdirSync(path.join(skillsDir, 'h-parent'), { recursive: true });
    fs.writeFileSync(path.join(skillsDir, 'h-parent', 'SKILL.md'), 'x');
    const withLinks = (...lines) => `${skill('fine')}\n## Skill links\n\n${lines.join('\n')}\n`;
    const good = withLinks('- parent: [Parent](../h-parent/SKILL.md) — when to go up');
    assert.deepEqual(checkSkillText(good, 'h-demo', { skillsDir }), []);
    assert.match(checkSkillText(withLinks('- parent: [A](../h-parent/SKILL.md)', '- parent: [B](../h-other/SKILL.md)'), 'h-demo').join(), /2 parents/);
    assert.match(checkSkillText(withLinks('- related: [Gone](../h-gone/SKILL.md)'), 'h-demo', { skillsDir }).join(), /h-gone do not exist under HSkills skills\//);
  });
});

describe('the reminder', () => {
  it('appears in one MCP reply per client session and not again', async () => {
    const t = await start();
    for (let n = 1; n <= 5; n += 1) await addDifficulty(t, 'explorer', n);
    await waitForCandidate(t, 'explorer');

    const first = await t.mcp.tool('seat_list');
    assert.match(first.text, /explorer has a skill candidate awaiting review \(#\d+\)/, first.text);
    assert.match(first.text, /Inspect via candidates\(id=\d+\)/, 'it asks for something now, not on a phrase nobody prompts');
    assert.match(first.text, /candidates\(id=\d+\)/, 'the sentence says how to look');
    assert.match(first.text, /enabling writes to the skills directory for future runs/, 'it says what enabling changes');
    assert.equal((await t.service.call('GET', '/wall')).json.candidates.pending, 1, 'the wall can say a candidate waits');
    const second = await t.mcp.tool('seat_list');
    assert.doesNotMatch(second.text, /skill candidate awaiting review/);

    // A second client session (another MCP process) is reminded again.
    const other = startMcp(t.service);
    cleanups.push(() => other.close());
    assert.match((await other.tool('seat_list')).text, /skill candidate awaiting review/);
  });
});

describe('review', () => {
  it('[S-3] records a verdict per difficulty, refuses to enable before all are judged, and writes nothing when rejecting', async () => {
    const original = '---\nname: h-explorer\ndescription: the original\n---\n\n# h-explorer\n\nOriginal text.\n';
    const t = await start({ skills: { 'h-explorer': original } });
    await addFiveClasses(t, 'explorer');
    const [candidate] = await waitForCandidate(t, 'explorer');
    // In seq order, the order the verdict queries below read them back in.
    const ids = JSON.parse(candidate.difficulty_ids).sort((a, b) => a - b);
    assert.equal(ids.length, 5, 'one row per class');

    const shown = (await t.mcp.tool('candidates', { id: candidate.id })).text;
    assert.match(shown, /Refiner rationale/);
    assert.match(shown, /\+ - added by the fake refiner/, 'the diff shows the added line');
    for (const id of ids) assert.match(shown, new RegExp(`#${id} ·`));

    // Three of five judged: the verdicts are kept, enabling is refused, the skill is untouched.
    const partial = await t.mcp.tool('candidate_decide', {
      id: candidate.id,
      verdicts: [{ difficulty: ids[0], verdict: 'real' }, { difficulty: ids[1], verdict: 'invalid', note: 'brief was wrong' }, { difficulty: ids[2], verdict: 'sporadic' }],
      decision: 'enable',
    });
    assert.equal(partial.isError, true);
    // Listed in the candidate's own order (by class), so either order of the two.
    assert.match(partial.text, new RegExp(`still missing (#${ids[3]}, #${ids[4]}|#${ids[4]}, #${ids[3]})`));
    assert.deepEqual(t.query('SELECT difficulty_id, verdict, note FROM difficulty_verdicts WHERE candidate_id = ? ORDER BY difficulty_id', candidate.id).map((r) => [r.verdict, r.note]), [['real', null], ['invalid', 'brief was wrong'], ['sporadic', null]]);
    assert.equal(fs.readFileSync(t.skillFile('h-explorer'), 'utf8'), original);
    assert.equal(t.query('SELECT * FROM skill_versions').length, 0);

    // Rejecting needs a note, and then writes nothing.
    const done = await t.mcp.tool('candidate_decide', { id: candidate.id, verdicts: [{ difficulty: ids[3], verdict: 'real' }, { difficulty: ids[4], verdict: 'real' }] });
    assert.equal(done.isError, false);
    assert.match(done.text, /are judged/);
    const noNote = await t.mcp.tool('candidate_decide', { id: candidate.id, decision: 'reject' });
    assert.equal(noNote.isError, true);
    assert.match(noNote.text, /note/);
    const rejected = await t.mcp.tool('candidate_decide', { id: candidate.id, decision: 'reject', note: 'too broad' });
    assert.equal(rejected.isError, false, rejected.text);
    assert.equal(t.query('SELECT state, note FROM candidates WHERE id = ?', candidate.id)[0].state, 'rejected');
    assert.equal(t.query('SELECT note FROM candidates WHERE id = ?', candidate.id)[0].note, 'too broad');
    assert.equal(fs.readFileSync(t.skillFile('h-explorer'), 'utf8'), original, 'reject writes nothing into HSkills');
    assert.equal(t.query('SELECT * FROM skill_versions').length, 0);
    assert.equal((await t.mcp.tool('candidate_decide', { id: candidate.id, decision: 'enable' })).isError, true, 'a rejected candidate is final');
  });

  it('[S-3] enable writes the candidate file into the role\'s skill in HSkills, backs up the old one and records a version', async () => {
    const original = '---\nname: h-explorer\ndescription: the original\n---\n\n# h-explorer\n\nOriginal text.\n';
    const t = await start({ skills: { 'h-explorer': original } });
    await addFiveClasses(t, 'explorer');
    const [candidate] = await waitForCandidate(t, 'explorer');
    const ids = JSON.parse(candidate.difficulty_ids).sort((a, b) => a - b);

    // The lead trims the candidate file before enabling: what is written is the file's text at that moment.
    const trimmed = `${fs.readFileSync(candidate.file, 'utf8').trimEnd()}\n- trimmed by the lead\n`;
    fs.writeFileSync(candidate.file, trimmed);

    // All judged invalid or sporadic: no reason to enable.
    const none = await t.mcp.tool('candidate_decide', { id: candidate.id, verdicts: ids.map((difficulty) => ({ difficulty, verdict: 'sporadic' })), decision: 'enable' });
    assert.equal(none.isError, true);
    assert.match(none.text, /none of its difficulties were judged "real"/);
    assert.equal(fs.readFileSync(t.skillFile('h-explorer'), 'utf8'), original);

    const enabled = await t.mcp.tool('candidate_decide', {
      id: candidate.id,
      verdicts: ids.map((difficulty, i) => ({ difficulty, verdict: i === 0 ? 'sporadic' : 'real' })),
      decision: 'enable',
      note: 'looks right',
    });
    assert.equal(enabled.isError, false, enabled.text);
    assert.match(enabled.text, /Enabled candidate/);
    assert.match(enabled.text, /Git history in the target skills repository was left untouched/);
    assert.equal(fs.readFileSync(t.skillFile('h-explorer'), 'utf8'), trimmed);

    const [version] = t.query('SELECT * FROM skill_versions');
    assert.equal(version.role, 'explorer');
    assert.equal(version.skill, 'h-explorer');
    assert.equal(version.version, candidate.version);
    assert.equal(version.candidate_id, candidate.id);
    assert.equal(version.file, t.skillFile('h-explorer'));
    assert.equal(fs.readFileSync(version.previous_file, 'utf8'), original, 'the replaced text is kept');
    assert.match(version.sha256, /^[0-9a-f]{64}$/);
    // What a run is handed of it, so a frontmatter rewritten later (stamp.py) still names this version.
    assert.equal(version.body_sha256, crypto.createHash('sha256').update(skillBody(trimmed)).digest('hex'));
    assert.match(enabled.text, /picks up this version starting on its next run/);
    assert.equal(t.query('SELECT state FROM candidates WHERE id = ?', candidate.id)[0].state, 'active');
    assert.deepEqual(t.query('SELECT verdict FROM difficulty_verdicts WHERE candidate_id = ? ORDER BY difficulty_id', candidate.id).map((r) => r.verdict), ['sporadic', 'real', 'real', 'real', 'real']);
  });

  it('[S-3] enable creates the skill when the role has none, and writes nothing when HSkills is not where it should be', async () => {
    const t = await start();
    for (let n = 1; n <= 5; n += 1) await addDifficulty(t, 'explorer', n);
    const [candidate] = await waitForCandidate(t, 'explorer');
    const ids = JSON.parse(candidate.difficulty_ids);
    const real = ids.map((difficulty) => ({ difficulty, verdict: 'real' }));
    assert.equal(fs.existsSync(t.skillFile('h-explorer')), false);
    const moved = path.join(t.hskills, 'skills');
    fs.renameSync(moved, `${moved}-away`);
    const misplaced = await t.mcp.tool('candidate_decide', { id: candidate.id, verdicts: real, decision: 'enable' });
    assert.equal(misplaced.isError, true);
    assert.match(misplaced.text, /External skills directory not found/);
    assert.equal(t.query('SELECT * FROM skill_versions').length, 0);
    assert.equal(t.query('SELECT state FROM candidates WHERE id = ?', candidate.id)[0].state, 'pending');
    fs.renameSync(`${moved}-away`, moved);
    const enabled = await t.mcp.tool('candidate_decide', { id: candidate.id, verdicts: real, decision: 'enable' });
    assert.equal(enabled.isError, false, enabled.text);
    assert.equal(fs.readFileSync(t.skillFile('h-explorer'), 'utf8'), fs.readFileSync(candidate.file, 'utf8'));
    assert.equal(t.query('SELECT previous_file FROM skill_versions')[0].previous_file, null);
  });

  it('does not enable over a skill that changed after the candidate was written, unless forced', async () => {
    const original = '---\nname: h-explorer\ndescription: the original\n---\n\nOriginal.\n';
    const t = await start({ skills: { 'h-explorer': original } });
    for (let n = 1; n <= 5; n += 1) await addDifficulty(t, 'explorer', n);
    const [candidate] = await waitForCandidate(t, 'explorer');
    const real = JSON.parse(candidate.difficulty_ids).map((difficulty) => ({ difficulty, verdict: 'real' }));
    const edited = `${original}Edited by hand meanwhile.\n`;
    fs.writeFileSync(t.skillFile('h-explorer'), edited);
    const refused = await t.mcp.tool('candidate_decide', { id: candidate.id, verdicts: real, decision: 'enable' });
    assert.equal(refused.isError, true);
    assert.match(refused.text, /changed after this candidate was written/);
    assert.equal(fs.readFileSync(t.skillFile('h-explorer'), 'utf8'), edited);
    const forced = await t.mcp.tool('candidate_decide', { id: candidate.id, decision: 'enable', force: true });
    assert.equal(forced.isError, false, forced.text);
    assert.equal(fs.readFileSync(t.skillFile('h-explorer'), 'utf8'), fs.readFileSync(candidate.file, 'utf8'));
  });

  it('after a decision the role is free for its next batch, which starts from the difficulties after the last candidate', async () => {
    const t = await start();
    for (let n = 1; n <= 5; n += 1) await addDifficulty(t, 'coder', n);
    const [first] = await waitForCandidate(t, 'coder');
    // Seven in all: the two after the first batch are waiting.
    await addDifficulty(t, 'coder', 6);
    await addDifficulty(t, 'coder', 7);
    const real = JSON.parse(first.difficulty_ids).map((difficulty) => ({ difficulty, verdict: 'real' }));
    assert.equal((await t.mcp.tool('candidate_decide', { id: first.id, verdicts: real, decision: 'reject', note: 'not now' })).isError, false);
    await sleep(400);
    assert.equal(candidateRows(t, 'coder').length, 1, 'two new difficulties are not a batch');
    for (let n = 8; n <= 10; n += 1) await addDifficulty(t, 'coder', n);
    const rows = await waitForCandidate(t, 'coder', 2);
    const secondIds = JSON.parse(rows[1].difficulty_ids);
    assert.equal(Math.min(...secondIds) > Math.max(...JSON.parse(first.difficulty_ids)), true, 'the second batch only holds newer difficulties');
    assert.equal(rows[1].version, rows[0].version + 1, 'versions keep counting, a rejected number is not reused');
  });
});

describe('what a run carries', () => {
  const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');
  const readJsonLines = (file) => (fs.existsSync(file)
    ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
    : []);
  const skillText = (name, body, extra = '') => `---\nname: ${name}\ndescription: what ${name} knows${extra}\n---\n\n${body}\n`;
  const lastSkillEvent = (shown) => shown.events.filter((event) => event.kind === 'skill').at(-1)?.body ?? '';
  const contractLine = (role) => fs.readFileSync(path.join(REPO, 'roles', `${role}.md`), 'utf8').split('\n').find((line) => line.trim() && !line.startsWith('#'));
  const workDir = () => {
    const dir = tempDir('ssa-work-');
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
  };
  // `reply` is seat_start's own answer, for what it carries besides the seat. `identity` is where the
  // post is recognised: a directory path (cwd) for most posts, or { domain } for one recognised by a
  // field of knowledge (web_researcher), which refuses a cwd.
  async function dispatch(t, role, task, identity) {
    const where = identity === undefined || typeof identity === 'string' ? { cwd: identity } : identity;
    const started = await t.mcp.tool('seat_start', { role, task, ...where });
    assert.equal(started.isError, false, started.text);
    const reply = JSON.parse(started.text);
    const shown = await t.service.waitSeat(reply.seat);
    assert.equal(shown.seat.state, 'done', t.service.log());
    return { ...shown, reply };
  }
  const daemonLog = (t) => {
    const file = path.join(t.service.root, '.data', 'daemon.log');
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  };
  const logLines = (t, pattern) => daemonLog(t).split('\n').filter((line) => pattern.test(line));
  const codexWork = (t) => readJsonLines(t.service.env.FAKE_CODEX_CALLS).filter((call) => !call.closing);
  const NOTICE = /（服务消息）这个岗位的 skill|（服务消息）这段会话开始时/;

  it('hands over the text after the frontmatter, with LF or CRLF, behind a byte order mark, or the whole file when there is none', () => {
    assert.equal(skillBody('---\nname: x\ndescription: y\n---\n\n# Body\n\ntext\n'), '# Body\n\ntext');
    assert.equal(skillBody('﻿---\r\nname: x\r\ndescription: y\r\n---\r\n# Body\r\n'), '# Body');
    assert.equal(skillBody('# No frontmatter\n'), '# No frontmatter');
    assert.equal(skillBody('---\nname: x\ndescription: y\n---\n'), '');
  });

  it('[S-5] a fresh Codex session gets contract, skill without frontmatter, memory; a continued one gets the skill again only when its body changed', async () => {
    const v1 = '# h-explorer\n\nSKILL-BODY-V1: read the call sites before the definitions.';
    const t = await start({ skills: { 'h-explorer': skillText('h-explorer', v1, '\nmetadata:\n  verified: FRONTMATTER-ONLY') } });
    const work = workDir();
    assert.equal((await t.mcp.tool('memory_write', { role: 'explorer', kind: 'fact', body: 'MEMORY-FACT-1' })).isError, false);

    // A fresh session: the skill sits between the contract and the memory, once, with the line that
    // says the contract wins in front of it and no frontmatter.
    const first = await dispatch(t, 'explorer', 'TASK-ONE', work);
    const fresh = codexWork(t).at(-1);
    assert.equal(fresh.args.includes('resume'), false);
    const at = (text) => fresh.prompt.indexOf(text);
    assert.ok(at(contractLine('explorer')) >= 0, 'the contract is there');
    assert.ok(at('SKILL-BODY-V1') > at(contractLine('explorer')), 'the skill comes after the contract');
    assert.ok(at('MEMORY-FACT-1') > at('SKILL-BODY-V1'), 'and before the memory');
    assert.ok(at('TASK-ONE') > at('MEMORY-FACT-1'));
    assert.match(fresh.prompt, /（服务消息）下面是这个岗位的 skill「h-explorer」。它和上面的岗位合同冲突时，以合同为准。\n\n# h-explorer\n/);
    assert.doesNotMatch(fresh.prompt, /FRONTMATTER-ONLY|description: what h-explorer knows/, 'the frontmatter is not handed over');
    assert.equal(fresh.prompt.split('SKILL-BODY-V1').length, 2, 'the body is there once');
    const h1 = sha(v1);
    let event = lastSkillEvent(first);
    assert.match(event, /This run carried explorer skill h-explorer/);
    assert.match(event, new RegExp(`sha256 first 12 chars ${h1.slice(0, 12)}`));
    assert.match(event, /manually authored \(no skill-loop version enabled yet\)/);
    assert.equal(first.seat.skill_hash, h1, 'the session is recorded with the skill it was given');

    // The same body, now enabled as version 3 and under a frontmatter stamp.py rewrote: the continued
    // session is not told again, and the run names the version.
    t.write((db) => db
      .prepare("INSERT INTO skill_versions (role, skill, version, candidate_id, file, sha256, body_sha256, previous_file, note, at) VALUES ('explorer', 'h-explorer', 3, NULL, ?, ?, ?, NULL, NULL, ?)")
      .run(t.skillFile('h-explorer'), sha('the whole file as it was enabled'), h1, new Date().toISOString()));
    fs.writeFileSync(t.skillFile('h-explorer'), skillText('h-explorer', v1, '\nmetadata:\n  verified: STAMPED'));
    const second = await dispatch(t, 'explorer', 'TASK-TWO', work);
    const same = codexWork(t).at(-1);
    assert.ok(same.args.includes('resume'), 'the second run continues the session');
    assert.doesNotMatch(same.prompt, /SKILL-BODY/);
    assert.doesNotMatch(same.prompt, NOTICE);
    event = lastSkillEvent(second);
    assert.match(event, /h-explorer \(v3, /);
    assert.doesNotMatch(event, /which differs/);

    // The body changes: the continued session is handed a notice and the whole new text before its task.
    const v2 = '# h-explorer\n\nSKILL-BODY-V2: grep the tests first.';
    fs.writeFileSync(t.skillFile('h-explorer'), skillText('h-explorer', v2));
    const third = await dispatch(t, 'explorer', 'TASK-THREE', work);
    const told = codexWork(t).at(-1);
    assert.ok(told.args.includes('resume'));
    assert.ok(told.prompt.startsWith('（服务消息）这个岗位的 skill「h-explorer」在这段会话开始之后换了版本。会话开头给你的那份作废'), told.prompt.slice(0, 200));
    assert.match(told.prompt, /以合同为准。\n\n# h-explorer\n\nSKILL-BODY-V2/);
    assert.ok(told.prompt.indexOf('SKILL-BODY-V2') < told.prompt.indexOf('TASK-THREE'));
    assert.doesNotMatch(told.prompt, /SKILL-BODY-V1|description:/);
    const h2 = sha(v2);
    event = lastSkillEvent(third);
    assert.match(event, new RegExp(`sha256 first 12 chars ${h2.slice(0, 12)}`));
    assert.match(event, /modified outside the skill loop \(last enabled was v3, edited since\)/);
    assert.match(event, new RegExp(`Previous session carried body sha256 first 12 chars ${h1.slice(0, 12)}, which differs`));
    assert.equal(third.seat.skill_hash, h2);

    // Told once: the run after that continues without it.
    const fourth = await dispatch(t, 'explorer', 'TASK-FOUR', work);
    const after = codexWork(t).at(-1);
    assert.ok(after.args.includes('resume'));
    assert.doesNotMatch(after.prompt, /SKILL-BODY/);
    assert.doesNotMatch(after.prompt, NOTICE);
    assert.doesNotMatch(lastSkillEvent(fourth), /which differs/);

    // The record is the service's own: a caller cannot write a skill event.
    const forged = await t.service.call('POST', '/seat/record', { seat: first.seat.id, kind: 'skill', body: '第 99 版' });
    assert.notEqual(forged.status, 200);
  });

  it('a role whose spawn names no skill runs without one and says so', async () => {
    const t = await start();
    const work = workDir();
    const first = await dispatch(t, 'handyman', 'TASK-PLAIN', work);
    const fresh = codexWork(t).at(-1);
    assert.doesNotMatch(fresh.prompt, /下面是这个岗位的 skill/);
    assert.ok(fresh.prompt.includes(contractLine('handyman')), 'the contract still goes');
    assert.match(lastSkillEvent(first), /^No skill attached for this run \(none\): handyman's spawn args in roles\.json have no \{skill\} placeholder/);
    assert.equal(first.seat.skill_hash, 'none');
    // A skill file appearing later changes nothing: this role's spawn never names one.
    fs.mkdirSync(path.dirname(t.skillFile('h-handyman')), { recursive: true });
    fs.writeFileSync(t.skillFile('h-handyman'), skillText('h-handyman', 'HANDYMAN-SKILL-BODY'));
    const second = await dispatch(t, 'handyman', 'TASK-PLAIN-2', work);
    const resumed = codexWork(t).at(-1);
    assert.ok(resumed.args.includes('resume'));
    assert.doesNotMatch(resumed.prompt, /HANDYMAN-SKILL-BODY|下面是这个岗位的 skill/);
    assert.match(lastSkillEvent(second), /^No skill attached for this run \(none\): handyman's spawn args in roles\.json have no \{skill\} placeholder/);
  });

  it('a role with no skill yet runs without one, and a continued session is handed the first one when it appears', async () => {
    const t = await start();
    const work = workDir();
    const first = await dispatch(t, 'explorer', 'TASK-NOSKILL-1', work);
    const fresh = codexWork(t).at(-1);
    assert.doesNotMatch(fresh.prompt, /下面是这个岗位的 skill/);
    assert.ok(fresh.prompt.includes(contractLine('explorer')), 'the contract still goes, the empty pair is dropped');
    assert.match(lastSkillEvent(first), /^This run carried no skill \(recorded as none\): explorer's h-explorer does not exist at .+/);
    assert.equal(first.seat.skill_hash, 'none');
    // One role without its own file, in a skills directory that is there, is not the HSkills error:
    // no error on the reply, the listing, /health or the wall, and nothing in the service log.
    assert.equal('error' in first.reply, false, JSON.stringify(first.reply));
    assert.doesNotMatch((await t.mcp.tool('seat_list')).text, /^Error:/m);
    const health = (await t.service.call('GET', '/health')).json;
    assert.equal(health.hskills.ok, true);
    assert.equal(health.hskills.error, null);
    assert.equal((await t.service.call('GET', '/wall')).json.hskills.ok, true);
    assert.deepEqual(logLines(t, /Error:|Recovered:/), []);

    fs.mkdirSync(path.dirname(t.skillFile('h-explorer')), { recursive: true });
    fs.writeFileSync(t.skillFile('h-explorer'), skillText('h-explorer', 'EXPLORER-SKILL-BODY'));
    const second = await dispatch(t, 'explorer', 'TASK-NOSKILL-2', work);
    const resumed = codexWork(t).at(-1);
    assert.ok(resumed.args.includes('resume'));
    assert.ok(resumed.prompt.startsWith('（服务消息）这段会话开始时这个岗位还没有 skill，现在有了：「h-explorer」'), resumed.prompt.slice(0, 200));
    assert.match(resumed.prompt, /EXPLORER-SKILL-BODY/);
    assert.match(lastSkillEvent(second), /Previous session carried no skill, which differs/);
  });

  // 2026-10-01 review: the whole prompt used to be one argv item for Codex, Grok and Claude, and a skill
  // the loop accepts can push it past what Windows allows on a command line (about 32,700 characters).
  // Spawn then threw ENAMETOOLONG, all three counted as "did not start", and the run slid to DeepSeek.
  it('a skill longer than a Windows command line still reaches Codex, fresh and in the notice of a continued session', async () => {
    const longBody = (tag) => [`# h-explorer ${tag}`, ...Array.from({ length: 450 }, (_, i) => `- ${tag} 第 ${i} 条：${'先读调用点，再读定义，最后看测试。'.repeat(5)}`)].join('\n');
    const v1 = longBody('LONG-V1');
    const v2 = longBody('LONG-V2');
    assert.ok(v1.length > 40000, `the body is ${v1.length} characters`);
    assert.deepEqual(checkSkillText(skillText('h-explorer', v1), 'h-explorer'), [], 'the loop itself would accept it');
    const t = await start({ skills: { 'h-explorer': skillText('h-explorer', v1) } });
    const work = workDir();

    await dispatch(t, 'explorer', 'TASK-LONG-1', work);
    const fresh = codexWork(t).at(-1);
    assert.ok(fresh, 'Codex ran it, the run did not slide to another backend');
    assert.equal(fresh.args.at(-1), '-', 'the prompt came on stdin, not in argv');
    assert.ok(fresh.prompt.includes(v1), 'the whole body, unchanged');
    assert.ok(fresh.prompt.indexOf(v1) < fresh.prompt.indexOf('TASK-LONG-1'));

    fs.writeFileSync(t.skillFile('h-explorer'), skillText('h-explorer', v2));
    const second = await dispatch(t, 'explorer', 'TASK-LONG-2', work);
    const told = codexWork(t).at(-1);
    assert.ok(told.args.includes('resume'), 'the session is continued');
    assert.equal(told.args.at(-1), '-');
    assert.ok(told.prompt.startsWith('（服务消息）这个岗位的 skill「h-explorer」在这段会话开始之后换了版本'));
    assert.ok(told.prompt.includes(v2) && told.prompt.indexOf(v2) < told.prompt.indexOf('TASK-LONG-2'));
    assert.equal(second.seat.skill_hash, sha(v2));
    assert.doesNotMatch(t.service.log(), /ENAMETOOLONG/);
  });

  // 2026-10-01 review: a missing HSkills (a wrong path) looked like a role that has no skill yet, and
  // the event promised a file the first enable would create, which enabling refuses in this very case.
  it('says HSkills is misplaced, and where its location came from, when the skills directory is not there at all', async () => {
    const parent = tempDir('ssa-nohskills-');
    cleanups.push(() => fs.rmSync(parent, { recursive: true, force: true }));
    const t = await start({ env: { SPECIALIST_SUBAGENTS_HSKILLS: path.join(parent, 'no-such-hskills') } });
    const shown = await dispatch(t, 'explorer', 'TASK-NO-HSKILLS', workDir());
    assert.equal(shown.seat.state, 'done', 'the run still goes ahead');
    assert.doesNotMatch(codexWork(t).at(-1).prompt, /下面是这个岗位的 skill/);
    assert.equal(shown.seat.skill_hash, 'none');
    const event = lastSkillEvent(shown);
    assert.match(event, /^Error: this run carried no skill \(recorded as none\): External skills directory .*no-such-hskills.skills does not exist \(root directory .*no-such-hskills itself does not exist; configured via env SPECIALIST_SUBAGENTS_HSKILLS\)/);
    assert.match(event, /configuration issue affecting all roles and candidate write-back, not a role difficulty/);
    assert.match(event, /not a role difficulty/);
    assert.doesNotMatch(event, /enabling its first candidate/);
  });

  // 2026-10-01,「マスター」: "照常开工但是一定要报错". The run above still goes ahead; the error is said on
  // every reply that dispatches or lists, on /health and the wall, once in the service log, and it is
  // configuration, not a difficulty of the role.
  it('a missing HSkills is an error on every seat_start and seat_list reply, /health and the wall, logged once, never a difficulty', async () => {
    const parent = tempDir('ssa-nohskills-');
    cleanups.push(() => fs.rmSync(parent, { recursive: true, force: true }));
    const t = await start({ env: { SPECIALIST_SUBAGENTS_HSKILLS: path.join(parent, 'no-such-hskills') } });
    const ERROR = /^Error: External skills directory .*no-such-hskills.skills does not exist \(root directory .*no-such-hskills itself does not exist; configured via env SPECIALIST_SUBAGENTS_HSKILLS\)\. Every role is running without its skill/;

    const first = await dispatch(t, 'explorer', 'TASK-NO-HSKILLS-1', workDir());
    assert.match(first.reply.error, ERROR);
    assert.equal(Object.keys(first.reply)[0], 'error', 'the error is the first thing in the reply');
    assert.match(first.reply.error, /SPECIALIST_SUBAGENTS_SKILLS or SPECIALIST_SUBAGENTS_HSKILLS \(requires service restart\), or set "skills" \/ "hskills" in \.runtime\.json/, 'it says how to fix it');
    assert.match(first.reply.error, /inform the user first/);
    assert.ok(first.reply.seat, 'the dispatch itself went through');
    // Not once per session: the second dispatch and every listing carry it again.
    const second = await dispatch(t, 'explorer', 'TASK-NO-HSKILLS-2', workDir());
    assert.match(second.reply.error, ERROR);
    for (let n = 0; n < 2; n += 1) {
      const list = await t.mcp.tool('seat_list');
      assert.equal(list.isError, false, list.text);
      assert.match(list.text.split('\n')[0], ERROR, list.text);
    }
    // full keeps its first block the bare rows, and says it in a second block (2026-10-01 review).
    for (let n = 0; n < 2; n += 1) {
      const full = await t.mcp.tool('seat_list', { full: true });
      assert.ok(Array.isArray(JSON.parse(full.text)), 'full stays the bare rows');
      assert.equal(full.blocks.length, 2, full.blocks.join('\n'));
      assert.match(full.blocks[1], ERROR);
    }
    assert.match(lastSkillEvent(second), /^Error:/);

    const health = (await t.service.call('GET', '/health')).json;
    assert.equal(health.ok, true, 'the daemon itself is up');
    assert.equal(health.hskills.ok, false);
    assert.match(health.hskills.error, ERROR);
    assert.match(health.hskills.dir, /no-such-hskills.skills$/);
    assert.equal(health.hskills.source, 'env SPECIALIST_SUBAGENTS_HSKILLS');
    const wall = (await t.service.call('GET', '/wall')).json;
    assert.equal(wall.hskills.ok, false);
    assert.match(wall.hskills.brief, /^Error: external skills directory not found; roles are running without skills \(.*no-such-hskills.skills missing via env SPECIALIST_SUBAGENTS_HSKILLS\)$/);
    assert.equal((await t.service.call('GET', '/events/wait?timeoutMs=0')).json.hskills_ok, false);
    const page = (await t.service.call('GET', '/')).text;
    assert.match(page, /<span id="alarm" role="alert" hidden><\/span>/, 'the header has its error line');

    assert.equal(t.query('SELECT COUNT(*) AS n FROM difficulties')[0].n, 0, 'configuration is not a difficulty of the role');
    const logged = logLines(t, /Error: external skills directory/);
    assert.equal(logged.length, 1, daemonLog(t));
    assert.match(logged[0], /A recovery line will be logged once restored/);
    assert.deepEqual(logLines(t, /Recovered:/), []);
  });

  it('a skills directory missing under an HSkills that is there is the same error, and it clears when the directory comes back', async () => {
    const t = await start();
    const skillsDir = path.join(t.hskills, 'skills');
    assert.doesNotMatch((await t.mcp.tool('seat_list')).text, /^Error:/m);
    fs.rmSync(skillsDir, { recursive: true, force: true });

    const missing = await t.mcp.tool('seat_list');
    assert.match(missing.text.split('\n')[0], /^Error: External skills directory .+ does not exist \(root directory .+ exists, but has no skills subdirectory; configured via env SPECIALIST_SUBAGENTS_HSKILLS\)/, missing.text);
    assert.equal((await t.service.call('GET', '/health')).json.hskills.ok, false);
    assert.equal((await t.service.call('GET', '/wall')).json.hskills.ok, false);
    const during = await dispatch(t, 'explorer', 'TASK-NO-SKILLS-DIR', workDir());
    assert.match(during.reply.error, /exists, but has no skills subdirectory/);
    assert.match(lastSkillEvent(during), /^Error: this run carried no skill \(recorded as none\)/);
    assert.equal(logLines(t, /Error: external skills directory/).length, 1, daemonLog(t));

    fs.mkdirSync(skillsDir);
    const back = await t.mcp.tool('seat_list');
    assert.doesNotMatch(back.text, /^Error:/m);
    const health = (await t.service.call('GET', '/health')).json.hskills;
    assert.equal(health.ok, true);
    assert.equal(health.error, null);
    assert.equal((await t.service.call('GET', '/wall')).json.hskills.ok, true);
    assert.equal((await t.service.call('GET', '/events/wait?timeoutMs=0')).json.hskills_ok, true);
    const after = await dispatch(t, 'explorer', 'TASK-SKILLS-DIR-BACK', workDir());
    assert.equal('error' in after.reply, false, JSON.stringify(after.reply));
    assert.doesNotMatch(lastSkillEvent(after), /^Error/);
    const cleared = logLines(t, /Recovered: external skills directory found at/);
    assert.equal(cleared.length, 1, daemonLog(t));
    assert.equal(logLines(t, /Error: external skills directory/).length, 1, 'the error was logged once, not per check');
    assert.equal(t.query('SELECT COUNT(*) AS n FROM difficulties')[0].n, 0);
  });

  it('degrades cleanly without probing ~/HSkills when no skills directory is configured, and states unconfigured on /health and /wall', async () => {
    const t = await start({ env: { SPECIALIST_SUBAGENTS_HSKILLS: '', SPECIALIST_SUBAGENTS_SKILLS: '' } });
    const health = (await t.service.call('GET', '/health')).json.hskills;
    assert.equal(health.ok, true);
    assert.equal(health.configured, false);
    assert.equal(health.error, null);
    assert.match(health.brief, /External skills directory not configured/);

    const wall = (await t.service.call('GET', '/wall')).json.hskills;
    assert.equal(wall.ok, true);
    assert.equal(wall.configured, false);
    assert.match(wall.brief, /candidate write-back disabled/);

    const list = await t.mcp.tool('seat_list');
    assert.doesNotMatch(list.text, /^Error:/m);
  });

  it('DeepSeek gets the skill in the system prompt seat-runner rebuilds every run, and never again in the task', async () => {
    const scratch = tempDir('ssa-pi-');
    cleanups.push(() => fs.rmSync(scratch, { recursive: true, force: true }));
    const piCalls = path.join(scratch, 'pi-calls.jsonl');
    const t = await start({
      skills: { 'h-web-researcher': skillText('h-web-researcher', 'WEB-SKILL-V1') },
      env: { SPECIALIST_SUBAGENTS_RUNTIME: FAKE_PI_CLI, FAKE_PI_CALLS: piCalls },
    });
    const piWork = () => readJsonLines(piCalls).filter((call) => !call.closing);

    // web_researcher is recognised by domain, so it is dispatched with one and no cwd.
    const first = await dispatch(t, 'web_researcher', 'TASK-WEB-1', { domain: 'ai' });
    let call = piWork().at(-1);
    assert.ok(call, 'the run went to DeepSeek');
    assert.equal(call.system.split('WEB-SKILL-V1').length, 2, 'once, in the system prompt');
    assert.doesNotMatch(call.text, /WEB-SKILL/);
    const sys = call.system;
    assert.ok(sys.indexOf(contractLine('web_researcher')) >= 0);
    assert.ok(sys.indexOf('联网有两条路') > sys.indexOf(contractLine('web_researcher')));
    assert.ok(sys.indexOf('下面是这个岗位的 skill「h-web-researcher」') > sys.indexOf('联网有两条路'), 'after the contract and the network note');
    assert.equal(first.seat.skill_hash, sha('WEB-SKILL-V1'));

    fs.writeFileSync(t.skillFile('h-web-researcher'), skillText('h-web-researcher', 'WEB-SKILL-V2'));
    const second = await dispatch(t, 'web_researcher', 'TASK-WEB-2', { domain: 'ai' });
    assert.equal(second.seat.id, first.seat.id);
    assert.ok(second.events.some((event) => event.kind === 'session' && /Continuing prior session/.test(event.body)), 'the pi session is continued');
    call = piWork().at(-1);
    assert.match(call.text, /TASK-WEB-2/);
    assert.equal(call.system.split('WEB-SKILL-V2').length, 2, 'the new text, once, in the rebuilt system prompt');
    assert.doesNotMatch(call.system, /WEB-SKILL-V1/);
    assert.doesNotMatch(call.text, /WEB-SKILL/);
    assert.doesNotMatch(call.text, NOTICE);
    assert.match(lastSkillEvent(second), /DeepSeek rebuilds its system prompt every run/);
    assert.equal(second.seat.skill_hash, sha('WEB-SKILL-V2'));
  });

  // 2026-10-01,「マスター」: a resumed Codex / Grok / Claude session gets a changed contract the way it
  // gets a changed skill. The contract is the copy's own roles/<role>.md, read at every run; its version
  // is roles.json's, read at startup, so a session "started under an older version" is planted in the
  // ledger rather than made by restarting the service.
  const CONTRACT_NOTICE = /（服务消息）岗位合同/;
  const lastContractEvent = (shown) => shown.events.filter((event) => event.kind === 'contract').at(-1)?.body ?? '';
  const versionOf = (role) => JSON.parse(fs.readFileSync(path.join(REPO, 'roles.json'), 'utf8'))[role].contract_version;
  const contractFile = (t, role) => path.join(t.service.root, 'roles', `${role}.md`);
  const contractText = (t, role) => fs.readFileSync(contractFile(t, role), 'utf8');
  const plantContract = (t, seat, version, hash) => t.write((db) => db.prepare('UPDATE seats SET contract_version = ?, contract_hash = ? WHERE id = ?').run(version, hash, seat));

  it('a fresh session carries the contract in its preamble only, and records its version and hash; an unchanged one is not told again', async () => {
    const t = await start();
    const work = workDir();
    const v = versionOf('explorer');

    const first = await dispatch(t, 'explorer', 'TASK-C1', work);
    const fresh = codexWork(t).at(-1);
    assert.equal(fresh.args.includes('resume'), false);
    assert.equal(fresh.prompt.split(contractLine('explorer')).length, 2, 'the contract is there once, in the preamble');
    assert.doesNotMatch(fresh.prompt, CONTRACT_NOTICE, 'a fresh session gets no notice');
    const hash = sha(contractText(t, 'explorer'));
    assert.equal(first.seat.contract_version, v);
    assert.equal(first.seat.contract_hash, hash);
    const event = lastContractEvent(first);
    assert.equal(event, `This run carried role contract v${v} for explorer (sha256 first 12 chars ${hash.slice(0, 12)}) from roles/explorer.md.`);

    const second = await dispatch(t, 'explorer', 'TASK-C2', work);
    const same = codexWork(t).at(-1);
    assert.ok(same.args.includes('resume'), 'the second run continues the session');
    assert.doesNotMatch(same.prompt, CONTRACT_NOTICE);
    assert.equal(same.prompt.includes(contractLine('explorer')), false, 'nor the contract text');
    assert.doesNotMatch(lastContractEvent(second), /which differs|treated as changed/);

    // The record is the service's own: a caller cannot write a contract event.
    const forged = await t.service.call('POST', '/seat/record', { seat: first.seat.id, kind: 'contract', body: 'v9.9.9' });
    assert.notEqual(forged.status, 200);
  });

  it('a continued session started under another version, or before the record, or whose text was edited, is handed the whole current contract once', async () => {
    const t = await start();
    const work = workDir();
    const v = versionOf('explorer');
    const first = await dispatch(t, 'explorer', 'TASK-V1', work);
    const seat = first.seat.id;

    // An older version on record: the notice names both, the whole text follows, then the task.
    plantContract(t, seat, '0.9.0', sha('the 0.9.0 text'));
    const second = await dispatch(t, 'explorer', 'TASK-V2', work);
    let told = codexWork(t).at(-1);
    assert.ok(told.args.includes('resume'));
    assert.ok(told.prompt.startsWith(`（服务消息）岗位合同现在是 v${v}（这段会话上次拿到的是 v0.9.0），以下是新合同全文，以它为准。\n\n`), told.prompt.slice(0, 200));
    const text = contractText(t, 'explorer').trim();
    assert.ok(told.prompt.includes(text), 'the whole contract');
    assert.equal(told.prompt.split(contractLine('explorer')).length, 2, 'once');
    assert.ok(told.prompt.indexOf(text) < told.prompt.indexOf('TASK-V2'));
    assert.match(lastContractEvent(second), new RegExp(`Previous session carried v0\\.9\\.0 \\(sha256 first 12 chars ${sha('the 0.9.0 text').slice(0, 12)}\\), which differs`));
    assert.equal(second.seat.contract_version, v, 'the session is recorded with what it was just handed');
    assert.equal(second.seat.contract_hash, sha(contractText(t, 'explorer')));

    // Told once: the next run continues without it.
    const third = await dispatch(t, 'explorer', 'TASK-V3', work);
    assert.doesNotMatch(codexWork(t).at(-1).prompt, CONTRACT_NOTICE);
    assert.doesNotMatch(lastContractEvent(third), /which differs|treated as changed/);

    // A session from before contracts were recorded counts as changed once.
    plantContract(t, seat, null, null);
    const fourth = await dispatch(t, 'explorer', 'TASK-V4', work);
    told = codexWork(t).at(-1);
    assert.ok(told.args.includes('resume'));
    assert.ok(told.prompt.startsWith(`（服务消息）岗位合同现在是 v${v}（这段会话上次拿到的是哪一版没有记录），以下是现行合同全文，以它为准。`), told.prompt.slice(0, 200));
    assert.ok(told.prompt.includes(text));
    assert.match(lastContractEvent(fourth), /Previous session carried no version on record.+treated as changed/);
    assert.equal(fourth.seat.contract_version, v);
    await dispatch(t, 'explorer', 'TASK-V5', work);
    assert.doesNotMatch(codexWork(t).at(-1).prompt, CONTRACT_NOTICE, 'and once only');

    // The text edited without a new version number (the file is read at every run): the hash tells.
    fs.appendFileSync(contractFile(t, 'explorer'), '\nCONTRACT-EDIT-MARK：改过的一行。\n');
    const sixth = await dispatch(t, 'explorer', 'TASK-V6', work);
    told = codexWork(t).at(-1);
    assert.ok(told.prompt.startsWith(`（服务消息）岗位合同的正文在这段会话上次拿到之后改过（版本号仍是 v${v}），以下是新合同全文，以它为准。`), told.prompt.slice(0, 200));
    assert.ok(told.prompt.indexOf('CONTRACT-EDIT-MARK') < told.prompt.indexOf('TASK-V6'));
    assert.equal(sixth.seat.contract_hash, sha(contractText(t, 'explorer')));
  });

  it('a contract and a skill that both changed reach a continued session in one prefix, contract first, each once', async () => {
    const t = await start({ skills: { 'h-explorer': skillText('h-explorer', 'BOTH-SKILL-V1') } });
    const work = workDir();
    const v = versionOf('explorer');
    const first = await dispatch(t, 'explorer', 'TASK-B1', work);
    assert.doesNotMatch(codexWork(t).at(-1).prompt, /（服务消息）岗位合同|（服务消息）这个岗位的 skill/);

    plantContract(t, first.seat.id, '0.9.0', sha('old'));
    fs.writeFileSync(t.skillFile('h-explorer'), skillText('h-explorer', 'BOTH-SKILL-V2'));
    const second = await dispatch(t, 'explorer', 'TASK-B2', work);
    const told = codexWork(t).at(-1);
    assert.ok(told.args.includes('resume'));
    const contractAt = told.prompt.indexOf(`（服务消息）岗位合同现在是 v${v}`);
    const skillAt = told.prompt.indexOf('（服务消息）这个岗位的 skill「h-explorer」在这段会话开始之后换了版本');
    assert.equal(contractAt, 0, told.prompt.slice(0, 200));
    assert.ok(skillAt > told.prompt.indexOf(contractLine('explorer')), 'the skill notice comes after the whole contract');
    assert.ok(told.prompt.indexOf('BOTH-SKILL-V2') > skillAt && told.prompt.indexOf('BOTH-SKILL-V2') < told.prompt.indexOf('TASK-B2'));
    assert.equal(told.prompt.split('（服务消息）岗位合同').length, 2, 'the contract notice once');
    assert.equal(told.prompt.split('（服务消息）这个岗位的 skill').length, 2, 'the skill notice once');
    assert.equal(told.prompt.split(contractLine('explorer')).length, 2, 'the contract text once');
    assert.equal(told.prompt.split('BOTH-SKILL-V2').length, 2, 'the skill text once');
    assert.doesNotMatch(told.prompt, /BOTH-SKILL-V1/);
    // One event each, the contract's first.
    const kinds = second.events.filter((event) => event.kind === 'contract' || event.kind === 'skill').map((event) => event.kind);
    assert.deepEqual(kinds.slice(-2), ['contract', 'skill']);

    await dispatch(t, 'explorer', 'TASK-B3', work);
    assert.doesNotMatch(codexWork(t).at(-1).prompt, /（服务消息）岗位合同|（服务消息）这个岗位的 skill/, 'neither again');
  });

  it('DeepSeek gets the contract in the system prompt it rebuilds every run, and never a contract notice in the task', async () => {
    const scratch = tempDir('ssa-pi-');
    cleanups.push(() => fs.rmSync(scratch, { recursive: true, force: true }));
    const piCalls = path.join(scratch, 'pi-calls.jsonl');
    const t = await start({ env: { SPECIALIST_SUBAGENTS_RUNTIME: FAKE_PI_CLI, FAKE_PI_CALLS: piCalls } });
    const piWork = () => readJsonLines(piCalls).filter((call) => !call.closing);
    const v = versionOf('web_researcher');

    // web_researcher is recognised by domain, so it is dispatched with one and no cwd.
    const first = await dispatch(t, 'web_researcher', 'TASK-PI-1', { domain: 'ai' });
    assert.ok(piWork().at(-1), 'the run went to DeepSeek');
    assert.equal(first.seat.contract_version, v);

    // A session from before the record, and an older version: neither is told in the task.
    for (const [version, task] of [[null, 'TASK-PI-2'], ['0.9.0', 'TASK-PI-3']]) {
      plantContract(t, first.seat.id, version, version === null ? null : sha('old'));
      const next = await dispatch(t, 'web_researcher', task, { domain: 'ai' });
      assert.equal(next.seat.id, first.seat.id);
      assert.ok(next.events.some((event) => event.kind === 'session' && /Continuing prior session/.test(event.body)), 'the pi session is continued');
      const call = piWork().at(-1);
      assert.match(call.text, new RegExp(task));
      assert.doesNotMatch(call.text, CONTRACT_NOTICE);
      assert.equal(call.text.includes(contractLine('web_researcher')), false, 'no contract text in the task');
      assert.equal(call.system.split(contractLine('web_researcher')).length, 2, 'the contract once, in the rebuilt system prompt');
      assert.match(lastContractEvent(next), /DeepSeek rebuilds its system prompt every run/);
      assert.equal(next.seat.contract_version, v);
    }
  });
});

// S-4 (2026-10-11): two layers. The role's skill holds the craft and stays in HSkills; what is peculiar
// to one object goes into that expert's hand-off document. A refiner's candidate therefore belongs to
// the role, in the role's own two places, and nowhere object-shaped.
describe('[S-4] a candidate is a version of the role\'s skill', () => {
  it('[S-4] the candidate lands in the role\'s own candidate directory and is enabled into that role\'s skill', async () => {
    const original = '---\nname: h-explorer\ndescription: the original\n---\n\nOriginal.\n';
    const t = await start({ skills: { 'h-explorer': original } });
    for (let n = 1; n <= 5; n += 1) await addDifficulty(t, 'explorer', n);
    const [candidate] = await waitForCandidate(t, 'explorer');

    // The role's own place beside the ledger: not an object's directory, not an expert's hand-offs.
    assert.match(candidate.file.replaceAll('\\', '/'), /\/candidates\/explorer\/v\d+\.SKILL\.md$/, candidate.file);
    assert.ok(fs.existsSync(candidate.file));

    const real = JSON.parse(candidate.difficulty_ids).map((difficulty) => ({ difficulty, verdict: 'real' }));
    const enabled = await t.mcp.tool('candidate_decide', { id: candidate.id, verdicts: real, decision: 'enable' });
    assert.equal(enabled.isError, false, enabled.text);
    assert.equal(fs.readFileSync(t.skillFile('h-explorer'), 'utf8'), fs.readFileSync(candidate.file, 'utf8'));
    // Only the role's skill was written: nothing of it went anywhere else.
    assert.deepEqual(t.query('SELECT file FROM skill_versions').map((row) => row.file), [t.skillFile('h-explorer')]);
  });

  it('[S-4] refuses to enable a candidate filed outside the role\'s candidate directory', async () => {
    const t = await start();
    for (let n = 1; n <= 5; n += 1) await addDifficulty(t, 'explorer', n);
    const [good] = await waitForCandidate(t, 'explorer');

    // Filed in the role's skill directory instead of the role's candidate directory: the second layer
    // (an object's own place) coming in through the first layer's door.
    const outside = path.join(t.hskills, 'skills', 'h-explorer', 'v99.SKILL.md');
    fs.mkdirSync(path.dirname(outside), { recursive: true });
    fs.writeFileSync(outside, fs.readFileSync(good.file, 'utf8'));
    const planted = t.write((db) => {
      const row = db.prepare('SELECT * FROM candidates WHERE id = ?').get(good.id);
      const at = new Date().toISOString();
      const info = db
        .prepare('INSERT INTO candidates (role, version, file, why_file, difficulty_ids, base_sha, state, note, warnings, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)')
        .run('explorer', row.version + 1, outside, row.why_file, row.difficulty_ids, row.base_sha, 'pending', at, at);
      return Number(info.lastInsertRowid);
    });

    const real = JSON.parse(good.difficulty_ids).map((difficulty) => ({ difficulty, verdict: 'real' }));
    const refused = await t.mcp.tool('candidate_decide', { id: planted, verdicts: real, decision: 'enable' });
    assert.equal(refused.isError, true, 'a candidate outside the role\'s own place is not enabled');
    assert.match(refused.text, /role’s skill|is outside explorer's candidate directory/);
    assert.equal(fs.existsSync(t.skillFile('h-explorer')), false, 'nothing was written into HSkills');
    assert.equal(t.query('SELECT state FROM candidates WHERE id = ?', planted)[0].state, 'pending');
  });
});
