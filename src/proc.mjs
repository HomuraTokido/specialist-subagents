// Process helpers shared by the ledger (store.mjs), the executor (exec.mjs) and the daemon.
// One place, so "is this pid alive" has one answer everywhere and "kill this seat" always means the
// whole tree, not just the runner script.

import { spawn } from 'node:child_process';

// Does a process with this pid exist? EPERM means it exists but belongs to someone we may not
// signal, which is still "alive". store.reconcileRunning used to read any error as "dead" while the
// daemon's own check read EPERM as "alive", so the same pid got two verdicts (2026-09-30 review).
// No start-time check: a recycled pid reads as alive, which is a known and accepted blind spot.
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

// Kill a runtime and everything it started. A seat's runtime is a node runner that starts the real
// work (codex, claude, a bash tool and whatever that runs) as grandchildren, so killing the pid alone
// leaves them running. Windows: taskkill /T walks the tree; stdio is ignored because a piped child
// dies with EPERM on this host (see exec.mjs). POSIX: the runtime was started as its own process
// group leader (exec.mjs passes detached only there), so the negative pid signals the whole group.
// Returns { ok, alreadyGone, detail }: ok means the tree is now gone (or was), detail says why not.
export async function killTree(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return { ok: false, alreadyGone: false, detail: `没有可用的 pid（${pid}）` };
  if (process.platform === 'win32') {
    return new Promise((resolve) => {
      let settled = false;
      const done = (res) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(res);
      };
      let child;
      try {
        child = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      } catch (err) {
        return done({ ok: false, alreadyGone: false, detail: `taskkill 退出码 ${err?.message ?? '未知'}` });
      }
      const timer = setTimeout(() => {
        try { child.kill(); } catch { /* ignore */ }
        done({ ok: false, alreadyGone: false, detail: 'taskkill 超时（15s）' });
      }, 15000);
      timer.unref?.();
      child.on('error', (err) => {
        if (!pidAlive(pid)) return done({ ok: true, alreadyGone: true, detail: '' });
        done({ ok: false, alreadyGone: false, detail: `taskkill 退出码 ${err?.message ?? '未知'}` });
      });
      child.on('close', (code) => {
        if (code === 0) return done({ ok: true, alreadyGone: false, detail: '' });
        // taskkill exits 128 when there is no such process.
        if (code === 128 || !pidAlive(pid)) return done({ ok: true, alreadyGone: true, detail: '' });
        done({ ok: false, alreadyGone: false, detail: `taskkill 退出码 ${code ?? '未知'}` });
      });
    });
  }
  for (const target of [-pid, pid]) {
    try {
      process.kill(target, 'SIGKILL');
      return { ok: true, alreadyGone: false, detail: '' };
    } catch (err) {
      if (err.code !== 'ESRCH') return { ok: false, alreadyGone: false, detail: err.message };
    }
  }
  return { ok: true, alreadyGone: true, detail: '' };
}
