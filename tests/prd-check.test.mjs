import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, after } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { c6Numbers, parsePrd } from '../tools/prd-check.mjs';
import { REPO, tempDir } from './lib/sandbox.mjs';

await describe('prd-check', { concurrency: false }, async () => {
// [P-1] node tools/prd-check.mjs: statuses come from tagged test results, and a broken scenario
// drags down every requirement it covers. These tests drive it against a tiny fixture PRD.










const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const checker = path.join(repo, 'tools', 'prd-check.mjs');
const fixtureRel = 'tests/fixtures/prd-check/basic';

const tempDir = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const cleanup = (dir) => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });

function check({ fixture = fixtureRel, extraArgs = [], json = true, env = {}, archive, ledger } = {}) {
  const temp = tempDir('prd-check-');
  try {
    const base = fixture;
    const args = [
      checker,
      '--prd', `${base}/PRD.md`,
      '--tests', `${base}/*.fixture-test.mjs`,
      '--scenarios', `${base}/*.scenario.mjs`,
      '--archive', archive ?? path.join(temp, 'archive'),
      '--ledger', ledger ?? path.join(temp, 'no-such-ledger.sqlite3'),
      ...(json ? ['--json'] : []),
      ...extraArgs,
    ];
    const run = spawnSync(process.execPath, args, { cwd: repo, env: { ...process.env, FIXTURE_T1: '', ...env }, encoding: 'utf8', timeout: 120000 });
    return { run, report: json && run.stdout.trim().startsWith('{') ? JSON.parse(run.stdout) : null, temp };
  } catch (err) {
    cleanup(temp);
    throw err;
  }
}

const byId = (list, id) => list.find((item) => item.id === id);

describe('prd-check', () => {
  it('[P-1] parses scenarios, covers and requirements, and ignores X-* and other sections', () => {
    const parsed = parsePrd(fs.readFileSync(path.join(repo, fixtureRel, 'PRD.md'), 'utf8'));
    assert.deepEqual(parsed.scenarios, [{ id: 'T-1', title: 'x', covers: ['A-1'] }]);
    assert.deepEqual(parsed.requirements.map((r) => r.id), ['A-1', 'A-2']);
  });

  it('[P-1] everything passes: exit 0, both requirements implemented, X-1 absent', () => {
    const { run, report, temp } = check();
    try {
      assert.equal(run.status, 0, run.stdout + run.stderr);
      assert.equal(byId(report.requirements, 'A-1').status, '已实现');
      assert.equal(byId(report.requirements, 'A-2').status, '已实现');
      assert.equal(byId(report.requirements, 'X-1'), undefined);
      assert.equal(byId(report.scenarios, 'T-1').passed, true);
    } finally { cleanup(temp); }
  });

  it('[P-1] a failing scenario shows where it broke and drags down the requirements it covers', () => {
    const { run, report, temp } = check({ env: { FIXTURE_T1: 'fail' } });
    try {
      assert.equal(run.status, 1, run.stdout + run.stderr);
      const t1 = byId(report.scenarios, 'T-1');
      assert.equal(t1.passed, false);
      assert.match(t1.reason, /第2步/);
      const a1 = byId(report.requirements, 'A-1');
      assert.equal(a1.status, '未实现');
      assert.match(a1.reason, /T-1/);
      assert.equal(byId(report.requirements, 'A-2').status, '已实现');
    } finally { cleanup(temp); }
  });

  it('[P-1][P-3] a requirement whose test was deleted is unimplemented', () => {
    const temp = tempDir('prd-check-copy-');
    try {
      const copy = path.join(temp, 'basic');
      fs.cpSync(path.join(repo, fixtureRel), copy, { recursive: true });
      const testFile = path.join(copy, 'a.fixture-test.mjs');
      fs.writeFileSync(testFile, fs.readFileSync(testFile, 'utf8').replace(/^it\('\[A-2\].*\r?\n/m, ''));
      const { run, report, temp: t2 } = check({ fixture: copy });
      try {
        assert.equal(run.status, 1, run.stdout + run.stderr);
        const a2 = byId(report.requirements, 'A-2');
        assert.equal(a2.status, '未实现');
        assert.match(a2.reason, /No tests tagged \[A-2\]/);
        assert.equal(byId(report.requirements, 'A-1').status, '已实现');
      } finally { cleanup(t2); }
      const zh = check({ fixture: copy, env: { SPECIALIST_SUBAGENTS_LANG: 'zh' } });
      try {
        assert.equal(zh.run.status, 1, zh.run.stdout + zh.run.stderr);
        assert.match(byId(zh.report.requirements, 'A-2').reason, /没有带 \[A-2\] 的测试/);
      } finally { cleanup(zh.temp); }
    } finally { cleanup(temp); }
  });

  it('[P-1] the text report has the summary line and says why C-6 cannot be computed', () => {
    const { run, temp } = check({ json: false });
    try {
      assert.equal(run.status, 0, run.stdout + run.stderr);
      assert.match(run.stdout, /Scenarios 1\/1 passed; requirements: 2 implemented, 0 require local machine, 0 not implemented \(2 total\)/);
      assert.match(run.stdout, /A-1 one: implemented/);
      assert.match(run.stdout, /Unavailable: no ledger file/);
      assert.match(run.stdout, /No real-model acceptance run yet/);
    } finally { cleanup(temp); }
    const zh = check({ json: false, env: { SPECIALIST_SUBAGENTS_LANG: 'zh' } });
    try {
      assert.equal(zh.run.status, 0, zh.run.stdout + zh.run.stderr);
      assert.match(zh.run.stdout, /场景 1\/1 过；需求 已实现 2，需要本机 0，未实现 0（共 2 条）/);
      assert.match(zh.run.stdout, /A-1 one：已实现/);
      assert.match(zh.run.stdout, /算不出：没有台账文件/);
      assert.match(zh.run.stdout, /还没有跑过真模型验收/);
    } finally { cleanup(zh.temp); }
  });

  it('[P-1] C-6 counts the newest runs, per load, and the blank starts on seats that had records', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE runs(id INTEGER PRIMARY KEY, seat TEXT, started_at TEXT, load TEXT, had_records INTEGER)');
    const insert = db.prepare('INSERT INTO runs(seat, started_at, load, had_records) VALUES (?, ?, ?, ?)');
    insert.run('old', 't0', 'fresh', 1); // outside the window below
    insert.run('a', 't1', 'resumed', 1);
    insert.run('a', 't2', 'loaded', 1);
    insert.run('b', 't3', 'fresh', 0);
    insert.run('c', 't4', 'fresh', 1);
    insert.run('c', 't5', 'resumed', 1);
    const all = c6Numbers(db, 50);
    assert.equal(all.total, 6);
    assert.deepEqual(all.byLoad, { resumed: 2, loaded: 1, fresh: 3 });
    assert.equal(all.blankOnExisting, 2);
    const newest = c6Numbers(db, 5);
    assert.equal(newest.total, 5);
    assert.equal(newest.blankOnExisting, 1);
    db.close();
  });

  it('[P-1] a ledger without a runs table says so; one with runs prints the numbers', () => {
    const temp = tempDir('prd-check-ledger-');
    try {
      const empty = path.join(temp, 'empty.sqlite3');
      const emptyDb = new DatabaseSync(empty);
      emptyDb.exec('CREATE TABLE other(x)');
      emptyDb.close();
      const first = check({ json: false, ledger: empty });
      try { assert.match(first.run.stdout, /Unavailable: ledger has no per-run loading records \(runs table\)/); } finally { cleanup(first.temp); }

      const full = path.join(temp, 'full.sqlite3');
      const fullDb = new DatabaseSync(full);
      fullDb.exec('CREATE TABLE runs(id INTEGER PRIMARY KEY, seat TEXT, started_at TEXT, load TEXT, had_records INTEGER)');
      fullDb.exec("INSERT INTO runs(seat, started_at, load, had_records) VALUES ('a','t','fresh',1),('a','t','resumed',1)");
      fullDb.close();
      const second = check({ json: false, ledger: full });
      try {
        assert.match(second.run.stdout, /Existing experts starting blank: 1 \(target 0\)/);
        assert.match(second.run.stdout, /Resumed 1, loaded records 0, fresh object 1/);
      } finally { cleanup(second.temp); }
    } finally { cleanup(temp); }
  });

  it('[P-1] --real archives the scenario results and a later plain run reports them', () => {
    const archive = tempDir('prd-check-archive-');
    try {
      const real = check({ archive, extraArgs: ['--real'], env: { PRD_REAL_BACKEND: 'fixture-model' } });
      cleanup(real.temp);
      const latest = JSON.parse(fs.readFileSync(path.join(archive, 'latest.json'), 'utf8'));
      assert.equal(latest.backend, 'fixture-model');
      assert.deepEqual(latest.scenarios, [{ id: 'T-1', passed: true, error: null }]);
      assert.match(latest.at, /^\d{4}-\d{2}-\d{2}T/);
      assert.ok(fs.readdirSync(archive).some((name) => name !== 'latest.json' && name.endsWith('.json') && !name.includes(':')));

      const plain = check({ archive, json: false });
      try { assert.match(plain.run.stdout, /Latest real-model acceptance: .*\(fixture-model\), 1\/1 scenarios passed/); } finally { cleanup(plain.temp); }
    } finally { cleanup(archive); }
  });

  it('[P-1] an unreadable PRD exits 2 with the reason', () => {
    const temp = tempDir('prd-check-bad-');
    try {
      const run = spawnSync(process.execPath, [checker, '--prd', path.join(temp, 'missing.md')], { cwd: repo, encoding: 'utf8', timeout: 30000 });
      assert.equal(run.status, 2);
      assert.match(run.stderr, /Could not read PRD/);
    } finally { cleanup(temp); }
  });
});
});

await describe('prd-texts', { concurrency: false }, async () => {
// The texts PRD.md says must exist: the entry documents point at the PRD (P-2), and the team leader's
// manual and the coder's guide carry the rule that the leader fixes the change for the coder (R-5).
// These are read straight off the checkout, so a rewritten manual cannot drop the sentence unnoticed.






const read = (rel) => fs.readFileSync(path.join(REPO, ...rel.split('/')), 'utf8');
const head = (rel, lines = 10) => read(rel).split(/\r?\n/).slice(0, lines).join('\n');

describe('the entry documents point at the PRD', () => {
  for (const rel of ['README.md', 'doc/connect.md', 'dispatch/team-leader.md']) {
    it(`[P-2] ${rel} says in its first 10 lines that the requirements follow doc/PRD.md`, () => {
      assert.ok(head(rel).includes('doc/PRD.md'), head(rel));
    });
  }
  for (const rel of ['README.zh-CN.md', 'doc/connect.zh-CN.md', 'dispatch/zh-CN/team-leader.md']) {
    it(`[P-2] ${rel} says in its first 10 lines that the requirements follow doc/PRD.md`, () => {
      assert.ok(head(rel).includes('需求以 `doc/PRD.md` 为准'), head(rel));
    });
  }

  it('[P-2] doc/REQUIREMENTS.md says in its first 10 lines that it has been superseded', () => {
    assert.ok(head('doc/REQUIREMENTS.md').includes('已被取代'), head('doc/REQUIREMENTS.md'));
  });
});

describe('the coder only does what the leader has fixed', () => {
  for (const rel of ['dispatch/team-leader.md', 'dispatch/coder.md']) {
    it(`[R-5] ${rel} says the leader fixes the change and an explorer draws the map first`, () => {
      const text = read(rel);
      assert.match(text, /fix(?:es)? the implementation approach/i, `${rel} lacks leader-fixed implementation approach`);
      assert.match(text, /explorer.*map/i, `${rel} does not send investigation to an explorer`);
    });
  }
  for (const rel of ['dispatch/zh-CN/team-leader.md', 'dispatch/zh-CN/coder.md']) {
    it(`[R-5] ${rel} says the leader fixes the change and an explorer draws the map first`, () => {
      const text = read(rel);
      assert.ok(text.includes('改法由组长定死'), `${rel} lacks 改法由组长定死`);
      assert.match(text, /explorer\s*出图/, `${rel} does not send investigation to an explorer`);
    });
  }
});
});

await describe('migration', { concurrency: false }, async () => {
// G-3: the ledger is the one asset that cannot be rebuilt. A schema migration copies the file first,
// loses no old row, and can be rolled back (drop what it added) so the older code still reads it.
//
// The ledger here is built by hand with the schema of commit b2fb04e (before the runs table and the
// seats.fork column), kept open in WAL mode while the new code opens it, so the backup has to carry what
// the WAL still holds. The new store runs in a child process each time: it reads its ledger path once.









// The tables of src/store.mjs at b2fb04e (`git show b2fb04e:src/store.mjs`), columns the ALTERs add inline.
const OLD_SCHEMA = `
CREATE TABLE roles (id TEXT PRIMARY KEY, spec TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE seats (
  id TEXT PRIMARY KEY, role TEXT NOT NULL, instance INTEGER NOT NULL, owner TEXT, parent TEXT, state TEXT NOT NULL,
  handle TEXT, pid INTEGER, opened_at TEXT NOT NULL, updated_at TEXT NOT NULL, closed_at TEXT,
  cwd TEXT, name TEXT, expertise TEXT, session_file TEXT, dir_state TEXT, backlog TEXT, skill_hash TEXT,
  contract_version TEXT, contract_hash TEXT, domain TEXT
);
CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, seat TEXT NOT NULL, kind TEXT NOT NULL, body TEXT, at TEXT NOT NULL);
CREATE INDEX events_seat_kind_at ON events (seat, kind, at);
CREATE TABLE memories (seq INTEGER PRIMARY KEY AUTOINCREMENT, role TEXT NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL, source TEXT, at TEXT NOT NULL);
CREATE TABLE difficulties (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, seat TEXT NOT NULL, role TEXT NOT NULL, cwd TEXT, kind TEXT NOT NULL, tool TEXT,
  detail TEXT, description TEXT, run_tokens INTEGER, run_cost REAL, at TEXT NOT NULL, run TEXT
);
CREATE TABLE run_usage (seat TEXT NOT NULL, role TEXT NOT NULL, tokens INTEGER NOT NULL, cost REAL, at TEXT NOT NULL);
CREATE TABLE difficulty_reviews (seq INTEGER PRIMARY KEY AUTOINCREMENT, class TEXT NOT NULL, decision TEXT NOT NULL, note TEXT, at TEXT NOT NULL);
CREATE TABLE candidates (
  id INTEGER PRIMARY KEY AUTOINCREMENT, role TEXT NOT NULL, version INTEGER NOT NULL, file TEXT NOT NULL, why_file TEXT,
  difficulty_ids TEXT NOT NULL, base_sha TEXT, state TEXT NOT NULL, note TEXT, warnings TEXT, created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL, decided_at TEXT
);
CREATE TABLE candidate_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, role TEXT NOT NULL, difficulty_ids TEXT NOT NULL, seat TEXT, work_dir TEXT,
  base_sha TEXT, status TEXT NOT NULL, detail TEXT, candidate_id INTEGER, started_at TEXT NOT NULL, ended_at TEXT
);
CREATE TABLE difficulty_verdicts (
  candidate_id INTEGER NOT NULL, difficulty_id INTEGER NOT NULL, verdict TEXT NOT NULL, note TEXT, at TEXT NOT NULL,
  PRIMARY KEY (candidate_id, difficulty_id)
);
CREATE TABLE skill_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, role TEXT NOT NULL, skill TEXT NOT NULL, version INTEGER NOT NULL, candidate_id INTEGER,
  file TEXT NOT NULL, sha256 TEXT NOT NULL, previous_file TEXT, note TEXT, at TEXT NOT NULL, body_sha256 TEXT
);
`;

const TABLES = ['roles', 'seats', 'events', 'memories', 'difficulties', 'run_usage', 'difficulty_reviews', 'candidates', 'candidate_runs', 'difficulty_verdicts', 'skill_versions'];

const scratch = tempDir('ssa-migration-');
after(() => fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));

// An old ledger with a few seats and events, left open in WAL mode: returns the handle.
function oldLedger(name) {
  const file = path.join(scratch, name, 'ledger.sqlite3');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const old = new DatabaseSync(file);
  old.exec('PRAGMA journal_mode = WAL');
  old.exec(OLD_SCHEMA);
  const at = '2026-10-01T00:00:00.000Z';
  const seat = old.prepare('INSERT INTO seats (id, role, instance, owner, parent, state, opened_at, updated_at, cwd, name, session_file, backlog) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  seat.run('seat-coder-1', 'coder', 1, 'lead', null, 'done', at, at, '/work/a', 'coder · a', '/sessions/a.jsonl', '- 还没跑集成测试');
  seat.run('seat-explorer-2', 'explorer', 2, null, 'seat-coder-1', 'closed', at, at, '/work/b', '读 b 的专家', null, null);
  seat.run('seat-web_researcher-3', 'web_researcher', 3, 'lead', null, 'failed', at, at, '/data/ai', null, null, null);
  const event = old.prepare('INSERT INTO events (seat, kind, body, at) VALUES (?, ?, ?, ?)');
  for (const [s, kind, body] of [['seat-coder-1', 'task', '读 README'], ['seat-coder-1', 'stdout', '第一行'], ['seat-coder-1', 'exit', '0'], ['seat-explorer-2', 'close', '不用了'], ['seat-web_researcher-3', 'error', 'boom']]) {
    event.run(s, kind, body, at);
  }
  old.prepare('INSERT INTO memories (role, kind, body, at) VALUES (?, ?, ?, ?)').run('coder', 'fact', '用 tab 缩进', at);
  old.prepare('INSERT INTO run_usage (seat, role, tokens, cost, at) VALUES (?, ?, ?, ?, ?)').run('seat-coder-1', 'coder', 1500, 0.01, at);
  return { file, old };
}

const rowsOf = (database, drop = []) => Object.fromEntries(TABLES.map((table) => [
  table,
  database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all().map((row) => Object.fromEntries(Object.entries(row).filter(([key]) => !drop.includes(key)))),
]));

const columnsOf = (database, table) => database.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
const tablesOf = (database) => database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
const backupsOf = (file) => fs.readdirSync(path.dirname(file)).filter((name) => name.startsWith(`${path.basename(file)}.bak-`));

// The service's store on `file`, in its own process: opens the ledger (migrating it) and reports.
function openWithNewStore(file) {
  const script = `
    const store = await import(${JSON.stringify(pathToFileURL(path.join(REPO, 'src', 'store.mjs')).href)});
    console.log(JSON.stringify({ seats: store.listSeats().length, file: store.dbFile() }));
    store.close();
  `;
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, SPECIALIST_SUBAGENTS_DB: file }, encoding: 'utf8' }));
}

describe('[G-3] migrating a ledger', () => {
  it('copies the old file first, keeps every old row, adds the runs table and the seat columns, and backs up only once', () => {
    const { file, old } = oldLedger('migrate');
    const before = rowsOf(old);
    const opened = openWithNewStore(file); // `old` is still open: the WAL holds rows the main file does not
    old.close();
    assert.equal(opened.seats, 3);

    const migrated = new DatabaseSync(file, { readOnly: true });
    try {
      assert.ok(tablesOf(migrated).includes('runs'), 'the runs table exists');
      assert.ok(columnsOf(migrated, 'seats').includes('fork'), 'seats has the fork column');
      assert.ok(columnsOf(migrated, 'seats').includes('topic'), 'seats has the topic column (L-3)');
      assert.ok(columnsOf(migrated, 'seats').includes('pending_handoff'), 'seats has the pending_handoff column (L-1)');
      assert.ok(columnsOf(migrated, 'difficulties').includes('expert'), 'difficulties has the expert column (S-1)');
      // roles is rewritten from roles.json at every start, so it is the one table that is not compared.
      // fork / topic / pending_handoff / expert are the columns this migration added; old rows hold no
      // value for them, so the comparison drops them rather than carrying NULLs the old rows never had.
      const after = rowsOf(migrated, ['fork', 'topic', 'pending_handoff', 'expert']);
      for (const table of TABLES.filter((t) => t !== 'roles')) assert.deepEqual(after[table], before[table], `${table}: every old row is unchanged`);
    } finally {
      migrated.close();
    }

    const backups = backupsOf(file);
    assert.equal(backups.length, 1, `one backup, got ${backups.join(', ')}`);
    assert.match(backups[0], /\.bak-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}/, 'named by the ISO time with the colons replaced');
    const backup = new DatabaseSync(path.join(path.dirname(file), backups[0]), { readOnly: true });
    try {
      assert.ok(!tablesOf(backup).includes('runs'), 'the backup still has the old schema');
      assert.ok(!columnsOf(backup, 'seats').includes('fork'));
      assert.ok(!columnsOf(backup, 'difficulties').includes('expert'), 'the backup predates the expert column');
      const kept = rowsOf(backup);
      for (const table of TABLES) assert.deepEqual(kept[table], before[table], `${table}: the backup holds the same rows`);
    } finally {
      backup.close();
    }

    // A second open finds nothing to change and makes no second backup.
    openWithNewStore(file);
    assert.equal(backupsOf(file).length, 1, 'no new backup when the schema is already current');
  });

  it('a brand-new ledger is not backed up', () => {
    const file = path.join(scratch, 'fresh', 'ledger.sqlite3');
    openWithNewStore(file);
    assert.ok(fs.existsSync(file));
    assert.deepEqual(backupsOf(file), []);
    openWithNewStore(file);
    assert.deepEqual(backupsOf(file), [], 'nor on later starts');
  });

  it('rolls back: dropping the runs table and the added seat columns leaves the old rows readable with the old schema', () => {
    const { file, old } = oldLedger('rollback');
    const before = rowsOf(old);
    old.close();
    openWithNewStore(file);

    const db = new DatabaseSync(file);
    try {
      // New data on top of the migration is lost by a roll back; the old rows must not be.
      db.exec('DROP TABLE runs');
      db.exec('ALTER TABLE seats DROP COLUMN fork');
      db.exec('ALTER TABLE seats DROP COLUMN topic');
      db.exec('ALTER TABLE seats DROP COLUMN pending_handoff');
      db.exec('ALTER TABLE difficulties DROP COLUMN expert');
      const oldColumns = ['id', 'role', 'instance', 'owner', 'parent', 'state', 'handle', 'pid', 'opened_at', 'updated_at', 'closed_at', 'cwd', 'name', 'expertise', 'session_file', 'dir_state', 'backlog', 'skill_hash', 'contract_version', 'contract_hash', 'domain'];
      assert.deepEqual(columnsOf(db, 'seats'), oldColumns, 'the seats table is the old one again');
      // What the old code asks, as plain SELECTs.
      const seats = db.prepare('SELECT id, role, state, cwd, name, session_file FROM seats ORDER BY id').all();
      assert.deepEqual(seats.map((s) => s.id), ['seat-coder-1', 'seat-explorer-2', 'seat-web_researcher-3']);
      const events = db.prepare("SELECT seat, kind, body FROM events WHERE seat = 'seat-coder-1' ORDER BY seq").all();
      assert.deepEqual(events.map((e) => e.kind), ['task', 'stdout', 'exit']);
      const after = rowsOf(db);
      for (const table of TABLES.filter((t) => t !== 'roles')) assert.deepEqual(after[table], before[table], `${table}: unchanged after the roll back`);
    } finally {
      db.close();
    }
  });
});
});
