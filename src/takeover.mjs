// What a run changed in its working directory, for the run that stops halfway (2026-10-24).
//
// A backend that is stopped after it has already used tools leaves the directory half done: on
// 2026-10-24 three Claude coder runs were stopped by the model's safety filter within a minute
// (model_refusal_no_fallback), one of them with compact-pointer.js cut off in the middle of a function.
// The dispatcher was told only to go and look at the seat's events and the directory. The runner now
// takes a snapshot of the directory when the run starts and, when a backend stops halfway, lists the
// files that changed since: the path relative to the working directory and, where git can say, the
// lines added and removed. The list goes into the result and into the brief of the session that takes
// the task over (cli-runner.mjs, takeOver).
//
// Synchronous on purpose: this runs in the runner's own process, between two backends, where nothing
// else is waiting on the event loop.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { message } from './presets.mjs';

// A file larger than this is compared by size and modification time instead of its content.
const HASH_LIMIT = 4 * 1024 * 1024;
// Outside git the directory is walked for files modified since the start; this many entries at most.
const WALK_LIMIT = 50000;
const SKIP_DIRS = new Set(['.git', 'node_modules', '.worktrees']);
// How many changed files the text lists by name; the rest are counted.
export const LIST_CAP = 50;

function git(cwd, args) {
  try {
    return execFileSync('git', ['-C', cwd, '-c', 'core.quotepath=false', ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      timeout: 15000,
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

function signature(file) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return 'other';
    if (stat.size > HASH_LIMIT) return `size:${stat.size}:${stat.mtimeMs}`;
    return createHash('sha1').update(fs.readFileSync(file)).digest('hex');
  } catch {
    return 'gone';
  }
}

// `git status --porcelain -z`: "XY path\0", a rename or copy followed by its old path as one more field.
// Paths are relative to the repository's top level, whatever directory git was asked from.
function dirtyPaths(cwd) {
  const out = git(cwd, ['status', '--porcelain=v1', '-z', '-uall', '--', '.']);
  if (out === null) return null;
  const fields = out.split('\0');
  const paths = [];
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    if (field.length < 4) continue;
    const xy = field.slice(0, 2);
    paths.push({ path: field.slice(3), untracked: xy === '??' });
    if (xy[0] === 'R' || xy[0] === 'C') i += 1;
  }
  return paths;
}

// The directory as the run found it. In git: HEAD and every dirty path with a signature of its content,
// so a file that was already dirty and is changed again still counts. Outside git: the time only.
export function worktreeSnapshot(cwd) {
  const at = Date.now();
  const top = (git(cwd, ['rev-parse', '--show-toplevel']) ?? '').trim();
  const head = (git(cwd, ['rev-parse', 'HEAD']) ?? '').trim();
  const dirty = top && head ? dirtyPaths(cwd) : null;
  if (!dirty) return { git: false, at };
  const entries = {};
  for (const item of dirty) entries[item.path] = signature(path.join(top, item.path));
  return { git: true, at, top, head, entries };
}

function relativeToCwd(cwd, top, file) {
  return path.relative(cwd, path.join(top, file)).split(path.sep).join('/');
}

function lineCount(file) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > HASH_LIMIT) return null;
    const text = fs.readFileSync(file, 'utf8');
    if (text.includes('\0')) return null;
    if (!text) return 0;
    return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
  } catch {
    return null;
  }
}

function walkChanged(cwd, since) {
  const files = [];
  const stack = [cwd];
  let seen = 0;
  let truncated = false;
  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (++seen > WALK_LIMIT) {
        truncated = true;
        break;
      }
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) stack.push(full);
        continue;
      }
      try {
        if (fs.statSync(full).mtimeMs >= since) files.push({ path: path.relative(cwd, full).split(path.sep).join('/'), added: null, removed: null });
      } catch {
        // gone while walking
      }
    }
    if (truncated) break;
  }
  return { truncated, files };
}

// What changed between the snapshot and now. Each file: { path (relative to cwd), added, removed,
// binary?, deleted?, dirtyBefore? }; added/removed are null when they cannot be counted.
export function changedFiles(cwd, before) {
  if (!before) return { git: false, files: [], unknown: true };
  if (!before.git) {
    // A second's slack: some file systems keep modification times at a coarse resolution.
    const walked = walkChanged(cwd, before.at - 1000);
    return { git: false, files: walked.files.sort((a, b) => a.path.localeCompare(b.path)), truncated: walked.truncated };
  }
  const now = worktreeSnapshot(cwd);
  if (!now.git) return { git: true, files: [], unknown: true };
  const changed = new Set();
  for (const [file, sig] of Object.entries(now.entries)) if (before.entries[file] !== sig) changed.add(file);
  for (const file of Object.keys(before.entries)) if (!(file in now.entries)) changed.add(file);
  // Commits made during the run (a role that commits its own work).
  if (now.head !== before.head) {
    const names = git(cwd, ['diff', '--name-only', '-z', before.head, now.head, '--', '.']);
    for (const file of (names ?? '').split('\0').filter(Boolean)) changed.add(file);
  }
  if (!changed.size) return { git: true, files: [], headMoved: now.head !== before.head };
  // Lines against the HEAD the run started from, for the tracked files; an untracked file is all added.
  const numstat = {};
  const list = [...changed];
  for (let i = 0; i < list.length; i += 200) {
    const chunk = list.slice(i, i + 200).map((file) => `:(top,literal)${file}`);
    const out = git(cwd, ['diff', '--numstat', '-z', before.head, '--', ...chunk]) ?? '';
    // -z numstat: "added\tremoved\tpath\0" (renames are not detected without -M).
    for (const row of out.split('\0').filter(Boolean)) {
      const [added, removed, ...rest] = row.split('\t');
      numstat[rest.join('\t')] = { added, removed };
    }
  }
  const files = list.sort().map((file) => {
    const full = path.join(before.top, file);
    const entry = { path: relativeToCwd(cwd, before.top, file), added: null, removed: null };
    if (file in before.entries) entry.dirtyBefore = true;
    if (!fs.existsSync(full)) entry.deleted = true;
    const stat = numstat[file];
    if (stat) {
      if (stat.added === '-') entry.binary = true;
      else {
        entry.added = Number(stat.added);
        entry.removed = Number(stat.removed);
      }
    } else if (!entry.deleted) {
      const lines = lineCount(full);
      if (lines === null) entry.binary = true;
      else {
        entry.added = lines;
        entry.removed = 0;
      }
    }
    return entry;
  });
  return { git: true, files, headMoved: now.head !== before.head };
}

// The list in words, one file per line, for the result and for the brief of whoever takes over.
export function changedFilesText(changes) {
  if (!changes || changes.unknown) {
    return message(
      '（算不出这一单改了哪些文件：工作目录的状态读不到）',
      '(Could not determine which files changed in this run: working directory status unavailable)',
    );
  }
  if (!changes.files.length) {
    return message('（没有发现改动过的文件）', '(No modified files detected)');
  }
  const lines = changes.files.slice(0, LIST_CAP).map((f) => {
    const counts = f.binary ? message('二进制', 'binary') : f.added === null ? '' : `+${f.added} -${f.removed}`;
    const marks = [
      counts,
      f.deleted ? message('已删除', 'deleted') : '',
      f.dirtyBefore ? message('开工前就有未提交改动，行数含那部分', 'had uncommitted changes before run; line counts include them') : '',
    ].filter(Boolean);
    return `- ${f.path}${marks.length ? message(`（${marks.join('，')}）`, ` (${marks.join(', ')})`) : ''}`;
  });
  if (changes.files.length > LIST_CAP) {
    lines.push(message(`……另有 ${changes.files.length - LIST_CAP} 个没有列出`, `... and ${changes.files.length - LIST_CAP} more not listed`));
  }
  if (changes.git) {
    const added = changes.files.reduce((n, f) => n + (f.added ?? 0), 0);
    const removed = changes.files.reduce((n, f) => n + (f.removed ?? 0), 0);
    lines.unshift(message(
      `共 ${changes.files.length} 个文件，+${added} -${removed}（相对这一单开工时的 HEAD）${changes.headMoved ? '；这一单里还有新提交' : ''}：`,
      `${changes.files.length} files, +${added} -${removed} (relative to HEAD at run start)${changes.headMoved ? '; new commits created during run' : ''}:`,
    ));
  } else {
    lines.unshift(message(
      `共 ${changes.files.length} 个文件（这里不是 git 仓库：按修改时间找的，没有增删行数，删掉的文件看不出来${changes.truncated ? '；目录太大，只查了前一部分' : ''}）：`,
      `${changes.files.length} files (non-git directory: found by mtime, line counts and deletions unavailable${changes.truncated ? '; directory too large, only partial scan performed' : ''}):`,
    ));
  }
  return lines.join('\n');
}
