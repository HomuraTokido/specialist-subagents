// specialist-subagents exec: open a seat, run that role's spawn spec, stream its output into the ledger.
//
// stdio note (environment fact, not a design choice): on this host a spawned child with piped
// stdio dies with EPERM (CreatePipe is blocked for confined processes), so the three stdio slots
// are backed by real files under .data/run/<seat>/ and stdout/stderr are tailed by polling.
// Everything the brief asks for stays observable: one stream per channel, line by line events,
// 64KB cap per channel, exit event, done/failed state, no shell.
// Swapping back to pipes is one line (stdio: ['pipe','pipe','pipe']) plus stream readers.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as store from './store.mjs';
import { callerLabel, resolveRuntime, timeoutMinutes } from './role-contract.mjs';
import { expectedRule } from './expected-traces.mjs';
import { killTree, pidAlive } from './proc.mjs';
import { contractChanged, contractEventText, contractNoticeText, runContract } from './run-contract.mjs';
import { message } from './presets.mjs';
import { runSkill, skillEventText, skillNoticeText, skillSegmentText } from './skill-loop.mjs';
import { sessionKind } from './session-kind.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUN_DIR = path.join(ROOT, '.data', 'run');
const CAP = 64 * 1024;
const POLL_MS = 150;
// Where a seat works when its caller named no directory. Until 2026-09-19 every seat ran in ROOT,
// this repository: a coder holds write and shell, so one relative path in a task wrote into the
// service's own source tree. A caller that names nothing now gets a directory where a stray file
// is harmless and stays visible, instead of one where it is a change to the service.
const NOWHERE_DIR = path.join(ROOT, '.data', 'nowhere');

// The directory a seat's runtime starts in. Checked before the seat is opened, so a bad path is
// the caller's error to read at once and leaves no seat behind.
export function resolveSeatCwd(cwd) {
  if (cwd === null || cwd === undefined || cwd === '') {
    fs.mkdirSync(NOWHERE_DIR, { recursive: true });
    return { dir: NOWHERE_DIR, named: false };
  }
  if (typeof cwd !== 'string') {
    throw new Error(message('cwd 必须是字符串：座位要在哪个目录里干活，写绝对路径', 'cwd must be a string: pass an absolute directory path'));
  }
  if (!path.isAbsolute(cwd)) {
    throw new Error(message(
      `cwd 必须是绝对路径，收到的是「${cwd}」：相对路径没有可以相对的地方`,
      `cwd must be an absolute path; got "${cwd}"`,
    ));
  }
  let stat = null;
  try {
    stat = fs.statSync(cwd);
  } catch {
    stat = null;
  }
  if (stat === null || !stat.isDirectory()) {
    throw new Error(message(
      `cwd「${cwd}」不存在或不是目录：座位没有开，先把目录建好或改对路径再派`,
      `cwd "${cwd}" does not exist or is not a directory; create or fix the path before dispatching`,
    ));
  }
  // The real path (E-7): a directory reached through a symlink or junction is run in, and
  // remembered as, the directory it really is.
  return { dir: store.realDir(cwd), named: true };
}

// Where a domain expert works: one directory of the service per (role, domain), created on demand.
// A domain is a label, not a path, so it is folded to one safe directory name — the seat's own
// system prompt names this directory, so a readable name ("ai", a Chinese word) is kept where it
// can be, and path-hostile characters become underscores.
function domainDir(role, domain) {
  const safe = domain.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/^\.+/, '').replace(/\.+$/, '').trim();
  return path.join(DOMAINS_DIR, role, safe || 'domain');
}

// Why a domain role refuses a dispatch that does not name its field (or that names a cwd as well):
// said in words, with what to pass instead, an example and the domains that already exist.
function domainRoleRefusal(role, because) {
  const known = store.domainsOf(role);
  const have = known.length
    ? message(`现在已有的领域：${known.join('、')}。`, `Existing domains: ${known.join(', ')}.`)
    : message('现在还没有任何领域。', 'No domains exist yet.');
  return message(
    `「${role}」按领域认专家，不按目录：要传 domain（领域名，例如 "ai"、"生物"；首尾空格和英文大小写会被规整），不要传 cwd——它的目录由服务在数据目录下按领域分一个，它自己会建。同一领域会回到同一个座位、接它的会话。${because}${have}`,
    `"${role}" tracks experts by domain rather than directory: pass domain (e.g. "ai", "biology"; trimmed and lowercased for ASCII) instead of cwd—the service creates and assigns a fixed domain directory and reuses its session. ${because}${have}`,
  );
}

// Why a directory role refuses a domain: only the posts that declare expert_by "domain" take one.
function directoryRoleRefusal(role) {
  const domains = store.domainRoles();
  const which = domains.length
    ? message(`按领域认专家的岗位是：${domains.join('、')}。`, `Domain-tracked roles: ${domains.join(', ')}.`)
    : message('现在没有按领域认专家的岗位。', 'No domain-tracked roles are configured.');
  return message(
    `「${role}」按目录认专家：用 cwd（绝对路径）指定目录，不要传 domain。${which}`,
    `"${role}" tracks experts by directory: pass cwd (an absolute path) instead of domain. ${which}`,
  );
}

const SESSION_DIR = path.join(ROOT, '.data', 'sessions');
// Where a domain expert works (2026-10-10): one fixed directory per (role, domain) under the
// service's data directory, created on demand. cwd is not the expert's identity for such a role, so
// the service, not the caller, chooses this directory.
const DOMAINS_DIR = path.join(ROOT, '.data', 'domains');

// What one process spawn may carry, per platform, measured before spawning rather than discovered
// by failing. Windows refuses a command line past 32,767 characters (CreateProcess) and Node turns
// that into a bare `spawn ENAMETOOLONG`; POSIX refuses a single argument past MAX_ARG_STRLEN
// (128 KiB) and the whole vector past ARG_MAX. A seat that dies without a report cannot say why,
// so the numbers live here and the check runs below. A little margin under each hard limit.
const ARGV_BUDGET = process.platform === 'win32'
  ? { total: 32400, single: 32000, where: () => message('Windows 32767 字符的命令行上限', 'the Windows 32,767-character command-line limit') }
  : { total: 1900000, single: 130000, where: () => message('POSIX 的 ARG_MAX / MAX_ARG_STRLEN', 'POSIX ARG_MAX / MAX_ARG_STRLEN') };

// Quotes and separators included: the limit applies to the whole line, not to the sum of the parts.
function commandLineLength(command, args) {
  let total = String(command).length;
  for (const arg of args) total += String(arg).length + 3;
  return total;
}

// The first over-budget fact, in the caller's words: which argument, how long, against what limit.
function overBudget(command, args) {
  let widest = { arg: null, chars: 0 };
  for (const arg of args) {
    const chars = String(arg).length;
    if (chars > widest.chars) widest = { arg, chars };
  }
  const total = commandLineLength(command, args);
  if (widest.chars > ARGV_BUDGET.single) return { chars: widest.chars, total, single: true, where: ARGV_BUDGET.where() };
  if (total > ARGV_BUDGET.total) return { chars: total, total, single: false, of: widest.chars, where: ARGV_BUDGET.where() };
  return null;
}

// The refusal a dispatcher can act on: which limit, how much, and the two ways out.
function tooLongMessage(budget, advice) {
  const size = budget.single
    ? message(`有一个参数长到 ${budget.chars} 字符`, `one argument is ${budget.chars} characters`)
    : message(`命令行一共 ${budget.total} 字符`, `total command line is ${budget.total} characters`);
  return message(
    `这一单的 spawn 命令超过${budget.where}（${size}），系统会直接拒绝启动，岗位不会有任何产出。${advice}。修法二选一：缩短 brief，或在 brief 里只给文件路径和行号、让岗位自己 read。`,
    `The spawn command exceeds ${budget.where} (${size}); the OS would reject launch with no output. ${advice}. Either shorten the brief or pass file paths and line ranges so the specialist can read them directly.`,
  );
}

// 2026-10-11 (C-2): there is no "the directory moved too far, start over" any more. Until then a
// directory that changed by more than 20 files or 500 lines threw the expert's session away and gave it
// a fresh one (「マスター」: "只要目录没有大的变更"); 20 runs of the 2026-10-01 review were restarted
// by that rule. The session is the expert's understanding, and a busy project is exactly where it is
// worth most, so a returning expert always continues and is told what moved.
const NOTE_LIST_CAP = 30;
// A commit lock older than this has no living holder: a commit_after_run step is seconds of git work.
const LOCK_STALE_MS = 10 * 60 * 1000;

// git without pipes: on this host a child with piped stdio dies with EPERM (see the stdio note at
// the top), so output goes through a scratch file like the seats' own streams do.
// Asynchronous on purpose: this runs inside the daemon (dispatch and settle both call it), and the
// spawnSync it used to be froze /health, the wall and every watcher for as long as git took — up to
// its 15 s timeout on a large or cold repository (2026-09-30 review). Resolves to the output, or to
// null when git failed, timed out or could not start.
function git(dir, args, timeout = 15000) {
  return new Promise((resolve) => {
    const out = path.join(RUN_DIR, `git-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.out`);
    let fd = null;
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      let text = null;
      try {
        if (fd !== null) fs.closeSync(fd);
      } catch {
        // already closed
      }
      try {
        if (ok) text = fs.readFileSync(out, 'utf8');
      } catch {
        text = null;
      }
      try { fs.unlinkSync(out); } catch { /* nothing to remove */ }
      resolve(text);
    };
    try {
      fs.mkdirSync(RUN_DIR, { recursive: true });
      fd = fs.openSync(out, 'w');
      // core.quotepath=false: by default git prints a non-ASCII path as a quoted, octal-escaped string
      // ("knowledge/ai/\347\254\224.md"), which never starts with the directory prefix commitStaged
      // compares against, so a staged Chinese filename made commit_after_run refuse to commit
      // (2026-09-30 review). It also keeps the file lists shown to the model readable.
      const child = spawn('git', ['-C', dir, '-c', 'core.quotepath=false', ...args], { stdio: ['ignore', fd, 'ignore'], windowsHide: true, timeout });
      child.once('error', () => finish(false));
      child.once('close', (code) => finish(code === 0));
    } catch {
      finish(false);
    }
  });
}

// What the directory looks like right now, as far as git can say. A directory outside git has no
// cheap notion of "changed", so it is recorded as such and the expert simply continues.
// Every question below is limited to this directory (`-- .`): a seat standing in a subdirectory of a
// bigger repository was sent into a fresh session by commits elsewhere in that repository
// (seat-librarian-1 in Hwiki's knowledge/ai, 2026-09-23 and 2026-09-27: its own directory had
// moved 4 files, Hwiki's code and archives the rest).
export async function dirState(dir) {
  const head = await git(dir, ['rev-parse', 'HEAD']);
  if (head === null) return { git: false, at: new Date().toISOString() };
  const status = (await git(dir, ['status', '--porcelain', '--', '.'])) ?? '';
  return { git: true, head: head.trim(), dirty: status.split('\n').filter(Boolean), at: new Date().toISOString() };
}

// Compare what the expert saw last time with now and say what moved. The session always continues
// (C-2); the note is what keeps a continuing expert from rebuilding the list itself from .git/logs/HEAD
// and a find over the whole repository, as seat-librarian-1 did (2026-09-29, 3.5M tokens).
// A list too long for the note goes to listFile, which the seat can read during its run.
export async function dirChange(dir, before, after, listFile = null) {
  if (!before || !before.git || !after.git) return { note: '' };
  const sameDirty = JSON.stringify(before.dirty ?? []) === JSON.stringify(after.dirty ?? []);
  if (before.head === after.head && sameDirty) return { note: '' };
  const files = [];
  let lines = 0;
  let commits = [];
  if (before.head !== after.head) {
    const numstat = await git(dir, ['diff', '--numstat', before.head, after.head, '--', '.']);
    if (numstat === null) {
      // History rewritten or the old HEAD is gone: what moved cannot be listed, but that it moved can be said.
      return { note: `服务提示：自你上次在这里（${before.at}，HEAD ${String(before.head).slice(0, 7)}）以来，这个目录的提交历史对不上了（被改写，或那个提交已经不在），算不出改了哪些文件。你接着的还是原来的会话；用到哪些文件就重新读哪些，别全信之前读到的。` };
    }
    for (const row of numstat.split('\n').filter(Boolean)) {
      const [added, removed, file] = row.split('\t');
      files.push(file);
      lines += (Number(added) || 0) + (Number(removed) || 0);
    }
    commits = ((await git(dir, ['log', '--oneline', `${before.head}..${after.head}`, '--', '.'])) ?? '').split('\n').filter(Boolean);
  }
  const dirty = sameDirty ? [] : (after.dirty ?? []);
  if (!files.length && !dirty.length) return { note: '' };
  const top = ((await git(dir, ['rev-parse', '--show-toplevel'])) ?? '').trim();
  const since = `自你上次在这里（${before.at}，HEAD ${String(before.head).slice(0, 7)}）以来`;
  const parts = [`服务提示：${since}，目录有变化${files.length ? `（${files.length} 个文件、${lines} 行）` : ''}。你接着的是原来的会话，之前读过的内容还在上下文里，下面是变了的部分。`];
  if (commits.length) parts.push(`新提交（共 ${commits.length} 个${commits.length > 10 ? '，这里是最近 10 个' : ''}）：\n${commits.slice(0, 10).join('\n')}`);
  if (files.length) {
    let rest = '';
    if (files.length > NOTE_LIST_CAP) {
      rest = `\n……另有 ${files.length - NOTE_LIST_CAP} 个没有列出`;
      if (listFile) {
        try {
          fs.writeFileSync(listFile, `${files.join('\n')}\n`);
          rest = `\n……另有 ${files.length - NOTE_LIST_CAP} 个，完整清单在 ${listFile}（每行一个路径，本次运行结束后删除）`;
        } catch {
          // the note still says how many were left out
        }
      }
    }
    parts.push(`提交里改动的文件（路径相对仓库根 ${top}，共 ${files.length} 个、${lines} 行）：\n${files.slice(0, NOTE_LIST_CAP).join('\n')}${rest}`);
  }
  if (dirty.length) parts.push(`现在未提交的改动：\n${dirty.slice(0, NOTE_LIST_CAP).join('\n')}`);
  // Only what the task needs: "read the list first" made seat-web_researcher-6 report 11 unrelated
  // notes as unfinished work (2026-09-29). Whether the whole list is the task is the contract's call.
  parts.push('清单里和这次任务有关的文件用到时重新读一下，其余沿用你已有的理解；和任务无关的不用读，也不算没做完。');
  return { note: parts.join('\n\n') };
}

// How a run was loaded (C-1 / C-6), in the words its `load` event uses.
const loadWord = (mode) => ({
  resumed: message('续上原会话', 'resumed prior session'),
  loaded: message('装载记录（换后端或会话续不上）', 'loaded records (switched backend or session unresumable)'),
  fresh: message('全新对象，没有记录', 'fresh object, no prior records'),
}[mode] ?? mode);

// C-5 (2026-10-11): where the expert's raw records are, written at the very front of every run's task
// (before the backlog and the change note). The expert reads or greps them when it needs the original
// instead of trusting a summary of it. Only files that exist are listed (store.expertRecords); an expert
// with nothing on disk gets no block at all. Every path line carries a word the reader recognises as a
// record (记录 / 报告（原文） / 交接) and an absolute path.
const when = (at) => (at ? `（${String(at).slice(0, 16).replace('T', ' ')}）` : '');
export function recordsNoteFor(records) {
  if (!records?.entries?.length) return '';
  const lines = ['服务提示：你的原始记录（需要时自己读或 grep；原文都在磁盘上）：'];
  for (const entry of records.entries) {
    if (entry.kind === 'session') lines.push(`- 会话记录：${entry.file}${when(entry.at)}`);
    else if (entry.kind === 'report') lines.push(`- 报告（原文）：${entry.file}${when(entry.at)}`);
    // B-3: another role's expert on this same object. Reading it is how one role learns what another
    // came to know here; nothing is dispatched between experts, the lead does that (PRD B-3).
    else if (entry.kind === 'peer') lines.push(`- ${entry.role} 的交接文档：${entry.file}`);
    else lines.push(`- 交接文档：${entry.file}`);
  }
  if (records.entries.some((entry) => entry.kind === 'peer')) {
    lines.push('别的岗位在同一处留下的交接，读它就当是它亲自告诉你；要它再干一单，经组长派。');
  }
  return lines.join('\n');
}

// L-1 / L-3 (2026-10-11): seat_merge / seat_split leave this expert a one-time hand-off: its next task
// starts with the hand-off document written by the expert it was merged from / split off, plus that
// expert's raw record paths. Built once at this run's start, then the marker is cleared
// (store.takePendingHandoff), so it is attached exactly once.
function pendingHandoffNote(marker) {
  if (!marker || !marker.file) return '';
  let body = '';
  try { body = fs.readFileSync(marker.file, 'utf8').trim(); } catch { body = ''; }
  const parts = ['（服务消息）这是并入你之前的专家留给你的交接：读它就当是你自己读过它读过的东西，它当时知道的就是你现在知道的。'];
  if (body) parts.push(body);
  if (marker.from) {
    try {
      const records = store.expertRecords(marker.from);
      const paths = [...new Set(records.entries.filter((e) => e.kind === 'session' || e.kind === 'report').map((e) => e.file))];
      if (paths.length) parts.push(`它当时读过的原始记录（需要时自己翻）：\n${paths.map((file) => `- ${file}`).join('\n')}`);
    } catch { /* the record list is best effort */ }
  }
  return parts.join('\n\n');
}

// A fork must not write the file its expert is writing (C-3). A pi session is a plain file that one
// process continues, so the fork continues a copy in its own session directory. The other backends keep
// their sessions in their own stores and resume them by id, so a copy would still be the same session:
// the fork gets none, starts fresh, and is handed the expert's records instead. Returns the copy's path,
// or null when the session is not a pi one (or could not be copied).
function forkSessionCopy(file, dir) {
  if (sessionKind(file)?.kind !== 'pi') return null;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const copy = path.join(dir, path.basename(file));
    fs.copyFileSync(file, copy);
    return copy;
  } catch {
    return null;
  }
}

// The seat's own list of what its last run left undone, handed back before the next task. A long
// list goes to listFile like the change list does: the task travels in argv, and Windows caps a
// command line at 32767 characters.
export function backlogNoteFor(backlog, listFile) {
  const lines = String(backlog).split('\n').filter((line) => line.trim());
  let shown = lines.join('\n');
  if (lines.length > NOTE_LIST_CAP) {
    shown = `${lines.slice(0, NOTE_LIST_CAP).join('\n')}\n……另有 ${lines.length - NOTE_LIST_CAP} 行没有列出`;
    try {
      fs.writeFileSync(listFile, `${lines.join('\n')}\n`);
      shown = `${lines.slice(0, NOTE_LIST_CAP).join('\n')}\n……另有 ${lines.length - NOTE_LIST_CAP} 行，完整清单在 ${listFile}（本次运行结束后删除）`;
    } catch {
      // the note still says how many were left out
    }
  }
  return `服务提示：你上次在这里结束时，报告了这些没做完的部分（你自己的原话）：\n${shown}\n\n这只是历史记录：只有它和本单原始用户任务相关、且本单明确授权处理时才做；不相关或明确禁止的事不能自动做，也不能为它们自创待办。收尾时只新增本单明确要求且确实没完成的事项，真正或无法确认的历史剩余仍保留。`;
}

// The commit the service just made for a seat is the seat's own work, not news for its next visit
// (seat-librarian-1 was once shown its own 81 files as changes, 2026-09-26). Only when that commit
// sits directly on what the seat saw: if anyone else committed meanwhile, their change must still
// be told, so the old baseline stays and the seat's own commit is shown along with theirs.
async function afterOwnCommit(dir, seen, who) {
  if (!seen?.git) return null;
  const subject = ((await git(dir, ['log', '-1', '--format=%s'])) ?? '').trim();
  const parent = ((await git(dir, ['rev-parse', 'HEAD^'])) ?? '').trim();
  if ((!subject.startsWith(`${who}: 整理 `) && !subject.startsWith(`${who}: tidy `)) || parent !== seen.head) return null;
  return dirState(dir);
}

// For a role that may not run git itself (commit_after_run): commit what the seat changed inside
// its own directory, and nothing else. Anything staged outside that directory stops the commit —
// it belongs to someone else — and what this step staged is taken back out.
// Waiting for the lock is a timer, not Atomics.wait: this runs inside the daemon's own process
// (daemon.mjs imports runPost), and a synchronous wait would freeze /health and every other caller
// for up to the 30 seconds below (found 2026-09-29; same rule as waitForChange in daemon.mjs). The
// git calls in here are asynchronous for the same reason (git() above).
async function commitInside(dir, who, lockName = null) {
  const top = ((await git(dir, ['rev-parse', '--show-toplevel'])) ?? '').trim();
  if (!top) return message('目录不在 git 仓库里，改动没有提交', 'Directory is not inside a git repository; changes left uncommitted');
  // Other writers of the same repository may commit through their own tool (Hwiki's ai-note takes
  // .git/hwiki-ai-note.lock). Sharing that lock keeps our add..commit from sweeping up what they
  // staged. The lock's name is data in roles.json, so no repository is named here.
  return withLock(top, lockName, message('改动留在工作区没有提交', 'changes left uncommitted in the working tree'), () => commitStaged(dir, top, who));
}

// Runs fn while holding the repository's commit lock (none named: runs it straight away). What the
// caller is left with when the lock cannot be had goes in `left`, so each refusal says what it means.
async function withLock(top, lockName, left, fn) {
  if (!lockName) return fn();
  const lockPath = path.join(top, lockName);
  const deadline = Date.now() + 30000;
  let fd = null;
  let brokeNote = '';
  while (fd === null) {
    try {
      fd = fs.openSync(lockPath, 'wx');
    } catch (err) {
      // Only EEXIST means somebody else holds the lock. Anything else (ENOTDIR when .git is a file in
      // a worktree or submodule, ENOENT, EACCES) will never clear by waiting: it used to be read as
      // "busy" and cost the full 30 seconds on every run (2026-09-30 review).
      if (err?.code !== 'EEXIST') {
        return message(
          `拿不到锁 ${lockName}（${err?.code ?? err?.message ?? err}），${left}；这不是有人占着锁，检查仓库的 .git 是不是普通目录、有没有写权限`,
          `Could not acquire lock ${lockName} (${err?.code ?? err?.message ?? err}); ${left}. Not lock contention—verify .git is a normal directory and writable.`,
        );
      }
      // A holder that died between creating and removing the lock leaves it behind for good; nothing
      // ever finishes a run in ten minutes here, so an older lock is broken and the fact is recorded.
      let ageMs = 0;
      try {
        ageMs = Date.now() - fs.statSync(lockPath).mtimeMs;
      } catch {
        ageMs = 0; // it vanished between the two calls: just try again
      }
      if (Date.now() > deadline) return message(`等了 30 秒仍拿不到锁 ${lockName}，${left}`, `Timed out after 30s waiting for lock ${lockName}; ${left}`);
      if (ageMs > LOCK_STALE_MS) {
        let removed = false;
        try {
          fs.unlinkSync(lockPath);
          removed = true;
          brokeNote = message(
            `（锁 ${lockName} 已经存在 ${Math.round(ageMs / 60000)} 分钟，判为持有者已经死掉，已清除后继续）`,
            ` (broke stale lock ${lockName} aged ${Math.round(ageMs / 60000)} min)`,
          );
        } catch {
          // someone else removed or re-took it first, or Windows still holds it open; wait before retrying
        }
        if (removed) continue;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  try {
    const result = await fn();
    if (!brokeNote) return result;
    if (typeof result === 'string') return `${result}${brokeNote}`;
    if (result && typeof result === 'object' && typeof result.text === 'string') return { ...result, text: `${result.text}${brokeNote}` };
    return result;
  } finally {
    try { fs.closeSync(fd); } catch { /* closed */ }
    try { fs.unlinkSync(lockPath); } catch { /* gone */ }
  }
}

async function commitStaged(dir, top, who) {
  // Where this directory sits in the repository, asked of git rather than worked out from two paths:
  // path.relative(top, dir) went wrong when the two spelled the same place differently (the Windows
  // CI temp directory is the 8.3 name C:\Users\RUNNER~1\..., git's top is the long name), and then
  // every staged file looked like it was outside (CI, 2026-09-30 to 2026-10-01).
  const prefix = await git(dir, ['rev-parse', '--show-prefix']);
  if (prefix === null) {
    return message(
      '问不出这个目录在仓库里的位置（git rev-parse --show-prefix 失败），改动留在工作区没有提交',
      'Could not resolve directory prefix in repository (git rev-parse --show-prefix failed); changes left uncommitted',
    );
  }
  const rel = prefix.trim().replace(/\/$/, '');
  if ((await git(dir, ['add', '-A', '--', '.'])) === null) {
    return message('git add 失败，改动留在工作区没有提交', 'git add failed; changes left uncommitted');
  }
  const staged = ((await git(dir, ['diff', '--cached', '--name-only'])) ?? '').split('\n').filter(Boolean);
  if (!staged.length) return message('这次没有改动，不需要提交', 'No changes to commit');
  const outside = staged.filter((file) => rel && !file.startsWith(`${rel}/`));
  if (outside.length) {
    await git(dir, ['reset', '-q', '--', '.']);
    return message(
      `暂存区里有目录外的改动（${outside.slice(0, 5).join('、')}），不是这个座位的，没有提交；它的改动留在工作区`,
      `Index contained staged changes outside this directory (${outside.slice(0, 5).join(', ')}); unstaged this seat’s directory and aborted commit`,
    );
  }
  if ((await git(dir, ['commit', '-q', '-m', message(`${who}: 整理 ${rel || '.'}`, `${who}: tidy ${rel || '.'}`)])) === null) {
    return message('git commit 失败，改动已暂存但没有提交', 'git commit failed; changes remain staged');
  }
  const hash = ((await git(dir, ['rev-parse', '--short', 'HEAD'])) ?? '').trim();
  return message(`已在本地提交 ${hash}（${staged.length} 个文件，未推送）`, `Committed locally ${hash} (${staged.length} file(s), unpushed)`);
}

// K-4 (2026-11-01): a role that keeps a shared library (sync_remote in roles.json) also carries it
// between machines. Writers only deposit locally; before its run the service merges in what the
// other machines pushed, so the seat's change note lists their notes too, and after its commit the
// service pushes. Two Windows/Linux copies of Hwiki diverged for a week (10-25 to 11-01, 31 commits
// against 46) because every writer committed locally and nobody pulled or pushed. Whether this
// repository may be pushed by an agent at all is the repository's own setting, the same one Claude
// Code's push rule reads: `git config --local claude.allowPush true`. Network steps get two minutes.
const NET_TIMEOUT = 120000;
// Where a seat handed conflicts finds what each conflicting file looks like, inside its own directory.
const CONFLICT_DIR = '.conflicts';

async function syncAllowed(dir) {
  return ((await git(dir, ['config', '--get', 'claude.allowPush'])) ?? '').trim() === 'true';
}

// Fetch and merge the upstream branch, under the commit lock. Returns a sentence for the seat's
// events, or null when this repository is not set up for syncing. A merge that conflicts is taken
// back whole: the seat then tidies only what is local, and the push after it is skipped by the same
// conflict, so nothing half-merged ever leaves the machine.
async function mergeUpstream(dir, lockName, { handOver = false } = {}) {
  if (!(await syncAllowed(dir))) return null;
  const top = ((await git(dir, ['rev-parse', '--show-toplevel'])) ?? '').trim();
  if (!top) return null;
  const upstream = ((await git(dir, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])) ?? '').trim();
  if (!upstream) return { ok: false, text: message('当前分支没有上游分支，没有同步', 'Current branch has no upstream; sync skipped') };
  if ((await git(dir, ['fetch', '-q'], NET_TIMEOUT)) === null) {
    return { ok: false, text: message(`从 ${upstream} 拉取失败（网络或权限），这次只用本地的`, `Failed to fetch from ${upstream} (network or permissions); using local state`) };
  }
  const behind = Number(((await git(dir, ['rev-list', '--count', 'HEAD..@{u}'])) ?? '0').trim()) || 0;
  if (!behind) return { ok: true, text: message(`${upstream} 没有新提交`, `No new commits on ${upstream}`) };
  const sha = ((await git(dir, ['rev-parse', '@{u}'])) ?? '').trim();
  let pending = null;
  const merged = await withLock(top, lockName, message('没有并入远端', 'upstream merge skipped'), async () => {
    if ((await git(dir, ['merge', '--no-edit', '-q', '@{u}'], NET_TIMEOUT)) !== null) {
      return { ok: true, text: message(`已并入 ${upstream} 的 ${behind} 个提交`, `Merged ${behind} commit(s) from ${upstream}`) };
    }
    const conflicted = ((await git(dir, ['diff', '--name-only', '--diff-filter=U'])) ?? '').split('\n').filter(Boolean);
    const rel = ((await git(dir, ['rev-parse', '--show-prefix'])) ?? '').trim().replace(/\/$/, '');
    const inside = conflicted.length > 0 && conflicted.every((file) => !rel || file.startsWith(`${rel}/`));
    let copies = null;
    if (handOver && inside) {
      try {
        copies = conflicted.map((file) => [file, fs.readFileSync(path.join(top, file), 'utf8')]);
      } catch {
        copies = null;
      }
    }
    await git(dir, ['merge', '--abort']);
    if (copies) {
      for (const [file, text] of copies) {
        const out = path.join(dir, CONFLICT_DIR, rel ? file.slice(rel.length + 1) : file);
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.writeFileSync(out, text);
      }
      pending = { sha, files: conflicted, rel };
      return {
        ok: false,
        text: message(
          `并入 ${upstream} 时有 ${conflicted.length} 篇两边都改过（${conflicted.slice(0, 5).join('、')}），交给这一单按语义合，合完由服务并入并推送`,
          `${conflicted.length} file(s) diverged when merging ${upstream} (${conflicted.slice(0, 5).join(', ')}); handed to this run to resolve semantically before syncing`,
        ),
      };
    }
    const where = !conflicted.length
      ? message('（工作区有未提交的改动挡着，或 git 出错）', ' (uncommitted working-tree changes or git error)')
      : message(
        `（冲突：${conflicted.slice(0, 5).join('、')}${inside ? '' : '，有的在这个座位的目录外'}）`,
        ` (conflicts: ${conflicted.slice(0, 5).join(', ')}${inside ? '' : '; some outside this seat’s directory'})`,
      );
    return {
      ok: false,
      text: message(
        `并入 ${upstream} 失败${where}，已撤回这次合并，没有推送${inside || !conflicted.length ? '；下一单开工时再试' : '；目录外的冲突要人来合'}`,
        `Merge from ${upstream} failed${where}; aborted without pushing (${inside || !conflicted.length ? 'will retry on next run' : 'outside conflicts require manual resolution'})`,
      ),
    };
  });
  const normalized = typeof merged === 'string' ? { ok: false, text: merged } : merged;
  return { ok: normalized.ok, text: normalized.text, pending };
}

// After a run that was handed conflicts: merge the very commit that conflicted before the run (not a
// newer one, whose changes the seat never saw) and, in the files it was given, keep what the seat
// wrote. A file the seat did not touch would lose the other side's change that way, so then nothing
// is merged and the next run is handed the conflict again.
async function resolvePending(dir, lockName, pending, preHead) {
  const top = ((await git(dir, ['rev-parse', '--show-toplevel'])) ?? '').trim();
  if (!top) return { ok: false, text: message('目录不在 git 仓库里，冲突没有合', 'Directory is not in a git repository; conflicts unresolved') };
  const result = await withLock(top, lockName, message('冲突没有合进去，下一单开工时再交给它', 'conflicts left unmerged; will retry next run'), async () => {
    const touched = new Set(((await git(dir, ['diff', '--name-only', preHead, 'HEAD'])) ?? '').split('\n').filter(Boolean));
    const untouched = pending.files.filter((file) => !touched.has(file));
    if (untouched.length) {
      return {
        ok: false,
        text: message(
          `这一单没有改 ${untouched.slice(0, 5).join('、')}，冲突没有合，没有推送；下一单开工时再交给它`,
          `Run did not modify ${untouched.slice(0, 5).join(', ')}; conflicts unmerged, push skipped; will retry next run`,
        ),
      };
    }
    if ((await git(dir, ['merge', '--no-edit', '-q', pending.sha], NET_TIMEOUT)) !== null) {
      return { ok: true, text: message('已并入远端（这次没有冲突）', 'Merged upstream (clean)') };
    }
    const conflicted = ((await git(dir, ['diff', '--name-only', '--diff-filter=U'])) ?? '').split('\n').filter(Boolean);
    const others = conflicted.filter((file) => !pending.files.includes(file));
    if (!conflicted.length || others.length) {
      await git(dir, ['merge', '--abort']);
      return {
        ok: false,
        text: message(
          `再次并入时${others.length ? `又有别的冲突（${others.slice(0, 5).join('、')}）` : ' git 出错'}，已撤回，没有推送；下一单开工时再试`,
          `Re-merge hit ${others.length ? `additional conflicts (${others.slice(0, 5).join(', ')})` : 'a git error'}; aborted without pushing; will retry next run`,
        ),
      };
    }
    // The names git gave are relative to the top, so these two run there, not in the seat's directory.
    for (const file of conflicted) {
      await git(top, ['checkout', '--ours', '--', file]);
      await git(top, ['add', '--', file]);
    }
    if ((await git(dir, ['commit', '-q', '--no-edit'])) === null) {
      await git(dir, ['merge', '--abort']);
      return { ok: false, text: message('合并提交失败，已撤回，没有推送；下一单开工时再试', 'Merge commit failed; aborted without pushing; will retry next run') };
    }
    return {
      ok: true,
      text: message(
        `已按这一单合好的内容并入远端（${conflicted.length} 篇：${conflicted.slice(0, 5).join('、')}）`,
        `Merged upstream keeping resolved content (${conflicted.length} file(s): ${conflicted.slice(0, 5).join(', ')})`,
      ),
    };
  });
  return typeof result === 'string' ? { ok: false, text: result } : result;
}

// The conflict copies are for reading during the run, never for the repository.
function removeConflictCopies(dir) {
  fs.rmSync(path.join(dir, CONFLICT_DIR), { recursive: true, force: true });
}

// What the seat is told before its task when it was handed conflicts.
function conflictNote(pending) {
  const files = pending.files.map((file) => `- ${pending.rel ? file.slice(pending.rel.length + 1) : file}`).join('\n');
  return `服务提示：并入远端（别的机器推上来的提交）时，下面这几篇两边都改过，git 合不了：\n${files}\n每篇冲突的样子放在本目录 ${CONFLICT_DIR}/ 下的同名文件里：<<<<<<< 到 ======= 是本机的写法，======= 到 >>>>>>> 是远端的。先按语义把每篇合好：两边有用的内容都留下，写进本目录里的正式文件（不是 ${CONFLICT_DIR}/ 里的副本），不留冲突标记。${CONFLICT_DIR}/ 由服务事后删掉，你合好的版本由服务并入远端并推送。合完再做本单的任务；最后回复里说清每篇是怎么合的。`;
}

// K-5 (2026-11-01): a seat without a shell may still move notes to where they belong. It writes a
// plan file in its directory (move_plan.file in roles.json); after the run the service takes the
// file out of the directory, so the tool's own commit does not sweep it up, and hands it to the
// repository's own mover (move_plan.run, started at the repository's top, `{plan}` replaced by the
// plan's path), which moves the notes, rewrites ids and links inside that target Hwiki repository
// only, and commits. References outside the target repository are intentionally not rewritten by
// this tool (product boundary confirmed with 「マスター」: 「改坏引用会怎么样？答案是不会怎么样。不如说修引用也是ta的工作」).
function movePlanCommand(command) {
  if (command !== 'python3') return command;
  const probe = (name) => spawnSync(name, ['--version'], { stdio: 'ignore', windowsHide: true, timeout: 5000 }).status === 0;
  return !probe('python3') && probe('python') ? 'python' : command;
}

async function applyMovePlan(dir, { file, run }) {
  const plan = path.join(dir, file);
  if (!fs.existsSync(plan)) return null;
  const top = ((await git(dir, ['rev-parse', '--show-toplevel'])) ?? '').trim();
  if (!top || !Array.isArray(run) || !run.length) {
    return message(
      `有挪动计划 ${file}，但目录不在 git 仓库里或 roles.json 没写怎么执行，没有挪，计划文件留在原处`,
      `Found move plan ${file}, but directory is not in a git repo or roles.json has no move_plan.run; left in place`,
    );
  }
  fs.mkdirSync(RUN_DIR, { recursive: true });
  const taken = path.join(RUN_DIR, `moves-${process.pid}-${Date.now()}.json`);
  fs.renameSync(plan, taken);
  const [requestedCommand, ...args] = run.map((part) => part.replace('{plan}', taken));
  const command = movePlanCommand(requestedCommand);
  const out = path.join(RUN_DIR, `moves-${process.pid}-${Date.now()}.out`);
  const fd = fs.openSync(out, 'w');
  const code = await new Promise((resolve) => {
    try {
      const child = spawn(command, args, { cwd: top, stdio: ['ignore', fd, fd], windowsHide: true, timeout: NET_TIMEOUT });
      child.once('error', () => resolve(null));
      child.once('close', (exit) => resolve(exit));
    } catch {
      resolve(null);
    }
  });
  try { fs.closeSync(fd); } catch { /* closed */ }
  let said = '';
  try { said = fs.readFileSync(out, 'utf8').trim().slice(-600); } catch { said = ''; }
  try { fs.unlinkSync(out); } catch { /* gone */ }
  if (code === 0) {
    try { fs.unlinkSync(taken); } catch { /* gone */ }
    return message(
      `按挪动计划执行完：${said || '（工具没有输出）'}`,
      `Applied move plan: ${said || '(no output)'}`,
    );
  }
  // The mover changes nothing unless it can do the whole plan. The plan is not put back: the commit
  // that follows would carry it into the repository. Its text goes into the event instead.
  let text = '';
  try { text = fs.readFileSync(taken, 'utf8').trim(); fs.unlinkSync(taken); } catch { /* left in the run directory */ }
  return message(
    `挪动计划执行失败，什么都没挪（${code === null ? `${command} 没能启动或超时` : `退出码 ${code}`}）：${said || '没有输出'}\n计划原文：${text}`,
    `Move plan failed (${code === null ? `${command} failed to start or timed out` : `exit ${code}`}); nothing moved: ${said || 'no output'}\nPlan:\n${text}`,
  );
}

// Before the run, conflicts inside the seat's own directory are handed to the seat (pending); after it,
// a merge that conflicts is only taken back, and the next run's pull hands it over. Conflicts that
// touch anything outside the directory are never the seat's to merge.
async function pullBeforeRun(dir, lockName) {
  removeConflictCopies(dir);
  const merged = await mergeUpstream(dir, lockName, { handOver: true });
  return merged ? { event: message(`同步：${merged.text}`, `sync: ${merged.text}`), pending: merged.pending } : { event: null, pending: null };
}

async function pushAfterCommit(dir, lockName, pending = null, preHead = null) {
  let done = '';
  if (pending && preHead && (await syncAllowed(dir))) {
    const resolved = await resolvePending(dir, lockName, pending, preHead);
    if (!resolved.ok) return message(`同步：${resolved.text}`, `sync: ${resolved.text}`);
    done = message(`${resolved.text}；`, `${resolved.text}; `);
  }
  const merged = await mergeUpstream(dir, lockName);
  if (!merged) return null;
  if (!merged.ok) return message(`同步：${done}${merged.text}`, `sync: ${done}${merged.text}`);
  const ahead = Number(((await git(dir, ['rev-list', '--count', '@{u}..HEAD'])) ?? '0').trim()) || 0;
  if (!ahead) return message(`同步：${done}没有要推送的提交`, `sync: ${done}no local commits to push`);
  if ((await git(dir, ['push', '-q'], NET_TIMEOUT)) === null) {
    return message(
      `同步：${done}推送 ${ahead} 个提交失败（网络、权限，或远端刚又有新提交），留到下一次整理再推`,
      `sync: ${done}failed to push ${ahead} commit(s) (network, auth, or remote diverged); will retry next run`,
    );
  }
  return message(`同步：${done}已推送 ${ahead} 个提交`, `sync: ${done}pushed ${ahead} commit(s)`);
}

// The difficulty ledger (FR-21). The runner reports the traces it saw; the service adds the two it
// alone can judge — a run that failed, and a run far bigger than this role usually is — and writes
// one line per difficulty into the seat's own events so the wall shows it where it happened.
const COSTLY_FACTOR = 3;
// `cancelled` (seat_close killed the run: the caller's own choice, not a difficulty) and `failedDetail`
// (why the run failed, when the service knows better than the runner: a timeout) come from exec.mjs.
function recordDifficulties(seat, runKey, role, cwd, state, report, { cancelled = false, failedDetail = null, expert = null } = {}) {
  try {
    const tokens = Number(report?.tokens?.total) || 0;
    const cost = typeof report?.cost === 'number' ? report.cost : null;
    // A trace the role's contract makes normal (roles.json expected_traces) is not written. The runners
    // already leave them out; this catches a runner that did not, with the same rule store.mjs counts by.
    const rules = store.roleSpec(role)?.expected_traces;
    const found = (Array.isArray(report?.difficulties) ? report.difficulties : []).filter((d) => !expectedRule(rules, d));
    // Each stop by a backend model's safety filter is its own row (2026-10-25), whatever came of the run:
    // the backend in `tool`, so a class says which model stops which post's tasks. A run that ended
    // because of one is told by those rows; a plain 'failed' row on top would count the same stop twice.
    const refusals = Array.isArray(report?.refusals) ? report.refusals : [];
    const ended = state === 'done'
      ? message('这一单最后做完了', 'run completed')
      : cancelled
        ? message('这一单被取消', 'run cancelled')
        : message('这一单没做完', 'run incomplete');
    const stageText = (stage) => ({
      before_tools: message('还没动手就被拦，换了下一个后端', 'blocked before tools; switched to next backend'),
      halfway: message('做到一半被拦，换不带历史的新会话接手', 'blocked halfway; handed off to fresh session'),
    }[stage] ?? stage);
    for (const r of refusals) {
      const progress = r.progress ? message(`（${r.progress}）`, ` (${r.progress})`) : '';
      found.push({
        kind: 'refused',
        tool: r.backend ?? null,
        detail: message(
          `${stageText(r.stage)}：${String(r.reason ?? '').slice(0, 200)}${progress}；${ended}`,
          `${stageText(r.stage)}: ${String(r.reason ?? '').slice(0, 200)}${progress}; ${ended}`,
        ),
      });
    }
    if (state !== 'done' && !cancelled && !refusals.length) {
      found.push({
        kind: 'failed',
        tool: null,
        detail: failedDetail ?? (report?.error
          ? message(`运行失败：${String(report.error).slice(0, 160)}`, `Run failed: ${String(report.error).slice(0, 160)}`)
          : message('运行失败退出', 'Run exited with failure')),
      });
    }
    if (tokens > 0) {
      const median = store.usageMedian(role);
      if (median && tokens > median * COSTLY_FACTOR) {
        found.push({
          kind: 'costly',
          tool: null,
          detail: message(
            `本次 ${tokens} token，是这个岗位最近常态（中位数 ${median}）的 ${(tokens / median).toFixed(1)} 倍`,
            `${tokens} tokens used (${(tokens / median).toFixed(1)}x this role's recent median of ${median})`,
          ),
        });
      }
      store.recordRunUsage({ seat, role, tokens, cost });
    }
    for (const d of found) {
      // S-1: filed under the expert this run belongs to, which for a fork is its parent (C-3).
      store.recordDifficulty({ seat, expert, run: runKey, role, cwd, kind: d.kind, tool: d.tool ?? null, detail: d.detail ?? null, description: d.description ?? null, runTokens: tokens || null, runCost: cost });
      recordQuietly(seat, 'difficulty', `${d.detail}${d.description ? ` —— ${d.description}` : ''}`);
    }
  } catch {
    // ledger trouble must not lose the run
  }
}

function recordQuietly(seat, kind, body) {
  try {
    store.recordEvent({ seat, kind, body });
  } catch {
    // ledger trouble must not lose the run
  }
}

// One line a reader understands without a legend: what this run consumed and what it cost.
function usageLine(report) {
  const t = report.tokens ?? {};
  const cost = typeof report.cost === 'number' ? message(`，约 $${report.cost.toFixed(4)}`, `, est. $${report.cost.toFixed(4)}`) : '';
  return message(
    `本次用量：输入 ${t.input ?? 0} token（另有缓存命中 ${t.cacheRead ?? 0}），输出 ${t.output ?? 0} token${cost}（${report.model ?? '模型未知'}）`,
    `Usage: input ${t.input ?? 0} tokens (cache hit ${t.cacheRead ?? 0}), output ${t.output ?? 0} tokens${cost} (${report.model ?? 'unknown model'})`,
  );
}

// A run whose session was stopped halfway by the backend model's safety filter, and what came of the one
// takeover by a session without the seat's history (cli-runner.mjs, takeOver): one event saying both.
function takeoverText(takeover) {
  const files = Array.isArray(takeover.files) ? takeover.files : [];
  const shown = files.slice(0, 20).map((f) => `${f.path}${f.added === null || f.added === undefined ? '' : ` +${f.added} -${f.removed}`}`).join(message('、', ', '));
  const where = files.length
    ? message(
      `被拦时改动过 ${files.length} 个文件（${shown}${files.length > 20 ? '……' : ''}）`,
      `changed ${files.length} file(s) before block (${shown}${files.length > 20 ? '...' : ''})`,
    )
    : message('被拦时没有发现改动过的文件', 'no modified files detected before block');
  const outcome = takeover.failed
    ? message(
      `接手没成：${takeover.by ? `${takeover.by} 的新会话` : '没有后端接得了'}（${takeover.failed}），这一单停下`,
      `takeover failed: ${takeover.by ? `fresh ${takeover.by} session` : 'no available backend'} (${takeover.failed}); stopped`,
    )
    : message(
      `由 ${takeover.by} 的新会话（不带这个座位的历史）接手做完，它的结果就是这一单的结果`,
      `completed by a fresh ${takeover.by} session without this seat's history`,
    );
  const sessionNote = takeover.session
    ? message(`；接手会话的记录在 ${takeover.session}`, `; takeover session at ${takeover.session}`)
    : '';
  return message(
    `这一单做到一半被拦截（${takeover.stopped}）；${where}；${outcome}${sessionNote}`,
    `Blocked mid-run (${takeover.stopped}); ${where}; ${outcome}${sessionNote}`,
  );
}

function capped() {
  let text = '';
  let truncated = false;
  return {
    add(part) {
      if (truncated || !part) return;
      const room = CAP - text.length;
      if (part.length <= room) {
        text += part;
        return;
      }
      text += part.slice(0, room);
      truncated = true;
    },
    value() {
      if (!truncated) return text;
      const sep = text.length === 0 || text.endsWith('\n') ? '' : '\n';
      return `${text}${sep}[truncated]`;
    },
  };
}

// One tailer per channel: reads newly appended bytes, splits complete lines, records them.
// `skipLines` is for a run adopted after a daemon restart: the previous daemon already put that many
// lines of this channel in the ledger, so they are read past and not recorded twice.
function makeTail(file, seat, kind, capture, skipLines = 0) {
  let fd = -1;
  let position = 0;
  let pending = Buffer.alloc(0);
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    fd = -1;
  }

  let skip = skipLines;
  const emit = (line) => {
    if (skip > 0) {
      skip -= 1;
      return;
    }
    const text = line.toString('utf8');
    try {
      store.recordEvent({ seat, kind, body: text });
    } catch {
      // the seat row is gone; output still lands in the returned strings
    }
    capture.add(`${text}\n`);
  };

  // The lines one read finds go into the ledger as one commit (2026-10-11). One commit per line made a
  // run that printed 3000 lines hold the daemon's only thread for ten seconds on the Windows CI, and
  // the keep-alive connections of the callers that waited were reset (ECONNRESET). Still one event per
  // line; only the commits are fewer. A failing batch must not take the daemon down: the lines are
  // still in the captured strings, and the next read goes on from where this one stopped.
  const batched = (fn) => {
    try {
      store.inTransaction(fn);
    } catch {
      // ledger trouble must not lose the run
    }
  };

  const drain = () => batched(drainLines);

  const drainLines = () => {
    if (fd < 0) {
      try {
        fd = fs.openSync(file, 'r');
      } catch {
        return;
      }
    }
    const buffer = Buffer.alloc(64 * 1024);
    for (;;) {
      let read = 0;
      try {
        read = fs.readSync(fd, buffer, 0, buffer.length, position);
      } catch {
        return;
      }
      if (read <= 0) break;
      position += read;
      const chunk = buffer.subarray(0, read);
      pending = pending.length ? Buffer.concat([pending, chunk]) : Buffer.from(chunk);
      let cut = pending.indexOf(0x0a);
      while (cut >= 0) {
        let line = pending.subarray(0, cut);
        pending = pending.subarray(cut + 1);
        if (line.length && line[line.length - 1] === 0x0d) line = line.subarray(0, line.length - 1);
        emit(line);
        cut = pending.indexOf(0x0a);
      }
    }
  };

  const finish = () => {
    batched(() => {
      drainLines();
      if (pending.length) {
        let line = pending;
        if (line[line.length - 1] === 0x0d) line = line.subarray(0, line.length - 1);
        pending = Buffer.alloc(0);
        emit(line);
      }
    });
    try {
      if (fd >= 0) fs.closeSync(fd);
    } catch {
      // nothing left to close
    }
    fd = -1;
  };

  return { drain, finish };
}

// How long a run may last before the service kills it: role-contract.mjs timeoutMinutes (per role in
// roles.json, 60 when absent). Until 2026-09-30 nothing bounded a run: a seat hung on a prompt or a
// stalled model call held its concurrency slot and its process tree until someone killed them by hand
// (2026-09-30 review).
const ADOPT_POLL_MS = 3000;
const MAX_TIMER_MS = 2 ** 31 - 1;

function durationWords(ms) {
  return ms < 120000
    ? message(`${Math.max(1, Math.round(ms / 1000))} 秒`, `${Math.max(1, Math.round(ms / 1000))}s`)
    : message(`${Math.round(ms / 60000)} 分钟`, `${Math.round(ms / 60000)} min`);
}

// The runs this process supervises, by seat: the runtime's pid (an adopted orphan has no child
// handle, only the pid) and what was done to the run. seat_close and the timeout reach a run through
// here, and settle() reads it to know the run was killed on purpose.
const live = new Map();

// Cancel the run on a seat: kill its whole process tree (a hung runner's real work is grandchildren)
// and record a 'cancelled' event with the reason. `mode` says what happens to the seat after:
//   'close' — seat_close/seat_merge retirement: the caller then closes the seat, and settle() must not
//             bring it back as done/failed.
//   'task'  — task_cancel: the expert goes back to idle (done) with its session intact, NOT archived.
// A run this process does not supervise (another daemon's) is still killed by its pid. If the tree
// cannot be killed the seat is left as it was and the error says so: a seat marked cancelled with its
// process still running is the lie this replaces (2026-09-30 review).
async function cancelRun({ seat, reason = null, mode }) {
  const found = store.showSeat(seat, { tail: 0 });
  if (!found) throw new Error(`unknown seat: ${seat}`);
  const run = live.get(seat);
  const pid = run ? run.pid : found.seat.state === 'running' && pidAlive(found.seat.pid) ? found.seat.pid : null;
  const why = reason === null || reason === undefined || reason === ''
    ? ''
    : message(`原因：${reason}。`, `Reason: ${reason}. `);
  if (pid === null || pid === undefined) {
    // A run of this daemon that has no pid yet is still preparing (asking git about the directory):
    // flag it so it does not go on to start a runtime for a seat being cancelled.
    if (run) {
      run.cancelled = { reason: reason ?? null, at: new Date().toISOString() };
      run.cancelMode = mode;
    }
    return { seat: found.seat, killed: false, pid: null, alreadyGone: true };
  }
  const prevCancelled = run ? run.cancelled : null;
  const prevCancelMode = run ? run.cancelMode : null;
  if (run) {
    run.cancelled = { reason: reason ?? null, at: new Date().toISOString() };
    run.cancelMode = mode;
  }
  const pending = (async () => {
    const result = await killTree(pid);
    if (!result.ok) {
      if (run) {
        run.cancelled = prevCancelled;
        run.cancelMode = prevCancelMode;
      }
      throw new Error(message(
        `座位 ${seat} 正在跑，但结束它的进程树失败了（pid ${pid}：${result.detail}），座位保持原样。可以再试一次，或由${callerLabel('用户')}在本机结束那个进程。`,
        `Seat ${seat} is running, but failed to terminate process tree (pid ${pid}: ${result.detail}); seat unchanged. Retry or kill the process manually.`,
      ));
    }
    const opener = mode === 'task' ? 'task_cancel' : 'seat_close';
    const body = result.alreadyGone
      ? message(
        `座位在跑的时候被 ${opener} 取消；取消的瞬间它的进程（pid ${pid}）已经退出。${why}这一单没有做收尾，未完成清单保持上次的样子。`,
        `Cancelled mid-run by ${opener}; process (pid ${pid}) had already exited. ${why}Skipped closing questions; backlog left as before.`,
      )
      : message(
        `座位在跑的时候被 ${opener} 取消：已结束它的进程树（pid ${pid}）。${why}这一单没有跑完，也没有问收尾问题，未完成清单保持上次的样子。`,
        `Cancelled mid-run by ${opener}: terminated process tree (pid ${pid}). ${why}Skipped closing questions; backlog left as before.`,
      );
    store.recordEvent({ seat, kind: 'cancelled', body });
    return { seat: found.seat, killed: !result.alreadyGone, pid, alreadyGone: result.alreadyGone };
  })();
  if (run) {
    run.cancelPending = pending.catch(() => {}).finally(() => {
      run.cancelPending = null;
    });
  }
  return await pending;
}

// seat_close. A seat that is not running is only retired in the ledger. A running one is cancelled:
// its whole process tree is killed first, a 'cancelled' event records who and why, and then the seat is
// closed. The run's own settle() still records the exit and usage, but can no longer move the seat off
// 'closed' (store.setSeatState). The backlog is left as it was, since no closing question ran.
export async function closeSeatNow({ seat, reason = null } = {}) {
  const cancelled = await cancelRun({ seat, reason, mode: 'close' });
  const closed = store.closeSeat({ seat, reason });
  return { seat: closed, killed: cancelled.killed, pid: cancelled.pid };
}

// task_cancel (L-5, 2026-10-11): stop the run on a seat but KEEP the expert. The process tree is killed,
// a 'cancelled' event records the reason, and the expert goes back to idle (done) — it is not archived,
// its half-written session stays its record, and its next task continues from that. A fork (分身) of a
// busy expert is a one-run seat: it is retired when cancelled, the same way it is when it ends.
export async function cancelRunNow({ seat, reason = null } = {}) {
  const cancelled = await cancelRun({ seat, reason, mode: 'task' });
  let closed = null;
  // A fork has no session of its own to go back to idle on: retire it. A normal expert stays living.
  if (cancelled.seat && Number(cancelled.seat.fork) === 1) {
    closed = store.closeSeat({ seat, reason: reason ? message(`取消分身：${reason}`, `Cancelled fork: ${reason}`) : message('取消分身', 'Cancelled fork') });
  }
  return { seat: closed ?? cancelled.seat, killed: cancelled.killed, pid: cancelled.pid, closed: Boolean(closed) };
}

// What an adopted run needs that the ledger has: the seat row, its role's spec, and what run.json
// (written when the run started) remembers. A run started by a daemon from before run.json existed
// has no such file: the directory baseline and the follow-up check are skipped for it, everything
// else is rebuilt from the ledger.
function describeAdoption(seat) {
  const row = store.showSeat(seat, { tail: 0 })?.seat;
  if (!row) throw new Error(`unknown seat: ${seat}`);
  const spec = store.roleSpec(row.role);
  if (!spec) throw new Error(`unknown role: ${row.role}`);
  let info = null;
  try {
    info = JSON.parse(fs.readFileSync(path.join(RUN_DIR, seat, 'run.json'), 'utf8'));
  } catch {
    info = null;
  }
  const task = store.latestTask(seat);
  const scratch = (dir) => (process.platform === 'win32' ? path.resolve(dir).toLowerCase() : path.resolve(dir));
  const named = typeof info?.named === 'boolean' ? info.named : Boolean(row.cwd) && scratch(row.cwd) !== scratch(NOWHERE_DIR);
  return {
    pid: row.pid,
    opened: { seat, role: row.role, instance: row.instance, name: row.name, spec, reused: false, previous: null, fork: row.fork === true, fresh: info?.fresh === true, expert: row.fork === true ? row.parent : null },
    workDir: { dir: row.cwd ?? NOWHERE_DIR, named },
    seenNow: info?.seenNow ?? null,
    runKey: info?.runKey ?? (task ? `${seat}#${task.seq}` : `${seat}#${Date.now()}`),
    startedMs: Date.parse(info?.startedAt ?? task?.at ?? '') || Date.now(),
    taskSeq: task?.seq ?? 0,
    // The run's row in the runs table (C-6): run.json remembers it, an older daemon's runs are found by
    // their task event, and a run with no row (from before the table) simply has none to finish.
    runId: Number.isInteger(info?.runId) ? info.runId : store.runByTask(seat, task?.seq ?? 0)?.id ?? null,
    // The skill the run was started with; null when run.json is missing, and then the session it
    // leaves behind is recorded as having no skill, so its next run is handed the current one.
    skillHash: typeof info?.skillHash === 'string' ? info.skillHash : null,
    // The contract the run was started with; null for both when run.json is missing or older than the
    // record, and then the session's next run is handed the current contract once.
    contractVersion: typeof info?.contractVersion === 'string' ? info.contractVersion : null,
    contractHash: typeof info?.contractHash === 'string' ? info.contractHash : null,
  };
}

// A seat does not die with its caller: this promise can be dropped by anyone, the child keeps
// running, and the ledger keeps taking its output until the process itself exits.
// With `adopt: { seat }` no runtime is spawned: the seat's runtime was started by an earlier daemon
// and is still alive (or has just exited unseen). This run then watches its pid and, when it is gone,
// does the same post-processing a normal exit gets, from the result file the runner left.
export function runPost({ role, task, owner = null, parent = null, cwd = null, domain = null, topic = null, seat: namedSeat = null, fork = null, runner = null, onOpen = null, adopt = null } = {}) {
  let opened;
  let workDir;
  let adopted = null;
  try {
    // 2026-10-24: the caller's own fork of the expert, with its records ("context") or with none of its
    // history ("fresh"); see store.mjs openFork.
    fork = store.normalizeFork(fork);
    if (adopt) {
      adopted = describeAdoption(adopt.seat);
      opened = adopted.opened;
      workDir = adopted.workDir;
      role = opened.role;
    } else if (namedSeat !== null && namedSeat !== undefined && namedSeat !== '') {
      // Point dispatch (E-2, 2026-10-11): the caller named the expert, so nothing is chosen by
      // directory or domain. claimNamedSeat refuses (unknown, wrong role, archived, other object,
      // busy, one-shot) before anything is opened; what is left is a returning expert, and its own
      // directory (or its domain directory) is where the run works, as for any reused expert.
      opened = store.claimNamedSeat({ seat: String(namedSeat), role, cwd, domain, owner, parent, scratchDir: NOWHERE_DIR, fork });
      const row = store.seatById(opened.seat);
      workDir = row.domain
        ? { dir: row.cwd, named: true, domain: row.domain }
        : { dir: row.cwd, named: true };
      if (row.domain) {
        fs.mkdirSync(workDir.dir, { recursive: true });
      } else if (!fs.existsSync(workDir.dir)) {
        // The seat was marked open a moment ago; put it back the way it was before refusing.
        store.setSeatState({ seat: opened.seat, state: opened.previous.state });
        throw new Error(message(
          `专家「${opened.name ?? opened.seat}」的目录 ${workDir.dir} 现在不存在了：先把目录建回来再派`,
          `Directory ${workDir.dir} for expert "${opened.name ?? opened.seat}" no longer exists; restore it before dispatching`,
        ));
      }
    } else if (store.expertBy(role) === 'domain') {
      // The expert is (role, domain): cwd is not its identity and the caller must not send one; the
      // service gives the seat a fixed directory of its own. Refused before anything is opened.
      if (cwd !== null && cwd !== undefined && cwd !== '') {
        throw new Error(domainRoleRefusal(role, message(`这次带了 cwd（「${cwd}」），它不参与认专家。`, `Got cwd ("${cwd}"), which is unused for domain roles. `)));
      }
      const normalised = store.normalizeDomain(domain);
      if (!normalised) throw new Error(domainRoleRefusal(role, message('这次没有传 domain。', 'No domain was provided. ')));
      const dir = domainDir(role, normalised);
      fs.mkdirSync(dir, { recursive: true });
      workDir = { dir, named: true, domain: normalised };
      opened = store.claimDomainSeat({ role, domain: normalised, cwd: dir, owner, parent, fork });
    } else {
      if (domain !== null && domain !== undefined && domain !== '') {
        throw new Error(directoryRoleRefusal(role));
      }
      workDir = resolveSeatCwd(cwd);
      // A named directory has an expert; the scratch directory does not, so its seats stay one-shot.
      opened = workDir.named
        ? store.claimSeat({ role, owner, parent, cwd: workDir.dir, topic, fork })
        : store.openSeat({ role, owner, parent, cwd: workDir.dir, topic });
    }
  } catch (err) {
    return Promise.reject(err);
  }
  // What the seat was asked, kept in the ledger. The task used to live only in the scratch stdin
  // file, which is removed when the run ends, so a finished seat could not say what it had been for.
  // A reused seat runs many times, so a run is named by its task event, not by the seat.
  let runKey = adopted ? adopted.runKey : `${opened.seat}#${Date.now()}`;
  if (!adopted) {
    try {
      const taskEvent = store.recordEvent({ seat: opened.seat, kind: 'task', body: String(task ?? '') });
      runKey = `${opened.seat}#${taskEvent.seq}`;
      // Return the exact admitted run to asynchronous clients; a seat is reusable.
      opened.run = Number(taskEvent.seq);
      if (!workDir.named) {
        store.recordEvent({
          seat: opened.seat,
          kind: 'cwd',
          body: message(
            `调用方没有给 cwd，这个座位在 ${workDir.dir} 里跑；要它在项目目录里干活，派活时带上 cwd（绝对路径）`,
            `No cwd given; running in temporary service directory ${workDir.dir}. Pass an absolute cwd to bind an expert to a project directory.`,
          ),
        });
      } else if (workDir.domain) {
        store.recordEvent({
          seat: opened.seat,
          kind: 'cwd',
          body: message(
            `「${role}」按领域认专家（domain=${workDir.domain}）：座位的工作目录由服务给，固定在 ${workDir.dir}`,
            `"${role}" is domain-tracked (domain=${workDir.domain}); workspace fixed at ${workDir.dir}`,
          ),
        });
      }
    } catch {
      // ledger trouble must not lose the run
    }
    // The seat is in the ledger before its runtime exists. An async submitter wants that id back
    // while it still holds the caller's request, so it is offered here, synchronously.
    if (onOpen) {
      try {
        onOpen(opened);
      } catch {
        // reporting the seat must not lose the run
      }
    }
    // Who is running this seat, recorded the moment the seat exists. Only when a runner is named.
    if (runner) {
      try {
        store.recordEvent({ seat: opened.seat, kind: 'runner', body: String(runner) });
      } catch {
        // ledger trouble must not lose the run
      }
    }
  }

  return new Promise((resolve) => {
    const { seat, spec } = opened;
    const seatDir = path.join(RUN_DIR, seat);
    const resultFile = path.join(seatDir, 'result.json');

    // From here until the promise resolves this process owns the seat's ending: reconcileRunning
    // leaves it alone (a runtime that has exited while settle() still waits for the commit lock is not
    // "interrupted"), and seat_close / the timeout reach the run through `live`.
    const run = { pid: adopted ? adopted.pid : null, cancelled: null, cancelMode: null, timedOut: null, timeoutPending: null, cancelPending: null };
    live.set(seat, run);
    store.superviseSeat(seat);

    let seenNow = null;
    let sessionFile = null;
    let changeNote = '';
    // K-4: conflicts the pull before the run handed to this seat, and what it is told about them.
    let syncPending = null;
    let syncNote = '';
    let backlogNote = '';
    // C-5: the note naming the expert's records, and the newest hand-off document (SPECIALIST_SEAT_HANDOFF_FILE).
    let recordsNote = '';
    let handoffFile = '';
    // C-6: this run's row in the runs table, and what the service expected of the load when it started.
    let runId = adopted ? adopted.runId : null;
    let loadExpected = null;
    let runRowDone = false;
    let reportPath = null;
    // C-3: a fork's records go to its expert, and the fork itself is closed when its run ends.
    const expertId = opened.fork ? opened.expert : seat;
    // A fork with none of the expert's history (seat_start fork "fresh"): handed nothing of the expert's,
    // and its session never becomes the expert's.
    const freshFork = Boolean(opened.fresh);
    // The role's skill for this run: the segment file handed to the runtime ('' drops the argument
    // pair) and the content hash that the session this run leaves behind is recorded with. The same
    // record for the role contract: its version and the hash of its text (run-contract.mjs). And the
    // one notice file for a continued session ('' when none is needed): the new contract first, then
    // the new skill, so a resumed session is never handed either twice.
    let skillFile = '';
    let resumeNoticeFile = '';
    let skillHash = adopted ? adopted.skillHash : null;
    let contractVersion = adopted ? adopted.contractVersion : null;
    let contractHash = adopted ? adopted.contractHash : null;
    let startedMs = Date.now();
    const previous = opened.previous;
    const stdoutCapture = capped();
    const stderrCapture = capped();
    let tailOut = null;
    let tailErr = null;
    let timer = null;
    let timeoutTimer = null;
    let adoptPoll = null;
    const fds = [];
    let settled = false;
    let finished = false;
    let cleaned = false;

    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      clearInterval(timer);
      clearTimeout(timeoutTimer);
      clearInterval(adoptPoll);
      tailOut?.finish();
      tailErr?.finish();
      for (const fd of fds) {
        try {
          fs.closeSync(fd);
        } catch {
          // already closed
        }
      }
      try {
        fs.rmSync(seatDir, { recursive: true, force: true });
      } catch {
        // scratch files only; leaving them behind is harmless
      }
    };

    const finish = (result) => {
      if (finished) return;
      finished = true;
      live.delete(seat);
      store.superviseSeat(seat, false);
      resolve(result);
    };

    // Anything that throws outside the paths that already tolerate ledger trouble (a full disk while
    // the scratch files are made, SQLITE_BUSY in the middle of settle) ends here: the seat is
    // 'failed' with the message as an event, and the promise resolves so admit() releases its slot.
    // Before this the executor rejected with the seat still 'open', or settle's promise was dropped
    // and the slot leaked (2026-09-30 review).
    const failRun = (err) => {
      const detail = err?.message ?? String(err);
      recordQuietly(seat, 'error', message(`座位的启动或收尾出了异常：${detail}`, `Seat failed during startup or teardown: ${detail}`));
      try {
        store.setSeatState({ seat, state: 'failed' });
      } catch {
        // ledger trouble must not lose the result
      }
      settled = true;
      try {
        cleanup();
      } catch {
        // scratch files only
      }
      endRun('failed', null, null);
      finish({ seat, state: 'failed', exitCode: null, followUp: null, stdout: stdoutCapture.value(), stderr: `${detail}\n` });
    };

    // The end of a run in the runs table, and the end of a fork (C-3): however the run ends — settle,
    // or failRun when the service itself broke — its row is finished once, under its expert, with the
    // session and the report it left. A fork then hands its session to the expert when the expert is
    // not at work (whoever ends last leaves the session the next run continues; the expert's own run
    // overwrites it the same way when it ends later) and is closed: it was one run long.
    const endRun = (state, report, killedWhy) => {
      if (runRowDone) return;
      runRowDone = true;
      try {
        const left = report?.sessionFile ?? sessionFile ?? null;
        if (runId !== null) {
          const reported = typeof report?.load === 'string' && report.load ? report.load : undefined;
          store.finishRun({ id: runId, state: killedWhy ?? state, sessionFile: left, reportFile: reportPath, load: reported });
          if (reported && loadExpected && reported !== loadExpected) {
            recordQuietly(seat, 'load', message(`装载方式（以运行结果为准）：${loadWord(reported)}`, `Load mode (from runner): ${loadWord(reported)}`));
          }
        }
        if (opened.fork) {
          const expert = store.seatById(expertId);
          if (!freshFork && expert && report?.sessionFile && !killedWhy && state === 'done' && expert.state !== 'closed' && expert.state !== 'running' && expert.state !== 'open') {
            store.setSeatProfile({ seat: expertId, sessionFile: report.sessionFile, skillHash: skillHash ?? 'none', contractVersion: contractVersion ?? null, contractHash: contractHash ?? null });
            recordQuietly(expertId, 'session', message(
              `分身 ${seat} 比专家自己的这一单结束得晚（或专家当时没在跑），下一单续它的会话；另一份会话仍在记录清单里`,
              `Fork ${seat} finished after the expert's own run (or while expert was idle); next run resumes its session, and the other session remains in records`,
            ));
          }
          if (store.seatById(seat)?.state !== 'closed') {
            store.setSeatState({ seat, state: killedWhy ? 'failed' : state });
            const ending = killedWhy === 'cancelled'
              ? message('，这一单被取消', ' (cancelled)')
              : killedWhy === 'timeout'
                ? message('，这一单超时被终止', ' (timed out)')
                : state === 'done'
                  ? ''
                  : message('，这一单没有成功', ' (failed)');
            store.closeSeat({
              seat,
              reason: message(
                `${freshFork ? '不带上下文的分身' : '分身'}跑完，记录归入 ${expertId}${ending}`,
                `${freshFork ? 'Fresh fork' : 'Fork'} completed; records filed under ${expertId}${ending}`,
              ),
            });
          }
        }
      } catch {
        // ledger trouble must not lose the result
      }
    };

    const settle = async (state, exitCode, extraStderr = '') => {
      if (settled) return;
      settled = true;
      // Wait for an in-flight cancel or timeout kill to finish and record its event before moving
      // the seat to its final state (or rolling back if the kill failed / process already exited).
      if (run.cancelPending) await run.cancelPending;
      if (run.timeoutPending) await run.timeoutPending;
      // A run the service killed (timeout) is a failure whatever exit code the kill produced; a run
      // seat_close cancelled keeps the seat closed (the state write below cannot move it). Both skip
      // what only a finished run earns: the commit, the follow-up and the saved profile.
      const cancelled = () => run.cancelled !== null;
      const killed = () => cancelled() || run.timedOut !== null;
      if (run.timedOut !== null && !cancelled()) state = 'failed';
      // The runner's own report, read before cleanup removes the seat's scratch directory.
      let report = null;
      try {
        report = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
      } catch {
        report = null;
      }
      // The runner's final answer, kept apart from the stdout lines (where it sits between tool-call
      // echoes) in a file of its own next to the ledger: task_result and seat_show read it back, and
      // hand its path to a caller whose budget it exceeds (2026-10-01). Written before the exit event,
      // so whoever sees the run end can already read it.
      const runSeq = Number(String(runKey).split('#').pop());
      if (typeof report?.report === 'string' && report.report.trim() && Number.isInteger(runSeq)) {
        try {
          reportPath = store.saveReport({ seat, run: runSeq, text: report.report.trim() });
        } catch (err) {
          recordQuietly(seat, 'note', message(
            `这一单的报告没能单独存成文件（${err.message}）；task_result 会改从输出里取最后一段。`,
            `Could not save full report file (${err.message}); task_result will fall back to stdout tail.`,
          ));
        }
      }
      cleanup();
      // What the service does on the seat's behalf once it finished well: commit for a role without
      // git, and name the follow-up a role declares (the daemon admits it like any other request).
      let followUp = null;
      let baseline = seenNow;
      if (state === 'done' && workDir.named && !killed()) {
        if (spec.commit_after_run) {
          if (spec.sync_remote) removeConflictCopies(workDir.dir);
          if (spec.move_plan) {
            const moved = await applyMovePlan(workDir.dir, spec.move_plan);
            if (moved) recordQuietly(seat, 'move', moved);
          }
          recordQuietly(seat, 'commit', await commitInside(workDir.dir, opened.name ?? seat, spec.commit_lock ?? null));
          baseline = (await afterOwnCommit(workDir.dir, seenNow, opened.name ?? seat)) ?? seenNow;
          if (spec.sync_remote) {
            const pushed = await pushAfterCommit(workDir.dir, spec.commit_lock ?? null, syncPending, seenNow?.head ?? null);
            if (pushed) recordQuietly(seat, 'sync', pushed);
          }
        } else if (spec.grant?.some((g) => g === 'write' || g === 'shell')) {
          // A seat that can write or run commands changes the directory itself (edits, its own git
          // commits). Keeping the pre-run state as the baseline showed it those edits as outside
          // changes on its next visit, and past 20 files threw away its session (2026-09-30 review).
          // So the state after the run is what it has now seen. What others change while it runs is
          // absorbed too, which cannot be told apart from its own edits; a read-only seat keeps the
          // pre-run baseline, so there the difference stays visible, and so does the librarian's, whose
          // own commit is recognised above precisely so that other people's commits are not swallowed.
          // A run that a session without the seat's history finished after the seat was stopped halfway
          // (report.takeover, cli-runner.mjs) keeps the pre-run baseline: the session the seat continues
          // next time never saw the takeover's edits, so its next visit lists them as changes.
          baseline = report?.takeover ? seenNow : (await dirState(workDir.dir)) ?? seenNow;
        }
        const next = spec.followed_by;
        const headAfter = ((await git(workDir.dir, ['rev-parse', 'HEAD'])) ?? '').trim();
        if (!cancelled() && next?.role && next.when === 'new_commits' && seenNow?.head && headAfter && headAfter !== seenNow.head) {
          const nextDir = path.resolve(workDir.dir, next.cwd ?? '.');
          if (!fs.existsSync(nextDir)) {
            recordQuietly(seat, 'follow', message(`该由 ${next.role} 接着整理，但目录 ${nextDir} 不存在，没有派`, `Skipped follow-up for ${next.role}: directory ${nextDir} does not exist`));
          } else if (store.runningIn({ role: next.role, cwd: nextDir })) {
            recordQuietly(seat, 'follow', message(`${next.role} 正在 ${nextDir} 整理，这次的新提交会在它下次来时一并看到`, `${next.role} is already running in ${nextDir}; new commits will be seen next visit`));
          } else {
            followUp = {
              role: next.role,
              cwd: nextDir,
              task: `例行整理：「${opened.name ?? seat}」刚写了新笔记（${String(seenNow.head).slice(0, 7)}..${headAfter.slice(0, 7)}）。`,
            };
            recordQuietly(seat, 'follow', message(`已请 ${next.role} 到 ${nextDir} 整理这次的新笔记`, `Queued follow-up for ${next.role} in ${nextDir}`));
          }
        }
      }
      recordDifficulties(seat, runKey, role, workDir.dir, state, report, {
        cancelled: cancelled(),
        failedDetail: run.timedOut !== null && !cancelled() ? message(`运行超时被终止：${run.timedOut}`, `Terminated on timeout: ${run.timedOut}`) : null,
        expert: expertId,
      });
      if (report?.takeover) recordQuietly(seat, 'takeover', takeoverText(report.takeover));
      if (report) {
        try {
          if (report.tokens) recordQuietly(seat, 'usage', usageLine(report));
          // A killed run never answered the closing question, and what it left in the result file may
          // be only the checkpoint written before it: it says nothing about what is left undone, so
          // the profile and the backlog stay as the last complete run left them.
          if (!killed()) {
            // Only a string is an answer. A report without the field (an older runner), or with null (a
            // closing question that failed or got no usable reply: "unknown"), leaves the backlog as it
            // was; an empty string clears it, because the seat said nothing is left. Unknown must never
            // look like "nothing left" (2026-09-30 review: it used to).
            const backlog = typeof report.backlog === 'string' ? report.backlog.trim() || null : undefined;
            if (backlog) recordQuietly(seat, 'backlog', message(`它报告没做完的部分：\n${backlog.slice(0, 2000)}`, `Reported backlog:\n${backlog.slice(0, 2000)}`));
            store.setSeatProfile({
              seat,
              sessionFile: report.sessionFile ?? undefined,
              // Whatever session the run ended in has seen this run's skill: a fresh one in its system
              // prompt, a continued one through the notice (or it had the same one already), a pi one
              // because seat-runner rebuilds the prompt every run. No session reported, nothing to note.
              skillHash: report.sessionFile ? skillHash ?? 'none' : undefined,
              // The contract the same way. Null for both (it carried none, or an adopted run whose
              // start is not known) makes the session's next run hand the current contract over once.
              contractVersion: report.sessionFile ? contractVersion ?? null : undefined,
              contractHash: report.sessionFile ? contractHash ?? null : undefined,
              // A run that ended in an error report did not work through what it was shown: the
              // baseline stays, so the same changes are listed again on its next visit (2026-09-30
              // review: a runtime failing early used to swallow 364 changed files).
              dirState: report.error || state !== 'done' ? undefined : baseline ?? undefined,
              expertise: typeof report.expertise === 'string' && report.expertise.trim() ? report.expertise.trim() : undefined,
              backlog,
            });
          }
        } catch {
          // ledger trouble must not lose the result
        }
      }
      try {
        store.recordEvent({ seat, kind: 'exit', body: exitCode === null ? 'null' : String(exitCode) });
        // setSeatState leaves a closed seat closed, so a close-cancelled run cannot come back as
        // done/failed. A task_cancel, by contrast, leaves the expert living and idle: it goes back to
        // 'done' (available for the next task) rather than to 'closed'.
        const seatState = run.cancelMode === 'close' ? 'closed' : run.cancelMode === 'task' ? 'done' : state;
        store.setSeatState({ seat, state: seatState });
      } catch {
        // ledger trouble must not lose the result
      }
      endRun(state, report, cancelled() ? 'cancelled' : run.timedOut !== null ? 'timeout' : null);
      finish({
        seat,
        state: run.cancelMode === 'close' ? 'closed' : run.cancelMode === 'task' ? 'done' : state,
        exitCode,
        followUp,
        stdout: stdoutCapture.value(),
        stderr: `${stderrCapture.value()}${extraStderr}`,
      });
    };
    const settleSafely = (state, exitCode, extraStderr = '') => settle(state, exitCode, extraStderr).catch(failRun);

    // The run's clock. Armed once the runtime exists; an adopted run counts from its real start.
    const armTimeout = (afterMs) => {
      timeoutTimer = setTimeout(onTimeout, Math.min(Math.max(afterMs, 0), MAX_TIMER_MS));
    };
    const onTimeout = () => {
      if (settled || finished) return;
      const limitMs = timeoutMinutes(spec) * 60000;
      const ranWords = durationWords(Date.now() - startedMs);
      const prevTimedOut = run.timedOut;
      run.timedOut = message(`跑了 ${ranWords}，上限 ${durationWords(limitMs)}`, `ran ${ranWords}, limit ${durationWords(limitMs)}`);
      run.timeoutPending = (async () => {
        const killedTree = await killTree(run.pid);
        if (!killedTree.ok) {
          run.timedOut = prevTimedOut;
          if (settled || finished) return;
          recordQuietly(seat, 'error', message(
            `这一单已经跑了 ${ranWords}，超过上限 ${durationWords(limitMs)}，但结束它的进程树失败了（${killedTree.detail}）。一分钟后再试一次。`,
            `Run reached ${ranWords} (limit ${durationWords(limitMs)}), but failed to kill process tree (${killedTree.detail}); retrying in 1 min.`,
          ));
          armTimeout(60000);
          return;
        }
        // Already gone: it is exiting on its own and settle() will see the real outcome.
        if (killedTree.alreadyGone) {
          run.timedOut = prevTimedOut;
          return;
        }
        recordQuietly(seat, 'timeout', message(
          `这一单跑了 ${ranWords}，超过这个岗位的上限 ${durationWords(limitMs)}，已结束它的进程树（pid ${run.pid}），记为失败。要让它一次跑更久，在 roles.json 里给这个岗位加 timeout_minutes。`,
          `Timed out after ${ranWords} (limit ${durationWords(limitMs)}); terminated process tree (pid ${run.pid}) and marked failed. Increase timeout_minutes in roles.json if needed.`,
        ));
      })().finally(() => {
        run.timeoutPending = null;
      });
      return run.timeoutPending;
    };

    // The launch is asynchronous because the directory questions it asks git are (see git() above): a
    // synchronous chain here froze the daemon's whole event loop while /seat/start was being answered.
    // Everything that throws still ends in failRun, exactly as when this was a plain try block.
    void (async () => {
      try {
        if (!adopted) {
          fs.mkdirSync(seatDir, { recursive: true });
          // A result file left by an earlier run that never settled must not pass for this run's report.
          fs.rmSync(resultFile, { force: true });

          // Which session this run lives in. A returning expert continues the one it has, told what moved in
          // the directory since, however much that is (C-2, 2026-10-11: the old "moved too far, start over"
          // rule is gone); a first visit starts a new one. A domain expert is not a directory expert: it
          // continues its session and no change note applies (directory logic off for domain seats).
          // A fork (C-3) continues a copy of the expert's pi session; for any other backend it gets no
          // session and is handed the expert's records (forkSessionCopy says why).
          if (spec.sync_remote && workDir.named && !workDir.domain) {
            // Before the state is taken, so what the other machines pushed shows up in the change note.
            const pulled = await pullBeforeRun(workDir.dir, spec.commit_lock ?? null);
            if (pulled.event) recordQuietly(seat, 'sync', pulled.event);
            syncPending = pulled.pending;
            if (syncPending) syncNote = conflictNote(syncPending);
          }
          seenNow = workDir.named && !workDir.domain ? await dirState(workDir.dir) : null;
          if (freshFork) {
            recordQuietly(seat, 'session', message(
              `不带上下文的分身：新开一个会话，不续专家 ${expertId} 的会话，也不给它专家的记录、交接、专长说明和未完成清单；跑完记录归入专家，专家下一单仍续它自己的会话`,
              `Fresh fork: new clean session without ${expertId}'s session, records, hand-off, expertise, or backlog; findings file back to ${expertId}`,
            ));
          } else if (opened.reused && previous?.session_file && fs.existsSync(previous.session_file)) {
            const forkCopy = opened.fork ? forkSessionCopy(previous.session_file, path.join(SESSION_DIR, seat)) : null;
            sessionFile = opened.fork ? forkCopy : previous.session_file;
            if (!workDir.domain) {
              const change = await dirChange(workDir.dir, previous.dir_state, seenNow, path.join(seatDir, 'changes.txt'));
              changeNote = change.note;
            }
            const where = workDir.domain
              ? message('；这个岗位按领域认专家，不比较目录', '; domain-tracked role, directory diff skipped')
              : changeNote
                ? message('，并告诉它目录里变了什么', '; directory changes attached')
                : message('，目录没有变化', '; no directory changes');
            if (!opened.fork) {
              recordQuietly(seat, 'session', message(`接着上次的会话${where}`, `Continuing prior session${where}`));
            } else if (forkCopy) {
              recordQuietly(seat, 'session', message(
                `分身：接着专家 ${expertId} 的会话，复制了一份来续，不动专家正在写的那份${where}`,
                `Fork: continuing from a copy of ${expertId}'s session without touching the active session${where}`,
              ));
            } else {
              recordQuietly(seat, 'session', message(
                `分身：专家 ${expertId} 的会话不能让两个进程同时写，这一单不续它，另开会话，专家的记录交给它读${where}`,
                `Fork: started fresh session with ${expertId}'s records attached (backend session cannot be shared concurrently)${where}`,
              ));
            }
          } else if (workDir.named) {
            recordQuietly(seat, 'session', opened.fork
              ? message(
                `分身：专家 ${expertId} 还没有可续的会话（它在跑第一单），新开一个会话；已有的记录列在任务前面`,
                `Fork: ${expertId} has no saved session yet; starting a fresh session with prior records attached`,
              )
              : workDir.domain
                ? message('这个领域第一次来，新开一个会话', 'First visit for this domain; starting a fresh session')
                : message('这个目录第一次来，新开一个会话', 'First visit for this directory; starting a fresh session'));
          }
          // C-5: where the expert's raw records are, written in front of everything else in the task. Read
          // before this run's own row exists, so the newest-ten window holds finished runs only.
          const records = freshFork ? { entries: [], handoff: '' } : store.expertRecords(expertId);
          recordsNote = recordsNoteFor(records);
          handoffFile = records.handoff ?? '';
          // C-6: the run's row, with the load the service expects; the runner's report corrects it at the end.
          // A fresh fork starts with nothing by request: it counts with the new objects, not as a blank start
          // on an expert that had records.
          const hadRecords = freshFork ? false : store.expertHasRecords(expertId);
          loadExpected = sessionFile ? 'resumed' : hadRecords ? 'loaded' : 'fresh';
          try {
            const taskSeq = Number(String(runKey).split('#').pop());
            runId = store.startRun({ seat, expert: expertId, taskSeq: Number.isInteger(taskSeq) ? taskSeq : null, load: loadExpected, hadRecords });
            recordQuietly(seat, 'load', message(`装载方式：${loadWord(loadExpected)}`, `Load mode: ${loadWord(loadExpected)}`));
          } catch {
            // ledger trouble must not lose the run
          }
          // What this seat said it left undone last time goes in front of the new task (closing.mjs).
          // A fork does not take the expert's undone list: the expert is working through it in its own run.
          backlogNote = previous?.backlog && !opened.fork ? backlogNoteFor(previous.backlog, path.join(seatDir, 'backlog.txt')) : '';
          if (backlogNote) {
            recordQuietly(seat, 'backlog', message('把它上次报告没做完的部分放在这次任务前面', 'Prepended unfinished backlog from previous run'));
          }

          // The role's skill (architecture 4.5), read from HSkills at every start, so an enabled version
          // reaches the next run without a restart. Its body goes into a file in this seat's own run
          // directory and roles.json's `{skill}` names that file: a body can run to 500 lines, too long
          // for a Windows command line. cli-runner keeps it off the next command line too: Codex, Grok
          // and Claude get their whole prompt on stdin or in a file (its header), pi reads the file. A
          // run that continues a session started with another skill gets a notice file too; cli-runner
          // puts it in front of the task only when Codex, Grok or Claude actually resume that session
          // (a fresh session has the skill in its system prompt already, and pi rebuilds its system
          // prompt every run). What the run carried is a seat event (I4). A role without a skill file
          // runs without one, and so does every role when HSkills has no skills directory where the
          // resolver points (the event says which, and where the location came from); a file that
          // exists and cannot be read throws, and failRun ends the seat with the reason.
          //
          // The role contract gets the same treatment (run-contract.mjs), and goes first: the version and
          // text hash recorded for the session this run continues decide whether that session is handed
          // the current contract in full; a session from before the record counts as changed once. Its
          // record is a `contract` event. The two notices share one file, contract first, so cli-runner
          // adds one prefix and a resumed run never gets either twice.
          const contract = runContract(role, spec);
          contractVersion = contract.version;
          contractHash = contract.hash;
          const resumedContract = sessionFile ? { version: previous?.contract_version ?? null, hash: previous?.contract_hash ?? null } : null;
          const notices = [];
          if (resumedContract !== null && contractChanged(contract, resumedContract)) notices.push(contractNoticeText(contract, resumedContract));
          recordQuietly(seat, 'contract', contractEventText(contract, resumedContract));
          if ((spec.spawn?.args ?? []).some((arg) => typeof arg === 'string' && arg.includes('{skill}'))) {
            const skill = runSkill(role);
            skillHash = skill.hash;
            const resumedHash = sessionFile ? previous?.skill_hash ?? 'none' : null;
            if (skill.body) {
              skillFile = path.join(seatDir, 'skill.md');
              fs.writeFileSync(skillFile, skillSegmentText(skill), 'utf8');
            }
            if (resumedHash !== null && resumedHash !== skill.hash) notices.push(skillNoticeText(skill, resumedHash));
            recordQuietly(seat, 'skill', skillEventText(skill, { resumedHash }));
          } else {
            skillHash = 'none';
            recordQuietly(seat, 'skill', message(
              `这一单没有带 skill（记为 none）：${role} 在 roles.json 里的启动参数没有 {skill} 占位符。`,
              `No skill attached for this run (none): ${role}'s spawn args in roles.json have no {skill} placeholder.`,
            ));
          }
          if (notices.length) {
            resumeNoticeFile = path.join(seatDir, 'resume-notice.md');
            fs.writeFileSync(resumeNoticeFile, notices.join('\n\n---\n\n'), 'utf8');
          }
          startedMs = Date.now();
          // What a daemon that adopts this run after a restart cannot recompute: the directory as this
          // run first saw it, the run's name, and the skill and contract it was started with. Best
          // effort; adoption copes without the file.
          try {
            fs.writeFileSync(path.join(seatDir, 'run.json'), `${JSON.stringify({ runKey, runId, named: workDir.named, seenNow, startedAt: new Date(startedMs).toISOString(), skillHash, contractVersion, contractHash, fresh: freshFork })}\n`);
          } catch {
            // adoption falls back to the ledger
          }
        } else {
          seenNow = adopted.seenNow;
          startedMs = adopted.startedMs;
        }
        // seat_close can arrive while git was being asked about the directory: the seat has no pid
        // yet, so closeSeatNow could only mark the run cancelled. Do not start a runtime for a seat
        // that has been closed.
        if (run.cancelled !== null) {
          const opener = run.cancelMode === 'task' ? 'task_cancel' : 'seat_close';
          const why = run.cancelled.reason ? message(`原因：${run.cancelled.reason}。`, `Reason: ${run.cancelled.reason}.`) : '';
          recordQuietly(seat, 'cancelled', message(
            `座位在运行时启动之前就被 ${opener} 取消，没有启动它。${why}`,
            `Cancelled by ${opener} before runtime launched; skipped launch. ${why}`,
          ).trim());
          settleSafely('failed', null);
          return;
        }
        const stdinFile = path.join(seatDir, 'stdin.json');
        const stdoutFile = path.join(seatDir, 'stdout.log');
        const stderrFile = path.join(seatDir, 'stderr.log');

        if (!adopted) {
          // A runtime that already takes the task in argv must get an empty stdin. pi -p folds piped
          // stdin into the first user message, so this envelope reached the model a second time, with the
          // contract as a path relative to this repository: a seat standing in a project went looking for
          // roles/<role>.md there and reported it missing (seat-explorer-32, 2026-09-22).
          const taskInArgv = (spec.spawn.args ?? []).some((arg) => typeof arg === 'string' && arg.includes('{task}'));
          fs.writeFileSync(stdinFile, taskInArgv ? '' : `${JSON.stringify({ role, task, contract: spec.contract })}\n`);
          fs.writeFileSync(stdoutFile, '');
          fs.writeFileSync(stderrFile, '');
        }

        // An adopted run's earlier output is already in the ledger: read past it, record what follows.
        tailOut = makeTail(stdoutFile, seat, 'stdout', stdoutCapture, adopted ? store.countEventsAfter({ seat, kind: 'stdout', seq: adopted.taskSeq }) : 0);
        tailErr = makeTail(stderrFile, seat, 'stderr', stderrCapture, adopted ? store.countEventsAfter({ seat, kind: 'stderr', seq: adopted.taskSeq }) : 0);
        timer = setInterval(() => {
          tailOut.drain();
          tailErr.drain();
        }, POLL_MS);

        if (adopted) {
          recordQuietly(seat, 'note', message(
            `daemon 重启后接管了这个座位（pid ${run.pid}）：等它的进程结束，再按它留下的结果文件做收尾（结果、专长、未完成清单、用量、提交）。`,
            `Adopted seat after daemon restart (pid ${run.pid}); waiting for process exit to settle outputs, expertise, backlog, usage, and commits.`,
          ));
          armTimeout(timeoutMinutes(spec) * 60000 - (Date.now() - startedMs));
          const check = () => {
            if (pidAlive(run.pid)) return;
            clearInterval(adoptPoll);
            // The exit code died with the previous daemon. The result file says how far the run got:
            // a report without an error means the runner finished (exit 0 inferred), an error means it
            // failed, and no report at all means the runtime was killed before it wrote one.
            let report = null;
            try {
              report = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
            } catch {
              report = null;
            }
            if (report && !report.error) {
              recordQuietly(seat, 'note', message(
                '被接管的运行结束了；它的退出码已经随上一个 daemon 丢失，按结果文件里没有报错推断为成功退出（0）。',
                'Adopted run exited; exit code was lost with previous daemon, inferred success (0) because result file has no error.',
              ));
              settleSafely('done', 0);
            } else if (report) {
              settleSafely('failed', null);
            } else {
              settleSafely('interrupted', null);
            }
          };
          check();
          if (!settled) adoptPoll = setInterval(check, ADOPT_POLL_MS);
          return;
        }

        const stdinFd = fs.openSync(stdinFile, 'r');
        fds.push(stdinFd);
        const stdoutFd = fs.openSync(stdoutFile, 'a');
        fds.push(stdoutFd);
        const stderrFd = fs.openSync(stderrFile, 'a');
        fds.push(stderrFd);

        // The post's own memory, composed before it starts. Ledger trouble must not lose a run:
        // no memory is better than no seat.
        let memory = '';
        try {
          memory = store.memoryDigest(role);
        } catch {
          memory = '';
        }

        let child;
        try {
          // The task reaches the runtime either on stdin (this file writes it there) or in argv.
          // Every CLI agent we have takes the prompt as an argument (pi -p, claude -p, codex exec,
          // opencode run), so roles.json can only stay "one line of data" if it can name the task.
          // `{task}`, `{role}`, `{contract}`, `{seat}`, `{skill}`, `{memory}`, `{runtime}` and `{root}`
          // are substituted; anything else passes through. `{runtime}` is the machine-local one — the
          // spec names it, the code resolves it (role-contract.mjs), which is what keeps roles.json
          // portable. `{root}` is this repository, so a role's prompt can name one of its tools by
          // absolute path (web_researcher's tools/web-search.mjs, 2026-09-29) while the seat stands
          // elsewhere. `{skill}` is the absolute path of the skill segment written above, or empty.
          // L-1/L-3: a merged-from expert's hand-off is prepended to exactly this task, then the marker
          // is cleared, so the next task goes on without it.
          let handoffNoteBlock = '';
          try {
            const marker = store.takePendingHandoff(seat);
            if (marker) {
              handoffNoteBlock = pendingHandoffNote(marker);
              recordQuietly(seat, 'handoff', message(
                `本单任务前面附了来自 ${marker.from ?? '?'} 的交接文档（${marker.file}）`,
                `Prepended hand-off document from ${marker.from ?? '?'} (${marker.file})`,
              ));
            }
          } catch { handoffNoteBlock = ''; }
          const notes = [handoffNoteBlock, recordsNote, backlogNote, changeNote, syncNote].filter(Boolean);
          const told = notes.length ? `${notes.join('\n\n')}\n\n任务：\n${task}` : task;
          const values = { task: told, role, contract: spec.contract, seat, skill: skillFile, memory, runtime: resolveRuntime().runtime, root: ROOT.split(path.sep).join('/') };
          // roles.json names the contract relative to this repository, and the runtime reads that
          // argument as a file only if it exists from where it stands — otherwise it silently takes
          // the path itself as the prompt text. The seat no longer stands in ROOT, so the contract is
          // handed over as an absolute path.
          const contractFile = path.resolve(ROOT, spec.contract);
          // The runner script is named the same way, relative to this repository, for the same reason.
          const expanded = (spec.spawn.args ?? [])
            .map((arg) => (arg === spec.contract ? contractFile : arg))
            .map((arg) => (typeof arg === 'string' && /^src\/[\w.-]+\.mjs$/.test(arg) ? path.join(ROOT, arg) : arg))
            .map((arg) =>
            typeof arg === 'string'
              ? arg.replace(/\{(task|role|contract|seat|skill|memory|runtime|root)\}/g, (whole, key) => (values[key] === undefined ? whole : String(values[key])))
              : arg);
          // A role with no memory yet composes to an empty string, and so does a role with no skill.
          // Dropping the empty entry alone is not enough: `["--append-system-prompt", "", "-p", task]`
          // would become `["--append-system-prompt", "-p", task]`, handing `-p` to that flag as its
          // value. An empty expansion therefore takes its flag with it.
          const args = [];
          for (const arg of expanded) {
            if (arg === '') {
              const previousArg = args[args.length - 1];
              if (typeof previousArg === 'string' && previousArg.startsWith('-')) args.pop();
              continue;
            }
            args.push(arg);
          }
          const sessionDir = path.join(SESSION_DIR, seat);
          fs.mkdirSync(sessionDir, { recursive: true });

          // The runner's task can contain service notes and a historical backlog.  Its closing question
          // needs the original user task instead, so pass that small, per-run JSON file by path rather
          // than adding a potentially huge brief to the Windows environment block.
          const closingContextFile = `${resultFile}.closing.json`;
          fs.mkdirSync(path.dirname(closingContextFile), { recursive: true });
          fs.writeFileSync(closingContextFile, `${JSON.stringify({
            task,
            backlog: typeof previous?.backlog === 'string' ? previous.backlog : null,
          })}\n`, 'utf8');

          // A brief big enough to pass the platform's command-line limit never starts: the seat dies
          // with ENAMETOOLONG, no report, nothing the dispatcher can act on (2026-10-05: a 30k-character
          // read-only brief, seat-explorer-46). Hand the task over as a file instead — the runner takes
          // it either way, and the prompt it composes never goes on a command line (cli-runner.mjs,
          // header). Only if it is still over budget does the run refuse, and then in words.
          const tooLong = overBudget(spec.spawn.command, args);
          if (tooLong !== null) {
            const at = args.findIndex((arg, index) => index > 0 && args[index - 1] === '-p' && arg === values.task);
            if (at < 1) {
              throw new Error(tooLongMessage(tooLong, message('这个岗位的 spawn 参数里没有可以直接改成文件的 -p {task}', 'No replaceable -p {task} flag found in this role\'s spawn args')));
            }
            const file = path.join(sessionDir, 'task.md');
            fs.writeFileSync(file, values.task);
            args[at - 1] = '--task-file';
            args[at] = file;
            recordQuietly(seat, 'note', message(
              `任务正文 ${values.task.length} 字符，超过${ARGV_BUDGET.where()}；这一单改为从文件交给岗位：${file}`,
              `Task text (${values.task.length} chars) exceeds ${ARGV_BUDGET.where()}; passed via file instead: ${file}`,
            ));
            const still = overBudget(spec.spawn.command, args);
            if (still !== null) {
              throw new Error(tooLongMessage(still, message('任务改成文件之后仍然过长，说明别的参数太大（例如这个岗位的记忆正文）', 'Command line is still too long even after offloading the task to a file; another argument (e.g. role memory) is oversized')));
            }
          }

          child = spawn(spec.spawn.command, args, {
            cwd: workDir.dir,
            env: {
              ...process.env,
              SPECIALIST_SEAT_NAME: opened.name ?? seat,
              // R-6: the seat id itself; cli-runner hands it to the backends it starts, and the MCP
              // bridge a backend starts reports it with a dispatch so the daemon knows who asks.
              SPECIALIST_SEAT_ID: seat,
              SPECIALIST_SEAT_SESSION_FILE: sessionFile ?? '',
              // C-1 / C-5: the newest hand-off document of the expert ('' when it has none).
              SPECIALIST_SEAT_HANDOFF_FILE: handoffFile,
              // A fork of a session no copy can serve (Codex, Claude, Grok): the expert's session file, to
              // read as records. Not a session to continue.
              SPECIALIST_SEAT_RECORD_FILE: opened.fork && !sessionFile ? previous?.session_file ?? '' : '',
              // What this expert said it knows last time. A runner that cannot continue the old session
              // (codex-runner switching between Codex and DeepSeek) hands it to the fresh one.
              SPECIALIST_SEAT_EXPERTISE: previous?.expertise ?? '',
              SPECIALIST_SEAT_SESSION_DIR: sessionDir,
              SPECIALIST_SEAT_RESULT: resultFile,
              SPECIALIST_SEAT_CLOSING_CONTEXT: closingContextFile,
              // The new contract and the new skill for a continued session that was given others (one
              // file path, empty when none is needed). The runner decides where it goes; see cli-runner.mjs.
              SPECIALIST_SEAT_RESUME_NOTICE: resumeNoticeFile,
              // A fresh fork: the runner starts it with no history whatever else it finds (cli-runner.mjs freshNote).
              SPECIALIST_SEAT_FRESH: freshFork ? '1' : '',
            },
            shell: false,
            windowsHide: true,
            // POSIX only: the runtime leads its own process group, so killTree can signal the group and
            // take the runner's grandchildren with it. Never on Windows, where `detached` opens a console
            // window and changes the child's lifetime; taskkill /T walks the tree there.
            detached: process.platform !== 'win32',
            stdio: [stdinFd, stdoutFd, stderrFd],
          });
        } catch (err) {
          try {
            store.recordEvent({ seat, kind: 'error', body: err.message });
            store.setSeatState({ seat, state: 'failed' });
          } catch {
            // ledger trouble must not lose the result
          }
          settleSafely('failed', null, `${err.message}\n`);
          return;
        }

        run.pid = child.pid ?? null;
        if (run.pid !== null) armTimeout(timeoutMinutes(spec) * 60000);

        child.once('spawn', () => {
          try {
            store.bindSeat({ seat, handle: 'pid', pid: child.pid });
          } catch {
            // the seat row is gone; the child keeps running anyway
          }
        });

        child.once('error', (err) => {
          try {
            store.recordEvent({ seat, kind: 'error', body: err.message });
          } catch {
            // ledger trouble must not lose the result
          }
          settleSafely('failed', null, `${err.message}\n`);
        });

        child.once('close', (code) => {
          settleSafely(code === 0 ? 'done' : 'failed', code);
        });
      } catch (err) {
        failRun(err);
      }
    })();
  });
}
