// specialist-subagents daemon: the ledger's one HTTP door on 127.0.0.1.
// The MCP shell and the CLI both talk to this; neither owns the seats.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as store from './store.mjs';
import { renderMonitorHtml } from './page.mjs';
import { renderSettingsHtml } from './settings-page.mjs';
import { checkChoice, checkSettings, language, loadSettings, message, planFor, readBackendHealth, readChoice, saveSettings, summarizeBackendHealth, writeChoice } from './presets.mjs';
import { listModels } from './models.mjs';
import { runPost, closeSeatNow, cancelRunNow, resolveSeatCwd } from './exec.mjs';
import { pidAlive } from './proc.mjs';
import { assertRoleSpecs } from './role-contract.mjs';
import * as skillLoop from './skill-loop.mjs';
import { sessionPressure, HANDOFF_NODE_LARGE_CHARS } from './session-pressure.mjs';
import { handoffTitles, missingHandoffNote, missingHandoffSections } from './handoff-doc.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.join(ROOT, '.data');
const STATE_FILE = path.join(DATA_DIR, 'daemon.json');
function roleSpecs() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'roles.json'), 'utf8'));
}
function roleNames() {
  return Object.keys(roleSpecs());
}
function presetsView(settings, lang = 'en') {
  const specs = roleSpecs();
  const titles = Object.fromEntries(Object.entries(specs).map(([id, spec]) => [id, lang === 'zh' ? spec.title ?? id : id]));
  return { settings, roles: Object.keys(specs), titles };
}
const DEFAULT_PORT = 43130;
// How many runtimes may be alive at once. Over the limit a submission is refused outright; the
// service has no queue by design (a queue is a different feature, not a bigger number here).
const DEFAULT_MAX_CONCURRENCY = 10;
const WAIT_DEFAULT_MS = 30000;
const WAIT_MAX_MS = 600000;
const WAIT_POLL_MS = 200;

// Last words.
//
// This process died twice on 2026-09-19 without leaving a single line anywhere: no exception, no exit
// note, nothing the next reader could reason from. A service that disappears in silence cannot be
// operated, so the daemon writes its own life to .data/daemon.log: a start line carrying the parent
// pid (what says who owns it, and therefore which job object may kill it), and a line for every way
// out it can observe. A hard kill writes nothing — that absence is itself evidence, and the start
// line of the next run is what dates it.
//
// The handlers below are registered only when this file *is* the daemon (see isMain at the bottom).
// Registering them at module scope made every importer a diarist: the MCP bridge imports this file,
// so each bridge that exited wrote an "exit code=0" line into the daemon's log, where it read as if
// the service had died.
const LIFE_LOG = path.join(DATA_DIR, 'daemon.log');
// The /shutdown route is dispatched outside startDaemon(), so it needs its own handle on the server
// (referencing the local server from there threw ReferenceError: server is not defined, and the
// daemon exited 1 on a shutdown that looked clean from the caller's side).
let serverRef = null;
let lifeLogReady = false;

// Registered at the moment a process *becomes* the daemon (startDaemon), and nowhere else. Not at
// module scope: the MCP bridge imports this file, and every bridge that exited then wrote an
// "exit code=0" line into the daemon's log, where it reads like the service dying (2026-09-19). Not
// behind isMain either: the normal start path is `bin/specialist-subagents.mjs start`, which imports
// startDaemon() into the CLI's own process — there isMain is false, so nothing was logged at all.
function registerLifeLogHandlers() {
  if (lifeLogReady) return;
  lifeLogReady = true;
  process.on('uncaughtException', (error) => {
    lifeLog(`uncaughtException: ${error?.stack ?? error}`);
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    lifeLog(`unhandledRejection: ${reason?.stack ?? reason}`);
  });
  process.on('exit', (code) => lifeLog(`exit code=${code} uptime=${Math.round(process.uptime())}s`));
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => {
      lifeLog(`signal ${signal}`);
      process.exit(0);
    });
  }
}

function lifeLog(message) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(LIFE_LOG, `${new Date().toISOString()} pid=${process.pid} ${message}\n`);
  } catch {
    // logging must never be the reason the daemon fails to run
  }
}


function send(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function concurrencyLimit() {
  const raw = Number(process.env.SPECIALIST_SUBAGENTS_MAX_CONCURRENCY);
  return Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_MAX_CONCURRENCY;
}

// Seats this daemon has spawned and not yet seen finish. A seat only reaches state 'running' in the
// ledger once its child emits 'spawn' — tens of milliseconds after the HTTP reply on this host — so
// a burst of submissions would all read the same ledger count and walk straight past the limit.
// The ledger count still covers seats an earlier daemon left running; the larger of the two wins.
let inFlight = 0;

function runningNow() {
  return Math.max(store.countRunning(), inFlight);
}

// R-6 (2026-10-21): a dispatch from inside a seat. Every seat's process carries its seat id, and the
// MCP bridge a seat starts hands it over as `caller_seat`; the role is looked up here, never taken from
// the request. Only a role whose grant has `dispatch` (Lead) may dispatch, and only to a role whose grant
// does not: one level, no Lead under a Lead, no member dispatching at all. The dispatch is filed under
// the calling seat as its parent. A request with no caller_seat is a host, as before.
function forbidden(message) {
  const err = new Error(message);
  err.status = 403;
  err.payload = { error: message };
  return err;
}

function dispatchCaller(callerSeat, input) {
  if (!callerSeat) return null;
  const caller = store.seatById(callerSeat);
  if (!caller) {
    throw forbidden(message(
      `派单的座位 ${callerSeat} 不在台账里：座位里的派单只认服务给的座位号。这一单没有派出去。`,
      `Dispatching caller seat ${callerSeat} is not in the ledger: in-seat dispatch requires a valid service-assigned seat id. Dispatch refused.`,
    ));
  }
  if (!store.roleSpec(caller.role)?.grant?.includes('dispatch')) {
    throw forbidden(message(
      `${caller.role} 的座位（${callerSeat}）不能派单：只有 grant 里有 dispatch 的岗位（Leader）能往下派活，组员自己把活干完。这一单没有派出去。`,
      `${caller.role} seat (${callerSeat}) cannot dispatch: only roles granted "dispatch" (leads) can dispatch; member seats complete their own tasks. Dispatch refused.`,
    ));
  }
  const target = input.seat ? store.seatById(input.seat)?.role ?? input.role : input.role;
  for (const role of new Set([input.role, target])) {
    if (store.roleSpec(role)?.grant?.includes('dispatch')) {
      throw forbidden(message(
        `Leader 不能把活派给 ${role}：派单只有一层，Leader 只派组员，不派 Leader。这一单没有派出去。`,
        `A lead cannot dispatch to ${role}: dispatch is single-tier only (leads dispatch member roles, never other leads). Dispatch refused.`,
      ));
    }
  }
  return caller;
}

// Admission control for both spawn routes: refuse over the limit, otherwise hand back the seat id
// (available synchronously) and the run's promise.
function admit({ role, task, owner = null, parent = null, cwd = null, domain = null, topic = null, seat: named = null, fork = null }) {
  const limit = concurrencyLimit();
  const running = runningNow();
  if (running >= limit) {
    const err = new Error(message(
      `并发上限 ${limit}，当前在跑 ${running}：本服务不排队，等一个座位跑完再提交`,
      `Concurrency limit reached (${running}/${limit} running): this service does not queue; wait for a seat to finish before dispatching`,
    ));
    err.status = 429;
    err.payload = { error: err.message, limit, running };
    throw err;
  }
  let seat = null;
  let opened = null;
  inFlight += 1;
  const pending = runPost({
    role,
    task,
    owner,
    parent,
    cwd,
    domain,
    topic,
    seat: named,
    fork,
    runner: `daemon:${process.pid}`,
    onOpen: (info) => {
      seat = info.seat;
      opened = info;
    },
  });
  track(pending);
  return { seat, opened, pending };
}

// What the daemon does with a run it counted in inFlight, whether it spawned it (admit) or adopted it
// after a restart: give the slot back when the run ends, and admit the follow-up its role declares.
function track(pending) {
  const release = () => {
    inFlight -= 1;
  };
  pending.then(release, release);
  // The skill loop looks at the role of every run that ends (skill-loop.mjs): a refiner run that
  // finished becomes a candidate, and a role with a full batch of new difficulties gets its refiner.
  pending.then((result) => afterRun(result), () => {});
  // A role may declare who follows it (roles.json followed_by); the follow-up is admitted like any
  // request, so it respects the same concurrency limit. Refused or failed, the ledger says so.
  pending.then((result) => {
    if (!result?.followUp) return;
    try {
      admit({ ...result.followUp, owner: `followed_by:${result.seat}`, parent: result.seat });
    } catch (err) {
      try {
        store.recordEvent({
          seat: result.seat,
          kind: 'follow',
          body: message(`后续的 ${result.followUp.role} 没派出去：${err.message}`, `Follow-up ${result.followUp.role} was not dispatched: ${err.message}`),
        });
      } catch {
        // ledger trouble must not break the daemon
      }
    }
  }, () => {});
}

// The skill loop's dispatch: the refiner runs like any other seat, under the same concurrency limit.
// A full limit rejects with status 429, which skill-loop.mjs reads as "not now", not as a failure.
async function refineDispatch({ role, task, cwd }) {
  const { seat } = await withSeat(admit({ role, task, cwd, owner: store.SKILL_LOOP_OWNER }));
  return { seat };
}

// Ask the skill loop whether `role` is due for a refiner. It decides; this only calls it and keeps a
// failure of its own from touching the run or the request that triggered it.
function skillLoopTick(role) {
  skillLoop
    .maybeRefine({ role, dispatch: refineDispatch, hasRoom: () => runningNow() < concurrencyLimit() })
    .catch((err) => lifeLog(`skill loop (${role}): ${err.message}`));
}

function afterRun(result) {
  try {
    skillLoop.reconcileRuns();
    const seat = result?.seat ? store.seatById(result.seat) : null;
    if (seat) skillLoopTick(seat.role);
    // C-1's active hand-off nodes (2026-10-11): a finished expert whose session has grown past a node
    // gets one service-dispatched hand-off run, at most once per node.
    maybeWriteHandoff(result);
  } catch (err) {
    lifeLog(`skill loop after run: ${err.message}`);
  }
}

// `.data/handoffs/<seat>/<time>.md`: an ISO stamp with the colons a filename cannot carry.
function handoffStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

// H-4 (2026-10-11): "池：<角色> 在跑 n / 未关闭 m；…". One line over the roles that still hold seats:
// how many of their runs are in flight, and how many experts they have that were never retired. Roles
// come in the wall's order; a ledger with nothing in it says so instead of printing an empty list.
function poolText(lang = 'en') {
  const order = new Map(store.listRoles().map((spec, index) => [spec.id, index]));
  const counts = new Map();
  for (const row of store.listSeats()) {
    if (row.state === 'closed') continue;
    const count = counts.get(row.role) ?? { running: 0, open: 0 };
    count.open += 1;
    if (row.state === 'running') count.running += 1;
    counts.set(row.role, count);
  }
  const parts = [...counts.entries()]
    .sort(([a], [b]) => (order.get(a) ?? order.size) - (order.get(b) ?? order.size) || a.localeCompare(b))
    .map(([role, count]) => message(`${role} 在跑 ${count.running} / 未关闭 ${count.open}`, `${role} running ${count.running} / open ${count.open}`, lang));
  return parts.length ? message(`池：${parts.join('；')}`, `pool: ${parts.join('; ')}`, lang) : message('池：现在没有在跑的单子，也没有未关闭的专家', 'pool: no running tasks or open experts', lang);
}

// S-4 (2026-10-11): a hand-off is four sections, and the third — the pitfalls — is where the lessons of
// one object belong (they never go into a role's skill). What came back is checked against the shape it
// was asked for, and a document that came back short is said out loud in the receiving expert's own
// events, so a reader is not left to discover the hole.
function noteHandoffShape({ seat, file, body }) {
  try {
    const missing = missingHandoffSections(body);
    if (missing.length) store.recordEvent({ seat, kind: 'note', body: missingHandoffNote(file, missing) });
  } catch {
    // a note about the shape must never lose the hand-off itself
  }
}

// The service's own hand-off run: continue the expert's session with a service message that asks it to
// write the four-section hand-off. It occupies a concurrency slot like any run, owner recorded as
// `handoff`. Resolves to { body, ok } where body is the expert's report text.
async function dispatchHandoffRun({ role, seat, prompt }) {
  let opened = null;
  let pending = null;
  try {
    const admitted = admit({ role, task: prompt, seat, owner: 'handoff' });
    opened = admitted.opened;
    pending = admitted.pending;
  } catch (err) {
    return { ok: false, body: '', error: err.message };
  }
  const outcome = await pending;
  if (outcome?.state !== 'done') {
    return {
      ok: false,
      body: '',
      error: message(`写交接这一单以 ${outcome?.state ?? '未知'} 结束`, `Hand-off run ended with state "${outcome?.state ?? 'unknown'}"`),
    };
  }
  let body = '';
  try {
    body = store.runSummary({ seat, run: opened?.run ?? null, budget: 100000 })?.run?.report?.text ?? '';
  } catch { body = ''; }
  return { ok: true, body };
}

// L-1 (2026-10-11): merge expert `from` into `into`. A and B must be living experts of the same role.
// A's session is continued for one hand-off run; that document goes into B's hand-off dir, B's next
// task starts with it once, and A is archived ("并入 B"). If the hand-off run fails, A is left living
// and a 'merge' event records why.
async function mergeSeats({ from, into, name = null }) {
  const a = store.seatById(from);
  const b = store.seatById(into);
  if (!a) throw new Error(message(`seat_merge: 找不到座位 ${from}`, `seat_merge: seat not found: ${from}`));
  if (!b) throw new Error(message(`seat_merge: 找不到座位 ${into}`, `seat_merge: seat not found: ${into}`));
  if (a.fork || b.fork) throw new Error(message('seat_merge: 分身座位不能合并', 'seat_merge: fork seats cannot be merged'));
  if (a.role !== b.role) throw new Error(message(`seat_merge: 两个专家必须同岗位才能合并（${a.role} vs ${b.role}）`, `seat_merge: experts must share the same role (${a.role} vs ${b.role})`));
  if (a.state === 'closed') throw new Error(message(`seat_merge: ${from} 已经归档，不能再并入别人`, `seat_merge: ${from} is already archived and cannot be merged`));
  if (b.state === 'closed') throw new Error(message(`seat_merge: ${into} 已经归档，不能接收合并`, `seat_merge: ${into} is already archived and cannot receive a merge`));

  const written = await dispatchHandoffRun({
    role: a.role,
    seat: a.id,
    prompt: `（服务消息，不是新任务）写交接：把你到目前为止弄懂的、没做完的、踩过的坑，连同原始记录路径写成交接，四节标题依次是 ${handoffTitles()}。`,
  });
  if (!written.ok) {
    store.recordEvent({ seat: a.id, kind: 'merge', body: message(`并入 ${b.id} 失败：${written.error}。A 没有归档。`, `Merge into ${b.id} failed: ${written.error}. Source seat left active.`) });
    throw new Error(message(`seat_merge: ${from} 写交接的那一单没有正常结束（${written.error}），A 保持原样没有归档。`, `seat_merge: hand-off run for ${from} failed (${written.error}); ${from} left unchanged and active.`));
  }
  const file = path.join(store.handoffDir(b.id), `${handoffStamp()}.md`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${written.body}\n`, 'utf8');
  store.closeSeat({ seat: a.id, reason: message(`并入 ${b.id}`, `Merged into ${b.id}`) });
  store.setPendingHandoff({ seat: b.id, file, from: a.id });
  noteHandoffShape({ seat: b.id, file, body: written.body });
  const row = name ? store.renameSeat({ seat: b.id, name }) : b;
  return { from: a.id, into: b.id, file, seat: row.id, name: row.name ?? null };
}

// L-3 (2026-10-11): split one expert into several. For each part a focused hand-off is written from
// the original session, a fresh expert is opened for the part (with its topic/cwd), its first task will
// carry that hand-off, and the original is archived ("拆为 X、Y").
async function splitSeats({ seat, parts }) {
  const original = store.seatById(seat);
  if (!original) throw new Error(message(`seat_split: 找不到座位 ${seat}`, `seat_split: seat not found: ${seat}`));
  if (original.fork) throw new Error(message('seat_split: 分身座位不能拆分', 'seat_split: fork seats cannot be split'));
  if (original.state === 'closed') throw new Error(message(`seat_split: ${seat} 已经归档`, `seat_split: ${seat} is already archived`));
  if (!Array.isArray(parts) || parts.length < 2) throw new Error(message('seat_split: parts 至少要两个，每个是 { name, topic?, cwd? }', 'seat_split: parts must have at least two entries of { name, topic?, cwd? }'));
  const names = [];
  const created = [];
  for (const part of parts) {
    if (!part || typeof part.name !== 'string' || !part.name.trim()) {
      throw new Error(message('seat_split: 每个 part 都要有非空的 name', 'seat_split: every part must include a non-empty name'));
    }
    names.push(part.name.trim());
    const written = await dispatchHandoffRun({
      role: original.role,
      seat: original.id,
      prompt: `（服务消息，不是新任务）写交接：只写关于「${part.name.trim()}」${part.topic ? `（主题：${part.topic}）` : ''} 的那一部分交接，四节标题依次是 ${handoffTitles()}。`,
    });
    if (!written.ok) {
      store.recordEvent({ seat: original.id, kind: 'split', body: message(`拆分失败：给「${part.name.trim()}」写交接的单没正常结束（${written.error}）。`, `Split failed: hand-off run for "${part.name.trim()}" did not finish cleanly (${written.error}).`) });
      throw new Error(message(`seat_split: 给「${part.name.trim()}」写交接的单没有正常结束（${written.error}），拆分中止。`, `seat_split: hand-off run for "${part.name.trim()}" failed (${written.error}); split aborted.`));
    }
    // The part's object is the original's directory + its topic, unless the caller names a different cwd.
    const cwd = part.cwd ? resolveSeatCwd(part.cwd).cwd : original.cwd ?? null;
    const opened = store.openSeat({ role: original.role, name: part.name.trim(), topic: part.topic ?? null, cwd, owner: original.owner });
    // openSeat leaves the seat at 'open' (about to run, which claimNamedSeat treats as busy). A split part
    // waits idle for its first task, not running now, so put it in the idle 'done' state.
    store.setSeatState({ seat: opened.seat, state: 'done' });
    const file = path.join(store.handoffDir(opened.seat), `${handoffStamp()}.md`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${written.body}\n`, 'utf8');
    store.setPendingHandoff({ seat: opened.seat, file, from: original.id });
    noteHandoffShape({ seat: opened.seat, file, body: written.body });
    created.push({ seat: opened.seat, name: part.name.trim(), topic: opened.topic ?? null });
  }
  store.closeSeat({ seat: original.id, reason: message(`拆为 ${names.join('、')}`, `Split into ${names.join(', ')}`) });
  return { seat: original.id, parts: created };
}

// C-1 (2026-10-11): after a run ends, look at its expert's session. Two nodes, each fires at most once:
// the session's text first passing 60000 characters, or first passing half the backend context. Each
// fires one hand-off run (owner 'handoff', its own concurrency slot). The node event is recorded before
// the run is dispatched, so the hand-off run's own ending does not re-trigger it.
function maybeWriteHandoff(result) {
  if (!result?.seat || result.state !== 'done') return;
  const row = store.seatById(result.seat);
  if (!row || row.state === 'closed' || row.fork) return;
  if (!row.session_file) return;
  const pressure = sessionPressure(row.session_file);
  if (pressure.chars > HANDOFF_NODE_LARGE_CHARS && !store.handoffNodeDone({ seat: row.id, node: 'large-60k' })) {
    store.recordEvent({ seat: row.id, kind: 'handoff', body: 'large-60k' });
    try { admit({ role: row.role, seat: row.id, owner: 'handoff', task: `（服务消息，不是新任务）写交接：会话已经很长，把它写成交接文档，四节标题依次是 ${handoffTitles()}。` }); }
    catch (err) { lifeLog(`active hand-off large-60k (${row.id}): ${err.message}`); }
    return;
  }
  if (pressure.overHalf && !store.handoffNodeDone({ seat: row.id, node: 'half-context' })) {
    store.recordEvent({ seat: row.id, kind: 'handoff', body: 'half-context' });
    try { admit({ role: row.role, seat: row.id, owner: 'handoff', task: `（服务消息，不是新任务）写交接：会话快到这个后端的上下文上限了，把它写成交接文档，四节标题依次是 ${handoffTitles()}。` }); }
    catch (err) { lifeLog(`active hand-off half-context (${row.id}): ${err.message}`); }
  }
}

// Background posts nobody talks to (the librarian that keeps Hwiki's AI area tidy) run on a timer
// held by the daemon itself. The daemon already lives from logon to shutdown, so no second scheduler
// is needed, and "is it due" is read off the ledger: a machine that was off for a day simply finds
// the post overdue at the first tick after logon. What runs where is machine-local — directories
// differ per machine — so it lives in .schedules.json (not tracked), a list of
// { role, cwd, every_hours, task? }. A schedule whose post is already at work there is skipped.
const SCHEDULE_FILE = path.join(ROOT, '.schedules.json');
// The tick is a minute; SPECIALIST_SUBAGENTS_SCHEDULE_TICK_MS shortens it so a test does not wait that
// long for a schedule to fire. Anything that is not a positive number keeps the default.
const DEFAULT_TICK_MS = 60 * 1000;
const SCHEDULE_TICK_MS = (() => {
  const ms = Number(process.env.SPECIALIST_SUBAGENTS_SCHEDULE_TICK_MS);
  return Number.isFinite(ms) && ms > 0 ? ms : DEFAULT_TICK_MS;
})();

function runSchedules() {
  let list = [];
  try {
    list = JSON.parse(fs.readFileSync(SCHEDULE_FILE, 'utf8'));
  } catch {
    return; // no schedule file, or not JSON: nothing is scheduled on this machine
  }
  for (const entry of Array.isArray(list) ? list : []) {
    const hours = Number(entry?.every_hours);
    if (!entry?.role || typeof entry.cwd !== 'string' || !(hours > 0) || !fs.existsSync(entry.cwd)) continue;
    try {
      if (store.runningIn({ role: entry.role, cwd: entry.cwd })) continue;
      const last = store.lastStartedIn({ role: entry.role, cwd: entry.cwd });
      if (last && Date.now() - Date.parse(last) < hours * 3600 * 1000) continue;
      admit({ role: entry.role, cwd: entry.cwd, task: entry.task || '例行整理', owner: 'schedule' });
    } catch (err) {
      console.error(`specialist-subagents daemon: schedule ${entry.role} @ ${entry.cwd} not started: ${err.message}`);
    }
  }
}

// admit() comes back with no seat when openSeat refused the role (unknown role): nothing was
// spawned, so the refusal is this request's error to report.
async function withSeat(started) {
  if (started.seat) return started;
  throw await started.pending.then(
    () => new Error('seat was not opened'),
    (err) => err
  );
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1024 * 1024) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) return resolve({});
      if (String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase() !== 'application/json') {
        const err = new Error('content-type must be application/json');
        err.status = 415;
        return reject(err);
      }
      try {
        const parsed = JSON.parse(text);
        resolve(parsed && typeof parsed === 'object' ? parsed : {});
      } catch (err) {
        reject(new Error(`invalid JSON body: ${err.message}`));
      }
    });
    req.on('error', reject);
  });
}

function openSeatReply(input) {
  const opened = store.openSeat({ role: input.role, owner: input.owner ?? null, parent: input.parent ?? null });
  return {
    seat: opened.seat,
    instance: opened.instance,
    role: opened.role,
    contract: opened.spec.contract,
    spawn: opened.spec.spawn,
  };
}

// Each seat's state and last update, which is all a wait compares. It used to build the full row of
// every seat (one extra query each) five times a second per waiter; the wall now keeps a wait open
// all the time, so only the seat a wait answers with is read in full (store.seatById).
function seatStamp() {
  return store.seatStamps();
}

// /events/wait requests still polling; /health reports it so a pile-up of abandoned waits is visible.
let watchers = 0;

// Long polling, not blocking: this waits on a timer and re-reads the ledger between ticks. A
// synchronous wait here would hold the event loop and stall /health (and every other caller) for
// as long as the wait lasts — the daemon has no request timeout, so that would be minutes.
// `signal` ends the wait when the client has hung up: without it an abandoned wait kept re-reading
// the whole ledger five times a second until its deadline, up to ten minutes, and a watcher that
// reconnects after its own client-side timeout piled up one such loop per reconnect (2026-09-30).
// `seat` narrows the wait to one seat's events and state (task_wait waits on one run, and every
// other seat's output lines would otherwise wake it).
async function waitForChange({ since, timeoutMs, signal = null, seat = null }) {
  const stamps = () => {
    const all = seatStamp();
    if (seat === null) return all;
    return new Map(all.has(seat) ? [[seat, all.get(seat)]] : []);
  };
  const before = stamps();
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (signal?.aborted) return { changed: false, event: null, seat: null };
    const events = store.eventsSince(since, seat);
    if (events.length) {
      const event = events[0];
      return { changed: true, event, seat: store.seatById(event.seat) };
    }
    // A state change that carries no event of its own (a seat that just started running, a seat
    // opened or closed by hand) still counts as movement.
    for (const [id, stamp] of stamps()) {
      if (before.get(id) !== stamp) return { changed: true, event: null, seat: store.seatById(id) };
    }
    if (Date.now() >= deadline) return { changed: false, event: null, seat: null };
    await new Promise((resolve) => {
      const timer = setTimeout(done, WAIT_POLL_MS);
      function done() {
        clearTimeout(timer);
        signal?.removeEventListener('abort', done);
        resolve();
      }
      signal?.addEventListener('abort', done, { once: true });
    });
  }
}


export async function route(req, res) {
  if (req.headers.host) {
    const host = req.headers.host.toLowerCase().replace(/:\d+$/, '');
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) return send(res, 403, { error: 'forbidden host' });
  }
  const url = new URL(req.url, 'http://127.0.0.1');
  const routePath = url.pathname;
  const requestedLang = url.searchParams.get('lang') ?? (typeof req.headers['x-specialist-lang'] === 'string' ? req.headers['x-specialist-lang'] : null);
  const lang = requestedLang === null ? language() : requestedLang === 'zh' ? 'zh' : 'en';
  const method = req.method ?? 'GET';
  const token = process.env.SPECIALIST_SUBAGENTS_TOKEN?.trim();
  if (token && !(method === 'GET' && routePath === '/health') && req.headers.authorization !== `Bearer ${token}`) {
    return send(res, 401, { error: 'unauthorized' });
  }
  if (method !== 'GET' && method !== 'HEAD') {
    const site = req.headers['sec-fetch-site'];
    if (site !== undefined && !['same-origin', 'none'].includes(String(site).trim().toLowerCase())) {
      return send(res, 403, { error: 'cross-site request forbidden' });
    }
    const localPort = req.socket?.localPort || Number(process.env.SPECIALIST_SUBAGENTS_PORT) || DEFAULT_PORT;
    if (req.headers.origin !== undefined && ![`http://127.0.0.1:${localPort}`, `http://localhost:${localPort}`].includes(req.headers.origin)) {
      return send(res, 403, { error: 'cross-origin request forbidden' });
    }
  }

  // Role portraits and other static art, served from assets/. Read-only, and confined to that
  // directory: the request path is resolved and then checked to still be inside it, so a `..` in the
  // URL cannot walk out of the project.
  if (method === 'GET' && routePath.startsWith('/assets/')) {
    const assetsDir = path.join(ROOT, 'assets');
    const wanted = path.resolve(assetsDir, decodeURIComponent(routePath.slice('/assets/'.length)));
    if (!wanted.startsWith(assetsDir + path.sep) || !fs.existsSync(wanted) || !fs.statSync(wanted).isFile()) {
      return send(res, 404, { error: 'asset not found' });
    }
    const ext = path.extname(wanted).toLowerCase();
    const type = ext === '.png' ? 'image/png'
      : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
        : ext === '.webp' ? 'image/webp'
          : ext === '.svg' ? 'image/svg+xml'
            : 'application/octet-stream';
    // A file that vanishes or is locked between the check above and the open (EBUSY from an editor or
    // antivirus on Windows) emits 'error' on the stream; with no listener that is an uncaughtException,
    // and the daemon's handler for those exits the process. So the 200 is only sent once the file is
    // open, and an error answers 404/500 (or, if the body was already going out, cuts that response).
    const stream = fs.createReadStream(wanted);
    stream.on('error', (err) => {
      if (res.headersSent) return res.destroy();
      send(res, err.code === 'ENOENT' ? 404 : 500, { error: err.code === 'ENOENT' ? 'asset not found' : `asset could not be read: ${err.code ?? err.message}` });
    });
    stream.once('open', () => {
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache' });
      res.on('close', () => stream.destroy());
      stream.pipe(res);
    });
    return;
  }
  if (method === 'GET' && routePath === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(renderMonitorHtml(lang));
    return;
  }
  // The daemon owns its own pid and is the only thing that can say truthfully what to stop: the pid
  // in .data/daemon.json is written at boot and goes stale the moment the daemon is started by a path
  // that does not rewrite it — which is how `stop` came to report "kill ESRCH" while the service kept
  // running (2026-09-19). /health answers with the live pid, and /shutdown below is the way out.
  if (method === 'GET' && routePath === '/health') {
    // `ok` stays the daemon's own liveness (the CLI and the watchdog only read the HTTP status); a
    // misplaced HSkills is reported beside it, in `hskills`, with the sentence that says how to fix it.
    const hskills = skillLoop.skillLibraryCheck(lang);
    return send(res, 200, {
      ok: true, pid: process.pid, db: store.dbFile(), seats: { open: store.listSeats({ state: 'open' }).length }, watchers,
      hskills: { ok: hskills.ok, configured: hskills.configured, root: hskills.root, dir: hskills.dir, source: hskills.source, error: hskills.error ?? null, brief: hskills.brief ?? null },
    });
  }
  // Leaving through a door rather than by signal: a hard kill writes nothing to the life log, and the
  // whole point of the log is that a disappearance can be read afterwards.
  if (method === 'POST' && routePath === '/shutdown') {
    send(res, 200, { ok: true, pid: process.pid, stopping: true });
    lifeLog('shutdown requested over HTTP');
    setImmediate(() => {
      serverRef?.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 1000).unref();
    });
    return;
  }
  if (method === 'GET' && routePath === '/roles') {
    const roles = store.listRoles();
    const settings = loadSettings(ROOT, roleNames());
    const choice = readChoice(ROOT);
    const health = readBackendHealth(ROOT);
    return send(res, 200, roles.map((role) => {
      const network = Boolean(role.grant?.includes('web') || role.spawn?.args?.includes('--network'));
      const plan = planFor(role.id, settings, choice, { network, backends: role.backends ?? null, health });
      const first = plan.chain[0] ?? null;
      return {
        ...role,
        route: {
          primary: first ? `${first.kind}:${first.model}${first.effort ? `@${first.effort}` : ''}` : null,
          chain: plan.chain.map((step) => step.kind),
          notes: plan.notes,
        },
      };
    }));
  }
  // The wall's buttons: "best", or one backend first, with the bolt (max) on or off (presets.mjs).
  if (method === 'GET' && routePath === '/backend') {
    return send(res, 200, readChoice(ROOT));
  }
  if (method === 'GET' && routePath === '/backend/health') {
    const settings = loadSettings(ROOT, roleNames());
    const choice = readChoice(ROOT);
    const health = readBackendHealth(ROOT);
    return send(res, 200, { choice, health, summary: summarizeBackendHealth(settings, choice, health, Date.now(), lang) });
  }
  if (method === 'POST' && routePath === '/backend') {
    const checked = checkChoice(await readBody(req), lang);
    if (checked.error) return send(res, 400, { error: checked.error });
    writeChoice(ROOT, checked.value);
    return send(res, 200, checked.value);
  }
  // The settings page: each backend's model and effort per level, each role's own pick under "best".
  if (method === 'GET' && routePath === '/settings') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(renderSettingsHtml(lang));
    return;
  }
  if (method === 'GET' && routePath === '/presets') {
    return send(res, 200, presetsView(loadSettings(ROOT, roleNames()), lang));
  }
  if (method === 'POST' && routePath === '/presets') {
    const checked = checkSettings(await readBody(req), roleNames(), lang);
    if (checked.error) return send(res, 400, { error: checked.error });
    saveSettings(ROOT, checked.value);
    return send(res, 200, presetsView(checked.value, lang));
  }
  if (method === 'GET' && routePath === '/models') {
    return send(res, 200, await listModels({ fresh: url.searchParams.get('fresh') === '1', lang }));
  }
  // Reading the ledger reconciles liveness first: a seat whose runtime died (for instance because
  // the daemon that spawned it was restarted and never saw the child exit) would otherwise be
  // reported as running forever.
  if (method === 'GET' && routePath === '/seats') {
    store.reconcileRunning();
    const state = url.searchParams.get('state') ?? undefined;
    // ?view=compact is the short row per seat that seat_list shows a model (and the wall can poll):
    // living directory experts only unless `state` asks otherwise, `cwd` for one directory, `domain`
    // for one field of knowledge, `role` for one role's experts. Without `view` this answers with the
    // full rows exactly as before.
    const view = url.searchParams.get('view');
    if (view === 'compact') {
      const rows = store.listSeatsCompact({ state: state || null, cwd: url.searchParams.get('cwd') || null, domain: url.searchParams.get('domain') || null, role: url.searchParams.get('role') || null }, lang);
      // L-4 (2026-10-11): the roster line flags experts whose session has grown too long to keep as one.
      for (const row of rows) {
        try { row.suggest_split = sessionPressure(row.session_file).suggest; } catch { row.suggest_split = false; }
      }
      return send(res, 200, rows);
    }
    if (view !== null && view !== '' && view !== 'full') {
      throw new Error(message(
        `view 只能是 compact（每个座位一行短的）或不填（完整的行），收到的是「${view}」`,
        `view must be "compact" (one short line per seat) or omitted (full rows), got ${JSON.stringify(view)}`,
        lang,
      ));
    }
    return send(res, 200, store.listSeats({ state }));
  }
  // The role wall's one reply (store.wallView): each role's card, runs in flight and recently ended,
  // difficulty classes. The page reads it again only when /events/wait says the ledger moved.
  if (method === 'GET' && routePath === '/wall') {
    store.reconcileRunning();
    const rawRecent = url.searchParams.get('recent');
    const recent = rawRecent === null || rawRecent === '' ? store.WALL_RECENT_RUNS : Number(rawRecent);
    if (!Number.isInteger(recent) || recent < 1 || recent > 100) {
      throw new Error(message(
        `recent 要填 1 到 100 的整数（列出最近结束的几单），收到的是「${rawRecent}」`,
        `recent must be an integer between 1 and 100, got ${JSON.stringify(rawRecent)}`,
        lang,
      ));
    }
    // ?role= adds that role's seats (`instances`): the log panel's instance buttons when a card is open.
    // `hskills` is the header's error line while HSkills' skills directory is missing (skill-loop.mjs).
    const hskills = skillLoop.skillLibraryCheck(lang);
    const view = store.wallView({ recent, role: url.searchParams.get('role') || null, lang });
    if (lang === 'en') for (const role of view.roles) role.title = role.role;
    return send(res, 200, {
      ...view,
      hskills: { ok: hskills.ok, configured: hskills.configured, error: hskills.error ?? null, brief: hskills.brief ?? null },
    });
  }
  // H-4 (2026-10-11): the pool in one line of words, for a host that can put a line into every turn of
  // its lead. Which roles have runs in flight, and which still hold experts that were never retired.
  // It is a snapshot of the ledger and nothing else: it never waits, never blocks, and a host that
  // cannot read the service says 池：未知 from its own side (bin/specialist-subagents.mjs pool).
  if (method === 'GET' && routePath === '/pool') {
    store.reconcileRunning();
    return send(res, 200, { text: poolText(lang) });
  }
  // One run as the lead needs it (task_result, task_wait, seat_show's default view): how it ended,
  // usage, verdict, what it left undone and its final report within `budget` characters.
  if (method === 'GET' && routePath === '/run') {
    store.reconcileRunning();
    const rawBudget = url.searchParams.get('budget');
    const budget = rawBudget === null || rawBudget === '' ? store.REPORT_BUDGET_DEFAULT : Number(rawBudget);
    if (!Number.isFinite(budget) || budget < 1) {
      throw new Error(message(
        `budget 要填正整数（报告最多返回多少字），收到的是「${rawBudget}」`,
        `budget must be a positive number of characters, got ${JSON.stringify(rawBudget)}`,
        lang,
      ));
    }
    return send(res, 200, store.runSummary({
      seat: url.searchParams.get('seat') || null,
      run: url.searchParams.get('run') || null,
      budget,
    }, lang));
  }
  if (method === 'GET' && routePath.startsWith('/seats/')) {
    store.reconcileRunning();
    let id;
    try {
      id = decodeURIComponent(routePath.slice('/seats/'.length));
    } catch {
      return send(res, 400, { error: 'invalid seat id encoding' });
    }
    // Events are bounded by default (store.SEAT_EVENTS_DEFAULT). ?tail=N asks for the newest N, ?tail=all
    // for every event, ?run=<seq of the run's task event> for one run's events only.
    const rawTail = url.searchParams.get('tail');
    let tail = store.SEAT_EVENTS_DEFAULT;
    if (rawTail !== null && rawTail !== '') {
      tail = rawTail === 'all' ? Infinity : Number(rawTail);
      if (!(tail >= 0)) {
        throw new Error(message(
          `tail 要填条数（0 或正整数）或 all，收到的是「${rawTail}」`,
          `tail must be a non-negative number of events or "all", got ${JSON.stringify(rawTail)}`,
          lang,
        ));
      }
    }
    const rawRun = url.searchParams.get('run');
    let run = null;
    if (rawRun !== null && rawRun !== '') {
      run = Number(rawRun);
      if (!Number.isInteger(run) || run < 1) {
        throw new Error(message(
          `run 要填某次运行的 task 事件的 seq（正整数），收到的是「${rawRun}」`,
          `run must be a positive integer task event seq, got ${JSON.stringify(rawRun)}`,
          lang,
        ));
      }
    }
    const found = store.showSeat(id, { tail, run }, lang);
    if (!found) return send(res, 404, { error: `unknown seat: ${id}` });
    return send(res, 200, found);
  }
  if (method === 'POST' && routePath === '/seat/open') {
    return send(res, 200, openSeatReply(await readBody(req)));
  }
  if (method === 'POST' && routePath === '/seat/bind') {
    const input = await readBody(req);
    const seat = store.bindSeat({ seat: input.seat, handle: input.handle ?? null, pid: input.pid ?? null });
    return send(res, 200, { ok: true, seat: seat.id, handle: seat.handle, pid: seat.pid, state: seat.state });
  }
  if (method === 'POST' && routePath === '/seat/close') {
    const input = await readBody(req);
    // A "running" row whose runtime is already gone is stale, not busy: settle it first so it can be closed.
    store.reconcileRunning();
    // Closing a running seat cancels it: the runtime's whole process tree is killed (exec.mjs). The
    // reply says which of the two happened, because the caller is a model that has to know whether
    // anything is still running.
    const { seat, killed, pid } = await closeSeatNow({ seat: input.seat, reason: input.reason ?? null });
    const note = killed
      ? message(
        `座位 ${seat.id} 正在跑：已结束它的进程树（pid ${pid}）并关闭了座位。这一单没有跑完，已经写进台账的输出都还在；未完成清单保持上次的样子。`,
        `Seat ${seat.id} was running: killed its process tree (pid ${pid}) and closed the seat. Partial ledger events remain; backlog stays as before.`,
        lang,
      )
      : pid !== null
        ? message(
          `座位 ${seat.id} 已关闭；关闭的瞬间它的进程（pid ${pid}）已经自己退出了，没有再杀什么。`,
          `Seat ${seat.id} closed; its process (pid ${pid}) had already exited just before close.`,
          lang,
        )
        : message(
          `座位 ${seat.id} 没有在跑，只改了台账里的记录，没有结束任何进程。`,
          `Seat ${seat.id} was not running; updated the ledger record without killing any process.`,
          lang,
        );
    return send(res, 200, { ok: true, seat: seat.id, state: seat.state, closed_at: seat.closed_at, killed, pid, note });
  }
  // Rename an expert (E-5). The seat id stays; the refusal's reason (empty, too long, a living
  // expert already has the name, the seat is archived) goes back as a 400 in words.
  if (method === 'POST' && routePath === '/seat/rename') {
    const input = await readBody(req);
    if (!input.seat) throw new Error('seat/rename: seat is required');
    const before = store.seatById(input.seat)?.name ?? null;
    const row = store.renameSeat({ seat: input.seat, name: input.name }, lang);
    const note = before === row.name
      ? message(`座位 ${row.id} 本来就叫「${row.name}」，没有改动。`, `Seat ${row.id} is already named "${row.name}"; no change made.`, lang)
      : message(
        `座位 ${row.id} 已从「${before ?? '（没有名字）'}」改名为「${row.name}」；座位号不变，seat_list 和以后的 note 里都用新名字。`,
        `Seat ${row.id} renamed from "${before ?? '(unnamed)'}" to "${row.name}". Seat id is unchanged.`,
        lang,
      );
    return send(res, 200, { ok: true, seat: row.id, name: row.name, note });
  }
  // task_cancel (L-5, 2026-10-11): stop the run on a seat but keep the expert. The process tree is
  // killed, a 'cancelled' event records the reason, and the expert goes back to idle — not archived, its
  // half-written session stays its record, and its next task continues from that. A fork is retired.
  if (method === 'POST' && routePath === '/task/cancel') {
    const input = await readBody(req);
    if (!input.seat) throw new Error('task/cancel: seat is required');
    const { seat, killed, pid } = await cancelRunNow({ seat: input.seat, reason: input.reason ?? null });
    const note = killed
      ? message(
        `已取消座位 ${seat.id} 正在跑的这一单（进程树 pid ${pid} 已结束）。专家 ${seat.id} 回到空闲，没有归档；它写到一半的会话仍是它的记录，下一单接着用。`,
        `Cancelled the running task on seat ${seat.id} (killed process tree pid ${pid}). Expert ${seat.id} returned to idle without being archived; its partial session stays available for the next run.`,
        lang,
      )
      : message(
        `座位 ${seat.id} 没有在跑的单子，没有取消任何进程；它仍是空闲的专家。`,
        `Seat ${seat.id} had no running task; no process was killed and the expert remains idle.`,
        lang,
      );
    return send(res, 200, { ok: true, seat: seat.id, state: seat.state, killed, pid, note });
  }
  // seat_merge (L-1, 2026-10-11): continue A to write a hand-off, file it under B, archive A ("并入 B")
  // and mark B's next task to start with the hand-off once. Refused when A/B differ in role or one is
  // already archived; if A's hand-off run fails, A is left living and a 'merge' event records why.
  if (method === 'POST' && routePath === '/seat/merge') {
    const input = await readBody(req);
    if (!input.from || !input.into) throw new Error(message('seat/merge: from 和 into 都是必填的座位号', 'seat/merge: both from and into seat ids are required', lang));
    const result = await mergeSeats({ from: input.from, into: input.into, name: input.name ?? null });
    return send(res, 200, {
      ok: true, ...result,
      note: message(
        `已把 ${result.from} 并入 ${result.into}：交接写进 ${result.file}，它的下一单会带上这份交接（只附一次）；${result.from} 已归档（原因「并入 ${result.into}」）。`,
        `Merged ${result.from} into ${result.into}: hand-off written to ${result.file} (attached once to ${result.into}'s next run); ${result.from} is archived.`,
        lang,
      ),
    });
  }
  // seat_split (L-3, 2026-10-11): split one expert into several named parts, each with its own focused
  // hand-off and fresh expert; the original is archived ("拆为 X、Y").
  if (method === 'POST' && routePath === '/seat/split') {
    const input = await readBody(req);
    if (!input.seat) throw new Error(message('seat/split: seat 是必填的座位号', 'seat/split: seat is required', lang));
    const result = await splitSeats({ seat: input.seat, parts: input.parts ?? [] });
    return send(res, 200, {
      ok: true, ...result,
      note: message(
        `已把 ${result.seat} 拆成 ${result.parts.map((p) => `「${p.name}」（${p.seat}）`).join('、')}；${result.seat} 已归档。`,
        `Split ${result.seat} into ${result.parts.map((p) => `"${p.name}" (${p.seat})`).join(', ')}; ${result.seat} is archived.`,
        lang,
      ),
    });
  }
  if (method === 'POST' && routePath === '/seat/record') {
    const input = await readBody(req);
    // The kinds the service writes and later parses are not for callers: a hand-written task, exit,
    // usage or verdict event fabricates a run or overwrites a real one in cost_report (2026-09-30 review).
    if (store.RESERVED_EVENT_KINDS.includes(input.kind)) {
      throw new Error(message(
        `seat_record 不能写事件类型「${input.kind}」：${store.RESERVED_EVENT_KINDS.join('、')} 这几种由服务自己写入，成本报告、定时和座位墙会照着读，手写一条就会伪造运行或改掉真实记录。要记一条备注，用别的类型，比如 note；要记验收结论，用 seat_verdict。`,
        `seat_record cannot write reserved event kind "${input.kind}": ${store.RESERVED_EVENT_KINDS.join(', ')} are written by the service only. Use a custom kind such as "note", or use seat_verdict for verdicts.`,
        lang,
      ));
    }
    const event = store.recordEvent({ seat: input.seat, kind: input.kind, body: input.body ?? null });
    return send(res, 200, { ok: true, event });
  }
  if (method === 'POST' && routePath === '/seat/verdict') {
    const input = await readBody(req);
    if (!input.seat || !input.verdict) throw new Error('seat/verdict: seat and verdict are required');
    const event = store.recordSeatVerdict({ seat: input.seat, verdict: input.verdict, note: input.note ?? null, run: input.run ?? null }, lang);
    // A revised or rejected verdict is a difficulty too, and may be the one that fills a role's batch.
    if (input.verdict !== 'accepted') {
      const judged = store.seatById(input.seat);
      if (judged) skillLoopTick(judged.role);
    }
    const which = input.run === undefined || input.run === null || input.run === ''
      ? message('这一单', 'latest run', lang)
      : message(`运行 #${input.run}`, `run #${input.run}`, lang);
    const told = input.verdict === 'accepted'
      ? message(`已记下：${input.seat} ${which}直接采用。`, `Recorded: ${input.seat} (${which}) accepted.`, lang)
      : message(
        `已记下：${input.seat} ${which}${input.verdict === 'revised' ? '改过才能用' : '被退回'}，同时记进了困难账本，同类在 2 次以上运行里出现时会出现在 difficulty_report 里等裁决。`,
        `Recorded: ${input.seat} (${which}) ${input.verdict === 'revised' ? 'accepted with revisions' : 'rejected'}, and logged in the difficulty ledger.`,
        lang,
      );
    return send(res, 200, { ok: true, event, note: told });
  }
  // The seat's runtime is spawned here, inside the daemon: the caller may go away and the seat
  // keeps running, under the daemon's identity instead of the caller's. Dispatch never blocks:
  // the answer comes as soon as the seat exists, the run lands in the ledger on its own, and the
  // caller reads the result later through seat_show or a watcher on /events/wait. A blocking
  // dispatch route existed until 2026-09-19 and was deleted: any work, not only long work, has to
  // leave the caller free.
  if (method === 'POST' && routePath === '/seat/start') {
    const input = await readBody(req);
    if (!input.role) throw new Error('seat/start: role is required');
    if (typeof input.task !== 'string') throw new Error('seat/start: task is required');
    const caller = dispatchCaller(input.caller_seat, input);
    if (caller) {
      input.parent = caller.id;
      input.owner = input.owner || caller.name || caller.id;
    }
    const { seat, opened } = await withSeat(admit(input));
    // Said in words, because the caller is a model (E-3, 2026-10-11): which expert took the task (name
    // and seat id), how many times it has been here, and why it was chosen — named by the caller,
    // the same directory, the same field, newly opened, or a one-shot with no directory.
    const name = opened?.name ?? null;
    const who = name && name !== seat
      ? message(`「${name}」（${seat}）`, `"${name}" (${seat})`, lang)
      : message(`「${name ?? seat}」`, `"${name ?? seat}"`, lang);
    const visits = opened?.reused ? store.visits(seat, { before: opened.run ?? null }) : 0;
    const field = opened?.domain ? message(`「${opened.domain}」这个领域`, `domain "${opened.domain}"`, lang) : message('这个目录', 'this directory', lang);
    const here = opened?.domain ? field : message('这里', 'here', lang);
    const carry = message('会接着它已有的理解干活', 'will continue with its existing context', lang);
    let note;
    // The directory's other experts beside a newly opened topic expert (store.mjs claimSeat).
    const others = Array.isArray(opened?.others) && opened.others.length
      ? message(
        `；这个目录另有：${opened.others.map((o) => `「${o.name ?? o.seat}」（${o.seat}，主题：${o.topic ?? '（无）'}）`).join('、')}，topic 写错了就改派`,
        `; other experts in this directory: ${opened.others.map((o) => `"${o.name ?? o.seat}" (${o.seat}, topic: ${o.topic ?? '(none)'})`).join(', ')}`,
        lang,
      )
      : '';
    if (opened?.fork) {
      const expert = store.seatById(opened.expert);
      const expertName = expert?.name ?? opened.expert;
      const how = opened.named ? message('（按点名）', ' (named directly)', lang) : '';
      if (opened.fresh) {
        // 2026-10-24: fork "fresh", a second look without the expert's history.
        note = message(
          `交给了「${expertName}」的不带上下文的分身（${seat}）${how}：新会话，不带专家的会话、记录、交接和未完成清单，只凭现场判断；跑完记录归入专家，专家下一单仍续它自己的会话`,
          `Dispatched to a fresh-context fork of "${expertName}" (${seat})${how}: clean session with none of the expert’s history, records, hand-offs, or backlog; events file back under the expert while its own session stays untouched`,
          lang,
        );
      } else if (input.fork) {
        note = message(
          `交给了「${expertName}」的分身（${seat}）${how}：按要求开分身，带着专家的记录开工，跑完记录归回专家`,
          `Dispatched to a context fork of "${expertName}" (${seat})${how}: opened as requested with access to the expert’s records; events file back under the expert`,
          lang,
        );
      } else {
        // C-3: the expert is at work on another run, so this one went to a fork that starts from its records.
        note = message(
          `交给了「${expertName}」的分身（${seat}）：专家正在跑一单，分身带着它的记录并行开工，跑完记录归回专家${how}`,
          `Dispatched to a parallel fork of "${expertName}" (${seat})${how}: the expert is currently busy, so this fork started from its records and will file events back under it`,
          lang,
        );
      }
    } else if (opened?.named) {
      note = visits > 0
        ? message(`交给了${who}，按点名；它之前在${here}干过 ${visits} 单，${carry}`, `Dispatched to ${who} as named (${visits} prior run(s) in ${here}); ${carry}`, lang)
        : message(`交给了${who}，按点名；它在${here}还没有跑完过活，这一单是它的第一单`, `Dispatched to ${who} as named (first completed run in ${here})`, lang);
    } else if (opened?.reused) {
      note = message(
        `交给了${who}，按同一个${opened.domain ? '领域' : '目录'}；它之前来过 ${visits} 次，${carry}`,
        `Dispatched to ${who} for the same ${opened.domain ? 'domain' : 'directory'} (${visits} prior visit(s)); ${carry}`,
        lang,
      );
    } else if (opened?.domain) {
      note = message(`交给了${who}，新开的专家：${field}它第一次来`, `Dispatched to new expert ${who} (first visit to ${field})`, lang);
    } else if (input.cwd) {
      note = opened?.topic
        ? message(`交给了${who}，新开的专家：主题「${opened.topic}」在这个目录还没有专家${others}`, `Dispatched to new expert ${who} for topic "${opened.topic}" in this directory${others}`, lang)
        : message(`交给了${who}，新开的专家：${field}它第一次来`, `Dispatched to new expert ${who} (first visit to ${field})`, lang);
    } else {
      note = message(
        `交给了${who}，一次性的；没有给 cwd，它在服务的临时目录里干活，不会留下目录专家`,
        `Dispatched to one-shot seat ${who} (no cwd given; runs in a temporary service directory with no persistent expert)`,
        lang,
      );
    }
    // A fork asked for where the object has no expert yet: the new expert has no history to leave out.
    if (input.fork && !opened?.fork) {
      note += message(
        '（要的是分身，但这里还没有这个岗位的专家：新开的专家本来就不带任何记录）',
        ' (fork requested, but no existing expert existed yet, so a clean new expert was opened)',
        lang,
      );
    }
    return send(res, 200, { seat, run: opened?.run ?? null, name: opened?.name ?? null, reused: Boolean(opened?.reused), ...(opened?.fork ? { fork: true, expert: opened.expert, ...(opened.fresh ? { fresh: true } : {}) } : {}), state: 'running', note });
  }
  if (method === 'POST' && routePath === '/memory/write') {
    const input = await readBody(req);
    const memory = store.memoryWrite({
      role: input.role,
      kind: input.kind,
      body: input.body,
      source: input.source ?? null,
    });
    return send(res, 200, { ok: true, memory });
  }
  if (method === 'GET' && routePath === '/memory/read') {
    const role = url.searchParams.get('role');
    if (!role) throw new Error('memory/read: role is required');
    const rawLimit = url.searchParams.get('limit');
    const limit = rawLimit === null || rawLimit === '' ? 20 : Number(rawLimit);
    // LIMIT wants a whole number: 2.5 used to reach SQLite and come back as "datatype mismatch", so a
    // fraction is rounded down here and anything below 1 is refused.
    if (!Number.isFinite(limit) || limit < 1) throw new Error(`memory/read: limit must be a number of at least 1, got ${rawLimit}. Leave it out for the default of 20.`);
    return send(res, 200, store.listMemories({ role, limit: Math.floor(limit) }));
  }
  // The difficulty ledger (FR-21): the report in words for the lead, a count for the wall, the
  // reminder line for dispatch replies, and the verdict the lead and「マスター」give a class.
  if (method === 'GET' && routePath === '/costs') {
    const since = url.searchParams.get('since') || null;
    return send(res, 200, { text: store.costReportText({ since }, lang) });
  }
  if (method === 'GET' && routePath === '/difficulties') {
    const classes = store.difficultyClasses(lang);
    return send(res, 200, {
      text: store.difficultyReportText(lang),
      due: classes.filter((g) => g.runs >= store.DIFFICULTY_REMIND_AT).length,
      open: classes.length,
      reminder: store.difficultyReminder(lang),
      classes,
    });
  }
  // The skill loop (skill-loop.mjs): candidate versions of a role's skill, written by the refiner when a
  // role has collected a batch of difficulties. Reading is plain text for the lead; deciding records the
  // lead's judgment of each difficulty and enables, rejects or defers the candidate. Only the enable
  // path writes into HSkills.
  // The fourth moment the loop is asked (2026-10-25): by hand, for one role. The same check as the other
  // three, so nothing is forced: a pending candidate, a running refiner, the wait after a failure or a
  // short batch still say no, and the reply says which. The other three only come with work on that role.
  if (method === 'POST' && routePath === '/skill-loop/refine') {
    const input = await readBody(req);
    const role = String(input.role ?? '').trim();
    if (!role) throw new Error('skill-loop/refine: role is required');
    const result = await skillLoop.maybeRefine({ role, dispatch: refineDispatch, hasRoom: () => runningNow() < concurrencyLimit(), lang });
    const text = result.started
      ? message(`已给 ${role} 派 refiner：座位 ${result.seat}，交给它 ${result.difficulty_ids.length} 类困难。跑完会登记成候选版本，或记成「看过、不用改」；candidates 里看结果。`, `Refiner dispatched for ${role}: seat ${result.seat}, ${result.difficulty_ids.length} difficulty classes. Check candidates for the proposed version or a no-change decision.`, lang)
      : message(`没给 ${role} 派 refiner：${result.reason}。`, `No refiner dispatched for ${role}: ${result.reason}.`, lang);
    return send(res, 200, { ok: true, ...result, text });
  }
  if (method === 'GET' && routePath === '/candidates') {
    skillLoop.reconcileRuns();
    return send(res, 200, {
      text: skillLoop.candidatesText({ id: url.searchParams.get('id'), role: url.searchParams.get('role') || null, state: url.searchParams.get('state') || null }, lang),
      pending: store.listCandidates({ state: 'pending' }).length,
    });
  }
  if (method === 'POST' && routePath === '/candidates/decide') {
    const input = await readBody(req);
    if (input.id === undefined || input.id === null || input.id === '') throw new Error('candidates/decide: id is required');
    const candidate = store.getCandidate(input.id);
    const text = skillLoop.decideCandidate({ id: input.id, verdicts: input.verdicts ?? [], decision: input.decision ?? null, note: input.note ?? null, force: input.force === true }, lang);
    // A decision frees the role for its next batch: a pending candidate was what held it back. A defer
    // too: a deferred candidate does not hold the role (architecture 4.6), so a batch that filled while
    // it was pending starts now rather than at the role's next run (2026-10-01 review).
    if (candidate && input.decision) skillLoopTick(candidate.role);
    return send(res, 200, { ok: true, text });
  }
  // The one-sentence reminders the MCP shell attaches to a reply (once per client session each), and
  // `hskills`, the error it puts on every seat_start and seat_list reply while HSkills' skills
  // directory is missing (null while it is there).
  if (method === 'GET' && routePath === '/reminders') {
    return send(res, 200, { difficulty: store.difficultyReminder(lang), candidate: store.candidateReminder(lang), hskills: skillLoop.skillLibraryCheck(lang).error ?? null });
  }
  if (method === 'POST' && routePath === '/difficulties/decide') {
    const input = await readBody(req);
    if (!input.class || !input.decision) throw new Error('difficulties/decide: class and decision are required');
    store.decideDifficulty({ klass: input.class, decision: input.decision, note: input.note ?? null }, lang);
    return send(res, 200, {
      ok: true,
      note: message(
        `已记下「${input.class}」的裁决：${input.decision}。这一类之前的记录就此了结，之后再出现算新证据。`,
        `Recorded "${input.decision}" for "${input.class}". Prior occurrences are settled; recurrences count as fresh evidence.`,
        lang,
      ),
    });
  }
  // The wall's global log: every seat's events in one stream. `since` continues from a seq the page
  // already has; without it the newest `tail` events are the starting point.
  if (method === 'GET' && routePath === '/events') {
    const rawSince = url.searchParams.get('since');
    if (rawSince !== null && rawSince !== '' && Number.isFinite(Number(rawSince))) {
      return send(res, 200, store.eventsSince(Number(rawSince)).slice(0, 2000));
    }
    return send(res, 200, store.eventsTail(url.searchParams.get('tail')));
  }
  // Long poll for the DSH-side watcher: answer the moment the ledger moves, otherwise on timeout.
  if (method === 'GET' && routePath === '/events/wait') {
    const rawSince = url.searchParams.get('since');
    const since = rawSince === null || rawSince === '' || !Number.isFinite(Number(rawSince)) ? store.maxEventSeq() : Number(rawSince);
    const rawTimeout = url.searchParams.get('timeoutMs');
    const requested = rawTimeout === null || rawTimeout === '' ? NaN : Number(rawTimeout);
    const timeoutMs = Number.isFinite(requested) && requested >= 0 ? Math.min(requested, WAIT_MAX_MS) : WAIT_DEFAULT_MS;
    // Closing the response (not the request: a GET's request stream ends as soon as its headers are
    // read) before it was ended means the client went away; stop polling for it.
    const gone = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) gone.abort();
    });
    // ?seat= waits on that one seat only (task_wait); without it, on the whole ledger as before.
    const seat = url.searchParams.get('seat') || null;
    watchers += 1;
    let outcome;
    try {
      outcome = await waitForChange({ since, timeoutMs, signal: gone.signal, seat });
    } finally {
      watchers -= 1;
    }
    if (gone.signal.aborted) return;
    // The wall's header says whether HSkills' skills directory is there, which can change while the
    // ledger stands still: every wait answers with it, and the page re-reads /wall when it differs.
    return send(res, 200, { ...outcome, hskills_ok: skillLoop.skillLibraryCheck().ok });
  }
  return send(res, 404, { error: `no route: ${method} ${routePath}` });
}

// A seat may or may not die with the daemon that spawned it: inside a kill-on-close job object (the
// DSH host's) it does, but the watchdog starts the daemon outside any job, and Windows does not kill
// children when their parent exits (not reproduced yet, see README). The seat's real owner is the
// ledger, so going away must not touch seat states — marking every running seat interrupted on the
// way out erased seats that were in fact still running. Whether a seat is alive is a question about
// a pid, and only a starting daemon can answer it.

// Startup ledger check. A running seat whose runtime is still alive was started by the previous
// daemon, which is no longer there to collect its output or run settle(): this daemon adopts it
// (exec.mjs runPost with `adopt`), counts it against the concurrency cap and does the normal
// post-processing once the process is gone. On Windows the watchdog starts the daemon outside any job
// object, so runtimes do survive a restart there (2026-09-30). A running seat whose runtime is gone
// but which left a result file is adopted too, so its result is not lost; one with neither is
// interrupted. Without this the surviving seat used to be reported dead once it finished.
function reconcileRunningSeats() {
  const result = { adopted: 0, interrupted: 0 };
  for (const seat of store.listSeats({ state: 'running' })) {
    const finishedUnseen = fs.existsSync(path.join(DATA_DIR, 'run', seat.id, 'result.json'));
    if (pidAlive(seat.pid) || finishedUnseen) {
      adoptRun(seat);
      result.adopted += 1;
      continue;
    }
    store.recordEvent({ seat: seat.id, kind: 'interrupted', body: `daemon startup: pid ${seat.pid ?? 'none'} is gone` });
    store.setSeatState({ seat: seat.id, state: 'interrupted' });
    result.interrupted += 1;
  }
  return result;
}

function adoptRun(seat) {
  inFlight += 1;
  const pending = runPost({ adopt: { seat: seat.id } });
  track(pending);
  // An adoption that cannot even start (role gone from roles.json, say) must not leave the seat
  // 'running' with nobody watching it.
  pending.catch((err) => {
    try {
      store.recordEvent({ seat: seat.id, kind: 'interrupted', body: `daemon startup: could not adopt the seat (pid ${seat.pid ?? 'none'}): ${err.message}` });
      store.setSeatState({ seat: seat.id, state: 'interrupted' });
    } catch {
      // ledger trouble must not break startup
    }
  });
}

let exiting = false;
function shutdown() {
  if (exiting) return;
  exiting = true;
  try {
    store.close();
  } catch {
    // best effort on the way out
  }
}

export function startDaemon({ port = Number(process.env.SPECIALIST_SUBAGENTS_PORT) || DEFAULT_PORT } = {}) {
  // FR-15 / FR-16 gate (src/role-contract.mjs): every contract file has to exist and match the version
  // roles.json records (the sha256 check was removed 2026-09-29), and every role's declared boundary
  // (tier / grant / deny_intent) has to match the tool whitelist it actually runs with. This runs before the port is bound, so a
  // rejected start leaves nothing half-alive behind. It is a rejected promise rather than a throw so
  // that both entry points (this file run directly, and the CLI) report it through the error path
  // they already have.
  let contracts;
  try {
    contracts = assertRoleSpecs();
  } catch (err) {
    // The watchdog runs `start` with stdio ignored, so this rejection would otherwise vanish: the
    // MCP bridge tells the caller to read the tail of daemon.log, and this line is what it must find
    // there (2026-09-30: README promised .data/daemon-start.log, which nothing ever wrote).
    lifeLog(`refused to start: ${err.message}`);
    return Promise.reject(err);
  }
  // One line per role: "the start passed the gate, and here is what it vouched for" is evidence a
  // silent pass could not give.
  for (const line of contracts.ok) console.error(`specialist-subagents daemon: ${line}`);
  for (const warning of contracts.warnings) console.error(`specialist-subagents daemon: warning: ${warning}`);

  const server = http.createServer((req, res) => {
    route(req, res).catch((err) => {
      try {
        // A route may name its own status and payload (the concurrency refusal is a 429).
        send(res, err.status ?? 400, err.payload ?? { error: err.message });
      } catch {
        res.destroy();
      }
    });
  });

  // A seat runs as long as its runtime does: no HTTP timeout may cut a long task short.
  server.requestTimeout = 0;
  server.timeout = 0;

  return new Promise((resolve) => {
    // A daemon that cannot take its port says why and leaves: no half-started process behind.
    server.once('error', (err) => {
      const reason =
        err.code === 'EADDRINUSE'
          ? `port ${port} on 127.0.0.1 is already in use (another specialist-subagents daemon, or something else, holds it)`
          : `${err.code ?? 'listen error'}: ${err.message}`;
      console.error(`specialist-subagents daemon: ${reason}`);
      lifeLog(`refused to start: ${reason}`);
      process.exit(1);
    });
    server.listen(port, '127.0.0.1', () => {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(STATE_FILE, `${JSON.stringify({ port, pid: process.pid }, null, 2)}\n`);
      // The ledger is checked before the daemon answers anything: nobody should read a seat's
      // state off a daemon that has not yet told apart "runtime gone" from "runtime still here".
      try {
        const reconciled = reconcileRunningSeats();
        if (reconciled.adopted || reconciled.interrupted) {
          console.error(
            `specialist-subagents daemon: restart check -> ${reconciled.adopted} seat(s) adopted, ${reconciled.interrupted} marked interrupted`
          );
        }
      } catch (err) {
        console.error(`specialist-subagents daemon: restart check failed: ${err.message}`);
      }
      // A refiner this daemon's predecessor started may have ended while nobody was looking.
      try {
        skillLoop.reconcileRuns();
      } catch (err) {
        console.error(`specialist-subagents daemon: skill loop check failed: ${err.message}`);
      }
      setInterval(runSchedules, SCHEDULE_TICK_MS).unref();
      // Signals are handled once, in registerLifeLogHandlers: it writes the 'signal' line and then exits,
      // and this 'exit' listener closes the ledger on the way out. Until 2026-09-30 SIGINT and SIGTERM
      // also had a listener here that called process.exit(0) first, so the signal line was never written.
      process.on('exit', shutdown);
      serverRef = server;
      registerLifeLogHandlers();
      lifeLog(`born: pid=${process.pid} port=${port} parent=${process.ppid} cwd=${process.cwd()}`);
      // HSkills' skills directory: checked here, once a minute and on every reply that asks, so the
      // service log gets its 错误 line when the directory goes missing and its 恢复 line when it comes
      // back even while nobody dispatches. A check is one stat and one small file read.
      skillLoop.onSkillLibraryChange(lifeLog);
      skillLoop.skillLibraryCheck();
      setInterval(() => skillLoop.skillLibraryCheck(), DEFAULT_TICK_MS).unref();
      // One schedule tick right away, after the restart check above: a machine that was off finds its
      // overdue posts at startup, not up to a tick later.
      runSchedules();
      resolve({ server, port, pid: process.pid });
    });
  });
}

// Node resolves symlinks and junctions in the main module's URL but leaves process.argv[1] as typed, so
// comparing them bare made `node <junction>/src/daemon.mjs` start nothing and exit 0 (the same trap that
// made role-contract.mjs pass by not running, 2026-09-30 review). Both sides go through realpath.
function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return pathToFileURL(fs.realpathSync(fileURLToPath(import.meta.url))).href === pathToFileURL(fs.realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}
const isMain = isMainModule();
if (isMain) {
  startDaemon()
    .then(({ port, pid }) => {
      console.error(`specialist-subagents daemon listening on http://127.0.0.1:${port} (pid ${pid})`);
    })
    .catch((err) => {
      console.error(`specialist-subagents daemon failed to start: ${err.message}`);
      process.exit(1);
    });
}
