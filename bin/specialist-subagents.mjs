#!/usr/bin/env node
// specialist-subagents CLI: the thin front door for the daemon, the ledger and the MCP shell.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startDaemon } from '../src/daemon.mjs';
import { startMcpStdio, waitForRun } from '../src/mcp-stdio.mjs';
import { ensureOnboarding } from '../src/onboarding.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE_FILE = path.join(ROOT, '.data', 'daemon.json');
const args = process.argv.slice(2);
const portIndex = args.indexOf('--port');
let argumentError = null;
if (portIndex >= 0) {
  const value = args[portIndex + 1];
  if (!/^\d+$/.test(value ?? '') || Number(value) < 1 || Number(value) > 65535) {
    argumentError = '--port requires an integer between 1 and 65535';
  } else process.env.SPECIALIST_SUBAGENTS_PORT = value;
  args.splice(portIndex, 2);
}
const zh = /^zh/i.test(process.env.SPECIALIST_SUBAGENTS_LANG ?? '');
const copy = (en, cn) => zh ? cn : en;
const PORT = Number(process.env.SPECIALIST_SUBAGENTS_PORT) || 43130;
const BASE = `http://127.0.0.1:${PORT}`;
const USAGE = copy(`Usage: node bin/specialist-subagents.mjs <command> [options]
Commands:
  start                 Start the daemon (idempotent)
  status                Show daemon status
  stop                  Stop the daemon
  seats [state]         List seats
  pool                  Show the pool snapshot
  wait <seat|run>       Wait for a run (--timeout seconds; default 6 hours)
  refine <role>         Request a skill-refinement check
  mcp                   Run the stdio MCP bridge (--profile full|core)
  demo                  Run an isolated demo with a configured backend
Options:
  --help, -h            Show this help
  --port <number>       Override the daemon port (default 43130)
  --non-interactive     Start without onboarding prompts
  --reset-onboarding    Reset saved onboarding choices before starting
Environment:
  SPECIALIST_SUBAGENTS_PORT, SPECIALIST_SUBAGENTS_TOKEN,
  SPECIALIST_SUBAGENTS_LANG, SPECIALIST_SUBAGENTS_CALLER_TITLE,
  SPECIALIST_TOOL_PROFILE`, `用法：node bin/specialist-subagents.mjs <命令> [选项]
命令：
  start                 启动守护进程（幂等）
  status                查看守护进程状态
  stop                  停止守护进程
  seats [state]         列出座位
  pool                  查看任务池快照
  wait <seat|run>       等待一次运行结束（--timeout 秒，默认 6 小时）
  refine <role>         请求一次 skill 提炼检查
  mcp                   启动 stdio MCP 桥接（--profile full|core）
  demo                  用已配置的后端跑一次隔离演示
选项：
  --help, -h            显示本帮助
  --port <number>       覆盖守护进程端口（默认 43130）
  --non-interactive     无交互引导直接启动
  --reset-onboarding    启动前重置已保存的引导选项
环境变量：
  SPECIALIST_SUBAGENTS_PORT, SPECIALIST_SUBAGENTS_TOKEN,
  SPECIALIST_SUBAGENTS_LANG, SPECIALIST_SUBAGENTS_CALLER_TITLE,
  SPECIALIST_TOOL_PROFILE`);

function localFetch(url, options = {}) {
  const token = process.env.SPECIALIST_SUBAGENTS_TOKEN?.trim();
  return fetch(url, { ...options, headers: { ...options.headers, ...(token ? { authorization: `Bearer ${token}` } : {}) } });
}

function readDaemonFile() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

// Short probe by default: a caller that just wants to know "is anything there" must not hang.
async function health(timeoutMs = 1500) {
  try {
    const res = await localFetch(`${BASE}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { httpStatus: res.status };
    return await res.json();
  } catch {
    return null;
  }
}

async function main() {
  if (args.includes('--help') || args.includes('-h')) { console.log(USAGE); return; }
  if (argumentError) { console.error(argumentError); console.log(USAGE); process.exitCode = 2; return; }
  const command = (args[0] ?? '').toLowerCase();
  switch (command) {
    case 'start': {
      // Idempotent: a login script may run this unconditionally, so a live daemon means "nothing to do".
      const live = await health();
      if (live) {
        const daemon = readDaemonFile();
        const owner = daemon?.port === PORT && daemon.pid ? ` (pid ${daemon.pid})` : '';
        console.log(`specialist-subagents: already running on 127.0.0.1:${PORT}${owner}`);
        break;
      }
      const envDb = process.env.SPECIALIST_SUBAGENTS_DB?.trim();
      const defaultDb = path.join(ROOT, '.data', 'ledger.sqlite3');
      if (envDb && path.resolve(envDb) !== defaultDb) {
        console.error(copy(
          `note: SPECIALIST_SUBAGENTS_DB is set; using external ledger ${path.resolve(envDb)}`,
          `注意：已设置环境变量 SPECIALIST_SUBAGENTS_DB，当前使用外部台账 ${path.resolve(envDb)}`,
        ));
      }
      if (!(await ensureOnboarding({ nonInteractive: args.includes('--non-interactive'), reset: args.includes('--reset-onboarding') })).ok) { process.exitCode = 1; break; }
      const { port, pid } = await startDaemon();
      console.error(copy(
        `specialist-subagents daemon listening on http://127.0.0.1:${port} (pid ${pid})`,
        `specialist-subagents 守护进程已监听 http://127.0.0.1:${port}（pid ${pid}）`,
      ));
      break;
    }
    case 'status': {
      const daemon = readDaemonFile();
      const live = await health();
      if (!daemon && !live) {
        console.log(copy('daemon: not running', '守护进程：未运行'));
        break;
      }
      console.log(copy(`daemon: ${live ? 'running' : 'not reachable'}`, `守护进程：${live ? '运行中' : '不可达'}`));
      console.log(JSON.stringify({ stateFile: daemon, health: live }, null, 2));
      break;
    }
    case 'stop': {
      // Ask the port, not the state file: `.data/daemon.json` names the pid of whichever start wrote
      // it last, and `stop` killing that pid is how it once reported "kill ESRCH" while the service
      // was still up (2026-09-19). /health answers with the live pid.
      const live = await health();
      const authFailure = (status) => {
        if (status !== 401 && status !== 403) return false;
        console.error(copy(`stop failed: authentication required (HTTP ${status}; set SPECIALIST_SUBAGENTS_TOKEN)`, `停止失败：需要身份验证（HTTP ${status}；请设置 SPECIALIST_SUBAGENTS_TOKEN）`));
        process.exitCode = 1;
        return true;
      };
      if (authFailure(live?.httpStatus)) break;
      if (live?.httpStatus) { console.error(`stop failed: HTTP ${live.httpStatus}`); process.exitCode = 1; break; }
      if (live?.pid) {
        const res = await localFetch(`${BASE}/shutdown`, { method: 'POST' }).catch(() => null);
        if (authFailure(res?.status)) break;
        if (res?.ok) {
          for (let attempt = 0; attempt < 40; attempt += 1) {
            await new Promise((resolve) => setTimeout(resolve, 250));
            if (!(await health())) break;
          }
          console.log(copy(`stopped pid ${live.pid}`, `已停止进程 ${live.pid}`));
          break;
        }
        // Only a genuinely missing route permits the legacy PID fallback.
        if (!res || ![404, 405].includes(res.status)) {
          console.error(copy(`stop failed: ${res ? `HTTP ${res.status}` : 'shutdown request failed'}`, `停止失败：${res ? `HTTP ${res.status}` : '关闭请求失败'}`));
          process.exitCode = 1;
          break;
        }
        try {
          process.kill(live.pid);
          console.log(copy(`stopped pid ${live.pid} (killed: this build has no /shutdown route)`, `已停止进程 ${live.pid}（强制终止：当前构建无 /shutdown 路由）`));
        } catch (err) {
          console.log(copy(`stop failed: ${err.message}`, `停止失败：${err.message}`));
        }
        break;
      }
      const daemon = readDaemonFile();
      let dead = false;
      if (daemon?.pid && (daemon.port === undefined || daemon.port === PORT)) {
        try { process.kill(daemon.pid, 0); } catch (err) { dead = err.code === 'ESRCH'; }
      }
      if (dead) {
        fs.unlinkSync(STATE_FILE);
        console.log(copy('daemon: not running (removed stale daemon.json)', '守护进程未运行（已移除过期的 daemon.json）'));
        break;
      }
      console.log(
        daemon?.pid
          ? copy(`daemon: not reachable (state file names pid ${daemon.pid}; not confirmed dead on this port)`, `守护进程不可达（状态文件记录 pid ${daemon.pid}；未能在此端口确认其已退出）`)
          : copy('daemon: not running', '守护进程：未运行'),
      );
      break;
    }
    case 'seats': {
      const state = args[1];
      const query = state ? `?state=${encodeURIComponent(state)}` : '';
      const res = await localFetch(`${BASE}/seats${query}`).catch(() => null);
      if (!res || !res.ok) {
        console.log(`daemon: not reachable on ${BASE}`);
        break;
      }
      const rows = await res.json();
      if (!rows.length) console.log(copy('seats: none', '座位：无'));
      for (const seat of rows) {
        console.log(
          `${seat.id} role=${seat.role} instance=${seat.instance} state=${seat.state} handle=${seat.handle ?? '-'} pid=${seat.pid ?? '-'} owner=${seat.owner ?? '-'} parent=${seat.parent ?? '-'}`
        );
      }
      break;
    }
    case 'wait': {
      // Meant to run as a background command of a Claude Code lead: it exits when the run ends, and the
      // host wakes the lead with this output, so the lead never blocks. Exit codes are for scripts; the
      // text says the same thing for the model reading it.
      const target = args[1];
      const timeoutArg = args.indexOf('--timeout');
      const timeoutSeconds = timeoutArg > 0 ? Number(args[timeoutArg + 1]) : 6 * 3600;
      if (!target) {
        console.log(copy('Usage: node bin/specialist-subagents.mjs wait <seat|run> [--timeout seconds] (default 6 hours). Use seat-coder-3, a run number, or seat-coder-3#1234.', '用法：node bin/specialist-subagents.mjs wait <座位号或运行号> [--timeout 秒]（默认等 6 小时）。座位号写成 seat-coder-3，运行号写成数字或 seat-coder-3#1234。'));
        process.exitCode = 2;
        break;
      }
      const targetArgs = /^\d+$/.test(target) ? { run: Number(target) } : { seat: target };
      const result = await waitForRun({ ...targetArgs, timeout_seconds: timeoutSeconds }, { tool: 'wait', maxSeconds: 24 * 3600 });
      console.log(result.text);
      if (!result.ended) {
        process.exitCode = 3;
      } else if (result.status !== 'done') {
        process.exitCode = 1;
        console.log(copy('(This run did not finish normally; see the status above.)', '（这一单没有正常完成，看上面的状态和状况。）'));
      }
      break;
    }
    case 'pool': {
      // H-4: one line about the pool, for a host that can put it into every turn of its lead. A
      // service that cannot be read is not a failure — the host goes on without the snapshot, and
      // says so rather than stopping or printing an error a model would chase.
      const res = await localFetch(`${BASE}/pool?lang=${zh ? 'zh' : 'en'}`, { signal: AbortSignal.timeout(2000) }).catch(() => null);
      const body = res && res.ok ? await res.json().catch(() => null) : null;
      console.log(body?.text ?? copy('pool: unknown', '池：未知'));
      break;
    }
    case 'refine': {
      // Ask the skill loop now whether this role is due for a refiner, instead of waiting for its next
      // run or verdict. The service decides with the same checks; this only reports what it said.
      const role = args[1];
      if (!role) {
        console.log(copy('Usage: node bin/specialist-subagents.mjs refine <role>, for example refine coder. The service checks its normal refinement conditions and reports why it did not dispatch.', '用法：node bin/specialist-subagents.mjs refine <岗位>，例如 refine coder。服务按平时的条件判断要不要派 refiner，不满足就说为什么没派。'));
        process.exitCode = 2;
        break;
      }
      const res = await localFetch(`${BASE}/skill-loop/refine?lang=${zh ? 'zh' : 'en'}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ role }),
      }).catch(() => null);
      if (!res) {
        console.log(`daemon: not reachable on ${BASE}`);
        process.exitCode = 1;
        break;
      }
      const body = await res.json().catch(() => null);
      console.log(body?.text ?? body?.error ?? `HTTP ${res.status}`);
      if (!body?.started) process.exitCode = 1;
      break;
    }
    case 'mcp': {
      startMcpStdio();
      await new Promise(() => {});
      break;
    }
    case 'demo': {
      await import('./demo.mjs');
      break;
    }
    default: {
      console.log(USAGE);
      if (command) process.exitCode = 2;
      break;
    }
  }
}

main().catch((err) => {
  console.error(`specialist-subagents: ${err.message}`);
  process.exit(1);
});
