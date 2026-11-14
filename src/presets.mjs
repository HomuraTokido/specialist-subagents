// Which backend and model a seat runs on, decided per dispatch from two things:
//
//   the choice  (.data/backend-prefer.json, set by the wall's buttons): "best", or one backend
//               first, with or without the lightning bolt (max = the heavy level);
//   the settings (presets.json in the repository, overridden by .data/presets.json, which the
//               settings page writes): each backend's model and reasoning effort at the standard
//               and the heavy level, each role's own backend and level under "best", the roles
//               that stay standard even when the bolt is on, and the order backends fall through.
//
// planFor() turns them into the chain cli-runner walks: the chosen backend first, then the others in
// order, all at the same level. DeepSeek runs through pi and ends the chain wherever it stands.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export function language(env = process.env) {
  return /^zh/i.test(env.SPECIALIST_SUBAGENTS_LANG ?? '') ? 'zh' : 'en';
}

export function message(zh, en, lang = language()) {
  return lang === 'zh' ? zh : en;
}

// antigravity (2026-10-21) is Google's `agy`: Google AI Pro left Gemini CLI on 2026-06-18 and is served
// only through it. It sits before deepseek, which ends every chain.
export const KINDS = ['codex', 'grok', 'claude', 'antigravity', 'deepseek'];
export const KIND_NAMES = { codex: 'Codex', grok: 'Grok', claude: 'Claude', antigravity: 'Antigravity', deepseek: 'DeepSeek' };
export const LEVELS = ['standard', 'max'];
export const EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
// C-4 (2026-10-11): each model's context window, and when each backend compacts the session by default.
// The default is the latest the backend allows (doc/impl/compaction.md), because a compaction throws the
// session's detail away and the service would rather keep the whole of it for as long as it can:
//   codex     784800 tokens (0.9 of the 872000 window the run is then given, see codexCompactArgs)
//   claude    1000000 tokens (--autocompact's ceiling)
//   deepseek  16384 tokens of reserve: pi compacts when the context passes window - reserve, so a small
//             reserve is a late compaction. It is the only value here that is a reserve, not a threshold.
//   grok      100 (percent of the window; the others are token counts)
// antigravity has no entry: `agy` exposes no compaction setting (its flag list, 1.4.4), so there is
// nothing to pass; a value written for it is accepted and unused.
export const DEFAULT_CONTEXT_TOKENS = { codex: 272000, grok: 256000, claude: 1000000, antigravity: 1000000, deepseek: 1000000 };
export const DEFAULT_COMPACT = { codex: 784800, claude: 1000000, deepseek: 16384, grok: 100 };
const DEFAULT_CHOICE = { mode: 'best', max: false };

function dataDir(root) {
  return path.join(root, '.data');
}
export function choiceFile(root) {
  return path.join(dataDir(root), 'backend-prefer.json');
}
export function settingsFile(root) {
  return path.join(dataDir(root), 'presets.json');
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// ---- the choice ----------------------------------------------------------------------------------

export function checkChoice(input, lang = language()) {
  const copy = (zh, en) => message(zh, en, lang);
  const mode = input?.mode;
  if (mode !== 'best' && !KINDS.includes(mode)) {
    return { error: copy(`mode 只能是 best、${KINDS.join('、')} 之一，收到的是 ${JSON.stringify(mode ?? null)}。`, `mode must be best or one of ${KINDS.join(', ')}; got ${JSON.stringify(mode ?? null)}.`) };
  }
  if (input.max !== undefined && typeof input.max !== 'boolean') {
    return { error: copy(`max 只能是 true 或 false，收到的是 ${JSON.stringify(input.max)}。`, `max must be true or false; got ${JSON.stringify(input.max)}.`) };
  }
  // "Best" is each role's own setting; the bolt belongs to a backend, so it is off there.
  return { value: { mode, max: mode === 'best' ? false : Boolean(input.max) } };
}

// A file from before the presets ({ prefer: 'grok' }) still reads as that backend first, standard.
export function readChoice(root) {
  const saved = readJson(choiceFile(root));
  if (saved && KINDS.includes(saved.prefer) && saved.mode === undefined) return { mode: saved.prefer, max: false };
  const checked = checkChoice(saved ?? {});
  return checked.value ?? { ...DEFAULT_CHOICE };
}

export function writeChoice(root, choice) {
  fs.mkdirSync(dataDir(root), { recursive: true });
  fs.writeFileSync(choiceFile(root), `${JSON.stringify(choice)}\n`, 'utf8');
}

// ---- the settings --------------------------------------------------------------------------------

function checkLevel(value, where, lang = language()) {
  const copy = (zh, en) => message(zh, en, lang);
  if (!value || typeof value !== 'object') return copy(`${where} 缺了，要写成 { model, effort }`, `${where} is required and must be { model, effort }`);
  if (typeof value.model !== 'string' || !value.model.trim()) return copy(`${where}.model 要是非空的模型名`, `${where}.model must be a nonempty model name`);
  if (value.effort !== null && value.effort !== undefined && !EFFORTS.includes(value.effort)) {
    return copy(`${where}.effort 只能是 null 或 ${EFFORTS.join('、')} 之一，收到的是 ${JSON.stringify(value.effort)}`, `${where}.effort must be null or one of ${EFFORTS.join(', ')}; got ${JSON.stringify(value.effort)}`);
  }
  // context_tokens (C-4, L-4) is optional so a settings file from before it still checks: the model's
  // window is then the default above.
  if (value.context_tokens !== undefined && !(Number.isInteger(value.context_tokens) && value.context_tokens > 0)) {
    return copy(`${where}.context_tokens 要是正整数（模型的上下文窗口，token），收到的是 ${JSON.stringify(value.context_tokens)}`, `${where}.context_tokens must be a positive integer (model context window in tokens); got ${JSON.stringify(value.context_tokens)}`);
  }
  return null;
}

// A compaction setting: { codex?: n, claude?: n, deepseek?: n, grok?: pct, antigravity?: n (unused) }, from presets.json's `compact`
// or a role's `compact` in roles.json. Positive integers; Grok's is a percent, so 1 to 100. Returns the
// problem as a sentence, or null.
export function checkCompact(value, where, lang = language()) {
  const copy = (zh, en) => message(zh, en, lang);
  if (value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return copy(`${where} 要写成 { codex?, claude?, deepseek?, grok? } 这样的对象`, `${where} must be an object such as { codex?, claude?, deepseek?, grok? }`);
  for (const [kind, n] of Object.entries(value)) {
    if (!KINDS.includes(kind)) return copy(`${where}.${kind} 不是后端：只能写 ${KINDS.join('、')}`, `${where}.${kind} is not a backend; expected ${KINDS.join(', ')}`);
    if (!Number.isInteger(n) || n <= 0) return copy(`${where}.${kind} 要是正整数，收到的是 ${JSON.stringify(n)}`, `${where}.${kind} must be a positive integer; got ${JSON.stringify(n)}`);
    if (kind === 'grok' && n > 100) return copy(`${where}.grok 是窗口的百分比，要在 1 到 100 之间，收到的是 ${n}`, `${where}.grok is a window percentage between 1 and 100; got ${n}`);
  }
  return null;
}

// The compaction setting for one role on one backend: the role's own, else the settings' default.
export function compactFor(settings, roleSpec, kind) {
  return roleSpec?.compact?.[kind] ?? settings?.compact?.[kind] ?? DEFAULT_COMPACT[kind];
}

// Checks a whole settings object; roles is the list of role names roles.json defines.
export function checkSettings(input, roles, lang = language()) {
  const copy = (zh, en) => message(zh, en, lang);
  if (!input || typeof input !== 'object') return { error: copy('设置要是一个 JSON 对象', 'Settings must be a JSON object') };
  const order = input.order;
  if (!Array.isArray(order) || order.length !== KINDS.length || !KINDS.every((k) => order.includes(k))) {
    return { error: copy(`order 要把 ${KINDS.join('、')} 各列一次`, `order must list each of ${KINDS.join(', ')} exactly once`) };
  }
  const levels = {};
  for (const kind of KINDS) {
    levels[kind] = {};
    for (const level of LEVELS) {
      const problem = checkLevel(input.levels?.[kind]?.[level], `levels.${kind}.${level}`, lang);
      if (problem) return { error: problem };
      const { model, effort } = input.levels[kind][level];
      levels[kind][level] = { model: model.trim(), effort: effort ?? null, context_tokens: input.levels[kind][level].context_tokens ?? DEFAULT_CONTEXT_TOKENS[kind] };
    }
  }
  const best = {};
  for (const role of roles) {
    const entry = input.best?.[role];
    if (!entry) continue;
    if (!KINDS.includes(entry.kind)) return { error: copy(`best.${role}.kind 只能是 ${KINDS.join('、')} 之一，收到的是 ${JSON.stringify(entry.kind)}`, `best.${role}.kind must be one of ${KINDS.join(', ')}; got ${JSON.stringify(entry.kind)}`) };
    if (!LEVELS.includes(entry.level)) return { error: copy(`best.${role}.level 只能是 standard 或 max，收到的是 ${JSON.stringify(entry.level)}`, `best.${role}.level must be standard or max; got ${JSON.stringify(entry.level)}`) };
    best[role] = { kind: entry.kind, level: entry.level };
  }
  const compactProblem = checkCompact(input.compact, 'compact', lang);
  if (compactProblem) return { error: compactProblem };
  const compact = { ...DEFAULT_COMPACT, ...(input.compact ?? {}) };
  const stay = Array.isArray(input.stay_standard) ? input.stay_standard.filter((r) => roles.includes(r)) : [];
  return { value: { order: [...order], levels, best, compact, stay_standard: stay } };
}

// The repository's presets.json, with .data/presets.json laid over it when that one checks out.
// A saved file that no longer checks (a role renamed, a field missing) is ignored, not half-applied.
// A saved order from before a backend was added lacks it, and checkSettings wants every kind once, so
// the whole saved file would be dropped for one missing name. The missing kinds go in front of deepseek
// (which ends the chain), in KINDS order; an order that is not a list is left for checkSettings to refuse.
export function withAllKinds(order) {
  if (!Array.isArray(order)) return order;
  const missing = KINDS.filter((kind) => kind !== 'deepseek' && !order.includes(kind));
  if (!missing.length) return order;
  const at = order.includes('deepseek') ? order.indexOf('deepseek') : order.length;
  return [...order.slice(0, at), ...missing, ...order.slice(at)];
}

export function loadSettings(root, roles) {
  const base = checkSettings(readJson(path.join(root, 'presets.json')), roles);
  if (base.error) throw new Error(message(`presets.json 有问题：${base.error}`, `Invalid presets.json: ${base.error}`));
  const saved = readJson(settingsFile(root));
  if (!saved) return base.value;
  if (saved.order) saved.order = withAllKinds(saved.order);
  const merged = checkSettings({ ...base.value, ...saved, levels: { ...base.value.levels, ...(saved.levels ?? {}) } }, roles);
  return merged.value ?? base.value;
}

export function saveSettings(root, settings) {
  fs.mkdirSync(dataDir(root), { recursive: true });
  fs.writeFileSync(settingsFile(root), `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
}

// ---- the plan ------------------------------------------------------------------------------------

export const CODEX_FIVE_HOUR_HIGH = 85;
export const CODEX_WEEKLY_HIGH = 95;
const AUTH_OR_MISSING_RE = /disabled.*subscription|not logged in|login|api key|未安装|没有装|unauthorized|401|403/i;
const QUOTA_BLOCK_RE = /rate.?limit|quota|usage limit|额度|429|at capacity/i;

export function healthFile(root) {
  return path.join(dataDir(root), 'backend-health.json');
}

export function healthDbFile(root) {
  return path.join(dataDir(root), 'backend-health.sqlite');
}

function windowQuota(w, nowSec) {
  if (!w || typeof w.used_percent !== 'number') return { pct: 0, resetsAt: null };
  if (w.resets_at && w.resets_at <= nowSec) return { pct: 0, resetsAt: null };
  return { pct: w.used_percent, resetsAt: typeof w.resets_at === 'number' ? w.resets_at : null };
}

// Quota as one Codex rollout last saw it, in percent and reset timestamp. A window whose reset time
// has passed counts as empty, since the percent recorded before it is stale.
// The rollout is read from the tail, 256KB at a time and at most 2MB, so a long session does not
// pull the whole file into the process just to find the last rate_limits line.
const QUOTA_TAIL_CHUNK = 262144;
const QUOTA_TAIL_CHUNKS = 8;
const MAX_ROLLOUT_STATS = 20000;
const TOP_ROLLOUT_CANDIDATES = 10;
const quotaScanCache = new Map();

export function codexQuotaIn(file, nowSec = Date.now() / 1000) {
  let fd = null;
  try {
    const stat = fs.statSync(file);
    fd = fs.openSync(file, 'r');
    let pos = stat.size;
    let carry = '';
    let lineObj = null;
    let rl = null;
    for (let n = 0; n < QUOTA_TAIL_CHUNKS && pos > 0; n += 1) {
      const size = Math.min(QUOTA_TAIL_CHUNK, pos);
      pos -= size;
      const buf = Buffer.alloc(size);
      const nread = fs.readSync(fd, buf, 0, size, pos);
      let text = buf.subarray(0, nread).toString('utf8') + carry;
      carry = '';
      if (pos > 0) {
        const nl = text.indexOf('\n');
        if (nl === -1) {
          carry = text;
          continue;
        }
        // The chunk does not start on a line boundary: the leading fragment belongs to the
        // previous chunk's tail, and this chunk is scanned without it.
        carry = text.slice(0, nl);
        text = text.slice(nl + 1);
      }
      const lines = text.split('\n');
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        const line = lines[i];
        if (!line.includes('"rate_limits"')) continue;
        let parsed = null;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        const rate = parsed?.payload?.rate_limits;
        if (!rate?.primary || (rate.limit_id && rate.limit_id !== 'codex')) continue;
        lineObj = parsed;
        rl = rate;
        break;
      }
      if (rl) break;
    }
    if (!rl) return null;
    const ts = typeof lineObj?.timestamp === 'string' ? Date.parse(lineObj.timestamp) : NaN;
    const observedAtMs = Number.isFinite(ts) ? ts : null;
    const fh = windowQuota(rl.primary, nowSec);
    const wk = windowQuota(rl.secondary ?? null, nowSec);
    return {
      fiveHour: fh.pct,
      fiveHourResetsAt: fh.resetsAt,
      weekly: wk.pct,
      weeklyResetsAt: wk.resetsAt,
      observedAtMs,
    };
  } catch {
    // unreadable or half-written: no quota from this file
    return null;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* already closed */ }
    }
  }
}

function recordTopRollout(top, candidate) {
  if (top.length === TOP_ROLLOUT_CANDIDATES && candidate.mtimeMs <= top[top.length - 1].mtimeMs) {
    return;
  }
  let idx = top.findIndex((item) => candidate.mtimeMs > item.mtimeMs);
  if (idx === -1) idx = top.length;
  top.splice(idx, 0, candidate);
  if (top.length > TOP_ROLLOUT_CANDIDATES) top.pop();
}

function collectRecentRollouts(dir, state) {
  if (state.truncated) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    state.truncated = true;
    return;
  }
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
    if (state.scanned >= state.maxStats) {
      state.truncated = true;
      return;
    }
    const full = path.join(dir, e.name);
    try {
      const mtimeMs = fs.statSync(full).mtimeMs;
      state.scanned += 1;
      recordTopRollout(state.top, { full, mtimeMs });
    } catch {
      // ignore disappearing file
    }
  }
  const dirs = entries.filter((e) => e.isDirectory()).sort((a, b) => b.name.localeCompare(a.name));
  for (const d of dirs) {
    collectRecentRollouts(path.join(dir, d.name), state);
    if (state.truncated) return;
  }
}

export function readLatestCodexQuota({
  sessionsDir = null,
  nowSec = Date.now() / 1000,
  useCache = sessionsDir === null,
  maxStats = MAX_ROLLOUT_STATS,
} = {}) {
  const base = sessionsDir ?? path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions');
  const cacheable = useCache === true && maxStats === MAX_ROLLOUT_STATS && Math.abs(nowSec * 1000 - Date.now()) < 5000;
  if (cacheable) {
    const hit = quotaScanCache.get(base);
    if (hit && Date.now() - hit.at < 2000) return hit.value;
  }
  const finish = (value) => {
    if (cacheable) quotaScanCache.set(base, { at: Date.now(), value });
    return value;
  };
  try {
    if (!fs.existsSync(base)) return finish(null);
  } catch {
    return finish(null);
  }
  const limit = Number.isFinite(maxStats) && maxStats > 0 ? Math.floor(maxStats) : MAX_ROLLOUT_STATS;
  const state = { top: [], scanned: 0, maxStats: limit, truncated: false };
  collectRecentRollouts(base, state);
  if (state.truncated) return finish(null);
  for (const item of state.top) {
    const q = codexQuotaIn(item.full, nowSec);
    if (q) return finish(q);
  }
  return finish(null);
}

// SQLite serializes health updates; legacy JSON is only a fallback for unmigrated entries.
const HEALTH_BUSY_SLEEP = new Int32Array(new SharedArrayBuffer(4));

function isSqliteBusy(err) {
  const msg = String(err?.message || err || '');
  return /database is locked|SQLITE_BUSY/i.test(msg) || err?.errcode === 5;
}

function openHealthDb(root, { readonly = false } = {}) {
  if (readonly) {
    if (!fs.existsSync(healthDbFile(root))) return null;
    const db = new DatabaseSync(healthDbFile(root), { readOnly: true });
    try {
      db.exec('PRAGMA busy_timeout = 5000;');
      return db;
    } catch (err) {
      try { db.close(); } catch { /* preserve the opening error */ }
      throw err;
    }
  }
  fs.mkdirSync(dataDir(root), { recursive: true });
  const db = new DatabaseSync(healthDbFile(root));
  try {
    // busy_timeout MUST be set first before any WAL/schema statement touches the file lock.
    db.exec('PRAGMA busy_timeout = 5000;');
    const currentMode = String(db.prepare('PRAGMA journal_mode;').get()?.journal_mode || '').toLowerCase();
    if (currentMode !== 'wal') {
      db.exec('PRAGMA journal_mode = WAL;');
    }
    db.exec('PRAGMA synchronous = NORMAL; CREATE TABLE IF NOT EXISTS backend_health (kind TEXT PRIMARY KEY, entry_json TEXT NOT NULL);');
    return db;
  } catch (err) {
    try { db.close(); } catch { /* preserve the opening error */ }
    throw err;
  }
}

export function recordBackendOutcome(root, kind, { ok, reason = null, worked = false, refused = false, quota = null, nowMs = Date.now() } = {}) {
  if (!KINDS.includes(kind)) return { updated: false, reason: 'unknown_kind' };
  const maxAttempts = 8;
  let lastErr = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let db = null;
    let inTx = false;
    try {
      db = openHealthDb(root);
      db.exec('BEGIN IMMEDIATE');
      inTx = true;
      const row = db.prepare('SELECT entry_json FROM backend_health WHERE kind = ?').get(kind);
      const current = row ? JSON.parse(row.entry_json) : readJson(healthFile(root))?.[kind];
      const keptQuota = quota ?? current?.quota ?? null;
      let nextEntry;
      if (ok) {
        nextEntry = { ok: true, at: new Date(nowMs).toISOString(), ...(keptQuota ? { quota: keptQuota } : {}) };
      } else {
        const text = String(reason ?? '');
        const infra = !worked || QUOTA_BLOCK_RE.test(text) || AUTH_OR_MISSING_RE.test(text);
        if (refused || !infra) {
          if (!quota) {
            db.exec('COMMIT');
            inTx = false;
            return { updated: false, reason: 'ignored' };
          }
          nextEntry = { ...(current ?? { ok: true }), quota };
        } else {
          let until = nowMs + 5 * 60 * 1000;
          if (AUTH_OR_MISSING_RE.test(text)) {
            until = nowMs + 30 * 60 * 1000;
          } else if (QUOTA_BLOCK_RE.test(text)) {
            const fhUntil = keptQuota?.fiveHour >= 100 && keptQuota?.fiveHourResetsAt && keptQuota.fiveHourResetsAt * 1000 > nowMs ? keptQuota.fiveHourResetsAt * 1000 : 0;
            const wkUntil = keptQuota?.weekly >= 100 && keptQuota?.weeklyResetsAt && keptQuota.weeklyResetsAt * 1000 > nowMs ? keptQuota.weeklyResetsAt * 1000 : 0;
            until = Math.max(fhUntil, wkUntil) || (nowMs + 15 * 60 * 1000);
          }
          nextEntry = {
            ok: false,
            reason: text.replace(/\s+/g, ' ').trim().slice(0, 220),
            at: new Date(nowMs).toISOString(),
            until,
            ...(keptQuota ? { quota: keptQuota } : {}),
          };
        }
      }
      db.prepare('INSERT INTO backend_health (kind, entry_json) VALUES (?, ?) ON CONFLICT(kind) DO UPDATE SET entry_json = excluded.entry_json').run(kind, JSON.stringify(nextEntry));
      db.exec('COMMIT');
      inTx = false;
      return { updated: true };
    } catch (err) {
      lastErr = err;
      if (inTx) {
        try { db.exec('ROLLBACK'); } catch { /* preserve the update error */ }
      }
      if (attempt < maxAttempts && isSqliteBusy(err)) {
        Atomics.wait(HEALTH_BUSY_SLEEP, 0, 0, 15 * attempt);
        continue;
      }
      process.stderr.write(`[specialist-subagents] backend-health update failed (${kind}): ${err?.message || err}\n`);
      return { updated: false, error: String(err?.message || err) };
    } finally {
      if (db) { try { db.close(); } catch { /* already closed */ } }
    }
  }
  const msg = String(lastErr?.message || lastErr || 'busy');
  process.stderr.write(`[specialist-subagents] backend-health update failed (${kind}): ${msg}\n`);
  return { updated: false, error: msg };
}

function expireSavedQuota(quota, nowSec) {
  if (!quota || typeof quota !== 'object') return null;
  const fhExpired = Boolean(quota.fiveHourResetsAt && quota.fiveHourResetsAt <= nowSec);
  const wkExpired = Boolean(quota.weeklyResetsAt && quota.weeklyResetsAt <= nowSec);
  return {
    fiveHour: fhExpired ? 0 : (quota.fiveHour ?? 0),
    fiveHourResetsAt: fhExpired ? null : (quota.fiveHourResetsAt ?? null),
    weekly: wkExpired ? 0 : (quota.weekly ?? 0),
    weeklyResetsAt: wkExpired ? null : (quota.weeklyResetsAt ?? null),
  };
}

export function readBackendHealth(root, { sessionsDir = null, nowMs = Date.now() } = {}) {
  const saved = readJson(healthFile(root));
  const map = saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
  let db = null;
  try {
    if (fs.existsSync(healthDbFile(root))) {
      db = openHealthDb(root, { readonly: true });
      for (const row of db.prepare('SELECT kind, entry_json FROM backend_health').all()) {
        map[row.kind] = JSON.parse(row.entry_json);
      }
    }
  } catch {
    // Keep the legacy baseline if the health database cannot be read.
  } finally {
    if (db) { try { db.close(); } catch { /* already closed */ } }
  }
  const nowSec = nowMs / 1000;
  const out = {};
  for (const kind of KINDS) {
    const entry = map[kind];
    if (!entry || typeof entry !== 'object') continue;
    const expiredQuota = entry.quota ? expireSavedQuota(entry.quota, nowSec) : null;
    if (entry.ok === false && (!entry.until || entry.until <= nowMs)) {
      out[kind] = { ok: true, ...(entry.at ? { at: entry.at } : {}), ...(expiredQuota ? { quota: expiredQuota } : {}) };
    } else {
      out[kind] = {
        ok: entry.ok !== false,
        ...(entry.reason ? { reason: entry.reason } : {}),
        ...(entry.at ? { at: entry.at } : {}),
        ...(entry.until ? { until: entry.until } : {}),
        ...(expiredQuota ? { quota: expiredQuota } : {}),
      };
    }
  }
  const liveCodex = readLatestCodexQuota({ sessionsDir, nowSec });
  if (liveCodex) {
    out.codex = { ...(out.codex ?? { ok: true }), quota: liveCodex };
    const faultAtMs = out.codex?.at ? Date.parse(out.codex.at) : 0;
    if (out.codex.ok === false && QUOTA_BLOCK_RE.test(String(out.codex.reason ?? ''))
      && liveCodex.fiveHour < CODEX_FIVE_HOUR_HIGH && liveCodex.weekly < CODEX_WEEKLY_HIGH
      && typeof liveCodex.observedAtMs === 'number'
      && Number.isFinite(liveCodex.observedAtMs)
      && (!faultAtMs || liveCodex.observedAtMs > faultAtMs)) {
      out.codex.ok = true;
      delete out.codex.reason;
      delete out.codex.until;
    }
  }
  return out;
}

function formatResetIn(resetsAtSec, nowMs, lang = language()) {
  const copy = (zh, en) => message(zh, en, lang);
  if (!resetsAtSec || resetsAtSec * 1000 <= nowMs) return '';
  const mins = Math.max(1, Math.round((resetsAtSec * 1000 - nowMs) / 60000));
  return mins >= 60
    ? copy(`约 ${Math.floor(mins / 60)} 小时${mins % 60 ? ` ${mins % 60} 分钟` : ''}后重置`, `resets in about ${Math.floor(mins / 60)} hours${mins % 60 ? ` ${mins % 60} minutes` : ''}`)
    : copy(`约 ${mins} 分钟后重置`, `resets in about ${mins} minutes`);
}

// network: the role's work needs the internet. Codex's default sandbox has no outbound network
// (cli-runner.mjs, 2026-09-23), so Codex is left out of such a role's chain on all platforms and
// the label says why.
// backends (R-6, 2026-10-21): a role that may run only on some backends (roles.json `backends`, in
// the role's own order) walks that list instead of the settings' order, never reaches a backend
// outside it, and ends wherever the list ends. A wall button for a backend outside it is said to be
// skipped, and the role starts from its own list.
export function planFor(role, settings, choice, { network = false, backends = null, health = null, nowMs = Date.now() } = {}) {
  const allowed = Array.isArray(backends) && backends.length ? backends.filter((kind) => KINDS.includes(kind)) : null;
  const order = allowed ?? settings.order;
  const own = settings.best[role] ?? { kind: order[0], level: 'standard' };
  let first;
  let level;
  let label;
  if (choice.mode === 'best') {
    first = own.kind;
    level = own.level;
    label = message('按钮选了 最佳默认', 'Selected Best default');
  } else {
    first = choice.mode;
    const stays = choice.max && settings.stay_standard.includes(role);
    level = choice.max && !stays ? 'max' : 'standard';
    label = message(`按钮选了 ${KIND_NAMES[first]}${choice.max ? ' 大消耗' : ''}${stays ? '（这个岗位大消耗时也用标准档）' : ''}`, `Selected ${KIND_NAMES[first]}${choice.max ? ' heavy' : ''}${stays ? ' (this role also uses standard for lightning)' : ''}`);
  }
  if (allowed && !allowed.includes(first)) {
    label += message(`；这个岗位只用 ${allowed.map((kind) => KIND_NAMES[kind]).join('、')}，不用 ${KIND_NAMES[first]}，从 ${KIND_NAMES[order[0]]} 开始`, `; this role uses only ${allowed.map((kind) => KIND_NAMES[kind]).join(', ')}, excluding ${KIND_NAMES[first]}; starting with ${KIND_NAMES[order[0]]}`);
    first = order[0];
  }
  const notes = [label];
  const rawKinds = [];
  for (const kind of [first, ...order.filter((k) => k !== first)]) {
    if (network && kind === 'codex') {
      notes.push(message('codex 的沙箱里没有网络，这个岗位要联网，跳过 codex', 'Codex sandbox has no network; skipping Codex for this network role'));
      continue;
    }
    rawKinds.push(kind);
    if (kind === 'deepseek') break;
  }
  let finalKinds = rawKinds;
  if (health) {
    const hasDeepseek = rawKinds.at(-1) === 'deepseek';
    const subKinds = hasDeepseek ? rawKinds.slice(0, -1) : [...rawKinds];
    const info = subKinds.map((kind, idx) => {
      const h = health[kind];
      const cooling = Boolean(h && h.ok === false && h.until > nowMs);
      const q = kind === 'codex' ? h?.quota : null;
      const pinnedByUser = choice.mode === kind;
      let tier = 0;
      let why = null;
      if (cooling) {
        tier = 2;
        why = message(`${KIND_NAMES[kind]} 近期不可用（${h.reason || '启动失败'}）`, `${KIND_NAMES[kind]} recently unavailable (${h.reason || 'startup failure'})`);
      } else if (q && q.fiveHour >= 100) {
        tier = 2;
        const resetNote = formatResetIn(q.fiveHourResetsAt, nowMs);
        why = message(`Codex 5 小时窗口已满 100%${resetNote ? `（${resetNote}）` : ''}`, `Codex 5-hour quota exhausted (100%)${resetNote ? ` (${resetNote})` : ''}`);
      } else if (q && q.weekly >= 100) {
        tier = 2;
        const resetNote = formatResetIn(q.weeklyResetsAt, nowMs);
        why = message(`Codex 周窗口已满 100%${resetNote ? `（${resetNote}）` : ''}`, `Codex weekly quota exhausted (100%)${resetNote ? ` (${resetNote})` : ''}`);
      } else if (!pinnedByUser && q && q.fiveHour >= CODEX_FIVE_HOUR_HIGH) {
        tier = 1;
        const resetNote = formatResetIn(q.fiveHourResetsAt, nowMs);
        why = message(`Codex 5 小时窗口已用 ${q.fiveHour}%${resetNote ? `（${resetNote}）` : ''}`, `Codex 5-hour quota ${q.fiveHour}% used${resetNote ? ` (${resetNote})` : ''}`);
      } else if (!pinnedByUser && q && q.weekly >= CODEX_WEEKLY_HIGH) {
        tier = 1;
        const resetNote = formatResetIn(q.weeklyResetsAt, nowMs);
        why = message(`Codex 周窗口已用 ${q.weekly}%${resetNote ? `（${resetNote}）` : ''}`, `Codex weekly quota ${q.weekly}% used${resetNote ? ` (${resetNote})` : ''}`);
      } else if (pinnedByUser && q && q.fiveHour >= CODEX_FIVE_HOUR_HIGH) {
        notes.push(message(`Codex 5 小时窗口已用 ${q.fiveHour}%，按点名继续使用`, `Codex 5-hour quota ${q.fiveHour}% used; retaining explicit selection`));
      }
      return { kind, idx, tier, why };
    });
    const reorderedInfo = [...info].sort((a, b) => (a.tier - b.tier) || (a.idx - b.idx));
    const reordered = reorderedInfo.map((item) => item.kind);
    if (reordered.length && reordered[0] !== subKinds[0]) {
      const frontDemoted = info
        .filter((item) => item.idx < reorderedInfo[0].idx && item.tier > reorderedInfo[0].tier && item.why)
        .map((item) => item.why);
      if (frontDemoted.length) {
        notes.push(message(`${frontDemoted.join('；')}，先让位给 ${KIND_NAMES[reordered[0]]}`, `${frontDemoted.join('; ')}; prioritizing ${KIND_NAMES[reordered[0]]}`));
      }
    }
    finalKinds = hasDeepseek ? [...reordered, 'deepseek'] : reordered;
  }
  const chain = finalKinds.map((kind) => ({ kind, level, ...settings.levels[kind][level] }));
  // The model label already names the model; the effort it ran at is said here.
  if (chain[0]?.effort) notes[0] += message(`，推理 ${chain[0].effort}`, `, reasoning ${chain[0].effort}`);
  return { chain, notes };
}

export function summarizeBackendHealth(settings, choice, health, nowMs = Date.now(), lang = 'en') {
  if (typeof nowMs === 'string') { lang = nowMs; nowMs = Date.now(); }
  const copy = (zh, en) => message(zh, en, lang);
  const modeLabel = choice.mode === 'best'
    ? copy('最佳默认', 'Best default')
    : `${KIND_NAMES[choice.mode]}${choice.max ? copy(' 大消耗', ' heavy') : ''}`;
  const parts = [copy(`当前调度模式：${modeLabel}`, `Current routing mode: ${modeLabel}`)];
  const codexQ = health?.codex?.quota;
  if (codexQ) {
    const fhReset = formatResetIn(codexQ.fiveHourResetsAt, nowMs, lang);
    const wkReset = formatResetIn(codexQ.weeklyResetsAt, nowMs, lang);
    const fhFlag = codexQ.fiveHour >= 100
      ? copy('，已满 100%', '; exhausted (100%)')
      : codexQ.fiveHour >= CODEX_FIVE_HOUR_HIGH
        ? copy(`，已超 ${CODEX_FIVE_HOUR_HIGH}% 自动后移`, `; above ${CODEX_FIVE_HOUR_HIGH}%, automatically deprioritized`)
        : '';
    const wkFlag = codexQ.weekly >= CODEX_WEEKLY_HIGH && codexQ.fiveHour < CODEX_FIVE_HOUR_HIGH
      ? copy(`，周窗口超 ${CODEX_WEEKLY_HIGH}%`, `; weekly above ${CODEX_WEEKLY_HIGH}%`)
      : '';
    parts.push(copy(
      `Codex 额度：5 小时已用 ${codexQ.fiveHour}%${fhReset ? `（${fhReset}）` : ''}，周已用 ${codexQ.weekly}%${wkReset ? `（${wkReset}）` : ''}${fhFlag}${wkFlag}`,
      `Codex quota: 5-hour ${codexQ.fiveHour}% used${fhReset ? ` (${fhReset})` : ''}; weekly ${codexQ.weekly}% used${wkReset ? ` (${wkReset})` : ''}${fhFlag}${wkFlag}`,
    ));
  }
  const cooling = [];
  const healthy = [];
  for (const kind of KINDS) {
    const st = health?.[kind];
    if (st?.ok === false && st.until > nowMs) {
      const mins = Math.max(1, Math.round((st.until - nowMs) / 60000));
      const reason = st.reason || copy('近期失败', 'recent failure');
      cooling.push(copy(`${KIND_NAMES[kind]} 冷却中（${reason}，约 ${mins} 分钟后重试）`, `${KIND_NAMES[kind]} cooling down (${reason}; retry in about ${mins} minutes)`));
    } else if (kind === 'codex' && codexQ && (codexQ.fiveHour >= 100 || codexQ.weekly >= 100)) {
      cooling.push(copy('Codex 额度已满', 'Codex quota exhausted'));
    } else healthy.push(KIND_NAMES[kind]);
  }
  if (cooling.length) parts.push(cooling.join(copy('；', '; ')));
  parts.push(copy(`可用后端：${healthy.join('、') || '无'}；各岗位实际首发见每项的 route.primary。`, `Available backends: ${healthy.join(', ') || 'none'}; see route.primary for each role.`));
  return parts.join(copy('；', '; ')).replace(/\s+/g, ' ').trim();
}
