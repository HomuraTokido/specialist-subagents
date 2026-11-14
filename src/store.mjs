// specialist-subagents ledger store.
// One node:sqlite file, shared by every specialist-subagents process (daemon, MCP shell, CLI, demo).
// Nothing here is runtime specific: a seat row only carries what roles.json declares.

import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { equivalentCost } from './pricing.mjs';
import { pidAlive } from './proc.mjs';
import { expectedRule } from './expected-traces.mjs';
import { language, message } from './presets.mjs';
import { sessionPressure } from './session-pressure.mjs';
import { callerLabel } from './role-contract.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROLES_FILE = path.join(ROOT, 'roles.json');
const DB_FILE = process.env.SPECIALIST_SUBAGENTS_DB
  ? path.resolve(process.env.SPECIALIST_SUBAGENTS_DB)
  : path.join(ROOT, '.data', 'ledger.sqlite3');

let db = null;

function now() {
  return new Date().toISOString();
}

// The module-level handle is published only once the schema and the roles are in place. Assigning it
// first (as this did until 2026-09-30) meant a failed init — a locked file, an ALTER that hit a view
// of the same name, a bad roles.json — threw once and then left a half-built handle that every later
// call returned silently: no roles, maybe no tables, and an "unknown role" error far from the cause.
function conn() {
  if (db) return db;
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
  // Looked at before the file is opened: opening creates it, and a brand-new ledger has nothing to lose.
  const existed = ledgerFileExists(DB_FILE);
  const handle = new DatabaseSync(DB_FILE);
  try {
    initSchema(handle, { existed });
    syncRoles(handle);
  } catch (err) {
    try { handle.close(); } catch { /* already unusable */ }
    throw err;
  }
  db = handle;
  return db;
}

// An existing ledger is one with bytes in it. A zero-byte file (touched, or left by a failed first open)
// holds no seats and no events, so it counts as new.
function ledgerFileExists(file) {
  try {
    return fs.statSync(file).size > 0;
  } catch {
    return false;
  }
}

// A text fingerprint of the tables, indexes and columns: what "the schema changed" is decided by.
function schemaShape(database) {
  const lines = [];
  for (const item of database.prepare("SELECT name, type FROM sqlite_master WHERE type IN ('table', 'index') AND name NOT LIKE 'sqlite_%' ORDER BY type, name").all()) {
    lines.push(`${item.type} ${item.name}`);
    if (item.type === 'table') {
      for (const column of database.prepare(`PRAGMA table_info("${item.name}")`).all()) lines.push(`  ${column.name} ${column.type}`);
    }
  }
  return lines.join('\n');
}

// G-3 (2026-10-11): the ledger is the one asset that cannot be rebuilt, so before the code adds a table,
// a column or an index to a ledger file that already exists, the file is copied to
// `<file>.bak-<time>`. Only when a change is really about to happen: the dry run below applies the
// whole schema inside a transaction, compares the shape and rolls it back (DDL is transactional in
// SQLite), so an up-to-date ledger opens without a copy and every later start stays quiet.
// VACUUM INTO writes a consistent snapshot of the live database, WAL content included, which a plain
// copy of the main file would miss. Returns the backup's path, or null when nothing was to change.
function backupBeforeMigration(database) {
  database.exec('BEGIN IMMEDIATE');
  let changes;
  try {
    const before = schemaShape(database);
    createTables(database);
    changes = schemaShape(database) !== before;
  } finally {
    database.exec('ROLLBACK');
  }
  if (!changes) return null;
  const stamp = now().replaceAll(':', '-');
  for (let n = 0; ; n += 1) {
    const target = `${DB_FILE}.bak-${stamp}${n ? `-${n}` : ''}`;
    if (fs.existsSync(target)) continue;
    database.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`);
    return target;
  }
}

function initSchema(db, { existed = false } = {}) {
  // busy_timeout first: switching to WAL needs a lock, and another process (CLI, demo) may hold the file.
  db.prepare('PRAGMA busy_timeout = 5000').get();
  db.prepare('PRAGMA journal_mode = WAL').get();
  if (existed) backupBeforeMigration(db);
  createTables(db);
}

function createTables(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS roles (
    id TEXT PRIMARY KEY,
    spec TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS seats (
    id TEXT PRIMARY KEY,
    role TEXT NOT NULL,
    instance INTEGER NOT NULL,
    owner TEXT,
    parent TEXT,
    state TEXT NOT NULL,
    handle TEXT,
    pid INTEGER,
    opened_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    closed_at TEXT
  )`);
  // Where the seat's runtime works (2026-09-19). A ledger made before that has no such column; the
  // seats in it ran in this repository's own directory and stay NULL, which is what they knew.
  if (!db.prepare('PRAGMA table_info(seats)').all().some((column) => column.name === 'cwd')) {
    db.exec('ALTER TABLE seats ADD COLUMN cwd TEXT');
  }
  // A seat is a directory expert (2026-09-22): it keeps a readable name, a few lines on what it has
  // come to know, the session that holds that knowledge, and the state the directory was in when it
  // last looked. Seats from before have none of these and are never picked up again: their runs
  // were one-shot, so there is no knowledge to go back to.
  const seatColumns = db.prepare('PRAGMA table_info(seats)').all().map((column) => column.name);
  // `backlog` (2026-09-29): what the seat's last run said it left undone, carried into its next task.
  // `skill_hash` (2026-10-01): the content hash of the skill the session in `session_file` was last
  // given ('none' for no skill; NULL for a session from before skills were loaded, read as 'none').
  // Codex, Grok and Claude get the skill only when a session starts, so a run that continues one
  // compares this with the current skill and hands the new text along when they differ (exec.mjs).
  // `contract_version` and `contract_hash` (2026-10-01): the same for the role contract, its version
  // (roles.json contract_version) and the sha256 of its text as that session was last given them. NULL
  // for a session from before they were recorded, which counts as changed once (run-contract.mjs).
  // `domain` (2026-10-10): the field of knowledge a seat expertises when its role declares
  // `expert_by: "domain"` (web_researcher). NULL for every directory expert, the seats that came
  // before this and every seat a directory role opens.
  for (const column of ['name', 'expertise', 'session_file', 'dir_state', 'backlog', 'skill_hash', 'contract_version', 'contract_hash', 'domain']) {
    if (!seatColumns.includes(column)) db.exec(`ALTER TABLE seats ADD COLUMN ${column} TEXT`);
  }
  // `fork` (2026-10-11, C-3): 1 when the seat is a fork of a busy expert (its `parent` is that expert),
  // NULL or 0 for an expert. A fork carries one run and is closed when it ends; it is not in the roster.
  // Rolling back is `ALTER TABLE seats DROP COLUMN fork`: the old code never reads it.
  if (!seatColumns.includes('fork')) db.exec('ALTER TABLE seats ADD COLUMN fork INTEGER');
  // `topic` (2026-10-11, L-3): when one directory has several experts, this short label tells them apart
  // (seat_start takes an optional topic). NULL for every expert before this, and the single-expert
  // directories where the label is meaningless. Rolling back: `ALTER TABLE seats DROP COLUMN topic`.
  if (!seatColumns.includes('topic')) db.exec('ALTER TABLE seats ADD COLUMN topic TEXT');
  // `pending_handoff` (2026-10-11, L-1): a JSON marker `{file, from}` — a hand-off document to prepend to
  // this expert's NEXT task, exactly once, then cleared. set on seat_merge/seat_split, read and cleared
  // by exec.mjs at the next run start. NULL when nothing is pending. Rolling back: DROP COLUMN.
  if (!seatColumns.includes('pending_handoff')) db.exec('ALTER TABLE seats ADD COLUMN pending_handoff TEXT');
  db.exec(`CREATE TABLE IF NOT EXISTS events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    seat TEXT NOT NULL,
    kind TEXT NOT NULL,
    body TEXT,
    at TEXT NOT NULL
  )`);
  // seatRow() asks for each seat's latest 'task' event on every /seats read, the wall page's 1s poll
  // and every /events/wait tick, so without this index the cost grows as seats x events and events
  // only ever grow: 300 seats over 200k events took 3-4s per listSeats() on a scratch ledger, 3ms
  // with the index (2026-09-30 review). IF NOT EXISTS builds it once on an existing ledger.
  db.exec('CREATE INDEX IF NOT EXISTS events_seat_kind_at ON events (seat, kind, at)');
  // One row per run (2026-10-11, G-3 / C-5 / C-6). A run used to be only "a task event and what follows
  // it", which could not say whose records it belongs to once forks exist, nor how it was loaded.
  // `expert` is the seat's `parent` for a fork and the seat itself otherwise, so a fork's run counts
  // under the expert; `task_seq` is the seq of the run's task event (the run key the rest of the
  // service uses); `load` is resumed | loaded | fresh (how the run got its records, C-1), and
  // `had_records` is 1 when the expert already had records at the start: fresh with had_records = 1
  // is the "派给已有专家却空白开工" defect C-6 counts. `session_file` and `report_file` are what the
  // run left on disk, which C-5 hands the next run. prd-check's c6Numbers reads id, seat, started_at,
  // load and had_records. Rolling back is DROP TABLE runs: nothing else reads it.
  db.exec(`CREATE TABLE IF NOT EXISTS runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    seat TEXT NOT NULL,
    expert TEXT NOT NULL,
    task_seq INTEGER,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    state TEXT,
    load TEXT,
    had_records INTEGER NOT NULL DEFAULT 0,
    session_file TEXT,
    report_file TEXT
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS runs_expert_id ON runs (expert, id)');
  // Role memory: what a post learned, kept next to the seats it learned it in. Not tied to a
  // seat or a session, so it survives both; `role` is the only key.
  db.exec(`CREATE TABLE IF NOT EXISTS memories (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    role TEXT NOT NULL,
    kind TEXT NOT NULL,
    body TEXT NOT NULL,
    source TEXT,
    at TEXT NOT NULL
  )`);
  // The difficulty ledger (2026-09-22, FR-21): a cost the work paid that it did not want to pay,
  // read off the run's traces by the runner rather than asked of the model. One row per trace; a
  // class is role × kind × tool. `run_usage` keeps each run's size so "unusually costly" has a
  // baseline per role. `difficulty_reviews` is the verdict「マスター」and the lead gave a class.
  db.exec(`CREATE TABLE IF NOT EXISTS difficulties (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    seat TEXT NOT NULL,
    role TEXT NOT NULL,
    cwd TEXT,
    kind TEXT NOT NULL,
    tool TEXT,
    detail TEXT,
    description TEXT,
    run_tokens INTEGER,
    run_cost REAL,
    at TEXT NOT NULL
  )`);
  if (!db.prepare('PRAGMA table_info(difficulties)').all().some((column) => column.name === 'run')) {
    db.exec('ALTER TABLE difficulties ADD COLUMN run TEXT');
  }
  // `expert` (2026-10-11, S-1): which expert this difficulty belongs to. A difficulty is filed under
  // the expert, not under the seat that paid it, so a fork's trouble counts as its expert's: the same
  // rule the runs table uses. NULL for rows written before this, which belong to their own seat.
  // Rolling back is `ALTER TABLE difficulties DROP COLUMN expert`: the old code never reads it.
  if (!db.prepare('PRAGMA table_info(difficulties)').all().some((column) => column.name === 'expert')) {
    db.exec('ALTER TABLE difficulties ADD COLUMN expert TEXT');
  }
  // `refused` (2026-10-25): a run stopped by the backend model's safety filter is its own kind. Before,
  // a run that failed this way was a plain 'failed' row with the event's subtype in its text; those rows
  // are moved over once, here, with the backend in `tool` (only Claude reported the event then). A
  // lead's verdict note that mentions a refusal stays a revised / rejected row: that is the lead's call.
  db.exec(`UPDATE difficulties SET kind = 'refused', tool = COALESCE(tool, 'claude')
    WHERE kind = 'failed' AND detail LIKE '%model_refusal%'`);
  db.exec(`CREATE TABLE IF NOT EXISTS run_usage (
    seat TEXT NOT NULL,
    role TEXT NOT NULL,
    tokens INTEGER NOT NULL,
    cost REAL,
    at TEXT NOT NULL
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS difficulty_reviews (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    class TEXT NOT NULL,
    decision TEXT NOT NULL,
    note TEXT,
    at TEXT NOT NULL
  )`);
  // The skill loop (2026-10-01, architecture-v2 step 4). A candidate is a refiner's proposed new text
  // of one role's skill; its body is a file next to the ledger, never in this table. `difficulty_ids`
  // are the difficulties.seq values it was written from (JSON array); `base_sha` is the hash of the
  // skill text it was written against (NULL: the role had no skill yet), so enabling can notice that
  // the skill moved underneath it. States: pending | active | rejected | deferred.
  db.exec(`CREATE TABLE IF NOT EXISTS candidates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    role TEXT NOT NULL,
    version INTEGER NOT NULL,
    file TEXT NOT NULL,
    why_file TEXT,
    difficulty_ids TEXT NOT NULL,
    base_sha TEXT,
    state TEXT NOT NULL,
    note TEXT,
    warnings TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    decided_at TEXT
  )`);
  // One row per refiner run the service started for a batch of difficulties. It is what keeps a role
  // from getting two refiners at once and what a failed attempt leaves behind (status 'failed' with the
  // reason and when it ended: the retry waits on it). status: running | done | failed.
  db.exec(`CREATE TABLE IF NOT EXISTS candidate_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    role TEXT NOT NULL,
    difficulty_ids TEXT NOT NULL,
    seat TEXT,
    work_dir TEXT,
    base_sha TEXT,
    status TEXT NOT NULL,
    detail TEXT,
    candidate_id INTEGER,
    started_at TEXT NOT NULL,
    ended_at TEXT
  )`);
  // The lead's judgment of each difficulty a candidate was written from: real | invalid | sporadic.
  db.exec(`CREATE TABLE IF NOT EXISTS difficulty_verdicts (
    candidate_id INTEGER NOT NULL,
    difficulty_id INTEGER NOT NULL,
    verdict TEXT NOT NULL,
    note TEXT,
    at TEXT NOT NULL,
    PRIMARY KEY (candidate_id, difficulty_id)
  )`);
  // Written only by enabling a candidate (skill-loop.mjs): one row per skill text the service put into
  // HSkills. `file` is the SKILL.md it wrote, `previous_file` a copy of what it replaced (NULL when the
  // skill did not exist before).
  db.exec(`CREATE TABLE IF NOT EXISTS skill_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    role TEXT NOT NULL,
    skill TEXT NOT NULL,
    version INTEGER NOT NULL,
    candidate_id INTEGER,
    file TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    previous_file TEXT,
    note TEXT,
    at TEXT NOT NULL
  )`);
  // `body_sha256` (2026-10-01): the hash of what a run is handed of that text (skill-text.mjs skillBody:
  // no frontmatter). `sha256` covers the whole file, and stamp.py rewrites the frontmatter after an
  // enable, so only this one still names the version a run carried. NULL on rows written before it.
  if (!db.prepare('PRAGMA table_info(skill_versions)').all().some((column) => column.name === 'body_sha256')) {
    db.exec('ALTER TABLE skill_versions ADD COLUMN body_sha256 TEXT');
  }
}

const DIFFICULTY_DECISIONS = ['contract', 'dispatch', 'service', 'tool_or_project', 'accept'];
const DIFFICULTY_DECISION_WORDS_ZH = {
  contract: '改岗位合同',
  dispatch: '给派活方的经验',
  service: '修服务',
  tool_or_project: '做工具或开项目',
  accept: '暂时接受',
};
const DIFFICULTY_DECISION_WORDS_EN = {
  contract: 'update role contract',
  dispatch: 'caller guidance',
  service: 'fix service',
  tool_or_project: 'build tool or open project',
  accept: 'accept for now',
};
const DIFFICULTY_KIND_WORDS_ZH = {
  failed: '运行失败',
  error: '工具报错',
  blocked: '写入被边界拦下',
  empty: '检索没结果',
  retry: '同一工具连续失败：换法重试，或原样重跑同一个调用',
  compaction: '触发上下文压缩',
  uncertain: '下不了结论',
  costly: 'token 远超该岗位常态',
  refused: '被模型安全过滤拦下',
  revised: '产出要派活方改过才能用',
  rejected: '产出被派活方退回',
};
const DIFFICULTY_KIND_WORDS_EN = {
  failed: 'run failed',
  error: 'tool error',
  blocked: 'blocked by boundary',
  empty: 'empty search result',
  retry: 'repeated tool failure: retried or repeated identical call',
  compaction: 'context compaction triggered',
  uncertain: 'inconclusive result',
  costly: 'token usage far above role baseline',
  refused: 'blocked by model safety filter',
  revised: 'output required caller edits',
  rejected: 'output rejected by caller',
};
export const difficultyDecisionWord = (decision, lang = language()) =>
  (lang === 'zh' ? DIFFICULTY_DECISION_WORDS_ZH : DIFFICULTY_DECISION_WORDS_EN)[decision] ?? decision;
const SEAT_VERDICTS = ['accepted', 'revised', 'rejected'];
export const DIFFICULTY_REMIND_AT = 2;

export function difficultyClass(row) {
  return `${row.role}|${row.kind}|${row.tool ?? '-'}`;
}

export function recordRunUsage({ seat, role, tokens, cost }) {
  conn().prepare('INSERT INTO run_usage (seat, role, tokens, cost, at) VALUES (?, ?, ?, ?, ?)').run(seat, role, Math.round(tokens), cost ?? null, now());
}

// The median size of this role's last 20 runs, or null while fewer than 5 are on record.
export function usageMedian(role) {
  const rows = conn().prepare('SELECT tokens FROM run_usage WHERE role = ? ORDER BY at DESC LIMIT 20').all(role).map((r) => Number(r.tokens));
  if (rows.length < 5) return null;
  rows.sort((a, b) => a - b);
  return rows[Math.floor(rows.length / 2)];
}

// S-1 (2026-10-11): which expert a seat's trouble is filed under. A fork is not an expert: its
// difficulty belongs to the expert it was forked from, exactly as its run does. A seat that is not in
// the ledger (one the service has already forgotten) is its own expert, which is what every row
// written before this column meant.
function expertOfSeat(seat) {
  try {
    const row = conn().prepare('SELECT parent, fork FROM seats WHERE id = ?').get(seat);
    if (row && Number(row.fork) === 1 && row.parent) return row.parent;
  } catch {
    // a lookup that fails must not lose the difficulty
  }
  return seat;
}

export function recordDifficulty({ seat, expert = null, run = null, role, cwd = null, kind, tool = null, detail = null, description = null, runTokens = null, runCost = null }) {
  conn()
    .prepare(
      `INSERT INTO difficulties (seat, expert, run, role, cwd, kind, tool, detail, description, run_tokens, run_cost, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(seat, expert ?? expertOfSeat(seat), run, role, cwd, kind, tool, detail, description, runTokens, runCost, now());
}

// The dispatcher's verdict on a seat's last run (2026-09-29). The ledger above only sees what a run
// paid on the way (errors, empty searches, cost); it cannot see whether what came back was right.
// A revised or rejected verdict is written as a difficulty of that run, so it reaches
// difficulty_report, the verdicts and the refiner like any other; an accepted one is only an event.
//
// `run` is the seq of the task event that started the run being judged (seat_show lists them). Without
// it the verdict is about the seat's newest run. A reused expert has many runs, and a dispatcher that
// judges run 1 after run 2 has started would otherwise pin the verdict on run 2 (2026-09-30 review).
// A verdict that names its run says so in its own event body ("accepted（针对运行 #12）：note" or
// "accepted (for run #12): note"), which is how costRuns tells which run it belongs to; without a
// marker it belongs to the run before it.
const VERDICT_RUN_MARK = /^(accepted|revised|rejected)(?:(?:（针对运行 #| \(for run #)(\d+)[）)])?/;

export function recordSeatVerdict({ seat, verdict, note = null, run = null } = {}, lang = language()) {
  if (!SEAT_VERDICTS.includes(verdict)) {
    throw new Error(message(
      `verdict 只能是 accepted（直接采用）、revised（改过才能用）或 rejected（退回），收到「${verdict}」`,
      `verdict must be accepted, revised, or rejected; got "${verdict}"`,
      lang,
    ));
  }
  if (verdict !== 'accepted' && !String(note ?? '').trim()) {
    throw new Error(message(
      'revised 和 rejected 要写 note：改了什么或为什么退回，refiner 只能拿这句话当证据',
      'revised and rejected require note: explain what you changed or why it was rejected so the refiner has evidence',
      lang,
    ));
  }
  const database = conn();
  const row = database.prepare('SELECT * FROM seats WHERE id = ?').get(seat);
  if (!row) throw new Error(`unknown seat: ${seat}`);
  let task;
  if (run === null || run === undefined || run === '') {
    task = database.prepare("SELECT seq FROM events WHERE seat = ? AND kind = 'task' ORDER BY seq DESC LIMIT 1").get(seat);
  } else {
    task = Number.isInteger(Number(run)) ? database.prepare("SELECT seq FROM events WHERE seat = ? AND kind = 'task' AND seq = ?").get(seat, Number(run)) : null;
    if (!task) {
      throw new Error(message(
        `座位 ${seat} 没有从事件 ${run} 开始的运行：run 要填某次运行的 task 事件的 seq（seat_show 返回的 runs 里列着），不填就是最新一次运行`,
        `Seat ${seat} has no run starting at event #${run}: run must be a task event seq from seat_show (or omit for the latest run)`,
        lang,
      ));
    }
  }
  const marked = run === null || run === undefined || run === ''
    ? verdict
    : message(`${verdict}（针对运行 #${task.seq}）`, `${verdict} (for run #${task.seq})`, lang);
  const body = note ? message(`${marked}：${note}`, `${marked}: ${note}`, lang) : marked;
  const event = recordEvent({ seat, kind: 'verdict', body });
  if (verdict !== 'accepted') {
    recordDifficulty({ seat, expert: row.fork ? row.parent : seat, run: task ? `${seat}#${task.seq}` : null, role: row.role, cwd: row.cwd ?? null, kind: verdict, detail: String(note).trim() });
  }
  return event;
}

export function decideDifficulty({ klass, decision, note = null } = {}, lang = language()) {
  if (!DIFFICULTY_DECISIONS.includes(decision)) {
    const allowed = DIFFICULTY_DECISIONS.map((d) => message(`${d}（${difficultyDecisionWord(d, lang)}）`, `${d} (${difficultyDecisionWord(d, lang)})`, lang)).join(message('、', ', ', lang));
    throw new Error(message(`decision 只能是 ${allowed}`, `decision must be one of ${allowed}`, lang));
  }
  conn().prepare('INSERT INTO difficulty_reviews (class, decision, note, at) VALUES (?, ?, ?, ?)').run(klass, decision, note, now());
}

// The latest verdict of each class (difficulty_decide), by class key.
function classReviews() {
  const reviews = new Map();
  for (const r of conn().prepare('SELECT class, decision, note, at FROM difficulty_reviews ORDER BY seq').all()) reviews.set(r.class, r);
  return reviews;
}

// A class verdict closes every row of that class recorded up to it; a row after it is new evidence.
// The one rule for "closed by a class verdict": the class report and the skill loop's count both ask
// it, so the two cannot disagree about which difficulties are still open (2026-10-01 review: the loop
// counted rows the lead had already closed as 'accept' or 'service', and handed them to the refiner).
function closedByClassReview(row, reviews) {
  const review = reviews.get(difficultyClass(row));
  return Boolean(review && row.at <= review.at);
}

// The difficulties the lead judged (real / invalid / sporadic) while reviewing a candidate that was then
// enabled or rejected. Those are handled: the class report does not list them as waiting for a verdict
// again. A deferred or pending candidate's judgments do not close anything yet.
// A candidate records one row per class, the class's newest (2026-10-25), and the refiner was shown the
// whole class: judging that row judges the class, so every row of the class up to it is handled too.
// `marks` is class → the highest judged seq.
function judgedInDecidedCandidates() {
  const rows = conn()
    .prepare(
      `SELECT DISTINCT v.difficulty_id AS id, d.role, d.kind, d.tool FROM difficulty_verdicts v
       JOIN candidates c ON c.id = v.candidate_id
       LEFT JOIN difficulties d ON d.seq = v.difficulty_id
       WHERE c.state IN ('active', 'rejected')`
    )
    .all();
  const ids = new Set();
  const marks = new Map();
  for (const row of rows) {
    const id = Number(row.id);
    ids.add(id);
    if (row.role) {
      const klass = difficultyClass(row);
      marks.set(klass, Math.max(marks.get(klass) ?? 0, id));
    }
  }
  return { ids, marks };
}

// Each role's expected_traces (roles.json, through the roles table syncRoles keeps), read once per
// question. A role gone from roles.json has none, so its rows count.
function expectedRulesByRole() {
  const cache = new Map();
  return (role) => {
    if (!cache.has(role)) cache.set(role, roleSpec(role)?.expected_traces ?? []);
    return cache.get(role);
  };
}

// Classes with their occurrences since their last verdict (a verdict closes what came before it;
// what happens after is new evidence), leaving out the rows already judged in a candidate review that
// ended in enable or reject. Sorted by occurrences, then by the cost the runs carried.
// A row the role's contract makes normal (expected-traces.mjs) is not a difficulty: it is left out of
// the classes and only tallied, by class, so the report can say how many were left out and why. This
// is what stops rows written before the rule existed (web_researcher's honest 查不到) from counting.
function scanDifficulties(lang = language()) {
  const database = conn();
  const reviews = classReviews();
  const judged = judgedInDecidedCandidates();
  const rulesOf = expectedRulesByRole();
  const groups = new Map();
  const expected = new Map();
  for (const row of database.prepare('SELECT * FROM difficulties ORDER BY seq').all()) {
    const klass = difficultyClass(row);
    const review = reviews.get(klass);
    if (closedByClassReview(row, reviews) || judged.ids.has(Number(row.seq)) || Number(row.seq) <= (judged.marks.get(klass) ?? 0)) continue;
    const rule = expectedRule(rulesOf(row.role), row);
    if (rule) {
      const tally = expected.get(klass) ?? { class: klass, role: row.role, count: 0, why: rule.why ?? null };
      tally.count += 1;
      expected.set(klass, tally);
      continue;
    }
    const g = groups.get(klass) ?? { class: klass, role: row.role, kind: row.kind, tool: row.tool, count: 0, tokens: 0, cost: 0, runs: new Set(), samples: [], last_verdict: review ?? null };
    g.count += 1;
    // A run's size is counted once per class even when it left several traces of that class.
    const runKey = row.run ?? `${row.seat}@${row.at}`;
    if (!g.runs.has(runKey)) {
      g.tokens += Number(row.run_tokens) || 0;
      g.cost += Number(row.run_cost) || 0;
    }
    g.runs.add(runKey);
    if (g.samples.length < 3) g.samples.push({ seat: row.seat, run: row.run ?? null, at: row.at, detail: row.detail, description: row.description });
    groups.set(klass, g);
  }
  const classes = [...groups.values()]
    .map((g) => ({ ...g, runs: g.runs.size, kind_words: difficultyKindWord(g.kind, lang) }))
    .sort((a, b) => b.runs - a.runs || b.count - a.count || b.cost - a.cost);
  return { classes, expected: [...expected.values()] };
}

export function difficultyClasses(lang = language()) {
  return scanDifficulties(lang).classes;
}

// One line on what the role contracts made normal, or null: without it a lead who remembers six
// web_researcher|uncertain rows would see them gone and not know why.
function expectedTraceLine(expected, lang = language()) {
  if (!expected.length) return null;
  const total = expected.reduce((sum, e) => sum + e.count, 0);
  const each = expected
    .map((e) => message(
      `【${e.class}】${e.count} 条${e.why ? `（${e.why}）` : ''}`,
      `[${e.class}] ${e.count} trace(s)${e.why ? ` (${e.why})` : ''}`,
      lang,
    ))
    .join(message('；', '; ', lang));
  return message(
    `另有 ${total} 条痕迹是岗位合同要它做的事，按 roles.json 的 expected_traces 不算困难，没有计入上面和 skill 循环：${each}。要让某一种重新计入，删掉那个岗位的那条规则，再重启服务：roles.json 只在服务启动时读进台账（启动闸也在那时核对），不重启，这些旧行照样跳过，新出现的同类痕迹也照样不写。`,
    `Another ${total} trace(s) matched expected_traces in roles.json and were excluded from difficulties and the skill loop: ${each}. To include one again, remove its rule in roles.json and restart the daemon (roles.json is synced at startup).`,
    lang,
  );
}

const REFUSED_TASK_CHARS = 300;

export function difficultyReportText(lang = language()) {
  const { classes, expected } = scanDifficulties(lang);
  const expectedLine = expectedTraceLine(expected, lang);
  if (!classes.length) {
    return [
      message('困难账本是空的：上次裁决之后，没有新的困难记录。', 'Difficulty ledger is empty: no new difficulties since last review.', lang),
      expectedLine,
    ].filter(Boolean).join('\n');
  }
  const lines = [
    message(
      `困难账本（上次裁决之后的新记录，按出现的运行数排序；在 ${DIFFICULTY_REMIND_AT} 次及以上不同运行里出现的该裁决了）：`,
      `Difficulty ledger (new entries since last review, sorted by distinct runs; entries in >= ${DIFFICULTY_REMIND_AT} runs need a decision):`,
      lang,
    ),
  ];
  for (const g of classes) {
    const toolLabel = g.tool ? message(` · 工具 ${g.tool}`, ` · tool ${g.tool}`, lang) : '';
    const prevLabel = g.last_verdict
      ? message(
        `；上次裁决 ${g.last_verdict.at.slice(0, 10)} 定为「${difficultyDecisionWord(g.last_verdict.decision, lang)}」`,
        `; last decision ${g.last_verdict.at.slice(0, 10)}: "${difficultyDecisionWord(g.last_verdict.decision, lang)}"`,
        lang,
      )
      : '';
    lines.push(message(
      `- 【${g.class}】${g.role} · ${g.kind_words}${toolLabel}：在 ${g.runs} 次运行里出现 ${g.count} 次，这些运行共约 ${g.tokens} token、$${g.cost.toFixed(4)}${prevLabel}`,
      `- [${g.class}] ${g.role} · ${g.kind_words}${toolLabel}: ${g.runs} run(s), ${g.count} occurrence(s), ~${g.tokens} tokens, $${g.cost.toFixed(4)}${prevLabel}`,
      lang,
    ));
    for (const s of g.samples) {
      const desc = s.description ? message(` —— 它说：${s.description}`, ` — reported: ${s.description}`, lang) : '';
      lines.push(message(
        `    · ${s.seat} ${s.at.slice(0, 16)}：${s.detail ?? ''}${desc}`,
        `    · ${s.seat} ${s.at.slice(0, 16)}: ${s.detail ?? ''}${desc}`,
        lang,
      ));
      // What set the filter off is in the task, so a refusal is shown with it (2026-10-25).
      if (g.kind === 'refused') {
        const task = taskTextOfRun(s.run);
        if (task) {
          lines.push(message(
            `      任务原文（前 ${REFUSED_TASK_CHARS} 字）：${flatLine(task, REFUSED_TASK_CHARS)}`,
            `      Task snippet (first ${REFUSED_TASK_CHARS} chars): ${flatLine(task, REFUSED_TASK_CHARS)}`,
            lang,
          ));
        }
      }
    }
  }
  lines.push(message(
    '裁决用 difficulty_decide(class, decision, note)，decision 取 contract / dispatch / service / tool_or_project / accept。',
    'Decide via difficulty_decide(class, decision, note) with decision in contract / dispatch / service / tool_or_project / accept.',
    lang,
  ));
  if (expectedLine) lines.push(expectedLine);
  return lines.join('\n');
}

export function difficultyReminder(lang = language()) {
  const due = difficultyClasses(lang).filter((g) => g.runs >= DIFFICULTY_REMIND_AT);
  if (!due.length) return null;
  return message(
    `困难账本里有 ${due.length} 类困难已在 ${DIFFICULTY_REMIND_AT} 次以上不同的运行里出现、还没裁决。${callerLabel('用户')}说"看困难账本"时，用 difficulty_report 取出来逐条给出解法去向。`,
    `${due.length} difficulty class(es) have appeared in ${DIFFICULTY_REMIND_AT}+ distinct runs without a decision. Call difficulty_report to review and resolve them when asked.`,
    lang,
  );
}

// ---- The skill loop's tables (2026-10-01) ---------------------------------------------------------
// The orchestration (when to dispatch the refiner, what it is told, enabling a candidate) is in
// skill-loop.mjs; what lives here is only what touches the ledger. Candidate bodies are files.

// How many new difficulties of one role start a refiner. The one place the number is written.
export const SKILL_LOOP_BATCH = 5;
// 'superseded' (2026-10-25): written under an earlier rule and set aside by the lead without judging it;
// it moves no baseline, and its summary goes to the role's next refiner.
export const CANDIDATE_STATES = ['pending', 'active', 'rejected', 'deferred', 'superseded'];
export const DIFFICULTY_VERDICT_WORDS = { real: '真困难', invalid: '不成立', sporadic: '偶发' };
const DIFFICULTY_VERDICT_WORDS_EN = { real: 'real difficulty', invalid: 'invalid', sporadic: 'sporadic' };

export const difficultyVerdictWord = (verdict, lang = language()) =>
  (lang === 'zh' ? DIFFICULTY_VERDICT_WORDS : DIFFICULTY_VERDICT_WORDS_EN)[verdict] ?? verdict;

export const difficultyKindWord = (kind, lang = language()) =>
  (lang === 'zh' ? DIFFICULTY_KIND_WORDS_ZH : DIFFICULTY_KIND_WORDS_EN)[kind] ?? kind;

const idList = (text) => JSON.parse(text);

function candidateRow(row) {
  return {
    id: Number(row.id),
    role: row.role,
    version: Number(row.version),
    file: row.file,
    why_file: row.why_file ?? null,
    difficulty_ids: idList(row.difficulty_ids),
    base_sha: row.base_sha ?? null,
    state: row.state,
    note: row.note ?? null,
    warnings: row.warnings ? JSON.parse(row.warnings) : [],
    created_at: row.created_at,
    updated_at: row.updated_at,
    decided_at: row.decided_at ?? null,
  };
}

function candidateRunRow(row) {
  return {
    id: Number(row.id),
    role: row.role,
    difficulty_ids: idList(row.difficulty_ids),
    seat: row.seat ?? null,
    work_dir: row.work_dir ?? null,
    base_sha: row.base_sha ?? null,
    status: row.status,
    detail: row.detail ?? null,
    candidate_id: row.candidate_id === null || row.candidate_id === undefined ? null : Number(row.candidate_id),
    started_at: row.started_at,
    ended_at: row.ended_at ?? null,
  };
}

// The highest difficulties.seq any candidate of this role was written from: what the next batch
// counts after. A rejected candidate counts too, its difficulties were looked at; recurrence after
// that is new evidence. So does a refiner run that read them all and judged that the skill needs no
// change (status 'nochange', 2026-10-25): that is an answer, not a failure, and retrying it would only
// hand the same evidence back. A failed refiner run is not a candidate and moves nothing, and neither
// does a superseded candidate: the lead set it aside unjudged, so its difficulties were never looked at.
export function candidateBaseline(role) {
  let top = 0;
  const database = conn();
  const rows = [
    ...database.prepare("SELECT difficulty_ids FROM candidates WHERE role = ? AND state != 'superseded'").all(role),
    ...database.prepare("SELECT difficulty_ids FROM candidate_runs WHERE role = ? AND status = 'nochange'").all(role),
  ];
  for (const row of rows) {
    for (const id of idList(row.difficulty_ids)) top = Math.max(top, Number(id));
  }
  return top;
}

// A run that stopped for a reason outside the role's craft: the model refused or ran out of capacity,
// an account hit its quota or rate limit, the backend could not start the process. The difficulty
// report still lists them (they are the service's or the account's to fix), but they are no evidence
// for a skill change and do not fill a batch: three refusals in a row once made the newest batch of
// coder, and the refiner rightly wrote no change (2026-10-25). Matched on the text the runner and the
// lead's verdict notes record.
// The lead's verdict notes say it in their own words too: "spawn 失败" for a seat that never started.
const INFRA_FAILURE = /model_refusal|refusal_no_fallback|rate_limit|usage limit|quota|at capacity|ENAMETOOLONG|spawn\s*(?:失败|failed)|helper_unknown_error|setup refresh had errors|API error|额度|daemon startup|pid \d+ (?:已消失|is gone)/i;
export function isInfraFailure(row) {
  if (!['failed', 'rejected', 'revised'].includes(row.kind)) return false;
  return INFRA_FAILURE.test(String(row.detail ?? ''));
}

// The `owner` of the seats the skill loop starts for its refiner runs.
export const SKILL_LOOP_OWNER = 'skill-loop';

// This role's open difficulties recorded after its last candidate, oldest first, all kinds together,
// except three:
// - a row whose class the lead already closed with difficulty_decide (the same rule difficulty_report
//   uses): it was judged and its fix went somewhere else (accept, service, contract...), so it is not
//   evidence for a skill change and does not fill a batch;
// - a row the role's contract makes normal (roles.json expected_traces, the same rule difficulty_report
//   uses): five of them would send the refiner to rewrite a skill against evidence of it being obeyed;
// - a stop by the backend model's safety filter (kind 'refused', 2026-10-25): no skill keeps a model's
//   safety layer from stopping a run; which tasks set it off is for whoever dispatches, and the
//   difficulty report lists them with the task's text;
// - a run failure of a seat the skill loop itself started. Those are already the loop's own
//   bookkeeping (candidate_runs keeps the reason and the retry waits on it); counted again they would
//   feed a refiner outage to the refiner's own batch, and a candidate would be written from failures of
//   a service that was down. The refiner's other difficulties and the lead's verdicts on its seats count.
// `s.owner IS ?`, not `=`: a seat started without an owner has NULL there, and `NULL = ?` is unknown,
// which made NOT(...) unknown and silently dropped every run failure of such a seat (2026-10-01 review).
export function newDifficulties(role) {
  const reviews = classReviews();
  const rules = roleSpec(role)?.expected_traces ?? [];
  return conn()
    .prepare(
      `SELECT d.* FROM difficulties d LEFT JOIN seats s ON s.id = d.seat
       WHERE d.role = ? AND d.seq > ? AND NOT (d.kind = 'failed' AND s.owner IS ?)
       ORDER BY d.seq`
    )
    .all(role, candidateBaseline(role), SKILL_LOOP_OWNER)
    .filter((row) => row.kind !== 'refused' && !closedByClassReview(row, reviews) && !expectedRule(rules, row) && !isInfraFailure(row));
}

// The open difficulties of one role grouped by class (role × kind × tool), the way the refiner reads
// them: every class since the last candidate, ordered by how many different runs it showed up in, then
// by how often, then by how recent. A trap every run trips over once comes first even when the newest
// few rows are something else (2026-10-25: taking the newest five dropped 67 of coder's 72 open rows,
// the recurring tool traps among them, as "seen"). `latest` is the class's newest row: the one id the
// candidate records for the class, so the lead judges a class once.
export function newDifficultyClasses(role) {
  const groups = new Map();
  for (const row of newDifficulties(role)) {
    const key = difficultyClass(row);
    let g = groups.get(key);
    if (!g) {
      g = { key, kind: row.kind, tool: row.tool ?? null, rows: [], runs: new Set() };
      groups.set(key, g);
    }
    g.rows.push(row);
    g.runs.add(row.run ?? `${row.seat}@${row.at}`);
  }
  return [...groups.values()]
    .map((g) => ({ key: g.key, kind: g.kind, tool: g.tool, rows: g.rows, runs: g.runs.size, count: g.rows.length, latest: g.rows[g.rows.length - 1] }))
    .sort((a, b) => b.runs - a.runs || b.count - a.count || b.latest.seq - a.latest.seq);
}

export function difficultiesByIds(ids) {
  const database = conn();
  return ids.map((id) => database.prepare('SELECT * FROM difficulties WHERE seq = ?').get(id)).filter(Boolean);
}

// The text of the task a run was given, by the run key a difficulty carries ("seat-coder-3#1234").
export function taskTextOfRun(runKey) {
  const seq = Number(String(runKey ?? '').split('#').pop());
  if (!Number.isInteger(seq)) return null;
  const row = conn().prepare("SELECT body FROM events WHERE seq = ? AND kind = 'task'").get(seq);
  return row ? String(row.body ?? '') : null;
}

export function startCandidateRun({ role, ids }) {
  const info = conn()
    .prepare("INSERT INTO candidate_runs (role, difficulty_ids, status, started_at) VALUES (?, ?, 'running', ?)")
    .run(role, JSON.stringify(ids), now());
  return Number(info.lastInsertRowid);
}

export function updateCandidateRun(id, { seat, workDir, baseSha } = {}) {
  const database = conn();
  if (baseSha !== undefined) database.prepare('UPDATE candidate_runs SET base_sha = ? WHERE id = ?').run(baseSha, id);
  if (seat !== undefined) database.prepare('UPDATE candidate_runs SET seat = ? WHERE id = ?').run(seat, id);
  if (workDir !== undefined) database.prepare('UPDATE candidate_runs SET work_dir = ? WHERE id = ?').run(workDir, id);
}

export function finishCandidateRun(id, { status, detail = null, candidateId = null }) {
  conn()
    .prepare('UPDATE candidate_runs SET status = ?, detail = ?, candidate_id = ?, ended_at = ? WHERE id = ?')
    .run(status, detail, candidateId, now(), id);
}

// A run that never started a refiner (the concurrency limit was full) leaves no trace: it was not an attempt.
export function deleteCandidateRun(id) {
  conn().prepare('DELETE FROM candidate_runs WHERE id = ?').run(id);
}

// Newest first.
export function candidateRuns({ role = null, status = null, limit = 50 } = {}) {
  const where = [];
  const args = [];
  if (role) { where.push('role = ?'); args.push(role); }
  if (status) { where.push('status = ?'); args.push(status); }
  const sql = `SELECT * FROM candidate_runs${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`;
  return conn().prepare(sql).all(...args, limit).map(candidateRunRow);
}

// Versions are one counter per role, shared by candidates and enabled skills: a rejected candidate's
// number is not reused, so the number on a file always names the same text.
export function nextSkillVersion(role) {
  const database = conn();
  const a = database.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM candidates WHERE role = ?').get(role);
  const b = database.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM skill_versions WHERE role = ?').get(role);
  return Math.max(Number(a.v), Number(b.v)) + 1;
}

// `file` and `whyFile` are decided by the caller from the version, so the row is written after the
// files exist: a candidate row never points at nothing.
export function createCandidate({ role, version, file, whyFile, ids, baseSha = null, warnings = [], runId = null }) {
  const database = conn();
  const at = now();
  const info = database
    .prepare(
      `INSERT INTO candidates (role, version, file, why_file, difficulty_ids, base_sha, state, warnings, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`
    )
    .run(role, version, file, whyFile, JSON.stringify(ids), baseSha, warnings.length ? JSON.stringify(warnings) : null, at, at);
  const id = Number(info.lastInsertRowid);
  if (runId !== null) finishCandidateRun(runId, { status: 'done', candidateId: id });
  return getCandidate(id);
}

export function getCandidate(id) {
  const row = conn().prepare('SELECT * FROM candidates WHERE id = ?').get(Number(id));
  return row ? candidateRow(row) : null;
}

// Newest first. `state` may be one state or an array of them.
export function listCandidates({ role = null, state = null } = {}) {
  const where = [];
  const args = [];
  if (role) { where.push('role = ?'); args.push(role); }
  const states = state === null ? null : Array.isArray(state) ? state : [state];
  if (states) { where.push(`state IN (${states.map(() => '?').join(', ')})`); args.push(...states); }
  const sql = `SELECT * FROM candidates${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC`;
  return conn().prepare(sql).all(...args).map(candidateRow);
}

export function setCandidateState(id, state, note = null) {
  if (!CANDIDATE_STATES.includes(state)) throw new Error(`candidate state must be one of ${CANDIDATE_STATES.join(' | ')}`);
  const at = now();
  conn()
    .prepare('UPDATE candidates SET state = ?, note = COALESCE(?, note), updated_at = ?, decided_at = ? WHERE id = ?')
    .run(state, note, at, state === 'pending' ? null : at, Number(id));
  return getCandidate(id);
}

export function setDifficultyVerdict({ candidateId, difficultyId, verdict, note = null }) {
  conn()
    .prepare(
      `INSERT INTO difficulty_verdicts (candidate_id, difficulty_id, verdict, note, at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(candidate_id, difficulty_id) DO UPDATE SET verdict = excluded.verdict, note = excluded.note, at = excluded.at`
    )
    .run(Number(candidateId), Number(difficultyId), verdict, note, now());
}

export function difficultyVerdicts(candidateId) {
  return conn()
    .prepare('SELECT difficulty_id, verdict, note, at FROM difficulty_verdicts WHERE candidate_id = ? ORDER BY difficulty_id')
    .all(Number(candidateId))
    .map((row) => ({ difficulty_id: Number(row.difficulty_id), verdict: row.verdict, note: row.note ?? null, at: row.at }));
}

export function recordSkillVersion({ role, skill, version, candidateId = null, file, sha256, bodySha256 = null, previousFile = null, note = null }) {
  const info = conn()
    .prepare(
      `INSERT INTO skill_versions (role, skill, version, candidate_id, file, sha256, body_sha256, previous_file, note, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(role, skill, version, candidateId, file, sha256, bodySha256, previousFile, note, now());
  return Number(info.lastInsertRowid);
}

// Newest first.
export function skillVersions({ role = null } = {}) {
  const rows = role
    ? conn().prepare('SELECT * FROM skill_versions WHERE role = ? ORDER BY id DESC').all(role)
    : conn().prepare('SELECT * FROM skill_versions ORDER BY id DESC').all();
  return rows.map((row) => ({ ...row, id: Number(row.id), version: Number(row.version) }));
}

// The one sentence the MCP shell attaches to a reply, once per client session, while a candidate waits
// for review. Deferred ones do not nag: the lead put them aside on purpose. It is the only time this
// session hears of the candidate, so it asks for something now (tell「マスター」, or review it) and
// names the ids, instead of waiting for a phrase nobody prompts「マスター」to say (2026-10-01 review).
// It says what enabling does: every run of the post carries its skill from the next run on (4.5).
export function candidateReminder(lang = language()) {
  const pending = listCandidates({ state: 'pending' });
  if (!pending.length) return null;
  const roles = [...new Set(pending.map((c) => c.role))];
  const ids = pending.map((c) => `#${c.id}`).join(message('、', ', ', lang));
  const first = pending[pending.length - 1].id;
  return message(
    `${pending.length === 1 ? `${roles[0]} 有一个 skill 候选版本待核对（${ids}）` : `${roles.length} 个岗位（${roles.join('、')}）有 ${pending.length} 个 skill 候选版本待核对（${ids}）`}：refiner 根据攒满的 ${SKILL_LOOP_BATCH} 条困难写了新版，没有启用；启用才写进 skills 目录，这个岗位从下一单起带的就是它。告诉${callerLabel('用户')}一声；核对就用 candidates（id=${first}）看改动和依据，把每条困难判成真困难 / 不成立 / 偶发，再用 candidate_decide 启用或退回。`,
    `${pending.length === 1 ? `${roles[0]} has a skill candidate awaiting review (${ids})` : `${roles.length} roles (${roles.join(', ')}) have ${pending.length} skill candidates awaiting review (${ids})`}: refiner proposed an update from the collected ${SKILL_LOOP_BATCH} difficulties (not enabled yet; enabling writes to the skills directory for future runs). Inspect via candidates(id=${first}), judge each difficulty real / invalid / sporadic, and run candidate_decide to enable or reject.`,
    lang,
  );
}

// How many candidates wait for review, for the wall's header.
export function pendingCandidateCount() {
  return Number(conn().prepare("SELECT COUNT(*) AS n FROM candidates WHERE state = 'pending'").get().n);
}

// Dollars per successful run, per role and model (2026-09-29). Token counts cannot compare a
// cheap model with an expensive one; what can is what a run cost and whether its output was used.
// Everything is read back from the events a run already leaves — task, usage, exit, verdict — so
// runs from before this report existed count too. A run is the stretch between one task event of
// a seat and its next. Real cost is the money a run spent (DeepSeek, priced off-peak by the runner);
// a subscription run spent none, and its equivalent is what the same tokens cost at API list price.
const USAGE_RE_ZH = /输入 (\d+) token（另有缓存命中 (\d+)），输出 (\d+) token(?:，约 \$([\d.]+))?/;
const USAGE_RE_EN = /input (\d+) tokens? \(cache hit (\d+)\), output (\d+) tokens?(?:, est\. \$([\d.]+))?/i;
const MODEL_RE = /(?:（|\()([a-z][\w-]*\/[\w.-]+)/;

// The `since` of cost_report as a point in time (epoch ms). It used to be compared with run.at as a
// string, which only works when both are the same UTC ISO shape: an offset timestamp, a date in
// another spelling or free text silently matched nothing and the report said "no runs" (2026-09-30
// review). A bare date is the start of that day in this machine's local time; a full timestamp may
// carry its own offset (Z or +08:00), and without one it is local time too. Anything else is an
// error that says what to write, never an empty report.
const SINCE_SHAPE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
export function parseSince(since, lang = language()) {
  const text = String(since).trim();
  const bad = () => new Error(message(
    `since 要填日期（2026-09-30，按这台机器本地时间的当天 0 点算）或完整时间（2026-09-30T08:00:00+08:00，可以带时区），收到的是「${since}」，无法识别。改成这两种写法之一再查；不填就是全部记录。`,
    `since must be a date (e.g. 2026-09-30, local midnight) or an ISO timestamp (e.g. 2026-09-30T08:00:00+08:00); got "${since}". Leave empty for all records.`,
    lang,
  ));
  const m = SINCE_SHAPE.exec(text);
  if (!m) throw bad();
  const [, y, mo, d, hh, mi, ss, zone] = m;
  let ms;
  if (hh === undefined) {
    const local = new Date(Number(y), Number(mo) - 1, Number(d));
    // new Date rolls 2026-02-31 over to March: a date that does not exist is a typo, not March 3rd.
    if (local.getFullYear() !== Number(y) || local.getMonth() !== Number(mo) - 1 || local.getDate() !== Number(d)) throw bad();
    ms = local.getTime();
  } else {
    const offset = zone === undefined ? '' : zone === 'Z' || zone.includes(':') ? zone : `${zone.slice(0, 3)}:${zone.slice(3)}`;
    ms = Date.parse(`${y}-${mo}-${d}T${hh}:${mi}:${ss ?? '00'}${offset}`);
  }
  if (!Number.isFinite(ms)) throw bad();
  return ms;
}

export function costRuns({ since = null } = {}, lang = language()) {
  const sinceMs = since ? parseSince(since, lang) : null;
  const database = conn();
  const roles = new Map(database.prepare('SELECT id, role FROM seats').all().map((row) => [row.id, row.role]));
  const current = new Map();
  const byKey = new Map();
  const runs = [];
  const rows = database
    .prepare("SELECT seq, seat, kind, body, at FROM events WHERE kind IN ('task', 'usage', 'exit', 'verdict') ORDER BY seq")
    .all();
  for (const row of rows) {
    if (row.kind === 'task') {
      const run = { run: `${row.seat}#${row.seq}`, seat: row.seat, role: roles.get(row.seat) ?? '?', at: row.at, model: null, input: 0, cacheRead: 0, output: 0, real: 0, equivalent: null, exit: null, verdict: null };
      current.set(row.seat, run);
      byKey.set(run.run, run);
      runs.push(run);
      continue;
    }
    const run = current.get(row.seat);
    if (!run) continue;
    const body = String(row.body ?? '');
    if (row.kind === 'usage') {
      const usage = USAGE_RE_ZH.exec(body) ?? USAGE_RE_EN.exec(body);
      const model = MODEL_RE.exec(body);
      if (usage) {
        run.input = Number(usage[1]);
        run.cacheRead = Number(usage[2]);
        run.output = Number(usage[3]);
        run.real = usage[4] ? Number(usage[4]) : 0;
      }
      if (model) {
        run.model = model[1];
        const bare = model[1].split('/').pop();
        // The runner's own equivalent wins when it wrote one: it saw cache writes, the usage line does not.
        const stated = /(?:按 API 价折合 |API-equivalent )\$([\d.]+)/.exec(body);
        if (stated) run.equivalent = Number(stated[1]);
        else if (!usage?.[4]) run.equivalent = equivalentCost(bare, run);
      }
    } else if (row.kind === 'exit') {
      run.exit = body;
    } else if (row.kind === 'verdict') {
      // A verdict that names its run (recordSeatVerdict's `run`) goes to that run, not to the newest one.
      const mark = VERDICT_RUN_MARK.exec(body);
      const target = mark?.[2] ? byKey.get(`${row.seat}#${mark[2]}`) : run;
      if (target) target.verdict = mark ? mark[1] : body.split(/[:：]/)[0];
    }
  }
  return sinceMs === null ? runs : runs.filter((run) => Date.parse(run.at) >= sinceMs);
}

export function costReportText({ since = null } = {}, lang = language()) {
  const runs = costRuns({ since }, lang);
  if (!runs.length) {
    return since
      ? message(`${since} 以来没有运行记录。`, `No runs recorded since ${since}.`, lang)
      : message('台账里还没有运行记录。', 'No runs recorded in the ledger yet.', lang);
  }
  const groups = new Map();
  for (const run of runs) {
    const unknownModel = run.exit && run.exit !== '0'
      ? message('没跑起来', 'failed to start', lang)
      : message('模型未知', 'unknown model', lang);
    const key = `${run.role} · ${run.model ?? unknownModel}`;
    const g = groups.get(key) ?? { key, runs: 0, failed: 0, accepted: 0, revised: 0, rejected: 0, unjudged: 0, real: 0, equivalent: 0, unpriced: 0 };
    g.runs += 1;
    if (run.exit !== null && run.exit !== '0') g.failed += 1;
    if (run.verdict && g[run.verdict] !== undefined) g[run.verdict] += 1;
    else g.unjudged += 1;
    g.real += run.real;
    if (run.equivalent !== null) g.equivalent += run.equivalent;
    else if (!run.real && run.model) g.unpriced += 1;
    groups.set(key, g);
  }
  const money = (x) => `$${x.toFixed(4)}`;
  const lines = [
    message(
      `每成功一单花多少钱（${since ? `${since} 以来` : '全部记录'}，${runs.length} 单）。真实花费是按量付费实际扣的钱；订阅折合是同样的 token 按 API 标价算，订阅本身不按单扣钱。「每采用一单」= 这一组全部花费 ÷ 直接采用的单数，没被采用的单子的钱也算进去。`,
      `Cost per accepted run (${since ? `since ${since}` : 'all records'}, ${runs.length} run(s)). Real spend is pay-as-you-go API billing; API-equivalent estimates subscription token usage at list rates. "Per accepted" = total group cost / accepted runs (including unaccepted runs).`,
      lang,
    ),
  ];
  for (const g of [...groups.values()].sort((a, b) => b.runs - a.runs)) {
    const spent = g.real + g.equivalent;
    const perAccepted = g.accepted
      ? money(spent / g.accepted)
      : message('还没有采用的单子，算不出', 'no accepted runs yet', lang);
    const judged = message(
      `采用 ${g.accepted}、改过 ${g.revised}、退回 ${g.rejected}、未验收 ${g.unjudged}`,
      `accepted ${g.accepted}, revised ${g.revised}, rejected ${g.rejected}, unjudged ${g.unjudged}`,
      lang,
    );
    const paid = [
      g.real ? message(`真实花费 ${money(g.real)}`, `real ${money(g.real)}`, lang) : '',
      g.equivalent ? message(`订阅折合 ${money(g.equivalent)}`, `API-equiv ${money(g.equivalent)}`, lang) : '',
      g.unpriced ? message(`${g.unpriced} 单的模型没有标价，未折合`, `${g.unpriced} run(s) unpriced`, lang) : '',
    ].filter(Boolean).join(message('，', ', ', lang)) || message('没有记到花费', 'no cost recorded', lang);
    const failedNote = g.failed ? message(`；其中 ${g.failed} 单运行失败`, `; ${g.failed} failed`, lang) : '';
    lines.push(message(
      `- ${g.key}：${g.runs} 单（${judged}${failedNote}），${paid}；每采用一单 ${perAccepted}`,
      `- ${g.key}: ${g.runs} run(s) (${judged}${failedNote}), ${paid}; per accepted: ${perAccepted}`,
      lang,
    ));
  }
  const judgedRuns = runs.filter((run) => run.verdict).length;
  lines.push(judgedRuns < runs.length / 2
    ? message(
      `验收结论只覆盖了 ${judgedRuns}/${runs.length} 单（seat_verdict 2026-09-29 才开始记），"每采用一单"现在主要反映的是记录不全，不是质量；验收记满之后这一栏才可信。`,
      `Verdicts cover only ${judgedRuns}/${runs.length} runs; "per accepted" mainly reflects sparse verdict coverage rather than quality until more runs are judged.`,
      lang,
    )
    : message(
      `验收结论覆盖了 ${judgedRuns}/${runs.length} 单。`,
      `Verdicts cover ${judgedRuns}/${runs.length} runs.`,
      lang,
    ));
  return lines.join('\n');
}

// Startup sync: roles.json is the source of truth for role specs, the table is its copy — and a copy
// has to lose what the source lost. Without the delete below, renaming a role (worker -> coder)
// leaves the old id behind as a phantom: a card on the wall with no contract and nothing to run,
// which is exactly what happened the first time this rename was tried.
function syncRoles(database) {
  const roles = JSON.parse(fs.readFileSync(ROLES_FILE, 'utf8'));
  const at = now();
  const stmt = database.prepare(
    `INSERT INTO roles (id, spec, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET spec = excluded.spec, updated_at = excluded.updated_at`
  );
  const ids = Object.keys(roles);
  for (const id of ids) stmt.run(id, JSON.stringify(roles[id]), at);
  if (ids.length) {
    const placeholders = ids.map(() => '?').join(', ');
    database.prepare(`DELETE FROM roles WHERE id NOT IN (${placeholders})`).run(...ids);
  } else {
    database.prepare('DELETE FROM roles').run();
  }
  return ids.length;
}

function seatRow(row) {
  return {
    id: row.id,
    role: row.role,
    instance: Number(row.instance),
    owner: row.owner ?? null,
    parent: row.parent ?? null,
    fork: Number(row.fork) === 1,
    cwd: row.cwd ?? null,
    domain: row.domain ?? null,
    name: row.name ?? null,
    expertise: row.expertise ?? null,
    session_file: row.session_file ?? null,
    topic: row.topic ?? null,
    pending_handoff: row.pending_handoff ?? null,
    skill_hash: row.skill_hash ?? null,
    contract_version: row.contract_version ?? null,
    contract_hash: row.contract_hash ?? null,
    dir_state: row.dir_state ? JSON.parse(row.dir_state) : null,
    backlog: row.backlog ?? null,
    state: row.state,
    handle: row.handle ?? null,
    pid: row.pid === null || row.pid === undefined ? null : Number(row.pid),
    opened_at: row.opened_at,
    // A seat is kept across runs, so opened_at is when it was first created; the current run began
    // at its latest task event.
    run_started_at: conn().prepare("SELECT MAX(at) AS at FROM events WHERE seat = ? AND kind = 'task'").get(row.id)?.at ?? null,
    updated_at: row.updated_at,
    closed_at: row.closed_at ?? null,
  };
}

function seatOrThrow(database, seat) {
  const row = database.prepare('SELECT id FROM seats WHERE id = ?').get(seat);
  if (!row) throw new Error(`unknown seat: ${seat}`);
}

function eventRow(row) {
  return {
    seq: Number(row.seq),
    seat: row.seat,
    kind: row.kind,
    body: row.body ?? null,
    at: row.at,
  };
}

// Open a seat: instance numbers run 1, 2, 3 ... per role. The id stays seat-<role>-<n> because
// callers and the DSH watcher already key on it; `name` is what a reader is meant to go by. A
// `domain` seat belongs to a field of knowledge instead of a directory (claimDomainSeat).
export function openSeat({ role, owner = null, parent = null, cwd = null, name = null, domain = null, topic = null, fork = false } = {}) {
  if (!role) throw new Error('openSeat: role is required');
  return inTransaction(() => {
    const database = conn();
    const specRow = database.prepare('SELECT spec FROM roles WHERE id = ?').get(role);
    if (!specRow) throw new Error(`unknown role: ${role}`);
    const top = database.prepare('SELECT COALESCE(MAX(instance), 0) AS top FROM seats WHERE role = ?').get(role);
    const instance = Number(top?.top ?? 0) + 1;
    const seat = `seat-${role}-${instance}`;
    const at = now();
    database
      .prepare(
        `INSERT INTO seats (id, role, instance, owner, parent, cwd, name, domain, topic, state, handle, pid, opened_at, updated_at, closed_at, fork)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(seat, role, instance, owner ?? null, parent ?? null, cwd ?? null, name ?? null, domain ?? null, normalizeTopic(topic), 'open', null, null, at, at, null, fork ? 1 : null);
    return { seat, role, instance, name: name ?? null, domain: domain ?? null, topic: normalizeTopic(topic) ?? null, spec: JSON.parse(specRow.spec), reused: false, previous: null, fork: Boolean(fork) };
  });
}

// A topic label, canonicalised the little it needs: outer whitespace gone. Null/empty becomes null so
// the column stays NULL for the single-expert directories where the label is meaningless.
export function normalizeTopic(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  return trimmed ? trimmed : null;
}

// The real path of a directory: symlinks and junctions resolved, so a directory reached by two
// routes is one directory (E-7, 2026-10-11). A path that cannot be resolved (it does not exist yet,
// no permission) falls back to the plain absolute path. Its case is kept; only the key is folded.
export function realDir(dir) {
  const resolved = path.resolve(dir);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

// What two spellings of one directory have in common. 2026-10-11 (E-7): the real path first, then
// case folded on win32 and darwin only — their file systems ignore case by default, a Linux one does
// not, and there /Work and /work are two directories and so two experts. Before this rule only
// win32 folded and nothing resolved symlinks, so a junction and its target were two experts.
function dirKey(dir) {
  const real = realDir(dir);
  return process.platform === 'win32' || process.platform === 'darwin' ? real.toLowerCase() : real;
}

// Is someone of this role already at work in this directory? A follow-up is not stacked on a
// running one: two seats rewriting the same notes at once would undo each other.
export function runningIn({ role, cwd } = {}) {
  const key = dirKey(cwd);
  return conn()
    .prepare("SELECT * FROM seats WHERE role = ? AND state IN ('running', 'open') AND cwd IS NOT NULL")
    .all(role)
    .some((row) => dirKey(row.cwd) === key);
}

// When this role last started work in this directory, failed runs included: a schedule waits its
// full interval after a failure too, instead of retrying every minute.
export function lastStartedIn({ role, cwd } = {}) {
  // Directories are matched in JS so Windows case folding agrees with claimSeat.
  const key = dirKey(cwd);
  const rows = conn().prepare("SELECT id, cwd FROM seats WHERE role = ? AND cwd IS NOT NULL").all(role);
  let latest = null;
  for (const row of rows) {
    if (dirKey(row.cwd) !== key) continue;
    const hit = conn().prepare("SELECT MAX(at) AS at FROM events WHERE seat = ? AND kind = 'task'").get(row.id);
    if (hit?.at && (!latest || hit.at > latest)) latest = hit.at;
  }
  return latest;
}

const isFork = (row) => Number(row.fork) === 1;
const isBusy = (row) => row.state === 'running' || row.state === 'open';

// A busy expert gets a fork, not a blank instance (C-3, 2026-10-11). The service never makes a caller
// wait (O-1) and never starts someone with no memory at all, so the extra task goes to a second seat
// that is the same expert for as long as the run lasts: `parent` is the expert, `fork` is 1, and the
// caller is told `reused` (it has the expert's records) and `fork`. exec.mjs gives it a copy of the
// expert's pi session or, for a backend that cannot share one, the expert's records as text; when the
// run ends the fork is closed and its session and report are filed under the expert (runs table).
// Before this a busy expert got a second blank instance `#2`, which then sat in the roster as a
// second expert of the same directory with none of the first one's understanding.
//
// 2026-10-24: the caller can also ask for a fork (seat_start `fork`), busy expert or not: "context" is
// the fork above; "fresh" is one with none of the expert's history, for a second look that must not
// share the expert's assumptions (falsifying, reviewing). A fresh fork has no `previous`: exec.mjs hands
// it no session, records, hand-off, expertise or backlog, and never makes its session the expert's.
function openFork(expert, { role, owner = null, fresh = false, lang = language() }) {
  return {
    ...openSeat({
      role, owner, parent: expert.id, cwd: expert.cwd, domain: expert.domain,
      name: `${expert.name ?? expert.id} ${message(`（${fresh ? '不带上下文的分身' : '分身'}）`, `(${fresh ? 'fresh fork' : 'fork'})`, lang)}`.replace(' （', '（'),
      fork: true,
    }),
    reused: !fresh, fork: true, fresh, expert: expert.id, previous: fresh ? null : seatRow(expert),
  };
}

// What seat_start's `fork` may be: null (the expert itself, a fork only when it is busy), "context" or
// "fresh". Anything else is refused in words before a seat is touched.
export const FORK_MODES = ['context', 'fresh'];
export function normalizeFork(value, lang = language()) {
  if (value === null || value === undefined || value === '' || value === false) return null;
  if (FORK_MODES.includes(value)) return value;
  const err = new Error(message(
    `fork 只能是 "context"（带专家的记录开分身）或 "fresh"（不带专家的任何历史开分身），不填就是交给专家本人；收到的是 ${JSON.stringify(value)}`,
    `fork must be "context" (with expert history) or "fresh" (clean slate), or omitted to target the expert directly; got ${JSON.stringify(value)}`,
    lang,
  ));
  err.status = 400;
  throw err;
}

// The expert for (role, directory): prefer a free seat with a session, then any free seat.
// Expert identity does not depend on having a session file. A busy one is not waited for and not
// duplicated blank: a fork of it takes the task (openFork).
// Closed seats are retired and never come back; forks are never anyone's expert.
//
// 2026-10-11 (L-3): one directory may hold several experts separated by `topic`; the object is the
// directory plus the topic (PRD E-3). 2026-10-24: a topic is matched exactly, also when the directory
// holds a single expert. Before, a lone expert took every task of its directory whatever topic came
// with it, so seat_start with a new topic in /path/to/repo landed on the topic-less seat-tester-12 and no
// expert for that topic was ever opened. Now:
//   - with a topic: the expert with that topic; none yet, a new expert for it (the reply names the
//     directory's other experts, so a mistyped topic is seen at once);
//   - without one: the directory's only expert, whatever its topic (the rule before topics existed);
//     with several, the one without a topic; with several and none or more than one without a topic,
//     the call is refused and the candidates (name, seat, topic) are listed, rather than landing the
//     task on the wrong expert.
// `fork` (normalizeFork): the task goes to a fork of the expert found this way, busy or not; with no
// expert found, a new expert takes it as for any first visit (it has no history to leave out anyway).
export function claimSeat({ role, cwd, owner = null, parent = null, topic = null, fork = null } = {}, lang = language()) {
  if (!role) throw new Error('claimSeat: role is required');
  if (!cwd) throw new Error('claimSeat: cwd is required');
  const database = conn();
  const key = dirKey(cwd);
  const rows = database
    .prepare("SELECT * FROM seats WHERE role = ? AND cwd IS NOT NULL AND state NOT IN ('closed') ORDER BY updated_at DESC")
    .all(role)
    .filter((row) => !isFork(row) && dirKey(row.cwd) === key);
  const wanted = normalizeTopic(topic);
  let pool = rows;
  if (wanted) {
    pool = rows.filter((row) => normalizeTopic(row.topic) === wanted);
  } else if (rows.length > 1) {
    const general = rows.filter((row) => !normalizeTopic(row.topic));
    if (general.length !== 1) {
      throw topicCandidatesError(rows, message(
        `这个目录有 ${rows.length} 个按主题分开的专家，派活时要带 topic 指明派给哪一个`,
        `This directory has ${rows.length} topic-scoped experts; pass topic to select one`,
        lang,
      ), lang);
    }
    pool = general;
  }
  if (fork && pool.length) {
    return openFork(pool.find((row) => row.session_file) ?? pool[0], { role, owner, fresh: fork === 'fresh', lang });
  }
  const free = pool.find((row) => row.session_file && !isBusy(row)) ?? pool.find((row) => !isBusy(row));
  if (free) {
    const specRow = database.prepare('SELECT spec FROM roles WHERE id = ?').get(role);
    if (!specRow) throw new Error(`unknown role: ${role}`);
    database
      .prepare('UPDATE seats SET state = ?, owner = ?, parent = ?, handle = NULL, pid = NULL, updated_at = ? WHERE id = ?')
      .run('open', owner ?? null, parent ?? null, now(), free.id);
    return {
      seat: free.id, role, instance: Number(free.instance), name: free.name ?? null, topic: free.topic ?? null,
      spec: JSON.parse(specRow.spec), reused: true, previous: seatRow(free),
    };
  }
  const busy = pool.find(isBusy);
  if (busy) return openFork(busy, { role, owner, lang });
  const real = realDir(cwd);
  const leaf = path.basename(real) || real;
  const label = wanted ? `${leaf} · ${wanted}` : leaf;
  const base = `${role} · ${label}`;
  // The expert keeps the real path of its directory (E-7), so every later route to it finds it.
  const opened = openSeat({ role, owner, parent, cwd: real, name: freeName(base, `${role} · ${path.basename(path.dirname(real))}/${label}`), topic });
  // The directory's other experts, for the reply: a new topic beside them may be a mistyped old one.
  return rows.length ? { ...opened, others: rows.map((row) => ({ seat: row.id, name: row.name ?? null, topic: row.topic ?? null })) } : opened;
}

// The refusal a multi-expert directory hands back: who the candidates are, so the caller can pick the
// right topic. name, seat id, topic, one per line.
function topicCandidatesError(rows, why, lang = language()) {
  const list = rows
    .map((row) => message(
      `「${row.name ?? row.id}」（座位 ${row.id}，主题：${row.topic ?? '（无）'}）`,
      `"${row.name ?? row.id}" (seat ${row.id}, topic: ${row.topic ?? '(none)'})`,
      lang,
    ))
    .join(message('、', ', ', lang));
  const err = new Error(message(
    `${why}。这个目录现有的专家：${list}。派活时 seat_start 带 topic，或点名 seat 派给具体座位号。`,
    `${why}. Existing experts in this directory: ${list}. Call seat_start with topic, or name a specific seat.`,
    lang,
  ));
  err.status = 400;
  err.payload = { error: err.message, candidates: rows.map((row) => ({ seat: row.id, name: row.name ?? null, topic: row.topic ?? null })) };
  return err;
}

// A new expert's initial name must not equal a living expert's (E-1: the lead picks by name). Two
// directories with one last component (a/proj and b/proj) would both be "coder · proj", so the second
// takes its parent directory too, and if even that is taken a number. Forks are not experts and are not
// compared (C-3).
function freeName(name, longer) {
  const taken = (text) => Boolean(conn().prepare("SELECT 1 FROM seats WHERE name = ? AND state != 'closed' AND COALESCE(fork, 0) = 0").get(text));
  if (!taken(name)) return name;
  if (!taken(longer)) return longer;
  for (let n = 2; ; n += 1) {
    if (!taken(`${longer} #${n}`)) return `${longer} #${n}`;
  }
}

// A domain label, canonicalised the little it needs: outer whitespace gone and English folded to
// lower case, everything else (Chinese included) kept as typed. The seat's key is (role, domain).
export function normalizeDomain(text) {
  return typeof text === 'string' ? text.trim().toLowerCase() : '';
}

// How a role recognises its expert: roles.json's `expert_by` is "domain" for a post whose expertise
// is a field of knowledge (web_researcher); anything else — including a post that does not set the
// field — is a directory expert, the behaviour every post had before this.
export function expertBy(role) {
  const spec = roleSpec(role);
  return spec?.expert_by === 'domain' ? 'domain' : 'directory';
}

// The domains a role's living experts already cover, sorted: what a refusal can offer the caller.
export function domainsOf(role) {
  if (!role) return [];
  return conn()
    .prepare("SELECT DISTINCT domain FROM seats WHERE role = ? AND domain IS NOT NULL AND domain != '' AND state != 'closed' ORDER BY domain")
    .all(role)
    .map((row) => row.domain);
}

// The posts that recognise experts by domain (roles.json expert_by): named in the refusal a
// directory post gives when it is handed a domain, so the caller learns which posts take one.
export function domainRoles() {
  return conn()
    .prepare('SELECT id, spec FROM roles')
    .all()
    .filter((row) => {
      try { return JSON.parse(row.spec).expert_by === 'domain'; } catch { return false; }
    })
    .map((row) => row.id);
}

// The expert for (role, domain): prefer a free seat with a session, then any free seat.
// Expert identity does not depend on having a session file. The same reuse and
// fork-beside-a-busy-expert rules as claimSeat, but the key is the
// domain text (already normalised by the caller), not a directory; the working directory is the
// service's own, one per domain, and is passed in.
export function claimDomainSeat({ role, domain, cwd = null, owner = null, parent = null, fork = null } = {}, lang = language()) {
  if (!role) throw new Error('claimDomainSeat: role is required');
  if (!domain) throw new Error('claimDomainSeat: domain is required');
  const database = conn();
  const rows = database
    .prepare("SELECT * FROM seats WHERE role = ? AND domain = ? AND state NOT IN ('closed') AND COALESCE(fork, 0) = 0 ORDER BY updated_at DESC")
    .all(role, domain);
  if (fork && rows.length) return openFork(rows.find((row) => row.session_file) ?? rows[0], { role, owner, fresh: fork === 'fresh', lang });
  const free = rows.find((row) => row.session_file && !isBusy(row)) ?? rows.find((row) => !isBusy(row));
  if (free) {
    const specRow = database.prepare('SELECT spec FROM roles WHERE id = ?').get(role);
    if (!specRow) throw new Error(`unknown role: ${role}`);
    database
      .prepare('UPDATE seats SET state = ?, owner = ?, parent = ?, handle = NULL, pid = NULL, updated_at = ? WHERE id = ?')
      .run('open', owner ?? null, parent ?? null, now(), free.id);
    return {
      seat: free.id, role, instance: Number(free.instance), name: free.name ?? null, domain,
      spec: JSON.parse(specRow.spec), reused: true, previous: seatRow(free),
    };
  }
  const busy = rows.find(isBusy);
  if (busy) return openFork(busy, { role, owner, lang });
  const base = `${role} · ${domain}`;
  return openSeat({ role, owner, parent, cwd, name: base, domain });
}

// How many runs a seat has been given: its task events. With `before` (a task event's seq) only the
// runs earlier than that one count, which is what "how many times has it been here" means for the
// run that has just been recorded (E-3, E-6).
export function visits(seat, { before = null } = {}) {
  const row = before === null || before === undefined
    ? conn().prepare("SELECT COUNT(*) AS n FROM events WHERE seat = ? AND kind = 'task'").get(seat)
    : conn().prepare("SELECT COUNT(*) AS n FROM events WHERE seat = ? AND kind = 'task' AND seq < ?").get(seat, Number(before));
  return Number(row?.n ?? 0);
}

// Hand a task to one named expert (E-2, 2026-10-11): no choosing by directory or domain, the caller
// said which seat. Every refusal says why and what to do next, because the caller is a model that
// has to act on the sentence. The reuse branch is claimSeat's: the seat is marked open with the new
// owner and parent, and the run goes on to continue its session like any returning expert.
export function claimNamedSeat({ seat, role, cwd = null, domain = null, owner = null, parent = null, scratchDir = null, fork = null } = {}, lang = language()) {
  if (!seat) throw new Error('claimNamedSeat: seat is required');
  const database = conn();
  const row = database.prepare('SELECT * FROM seats WHERE id = ?').get(seat);
  if (!row) throw new Error(message(`没有座位 ${seat}：用 seat_list 看活着的专家`, `Unknown seat "${seat}": call seat_list to see active experts`, lang));
  const label = message(`「${row.name ?? seat}」（${seat}）`, `"${row.name ?? seat}" (${seat})`, lang);
  if (isFork(row)) {
    throw new Error(message(
      `座位 ${seat} 是专家 ${row.parent} 的分身，只活一单，不能点名。要找那位专家，点名 ${row.parent}`,
      `Seat ${seat} is a one-shot fork of expert ${row.parent} and cannot be addressed directly; pass seat=${row.parent} instead`,
      lang,
    ));
  }
  if (row.role !== role) {
    throw new Error(message(
      `座位 ${seat} 是 ${row.role} 的专家，这一单派的是 ${role}：角色对不上。要用 ${role}，换一个 ${role} 的座位（seat_list 带 role 过滤），或者不点名，带 cwd / domain 让服务挑`,
      `Seat ${seat} is an expert for role "${row.role}", not "${role}". Pick a "${role}" seat (seat_list with role filter), or omit seat and pass cwd/domain`,
      lang,
    ));
  }
  if (row.state === 'closed') {
    const why = database.prepare("SELECT body FROM events WHERE seat = ? AND kind = 'close' ORDER BY seq DESC LIMIT 1").get(seat)?.body ?? null;
    const into = why ? /(?:并入|Merged into)\s*(seat-[\w-]+)/.exec(String(why)) : null;
    throw new Error(message(
      `专家${label}已经归档（${why ? `关闭原因：${why}` : '没有写关闭原因'}）。${into ? `它的记录已并入 ${into[1]}，改派给 ${into[1]}。` : '用 seat_list 看现在活着的专家，或不点名，带 cwd / domain 让服务挑。'}`,
      `Expert ${label} is closed (${why ? `reason: ${why}` : 'no reason given'}). ${into ? `Its records were merged into ${into[1]}; dispatch to ${into[1]} instead.` : 'Call seat_list to pick an active expert, or omit seat with cwd/domain.'}`,
      lang,
    ));
  }
  // A one-shot seat ran in the service's scratch directory (`scratchDir`, which exec.mjs knows) or
  // has no directory at all: there is nothing of the caller's it could continue.
  if (!row.domain && (!row.cwd || (scratchDir && dirKey(row.cwd) === dirKey(scratchDir)))) {
    throw new Error(message(
      `座位 ${seat} 是一次性的，没有可以点名接着干的对象`,
      `Seat ${seat} is a one-shot seat with no persistent object to resume`,
      lang,
    ));
  }
  const owns = row.domain
    ? message(`领域「${row.domain}」`, `domain "${row.domain}"`, lang)
    : message(`目录 ${row.cwd}`, `directory ${row.cwd}`, lang);
  if (cwd !== null && cwd !== undefined && cwd !== '' && (row.domain || dirKey(cwd) !== dirKey(row.cwd))) {
    throw new Error(message(
      `专家${label}负责的是${owns}，这一单带的 cwd 是「${cwd}」，对不上。去掉 cwd，或者换一个负责那个目录的专家（seat_list 带 cwd 看是谁）`,
      `Expert ${label} owns ${owns}, which does not match cwd "${cwd}". Omit cwd or pick another expert via seat_list(cwd)`,
      lang,
    ));
  }
  if (domain !== null && domain !== undefined && domain !== '' && normalizeDomain(domain) !== row.domain) {
    throw new Error(message(
      `专家${label}负责的是${owns}，这一单带的 domain 是「${domain}」，对不上。去掉 domain，或者换一个负责那个领域的专家（seat_list 带 domain 看是谁）`,
      `Expert ${label} owns ${owns}, which does not match domain "${domain}". Omit domain or pick another expert via seat_list(domain)`,
      lang,
    ));
  }
  // A busy expert is not refused any more (C-3, 2026-10-11): the task goes to a fork that starts from
  // the expert's records. This was a refusal in phase 2, when forks did not exist yet.
  // The caller's own fork (seat_start `fork`) goes beside the expert, busy or not.
  if (fork || isBusy(row)) return { ...openFork(row, { role, owner, fresh: fork === 'fresh', lang }), named: true };
  const specRow = database.prepare('SELECT spec FROM roles WHERE id = ?').get(role);
  if (!specRow) throw new Error(`unknown role: ${role}`);
  database
    .prepare('UPDATE seats SET state = ?, owner = ?, parent = ?, handle = NULL, pid = NULL, updated_at = ? WHERE id = ?')
    .run('open', owner ?? null, parent ?? null, now(), seat);
  return {
    seat, role, instance: Number(row.instance), name: row.name ?? null, domain: row.domain ?? null,
    spec: JSON.parse(specRow.spec), reused: true, previous: seatRow(row), named: true,
  };
}

// Give a living expert a new name (E-5). The name is what the lead picks people by (E-1), so two
// living experts never share one; the seat id does not change. A closed seat is a record, not
// someone to rename.
export function renameSeat({ seat, name } = {}, lang = language()) {
  const database = conn();
  const row = database.prepare('SELECT * FROM seats WHERE id = ?').get(seat);
  if (!row) throw new Error(message(`没有座位 ${seat}：用 seat_list 看活着的专家`, `Unknown seat "${seat}": call seat_list to see active experts`, lang));
  const next = typeof name === 'string' ? name.trim() : '';
  if (!next) {
    throw new Error(message(
      '名字不能是空的：写一句说清这个专家懂什么的话，例如「explorer · 座位与 skill 循环」',
      'name cannot be empty: describe what this expert knows, e.g. "explorer · seats & skill loop"',
      lang,
    ));
  }
  if ([...next].length > 80) {
    throw new Error(message(
      `名字最长 80 个字，这个有 ${[...next].length} 个：写短一点，细节放进专长说明里`,
      `name must be at most 80 characters (got ${[...next].length}); keep the label short and put details in expertise notes`,
      lang,
    ));
  }
  if (row.state === 'closed') {
    throw new Error(message(`座位 ${seat} 已经归档，不能改名；改名只给活着的专家`, `Seat ${seat} is closed and cannot be renamed`, lang));
  }
  if (isFork(row)) {
    throw new Error(message(
      `座位 ${seat} 是专家 ${row.parent} 的分身，只活一单，不用改名；要改名的是专家 ${row.parent}`,
      `Seat ${seat} is a one-shot fork of expert ${row.parent}; rename ${row.parent} instead`,
      lang,
    ));
  }
  // Forks carry the flag and are exempt: they are not experts and no roster lists them (C-3).
  const clash = database.prepare("SELECT id FROM seats WHERE name = ? AND id != ? AND state != 'closed' AND COALESCE(fork, 0) = 0").get(next, seat);
  if (clash) {
    throw new Error(message(
      `活着的专家 ${clash.id} 已经叫「${next}」：同名的两个专家没法按名字挑，换一个说得出区别的名字`,
      `Active expert ${clash.id} already uses the name "${next}"; choose a distinct name`,
      lang,
    ));
  }
  if (next === row.name) return seatRow(row);
  database.prepare('UPDATE seats SET name = ?, updated_at = ? WHERE id = ?').run(next, now(), seat);
  recordEvent({ seat, kind: 'rename', body: `${row.name ?? message('（没有名字）', '(unnamed)', lang)} → ${next}` });
  return seatRow(database.prepare('SELECT * FROM seats WHERE id = ?').get(seat));
}

// What a run leaves behind for the next one: the session to continue, the directory state it saw,
// the seat's own account of what it now knows, what it left undone (null: nothing left), and the
// skill hash and contract version and hash that session was last given. Only the fields given are
// touched; null clears one.
export function setSeatProfile({ seat, sessionFile, skillHash, contractVersion, contractHash, dirState, expertise, backlog } = {}) {
  const database = conn();
  seatOrThrow(database, seat);
  if (sessionFile !== undefined) database.prepare('UPDATE seats SET session_file = ? WHERE id = ?').run(sessionFile, seat);
  if (skillHash !== undefined) database.prepare('UPDATE seats SET skill_hash = ? WHERE id = ?').run(skillHash, seat);
  if (contractVersion !== undefined) database.prepare('UPDATE seats SET contract_version = ? WHERE id = ?').run(contractVersion, seat);
  if (contractHash !== undefined) database.prepare('UPDATE seats SET contract_hash = ? WHERE id = ?').run(contractHash, seat);
  if (dirState !== undefined) database.prepare('UPDATE seats SET dir_state = ? WHERE id = ?').run(dirState === null ? null : JSON.stringify(dirState), seat);
  if (expertise !== undefined) database.prepare('UPDATE seats SET expertise = ? WHERE id = ?').run(expertise, seat);
  if (backlog !== undefined) database.prepare('UPDATE seats SET backlog = ? WHERE id = ?').run(backlog, seat);
  database.prepare('UPDATE seats SET updated_at = ? WHERE id = ?').run(now(), seat);
  return seatRow(database.prepare('SELECT * FROM seats WHERE id = ?').get(seat));
}

export function bindSeat({ seat, handle = null, pid = null } = {}) {
  const database = conn();
  seatOrThrow(database, seat);
  // A seat closed between the child's spawn() call and its 'spawn' event (seat_close cancelling a
  // run that had only just started) stays closed: this call only records the pid then.
  database
    .prepare("UPDATE seats SET handle = ?, pid = ?, state = CASE WHEN state = 'closed' THEN state ELSE ? END, updated_at = ? WHERE id = ?")
    .run(handle ?? null, pid ?? null, 'running', now(), seat);
  return seatRow(database.prepare('SELECT * FROM seats WHERE id = ?').get(seat));
}

// Extra export beyond the brief's list: exec.mjs needs to move a seat to done/failed/interrupted.
export function setSeatState({ seat, state } = {}) {
  if (!state) throw new Error('setSeatState: state is required');
  const database = conn();
  seatOrThrow(database, seat);
  // Closed is final. A run that ends after its seat was closed (seat_close cancelled it) used to
  // write done/failed over 'closed' with closed_at still set, and the retired seat came back as the
  // directory's expert (2026-09-30 review). Reopening a seat goes through claimSeat, not through here.
  database.prepare("UPDATE seats SET state = ?, updated_at = ? WHERE id = ? AND state != 'closed'").run(state, now(), seat);
  return seatRow(database.prepare('SELECT * FROM seats WHERE id = ?').get(seat));
}

// Seats a live supervisor in this process will settle itself: a run the daemon spawned or adopted
// (exec.mjs). Their runtime may already be gone while settle() is still working (waiting for the
// commit lock, say), and reading the ledger in that window used to flip a finished run to
// 'interrupted' with a stale event (2026-09-30 review). The set is process-local on purpose: only the
// process that supervises a run can know it is being settled.
const supervised = new Set();

export function superviseSeat(seat, on = true) {
  if (on) supervised.add(seat);
  else supervised.delete(seat);
}

// A seat's runtime is a child of whichever daemon spawned it, so a daemon that was restarted owns
// none of the seats its predecessor left behind (until it adopts them at startup): that child can
// die with nobody watching, and the ledger would keep saying "running" until the next restart
// happened to sweep it. Reading the ledger therefore reconciles first — a running seat whose pid is
// gone is interrupted, with an event saying why, unless this process is supervising it. Cost: one
// process probe per running seat per read; the alternative is a ledger that lies about work, which
// is worse than a few syscalls.
export function reconcileRunning() {
  const database = conn();
  const rows = database.prepare("SELECT id, pid FROM seats WHERE state = 'running'").all();
  const flipped = [];
  for (const row of rows) {
    if (supervised.has(row.id)) continue;
    const pid = row.pid === null || row.pid === undefined ? null : Number(row.pid);
    if (pid !== null && pidAlive(pid)) continue;
    setSeatState({ seat: row.id, state: 'interrupted' });
    // The run's row is finished with the seat: a run nobody will settle must not stay open in the runs table.
    conn().prepare("UPDATE runs SET ended_at = ?, state = 'interrupted' WHERE seat = ? AND ended_at IS NULL").run(now(), row.id);
    recordEvent({
      seat: row.id,
      kind: 'interrupted',
      body: pid === null ? 'no runtime pid recorded' : `runtime pid ${pid} is gone`,
    });
    flipped.push(row.id);
  }
  return flipped;
}

// Retire a seat. This only rewrites the row: stopping a running runtime is exec.mjs's closeSeatNow,
// which kills the process tree first and then calls this.
export function closeSeat({ seat, reason = null } = {}, lang = language()) {
  const database = conn();
  seatOrThrow(database, seat);
  const at = now();
  database
    .prepare('UPDATE seats SET state = ?, updated_at = ?, closed_at = ? WHERE id = ?')
    .run('closed', at, at, seat);
  // L-2 (2026-10-11): every retirement leaves a 'close' event with the reason it was retired. Before,
  // a reason-less close wrote nothing, so an archived expert (and a merged one) left no trace of why it
  // went. With no reason the body says so, rather than the event being skipped.
  const text = reason === null || reason === undefined || String(reason).trim() === ''
    ? message('未说明原因', 'No reason given', lang)
    : String(reason);
  recordEvent({ seat, kind: 'close', body: text });
  return seatRow(database.prepare('SELECT * FROM seats WHERE id = ?').get(seat));
}

// L-1: ask exec.mjs to prepend this hand-off document to the seat's NEXT task, exactly once.
// `from` is the expert it was merged from (its raw record paths get listed under the document).
export function setPendingHandoff({ seat, file, from = null } = {}) {
  if (!seat || !file) throw new Error('setPendingHandoff: seat and file are required');
  const database = conn();
  seatOrThrow(database, seat);
  database.prepare('UPDATE seats SET pending_handoff = ?, updated_at = ? WHERE id = ?').run(JSON.stringify({ file, from }), now(), seat);
  return seatRow(database.prepare('SELECT * FROM seats WHERE id = ?').get(seat));
}

// Read and clear the one-time hand-off marker exec.mjs consumed (null when there was none).
export function takePendingHandoff(seat) {
  const database = conn();
  const row = database.prepare('SELECT pending_handoff FROM seats WHERE id = ?').get(seat);
  if (!row || !row.pending_handoff) return null;
  let marker = null;
  try { marker = JSON.parse(row.pending_handoff); } catch { marker = null; }
  if (marker) database.prepare('UPDATE seats SET pending_handoff = NULL, updated_at = ? WHERE id = ?').run(now(), seat);
  return marker;
}

// L-3: stamp a living expert's topic (seat_merge's optional rename also takes a topic).
export function setSeatTopic({ seat, topic = null } = {}) {
  const database = conn();
  seatOrThrow(database, seat);
  database.prepare('UPDATE seats SET topic = ?, updated_at = ? WHERE id = ?').run(normalizeTopic(topic), now(), seat);
  return seatRow(database.prepare('SELECT * FROM seats WHERE id = ?').get(seat));
}

// C-1's active hand-off nodes (2026-10-11): whether the seat has already recorded a 'handoff' event
// for one node (a session that passed 60000 chars, or one that passed half the backend context), so the
// service writes each node's hand-off at most once.
export function handoffNodeDone({ seat, node } = {}) {
  if (!seat || !node) throw new Error('handoffNodeDone: seat and node are required');
  const row = conn()
    .prepare("SELECT 1 FROM events WHERE seat = ? AND kind = 'handoff' AND body = ? LIMIT 1")
    .get(seat, node);
  return Boolean(row);
}

// ---- Runs (2026-10-11: G-3, C-5, C-6) ---------------------------------------------------------------

// The seat whose records a run belongs to: the parent of a fork, the seat itself for an expert.
export function expertOf(seat) {
  const row = conn().prepare('SELECT id, parent, fork FROM seats WHERE id = ?').get(seat);
  if (!row) throw new Error(`unknown seat: ${seat}`);
  return Number(row.fork) === 1 && row.parent ? row.parent : row.id;
}

// Where an expert's hand-off documents are kept, next to the ledger like the reports (phase 4 writes
// them; until then the directory is simply absent).
export function handoffDir(expert) {
  return path.join(path.dirname(DB_FILE), 'handoffs', String(expert).replace(/[^\w.-]/g, '_'));
}

// Does the expert have anything a run could be loaded from: a session it still holds, a finished run that
// left a session or a report, or a hand-off document. C-6's "had_records" is this, asked at a run's start.
export function expertHasRecords(expert) {
  const database = conn();
  const row = database.prepare('SELECT session_file FROM seats WHERE id = ?').get(expert);
  if (row?.session_file) return true;
  const run = database
    .prepare('SELECT 1 FROM runs WHERE expert = ? AND ended_at IS NOT NULL AND (session_file IS NOT NULL OR report_file IS NOT NULL) LIMIT 1')
    .get(expert);
  if (run) return true;
  try {
    return fs.readdirSync(handoffDir(expert)).some((name) => name.endsWith('.md'));
  } catch {
    return false;
  }
}

// A run starts: one row, with the load method the service expects (the runner may correct it at the end,
// finishRun). `hadRecords` is whether the expert already had records at this moment.
export function startRun({ seat, expert = null, taskSeq = null, load, hadRecords = false } = {}) {
  const info = conn()
    .prepare('INSERT INTO runs (seat, expert, task_seq, started_at, load, had_records) VALUES (?, ?, ?, ?, ?, ?)')
    .run(seat, expert ?? expertOf(seat), taskSeq ?? null, now(), load ?? null, hadRecords ? 1 : 0);
  return Number(info.lastInsertRowid);
}

// A run ends, however it ends (done, failed, cancelled, interrupted). `load`, when the runner reported
// it, replaces the provisional one; a field left out keeps what the row has.
export function finishRun({ id, state = null, sessionFile, reportFile, load } = {}) {
  conn()
    .prepare('UPDATE runs SET ended_at = ?, state = ?, load = COALESCE(?, load), session_file = COALESCE(?, session_file), report_file = COALESCE(?, report_file) WHERE id = ?')
    .run(now(), state, load ?? null, sessionFile ?? null, reportFile ?? null, Number(id));
}

// The run row of a seat's run, by the task event that started it: how an adopted run finds its row again.
export function runByTask(seat, taskSeq) {
  const row = conn().prepare('SELECT * FROM runs WHERE seat = ? AND task_seq = ? ORDER BY id DESC LIMIT 1').get(seat, Number(taskSeq));
  return row ? { ...row, id: Number(row.id) } : null;
}

// The expert's runs, newest first, forks' included (their rows say `expert` too).
export function expertRuns(expert, { limit = 10 } = {}) {
  return conn()
    .prepare('SELECT * FROM runs WHERE expert = ? ORDER BY id DESC LIMIT ?')
    .all(expert, limit)
    .map((row) => ({ ...row, id: Number(row.id), had_records: Number(row.had_records) }));
}

// The newest hand-off document of one expert, or null: B-3 asks this of the other roles' experts.
function newestHandoff(expert) {
  try {
    const dir = handoffDir(expert);
    const file = fs.readdirSync(dir).filter((name) => name.endsWith('.md')).sort().reverse()[0];
    return file ? path.join(dir, file) : null;
  } catch {
    return null;
  }
}

// B-3 (2026-10-11): the hand-off documents other roles' experts have written about this same object.
// Cross-role memory is read, never dispatched: what an explorer came to know in this directory is on
// disk, and the coder's expert is pointed at it instead of starting over (PRD B-3, "跨角色靠问").
// One entry per other role, its newest document; forks and archived experts are left out (their
// hand-offs were folded into whoever took them over, and are that expert's own records already).
function peerHandoffs(expert, limit = 5) {
  const out = [];
  try {
    const database = conn();
    const me = database.prepare('SELECT role, cwd FROM seats WHERE id = ?').get(expert);
    if (!me?.cwd) return out;
    const key = dirKey(me.cwd);
    const rows = database.prepare("SELECT id, role, cwd, fork FROM seats WHERE id != ? AND state != 'closed' AND cwd IS NOT NULL").all(expert);
    const roles = new Set();
    for (const row of rows) {
      if (row.role === me.role || roles.has(row.role) || isFork(row) || dirKey(row.cwd) !== key) continue;
      const file = newestHandoff(row.id);
      if (!file) continue;
      roles.add(row.role);
      let at = null;
      try { at = fs.statSync(file).mtime.toISOString(); } catch { at = null; }
      out.push({ kind: 'peer', role: row.role, file: path.resolve(file), at });
      if (out.length >= limit) break;
    }
  } catch {
    // the record list is best effort
  }
  return out;
}

// C-5: the raw records of an expert that exist on disk right now, for the note every run starts with.
// The session logs and reports of its newest `limit` runs (a continued session is one file, listed once
// under its newest run), the session the seat row still names (a ledger from before the runs table has no
// run rows for it), and the hand-off documents, newest first. Missing files are left out: a path the
// expert cannot open is worse than no path. `handoff` is the newest hand-off document, or ''.
export function expertRecords(expert, { limit = 10 } = {}) {
  const entries = [];
  const seen = new Set();
  const add = (kind, file, at) => {
    if (!file) return;
    const abs = path.resolve(file);
    if (seen.has(abs) || !fs.existsSync(abs)) return;
    seen.add(abs);
    entries.push({ kind, file: abs, at: at ?? null });
  };
  const runs = expertRuns(expert, { limit });
  const held = conn().prepare('SELECT session_file, updated_at FROM seats WHERE id = ?').get(expert);
  if (held?.session_file && !runs.some((run) => run.session_file === held.session_file)) add('session', held.session_file, held.updated_at);
  for (const run of runs) {
    const at = run.ended_at ?? run.started_at;
    add('session', run.session_file, at);
    add('report', run.report_file, at);
  }
  let handoffs = [];
  try {
    const dir = handoffDir(expert);
    handoffs = fs.readdirSync(dir).filter((name) => name.endsWith('.md')).sort().reverse().map((name) => path.join(dir, name));
  } catch {
    handoffs = [];
  }
  for (const file of handoffs.slice(0, limit)) {
    let at = null;
    try { at = fs.statSync(file).mtime.toISOString(); } catch { at = null; }
    add('handoff', file, at);
  }
  // B-3: after its own, what the other roles' experts of this same object have written.
  for (const peer of peerHandoffs(expert, limit)) {
    if (!seen.has(peer.file) && fs.existsSync(peer.file)) {
      seen.add(peer.file);
      entries.push(peer);
    }
  }
  return { entries, handoff: handoffs[0] ? path.resolve(handoffs[0]) : '' };
}

// Several writes as one commit (2026-10-11). Every ledger write is its own commit otherwise, and a run
// that prints thousands of lines paid thousands of fsyncs on the daemon's one thread (Windows CI, the
// same day: the event loop stalled for ten seconds). The function must be synchronous: nothing may
// yield to the event loop while the write lock is held. Re-entrant: inside a transaction it only calls
// the function. If the transaction cannot be opened the function still runs, one commit per write as
// before: losing the batching is better than losing the lines.
let inTx = false;
export function inTransaction(fn) {
  if (inTx) return fn();
  const database = conn();
  try {
    database.exec('BEGIN IMMEDIATE');
  } catch {
    return fn();
  }
  inTx = true;
  let result;
  try {
    result = fn();
  } catch (err) {
    inTx = false;
    try { database.exec('ROLLBACK'); } catch { /* the transaction is already gone */ }
    throw err;
  }
  inTx = false;
  try {
    database.exec('COMMIT');
  } catch (err) {
    try { database.exec('ROLLBACK'); } catch { /* already gone */ }
    throw err;
  }
  return result;
}

// How many events of one kind a seat has recorded after `seq`: an adopted run uses it to skip the
// output lines the previous daemon already put in the ledger.
export function countEventsAfter({ seat, kind, seq } = {}) {
  const row = conn().prepare('SELECT COUNT(*) AS n FROM events WHERE seat = ? AND kind = ? AND seq > ?').get(seat, kind, Number(seq) || 0);
  return Number(row.n);
}

// The newest task event of a seat (a run is named by it), or null.
export function latestTask(seat) {
  const row = conn().prepare("SELECT seq, at FROM events WHERE seat = ? AND kind = 'task' ORDER BY seq DESC LIMIT 1").get(seat);
  return row ? { seq: Number(row.seq), at: row.at } : null;
}

export function roleSpec(role) {
  const row = conn().prepare('SELECT spec FROM roles WHERE id = ?').get(role);
  return row ? JSON.parse(row.spec) : null;
}

// One seat's full row, or null.
export function seatById(id) {
  const row = conn().prepare('SELECT * FROM seats WHERE id = ?').get(id);
  return row ? seatRow(row) : null;
}

// Every seat's `state|updated_at`, by id: what /events/wait compares to notice a state change that
// wrote no event. One query, no per-seat lookups.
export function seatStamps() {
  return new Map(conn().prepare('SELECT id, state, updated_at FROM seats').all().map((row) => [row.id, `${row.state}|${row.updated_at}`]));
}

export function listSeats({ state } = {}) {
  const database = conn();
  const rows = state
    ? database.prepare('SELECT * FROM seats WHERE state = ? ORDER BY role, instance').all(state)
    : database.prepare('SELECT * FROM seats ORDER BY role, instance').all();
  return rows.map(seatRow);
}

// How many events seat_show returns unless asked for more. A directory expert is reused for run after
// run and every stdout line is an event, so one seat's history grows without bound; returning all of
// it made seat_show overflow the caller's context and made the wall's 1 Hz fetch of each running
// seat stringify megabytes on the daemon's event loop (2026-09-30 review).
export const SEAT_EVENTS_DEFAULT = 200;
// How many of a seat's newest runs seat_show lists in `runs`.
const SEAT_RUNS_SHOWN = 30;

// The seat and a bounded slice of its events (oldest first, the newest ones when it is cut).
//   tail: how many of the newest events to return; Infinity returns them all.
//   run:  a run is named by its 'task' event (the first event of the run); only that run's events
//         (up to the next 'task' event) are considered, and `tail` then applies within the run.
// `events_omitted` is how many older events of the selection were left out, so the caller can tell
// a complete answer from a cut one; `events_note` says in words how to get the rest.
export function showSeat(id, { tail = SEAT_EVENTS_DEFAULT, run = null } = {}, lang = language()) {
  const database = conn();
  const row = database.prepare('SELECT * FROM seats WHERE id = ?').get(id);
  if (!row) return null;
  let from = 0;
  let until = Number.MAX_SAFE_INTEGER;
  if (run !== null) {
    const start = database.prepare("SELECT seq FROM events WHERE seat = ? AND kind = 'task' AND seq = ?").get(id, Number(run));
    if (!start) {
      throw new Error(message(
        `座位 ${id} 没有从事件 ${run} 开始的运行：run 要填某次运行的 task 事件的 seq（在事件列表里找 kind 为 task 的那一条）`,
        `Seat ${id} has no run starting at event #${run}: pass a task event seq from the runs list`,
        lang,
      ));
    }
    from = Number(start.seq);
    const next = database.prepare("SELECT seq FROM events WHERE seat = ? AND kind = 'task' AND seq > ? ORDER BY seq ASC LIMIT 1").get(id, from);
    if (next) until = Number(next.seq);
  }
  const total = Number(database.prepare('SELECT COUNT(*) AS n FROM events WHERE seat = ? AND seq >= ? AND seq < ?').get(id, from, until).n);
  const limit = Number.isFinite(tail) ? Math.max(0, Math.floor(tail)) : total;
  const events = database
    .prepare('SELECT * FROM (SELECT * FROM events WHERE seat = ? AND seq >= ? AND seq < ? ORDER BY seq DESC LIMIT ?) ORDER BY seq ASC')
    .all(id, from, until, limit)
    .map(eventRow);
  const omitted = total - events.length;
  // The runs of this seat, named by their task events: the ids seat_verdict and seat_show take as `run`.
  // Listed here because the events above may be cut short of them (a run's output is one event per line).
  const runs = database
    .prepare("SELECT seq, at, body FROM (SELECT seq, at, body FROM events WHERE seat = ? AND kind = 'task' ORDER BY seq DESC LIMIT ?) ORDER BY seq ASC")
    .all(id, SEAT_RUNS_SHOWN)
    .map((e) => ({ run: Number(e.seq), at: e.at, task: String(e.body ?? '').slice(0, 80) }));
  const shown = { seat: seatRow(row), runs, events, events_total: total, events_omitted: omitted };
  if (omitted > 0) {
    shown.events_note = message(
      `只返回了最新的 ${events.length} 条事件，更早的 ${omitted} 条没有返回。要更多：带 tail=条数（比如 1000），或 tail=all 取全部；只看某一次运行：带 run=那次运行的 task 事件的 seq。`,
      `Returned only the latest ${events.length} event(s); ${omitted} older omitted. Pass tail=N (or tail="all"), or pass run=<task seq> for one run.`,
      lang,
    );
  }
  return shown;
}

// ---- Views for the lead (2026-10-01) ------------------------------------------------------------
// What the MCP shell hands a model is a view cut for that reader, with a length budget; the raw rows
// above stay available on request (architecture-v2-draft I7). seat_list returned every row of the
// seats table, closed and never-run seats included, about 108KB on the real ledger, and overflowed
// the caller's tool-result limit nine times in a row (review 2026-10-01 §3.4).

// A run's final report, in full, one file per run next to the ledger. The runner's result file lives
// in the run's scratch directory, which settle() removes, so the report is copied out of it first.
const REPORTS_DIR = path.join(path.dirname(DB_FILE), 'reports');

export function reportFile(seat, run) {
  return path.join(REPORTS_DIR, String(seat).replace(/[^\w.-]/g, '_'), `${Number(run)}.md`);
}

// What a saved report file holds byte for byte: the text and one newline. Kept in one place because
// runSummary reports the size and sha256 of this, so whoever reads the file can check it against them.
const reportBody = (text) => `${String(text)}\n`;

export function saveReport({ seat, run, text } = {}) {
  const file = reportFile(seat, run);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, reportBody(text), 'utf8');
  return file;
}

// The first sentence or two of a seat's expertise note, flattened to one line.
function shortExpertise(text, max = 160) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  const sentences = flat.match(/[^。！？!?]+[。！？!?]*|[^。！？!?]+$/g) ?? [flat];
  let cut = sentences.slice(0, 2).join('').trim();
  if (cut.length > max) cut = cut.slice(0, max - 1).trimEnd();
  return cut.length < flat.length ? `${cut}…` : cut;
}

// How many items an unfinished-work list holds: its bullet lines, or its non-empty lines when the
// seat wrote it without bullets.
export function backlogItems(text) {
  const lines = String(text ?? '').split('\n').map((line) => line.trim()).filter(Boolean);
  const bullets = lines.filter((line) => /^(?:[-*•·]|\d+[.、)）]|[（(]\d+[)）])/.test(line));
  return bullets.length || lines.length;
}

// One short row per seat. Without `state`, only the living directory experts: a directory, not
// closed, a role roles.json still has, and at least one run behind it — the seats a dispatch can
// actually land on. The refiner runs of the skill loop are not among them: each works in a scratch
// directory of its own and is never called again, so listing it would add one "expert" per batch for
// good. With `state`, every seat in that state (the caller asked for exactly that).
// `cwd` keeps the seats of that one directory (compared the way claimSeat compares directories);
// `domain` keeps the domain experts of that one field (compared after normalisation); `role` keeps
// one role's experts. `visits` is how many runs the seat has been given (E-6). A fork (C-3) is not an
// expert: the default view leaves it out, and its runs are counted under the expert in the runs table.
export function listSeatsCompact({ state = null, cwd = null, domain = null, role = null } = {}, lang = language()) {
  const database = conn();
  if (cwd !== null && (typeof cwd !== 'string' || !path.isAbsolute(cwd))) {
    throw new Error(message(`cwd 要写绝对路径，收到的是「${cwd}」`, `cwd must be an absolute path; got "${cwd}"`, lang));
  }
  if (domain !== null && typeof domain !== 'string') {
    throw new Error(message(`domain 要写字符串，收到的是「${domain}」`, `domain must be a string; got "${domain}"`, lang));
  }
  const roles = new Set(database.prepare('SELECT id FROM roles').all().map((row) => row.id));
  const lastRun = new Map(
    database.prepare("SELECT seat, MAX(seq) AS seq, MAX(at) AS at FROM events WHERE kind = 'task' GROUP BY seat").all().map((row) => [row.seat, row])
  );
  let rows = database.prepare('SELECT * FROM seats').all();
  rows = state
    ? rows.filter((row) => row.state === state)
    : rows.filter((row) => row.cwd && !isFork(row) && row.state !== 'closed' && row.owner !== SKILL_LOOP_OWNER && roles.has(row.role) && lastRun.has(row.id));
  if (cwd !== null) {
    const key = dirKey(cwd);
    rows = rows.filter((row) => row.cwd && dirKey(row.cwd) === key);
  }
  if (domain !== null) {
    const key = normalizeDomain(domain);
    rows = rows.filter((row) => row.domain && row.domain === key);
  }
  if (role !== null) rows = rows.filter((row) => row.role === role);
  const ran = new Map(
    database.prepare("SELECT seat, COUNT(*) AS n FROM events WHERE kind = 'task' GROUP BY seat").all().map((row) => [row.seat, Number(row.n)])
  );
  return rows
    .map((row) => ({
      seat: row.id,
      role: row.role,
      cwd: row.cwd ?? null,
      domain: row.domain ?? null,
      name: row.name ?? null,
      topic: row.topic ?? null,
      session_file: row.session_file ?? null,
      expertise: shortExpertise(row.expertise),
      state: row.state,
      visits: ran.get(row.id) ?? 0,
      backlog_items: backlogItems(row.backlog),
      last_run: lastRun.has(row.id) ? Number(lastRun.get(row.id).seq) : null,
      last_run_at: lastRun.get(row.id)?.at ?? null,
    }))
    .sort((a, b) => a.role.localeCompare(b.role) || String(b.last_run_at ?? '').localeCompare(String(a.last_run_at ?? '')));
}

// How many characters of a report a view returns unless asked for more.
export const REPORT_BUDGET_DEFAULT = 4000;
const REPORT_BUDGET_MAX = 100000;
const RECENT_RUNS_SHOWN = 10;
const RUN_END_KINDS = ['exit', 'cancelled', 'timeout', 'interrupted', 'error'];

// The final report of a run when its runner left no report file (runs from before 2026-10-01, a
// runner that died before writing one): what the run printed after its last tool call. Every runner
// echoes a tool call as a line starting with "· ", and the answer is the text after the last one.
function reportFromOutput(database, seat, from, until) {
  const lines = database
    .prepare("SELECT body FROM events WHERE seat = ? AND kind = 'stdout' AND seq > ? AND seq < ? ORDER BY seq")
    .all(seat, from, until)
    .map((row) => String(row.body ?? ''));
  let last = -1;
  lines.forEach((line, i) => {
    if (line.startsWith('· ')) last = i;
  });
  let tail = lines.slice(last + 1);
  if (!tail.some((line) => line.trim())) tail = lines.slice(-40);
  return tail.join('\n').trim();
}

// The facts of one run read off its events (everything but output lines): where it ends, how it
// ended, the verdict given on it and the unfinished list it handed back. `row` is the seat's row and
// `task` the run's task event. runSummary and the wall's run list both read a run through this.
function runFacts(database, row, task) {
  const seatId = row.id;
  const from = Number(task.seq);
  const next = database.prepare("SELECT seq FROM events WHERE seat = ? AND kind = 'task' AND seq > ? ORDER BY seq ASC LIMIT 1").get(seatId, from);
  const until = next ? Number(next.seq) : Number.MAX_SAFE_INTEGER;
  const events = database
    .prepare("SELECT seq, kind, body, at FROM events WHERE seat = ? AND seq > ? AND seq < ? AND kind NOT IN ('stdout', 'stderr') ORDER BY seq")
    .all(seatId, from, until);
  const lastOf = (kind) => [...events].reverse().find((e) => e.kind === kind) ?? null;
  const exit = lastOf('exit');

  // Ended: its exit is written, a newer run has started on the seat, or the seat left running/open
  // (cancelled runs close the seat at once; an interrupted one is marked so).
  const isLatest = !next;
  const ended = Boolean(exit) || !isLatest || !['running', 'open'].includes(row.state);
  let status;
  if (lastOf('cancelled')) status = 'cancelled';
  else if (lastOf('timeout')) status = 'timeout';
  else if (exit) status = exit.body === '0' ? 'done' : 'failed';
  else if (!ended) status = 'running';
  else if (lastOf('interrupted') || (isLatest && row.state === 'interrupted')) status = 'interrupted';
  else if (lastOf('error') || (isLatest && row.state === 'failed')) status = 'failed';
  else status = isLatest ? row.state : 'unknown';

  // A verdict that names this run, wherever it sits, or an unmarked one inside the run.
  let verdict = null;
  for (const e of database.prepare("SELECT seq, body FROM events WHERE seat = ? AND kind = 'verdict' AND seq > ? ORDER BY seq").all(seatId, from)) {
    const mark = VERDICT_RUN_MARK.exec(String(e.body ?? ''));
    if (mark?.[2] ? Number(mark[2]) === from : Number(e.seq) < until) verdict = String(e.body ?? '');
  }

  const leftEvent = events.filter((e) => e.kind === 'backlog' && (String(e.body ?? '').startsWith('它报告没做完的部分') || String(e.body ?? '').startsWith('Reported backlog:'))).pop();
  const backlog = leftEvent ? String(leftEvent.body).replace(/^(?:它报告没做完的部分：|Reported backlog:)\n?/, '').trim() : null;
  const endedAt = exit?.at ?? (ended ? (events.at(-1)?.at ?? null) : null);
  return { from, until, events, lastOf, exit, isLatest, ended, status, verdict, backlog, endedAt };
}

// One run in the words a lead needs: how it ended, what it cost, whether it was judged, what it left
// undone, and its final report cut to `budget` characters (with the file holding the whole of it).
// The run is named by the seq of its task event; without `run`, the seat's newest run.
export function runSummary({ seat = null, run = null, budget = REPORT_BUDGET_DEFAULT } = {}, lang = language()) {
  const database = conn();
  let task;
  if (run !== null && run !== undefined && run !== '') {
    const seq = Number(run);
    task = Number.isInteger(seq) ? database.prepare("SELECT seq, seat, body, at FROM events WHERE kind = 'task' AND seq = ?").get(seq) : null;
    if (!task) {
      const err = new Error(message(
        `没有编号为 ${run} 的运行：运行号是那一单开始时的 task 事件的 seq（seat_show 的「更早的运行」、seat_list 的 last_run 里有）。不知道号就只给 seat，取它最新的一单。`,
        `No run numbered ${run}: run id is the seq of its opening task event (shown in seat_show's earlier runs and seat_list's last_run). Omit run and pass seat alone for its latest run.`,
        lang,
      ));
      err.status = 404;
      throw err;
    }
    if (seat && task.seat !== seat) {
      throw new Error(message(
        `运行 #${task.seq} 属于座位 ${task.seat}，不是 ${seat}：只给 run 就够了。`,
        `Run #${task.seq} belongs to seat ${task.seat}, not ${seat}: pass run alone.`,
        lang,
      ));
    }
  } else {
    if (!seat) throw new Error(message('要给 seat（座位号）或 run（运行号），至少一个', 'Pass at least one of seat or run', lang));
    if (!database.prepare('SELECT id FROM seats WHERE id = ?').get(seat)) {
      const err = new Error(`unknown seat: ${seat}`);
      err.status = 404;
      throw err;
    }
    task = database.prepare("SELECT seq, seat, body, at FROM events WHERE seat = ? AND kind = 'task' ORDER BY seq DESC LIMIT 1").get(seat);
  }
  const seatId = task ? task.seat : seat;
  const row = database.prepare('SELECT * FROM seats WHERE id = ?').get(seatId);
  const seatInfo = {
    seat: row.id, role: row.role, name: row.name ?? null, cwd: row.cwd ?? null, state: row.state,
    backlog_items: backlogItems(row.backlog), expertise: shortExpertise(row.expertise),
  };
  const ledgerSeq = maxEventSeq();
  if (!task) return { seat: seatInfo, run: null, ledger_seq: ledgerSeq };

  const { from, until, events, lastOf, isLatest, ended, status, verdict, backlog, endedAt } = runFacts(database, row, task);

  const problems = events
    .filter((e) => RUN_END_KINDS.includes(e.kind) && e.kind !== 'exit')
    .map((e) => message(`${e.kind}：${String(e.body ?? '').slice(0, 300)}`, `${e.kind}: ${String(e.body ?? '').slice(0, 300)}`, lang));
  let stderrTail = [];
  if (ended && status !== 'done') {
    stderrTail = database
      .prepare("SELECT body FROM (SELECT seq, body FROM events WHERE seat = ? AND kind = 'stderr' AND seq > ? AND seq < ? ORDER BY seq DESC LIMIT 5) ORDER BY seq")
      .all(seatId, from, until)
      .map((e) => String(e.body ?? '').slice(0, 300));
  }
  let lastOutput = null;
  if (!ended) {
    const line = database.prepare("SELECT body FROM events WHERE seat = ? AND kind = 'stdout' AND seq > ? AND TRIM(body) != '' ORDER BY seq DESC LIMIT 1").get(seatId, from);
    lastOutput = line ? String(line.body).slice(0, 160) : null;
  }

  // The report: the runner's own file first, else the end of the run's output (saved to a file the
  // first time it is too long to return whole, so the caller has a path to read).
  let report = null;
  if (ended) {
    const file = reportFile(seatId, from);
    let text = null;
    let source = null;
    // The bytes the full report occupies: the runner's file as it lies on disk, otherwise what
    // saveReport writes for this text (the file the caller is pointed at once the report is cut).
    let raw = null;
    try {
      raw = fs.readFileSync(file);
      text = raw.toString('utf8').trim();
      source = 'runner';
    } catch {
      text = reportFromOutput(database, seatId, from, until);
      source = 'output';
      raw = Buffer.from(reportBody(text), 'utf8');
    }
    const limit = Math.min(Math.max(Number(budget) || REPORT_BUDGET_DEFAULT, 200), REPORT_BUDGET_MAX);
    const truncated = text.length > limit;
    let saved = source === 'runner' ? file : null;
    if (truncated && !saved) {
      try {
        saved = saveReport({ seat: seatId, run: from, text });
      } catch {
        saved = null;
      }
    }
    // bytes and sha256 describe the full report, not the part returned: O-4, so a caller can tell the
    // file it was pointed at is the whole of it.
    report = {
      text: truncated ? text.slice(0, limit) : text,
      chars: text.length,
      bytes: raw.length,
      sha256: createHash('sha256').update(raw).digest('hex'),
      truncated,
      file: saved,
      source,
    };
  }

  const recent = database
    .prepare("SELECT seq, at FROM events WHERE seat = ? AND kind = 'task' ORDER BY seq DESC LIMIT ?")
    .all(seatId, RECENT_RUNS_SHOWN)
    .map((e) => ({ run: Number(e.seq), at: e.at }));

  return {
    seat: seatInfo,
    run: {
      run: from,
      task: String(task.body ?? '').replace(/\s+/g, ' ').slice(0, 160),
      started_at: task.at,
      ended_at: endedAt,
      ended,
      status,
      latest: isLatest,
      usage: lastOf('usage')?.body ?? null,
      verdict,
      backlog: backlog ? backlog.slice(0, 1500) : null,
      backlog_items: backlog ? backlogItems(backlog) : 0,
      problems,
      stderr_tail: stderrTail,
      last_output: lastOutput,
      report,
    },
    recent_runs: recent,
    ledger_seq: ledgerSeq,
  };
}

// ---- The wall's view (2026-10-01) ---------------------------------------------------------------
// Everything the role wall (GET /) shows, in one short reply: the roles, the runs in flight and the
// newest finished ones, and the difficulty ledger's classes. The wall used to fetch the full /seats
// (about 108KB on the real ledger) plus every running seat's events once a second; it now fetches
// this only when /events/wait says the ledger moved. `ledger_seq` is the newest event when the view
// was read, the `since` for the next wait.
//
// Each role also carries what its card on the wall shows, so the page never needs the seat rows:
// `seats` (how many), `states` (seats per state), `latest` (the most recently updated seat),
// `last_failed_at`, and `live`, one entry per running seat with its newest line (the step the card
// lists). `totals` is the header's count over every seat, `names` the display name of each named
// seat in the newest WALL_NAMED_EVENTS events (the log's "who"), and with `role`, `instances` lists
// that role's seats for the log panel's instance buttons.
export const WALL_RECENT_RUNS = 12;
const WALL_DIFFICULTY_CLASSES = 30;
const WALL_NAMED_EVENTS = 2000;
const flatLine = (text, max) => {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

// W-1 (2026-10-11): what an expert of this role is the expert of — its directory's own name, or its
// field of knowledge for a role that is recognised by domain (PRD E-1). The wall's card names the
// object rather than repeating a path a reader cannot place.
const expertObject = (row) => (row.domain ? row.domain : row.cwd ? path.basename(row.cwd) : null);

// One role's card: counts by state, the newest seat, the newest failure, the running seats with the
// last line each one wrote (any event kind, as the wall always showed), and `experts` — one entry per
// living expert with its name, object, how many runs it has been given, its newest run and whether its
// session has grown too long to keep as one (L-4's 建议拆分). `rows` come in instance order; `visits`
// is each seat's run count (one task event per run) read once for the whole wall.
function wallCard(database, rows, visits) {
  const card = { seats: rows.length, states: {}, latest: null, last_failed_at: null, live: [], experts: [] };
  const later = (a, b) => new Date(a ?? 0) > new Date(b ?? 0);
  for (const row of rows) {
    card.states[row.state] = (card.states[row.state] ?? 0) + 1;
    if (row.state !== 'closed') {
      const seen = visits.get(row.id);
      const last = seen ? database.prepare("SELECT seq, body, at FROM events WHERE seat = ? AND kind = 'task' ORDER BY seq DESC LIMIT 1").get(row.id) : null;
      let suggest = false;
      try { suggest = Boolean(row.session_file && sessionPressure(row.session_file).suggest); } catch { suggest = false; }
      card.experts.push({
        seat: row.id,
        name: row.name ?? null,
        topic: row.topic ?? null,
        object: expertObject(row),
        runs: Number(seen?.runs ?? 0),
        last_run_at: last?.at ?? null,
        last_run_seq: last?.seq ?? null,
        last_task: last ? flatLine(last.body, 140) : null,
        state: row.state,
        suggest_split: suggest,
      });
    }
    if (!card.latest || later(row.updated_at, card.latest.updated_at)) {
      card.latest = { seat: row.id, state: row.state, updated_at: row.updated_at };
    }
    if ((row.state === 'failed' || row.state === 'interrupted') && (!card.last_failed_at || later(row.updated_at, card.last_failed_at))) {
      card.last_failed_at = row.updated_at;
    }
    if (row.state !== 'running') continue;
    const started = database.prepare("SELECT MAX(at) AS at FROM events WHERE seat = ? AND kind = 'task'").get(row.id)?.at ?? null;
    const line = database.prepare("SELECT body FROM events WHERE seat = ? AND body IS NOT NULL AND body != '' ORDER BY seq DESC LIMIT 1").get(row.id);
    card.live.push({
      seat: row.id,
      name: row.name ?? null,
      run_started_at: started,
      opened_at: row.opened_at,
      last_line: line ? flatLine(line.body, 200) : null,
    });
  }
  // Newest first: the expert that was last given work is the one a lead is likeliest to be looking for.
  // By the task event's sequence number, not its time: two runs given in the same millisecond tied on
  // the time and fell back to seat order (macOS CI, 2026-10-22, the newer expert listed second).
  card.experts.sort((a, b) => (b.last_run_seq ?? 0) - (a.last_run_seq ?? 0) || a.seat.localeCompare(b.seat));
  return card;
}

export function wallView({ recent = WALL_RECENT_RUNS, role = null, lang = language() } = {}) {
  const database = conn();
  const ledgerSeq = maxEventSeq();
  const seats = new Map(database.prepare('SELECT * FROM seats ORDER BY role, instance').all().map((row) => [row.id, row]));
  const seatsByRole = new Map();
  for (const row of seats.values()) {
    if (!seatsByRole.has(row.role)) seatsByRole.set(row.role, []);
    seatsByRole.get(row.role).push(row);
  }

  // W-1: one pass for every seat's number of runs (a run starts with its task event), so each role's
  // card can say how many times its experts have been there.
  const visits = new Map(database.prepare("SELECT seat, COUNT(*) AS runs FROM events WHERE kind = 'task' GROUP BY seat").all().map((row) => [row.seat, row]));
  const runningByRole = new Map();
  for (const row of seats.values()) {
    if (row.state === 'running') runningByRole.set(row.role, (runningByRole.get(row.role) ?? 0) + 1);
  }
  const lastByRole = new Map(
    database
      .prepare("SELECT s.role AS role, MAX(e.at) AS at FROM events e JOIN seats s ON s.id = e.seat WHERE e.kind = 'task' GROUP BY s.role")
      .all()
      .map((row) => [row.role, row.at])
  );
  const roles = listRoles()
    .map((spec) => ({
      role: spec.id,
      // The post's name as people read it ("Web Researcher"), kept in roles.json beside the id the
      // tools use ("web_researcher"); a role without one shows its id.
      title: typeof spec.title === 'string' && spec.title.trim() ? spec.title.trim() : null,
      contract_version: spec.contract_version ?? null,
      wall_order: typeof spec.wall_order === 'number' ? spec.wall_order : 0,
      running: runningByRole.get(spec.id) ?? 0,
      last_run_at: lastByRole.get(spec.id) ?? null,
      ...wallCard(database, seatsByRole.get(spec.id) ?? [], visits),
    }))
    .sort((a, b) => a.wall_order - b.wall_order || a.role.localeCompare(b.role));

  // The newest task events, plus the latest one of every running seat (a long run can be older than
  // the newest few dozen starts). Twice `recent` is read so that enough of them have ended.
  const tasks = new Map();
  const runningCount = [...runningByRole.values()].reduce((sum, n) => sum + n, 0);
  for (const task of database.prepare("SELECT seq, seat, body, at FROM events WHERE kind = 'task' ORDER BY seq DESC LIMIT ?").all(recent * 2 + runningCount)) {
    tasks.set(Number(task.seq), task);
  }
  for (const row of seats.values()) {
    if (row.state !== 'running') continue;
    const task = database.prepare("SELECT seq, seat, body, at FROM events WHERE seat = ? AND kind = 'task' ORDER BY seq DESC LIMIT 1").get(row.id);
    if (task) tasks.set(Number(task.seq), task);
  }
  const runs = [];
  for (const task of tasks.values()) {
    const row = seats.get(task.seat);
    if (!row) continue;
    const facts = runFacts(database, row, task);
    let lastOutput = null;
    if (!facts.ended) {
      const line = database.prepare("SELECT body FROM events WHERE seat = ? AND kind = 'stdout' AND seq > ? AND TRIM(body) != '' ORDER BY seq DESC LIMIT 1").get(row.id, facts.from);
      lastOutput = line ? flatLine(line.body, 160) : null;
    }
    const verdictMark = facts.verdict ? VERDICT_RUN_MARK.exec(facts.verdict) : null;
    runs.push({
      run: facts.from,
      seat: row.id,
      role: row.role,
      name: row.name ?? null,
      cwd: row.cwd ?? null,
      task: flatLine(task.body, 140),
      status: facts.status,
      started_at: task.at,
      ended_at: facts.endedAt,
      verdict: facts.verdict ? (verdictMark ? verdictMark[1] : facts.verdict.split(/[:：]/)[0]) : null,
      backlog_items: facts.backlog ? backlogItems(facts.backlog) : 0,
      last_output: lastOutput,
    });
  }
  const running = runs.filter((r) => r.status === 'running').sort((a, b) => b.run - a.run);
  const ended = runs
    .filter((r) => r.status !== 'running')
    .sort((a, b) => String(b.ended_at ?? b.started_at).localeCompare(String(a.ended_at ?? a.started_at)) || b.run - a.run)
    .slice(0, recent);

  let totalRunning = 0;
  let totalFailed = 0;
  for (const row of seats.values()) {
    if (row.state === 'running') totalRunning += 1;
    else if (row.state === 'failed' || row.state === 'interrupted') totalFailed += 1;
  }
  const names = {};
  for (const row of database
    .prepare('SELECT id, name FROM seats WHERE name IS NOT NULL AND id IN (SELECT seat FROM (SELECT seat FROM events ORDER BY seq DESC LIMIT ?))')
    .all(WALL_NAMED_EVENTS)) {
    names[row.id] = row.name;
  }

  const classes = difficultyClasses(lang);
  const view = {
    ledger_seq: ledgerSeq,
    totals: { seats: seats.size, running: totalRunning, failed: totalFailed },
    roles,
    names,
    running,
    recent: ended,
    // Only the count: the wall says a candidate is waiting, and the review itself is candidates.
    candidates: { pending: pendingCandidateCount() },
    difficulties: {
      remind_at: DIFFICULTY_REMIND_AT,
      due: classes.filter((g) => g.runs >= DIFFICULTY_REMIND_AT).length,
      open: classes.length,
      classes: classes.slice(0, WALL_DIFFICULTY_CLASSES).map((g) => ({
        class: g.class,
        role: g.role,
        kind_words: g.kind_words,
        tool: g.tool ?? null,
        runs: g.runs,
        count: g.count,
        due: g.runs >= DIFFICULTY_REMIND_AT,
        sample: g.samples[0] ? flatLine(g.samples[0].detail ?? g.samples[0].description, 160) : null,
        last_decision: g.last_verdict ? g.last_verdict.decision : null,
      })),
    },
  };
  if (role !== null) {
    view.instances = {
      role,
      seats: (seatsByRole.get(role) ?? []).map((row) => ({ seat: row.id, name: row.name ?? null, state: row.state, updated_at: row.updated_at })),
    };
  }
  return view;
}

// Event kinds the service writes itself and reads back: cost_report and the run boundaries parse
// task / usage / exit / verdict, the schedule reads task, the wall renders runner / stdout / stderr /
// error, and an adopted run counts stdout / stderr lines. A caller-written event of one of these kinds
// fabricates a run, resets a schedule timer or overwrites a real run's exit code, usage or verdict
// (2026-09-30 review), so the seat_record route refuses them. recordEvent itself stays open: the
// service is the one caller that may use them. `skill` (2026-10-01) is a run's record of which skill
// version it carried (I4); a hand-written one would tie a difficulty to a version the run never saw.
// `contract` (2026-10-01) is the same record for the role contract.
export const RESERVED_EVENT_KINDS = ['task', 'usage', 'exit', 'verdict', 'runner', 'stdout', 'stderr', 'error', 'skill', 'contract'];

export function recordEvent({ seat, kind, body = null } = {}) {
  if (!kind) throw new Error('recordEvent: kind is required');
  const database = conn();
  seatOrThrow(database, seat);
  const at = now();
  const text = body === null || body === undefined ? null : String(body);
  const info = database.prepare('INSERT INTO events (seat, kind, body, at) VALUES (?, ?, ?, ?)').run(seat, kind, text, at);
  return { seq: Number(info.lastInsertRowid), seat, kind, body: text, at };
}

export function listEvents(seat) {
  const database = conn();
  return database
    .prepare('SELECT * FROM events WHERE seat = ? ORDER BY seq ASC')
    .all(seat)
    .map(eventRow);
}

export function listRoles() {
  const database = conn();
  return database
    .prepare('SELECT id, spec, updated_at FROM roles ORDER BY id')
    .all()
    .map((row) => ({ id: row.id, ...JSON.parse(row.spec), updated_at: row.updated_at }));
}

const MEMORY_KINDS = ['fact', 'lesson', 'note'];
const MEMORY_CAP_BYTES = 4096;
const MEMORY_RECENT = 12;
// The longest single memory memory_write takes, in characters. The digest handed to a run is capped
// at MEMORY_CAP_BYTES in total, so a memory near this length is clipped there (see memoryDigest).
const MEMORY_BODY_MAX = 4000;
// One entry never takes more than this share of the digest. A single fact bigger than the whole cap
// used to make the drop loop discard every older fact and then itself, so the role was handed no
// memory at all and nobody was told (2026-09-30 review).
const MEMORY_ENTRY_BYTES = MEMORY_CAP_BYTES / 2;

function memoryRow(row) {
  return {
    seq: Number(row.seq),
    role: row.role,
    kind: row.kind,
    body: row.body,
    source: row.source ?? null,
    at: row.at,
  };
}

export function memoryWrite({ role, kind, body, source = null } = {}) {
  if (!role) throw new Error('memoryWrite: role is required');
  if (!MEMORY_KINDS.includes(kind)) throw new Error(`memoryWrite: kind must be one of ${MEMORY_KINDS.join(' | ')}`);
  if (typeof body !== 'string' || body.length === 0) throw new Error('memoryWrite: body is required');
  if (body.length > MEMORY_BODY_MAX) {
    throw new Error(`memoryWrite: one memory can be at most ${MEMORY_BODY_MAX} characters and this one has ${body.length}. Split it into several shorter memories, one fact or lesson each, and write them separately.`);
  }
  const database = conn();
  // A role that does not exist would take the write and report success, and no run would ever be
  // handed it ('web-researcher' for 'web_researcher'; 2026-09-30 review).
  if (!database.prepare('SELECT 1 FROM roles WHERE id = ?').get(role)) {
    const valid = database.prepare('SELECT id FROM roles ORDER BY id').all().map((r) => r.id);
    throw new Error(`memoryWrite: unknown role "${role}". Valid roles: ${valid.join(', ')}. Role ids are case-sensitive and use underscores (web_researcher); nothing was written, so call it again with one of these.`);
  }
  const info = database
    .prepare('INSERT INTO memories (role, kind, body, source, at) VALUES (?, ?, ?, ?, ?)')
    .run(role, kind, body, source ?? null, now());
  return memoryRow(database.prepare('SELECT * FROM memories WHERE seq = ?').get(Number(info.lastInsertRowid)));
}

// Newest first, which is also the order the digest wants. limit <= 0 means "all of them".
export function listMemories({ role, limit = 20 } = {}) {
  if (!role) throw new Error('listMemories: role is required');
  const database = conn();
  const capped = Number(limit);
  // LIMIT takes a whole number: a fractional one is bound as a REAL and SQLite answers "datatype
  // mismatch" (memory_read limit 2.5, 2026-09-30 review).
  const rows =
    Number.isFinite(capped) && capped > 0
      ? database.prepare('SELECT * FROM memories WHERE role = ? ORDER BY seq DESC LIMIT ?').all(role, Math.max(1, Math.floor(capped)))
      : database.prepare('SELECT * FROM memories WHERE role = ? ORDER BY seq DESC').all(role);
  return rows.map(memoryRow);
}

// What a role is handed before each run: every `fact`, then the newest lessons/notes, cut to fit
// the byte cap. Over the cap lessons/notes go first (oldest first), facts only when nothing else is
// left to drop, and the tail says how many stayed behind.
function renderMemory(kept, dropped) {
  const lines = kept.map((memory) => `[${memory.kind}] ${memory.body}`);
  if (lines.length) lines.unshift('岗位记忆（memory_read 可取该岗位的全部记忆）：');
  if (dropped > 0) lines.push(`（还有 ${dropped} 条未注入，可用 memory_read 取）`);
  return lines.join('\n');
}

// An entry too long for its share of the digest is cut on a character boundary and says so, with the
// way to the full text; the entries around it are unaffected.
function clipMemory(memory) {
  const room = MEMORY_ENTRY_BYTES - Buffer.byteLength(`[${memory.kind}] `, 'utf8');
  const bytes = Buffer.from(memory.body, 'utf8');
  if (bytes.length <= room) return memory;
  const marker = `…（这条记忆太长，只注入了前面一部分，全文用 memory_read 取，seq ${memory.seq}）`;
  let end = room - Buffer.byteLength(marker, 'utf8');
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1; // do not stop inside a multi-byte character
  return { ...memory, body: `${bytes.subarray(0, Math.max(end, 0)).toString('utf8')}${marker}` };
}

export function memoryDigest(role) {
  if (!role) return '';
  const all = listMemories({ role, limit: 0 }).map(clipMemory);
  const facts = all.filter((memory) => memory.kind === 'fact');
  const recent = all.filter((memory) => memory.kind !== 'fact').slice(0, MEMORY_RECENT);
  // Shown oldest-first. The cap drops lessons/notes (oldest first) before it touches any fact:
  // a fact is usually the oldest line, and dropping purely by age lost it first — the opposite of
  // "every fact" (README, found 2026-09-29). Only when the facts alone overflow do the oldest go.
  const ordered = [...facts, ...recent].sort((a, b) => a.seq - b.seq);
  const dropOrder = [...recent, ...facts].sort((a, b) => (a.kind === 'fact') - (b.kind === 'fact') || a.seq - b.seq);
  const gone = new Set();
  const render = () => renderMemory(ordered.filter((memory) => !gone.has(memory)), gone.size);
  let text = render();
  while (Buffer.byteLength(text, 'utf8') > MEMORY_CAP_BYTES && gone.size < ordered.length) {
    gone.add(dropOrder[gone.size]);
    text = render();
  }
  return text;
}

// How many runtimes are alive right now: the seat state machine's own answer, and the only one
// that can see seats a previous daemon left running.
export function countRunning() {
  const row = conn().prepare("SELECT COUNT(*) AS n FROM seats WHERE state = 'running'").get();
  return Number(row.n);
}

// Every event newer than `seq`, oldest first: the long poll reads the ledger through this. With
// `seat`, only that seat's events (a wait on one run must not reread everyone else's output).
export function eventsSince(seq, seat = null) {
  const from = Number(seq);
  const start = Number.isFinite(from) ? from : 0;
  const rows = seat === null
    ? conn().prepare('SELECT * FROM events WHERE seq > ? ORDER BY seq ASC').all(start)
    : conn().prepare('SELECT * FROM events WHERE seq > ? AND seat = ? ORDER BY seq ASC').all(start, seat);
  return rows.map(eventRow);
}

// The newest `n` events across every seat, oldest first: where the wall's global log starts.
export function eventsTail(n) {
  const count = Math.max(1, Math.min(Number(n) || 300, 2000));
  return conn()
    .prepare('SELECT * FROM (SELECT * FROM events ORDER BY seq DESC LIMIT ?) ORDER BY seq ASC')
    .all(count)
    .map(eventRow);
}

export function maxEventSeq() {
  const row = conn().prepare('SELECT COALESCE(MAX(seq), 0) AS top FROM events').get();
  return Number(row.top);
}

// Extra export beyond the brief's list: /health reports the ledger path.
export function dbFile() {
  return DB_FILE;
}

export function close() {
  if (db) {
    db.close();
    db = null;
  }
}
