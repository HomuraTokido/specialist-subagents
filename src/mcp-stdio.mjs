// specialist-subagents MCP shell: MCP over stdio, JSON-RPC 2.0, one JSON object per line (NDJSON).
// The shell owns no daemon logic: it health-checks the daemon and forwards to it, and when
// nothing answers it says so instead of starting one — a daemon started from inside a host dies
// with that host (see ensureDaemon below). Dispatch never blocks: seat_start answers with a seat id
// at once. Hosts with completion notifications wake the caller to read task_result; other clients
// can use a background CLI wait or the separate blocking task_wait call.

import fs from 'node:fs';
import { CodexCompletionBridge } from './codex-completion-bridge.mjs';
import { LEAD_TOOLS } from './lead-tools.mjs';
import { resolveCallerTitle } from './role-contract.mjs';
import { language, message } from './presets.mjs';
import os from 'node:os';
import readline from 'node:readline';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DAEMON_FILE = path.join(ROOT, 'src', 'daemon.mjs');
// The dispatching side's manual (team-leader.md) and one caller guide per role (<role>.md). The manual goes
// out as the server's instructions at initialize, so every client's model has it from the first turn, even
// when the host defers loading the tools themselves (Claude Code does; tool descriptions reach the model
// only after that). dispatch_guide serves the same files on request. Read from disk each time, so editing
// a guide takes effect for the next session without a restart.
const DISPATCH_DIR = path.join(ROOT, 'dispatch');
export function resolveLang(env = process.env) { return language(env); }
const LEAD_GUIDE = 'team-leader';
const PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = { name: 'specialist-subagents', version: '0.1.0' };
const DEFAULT_PORT = 43130;
// How long one call to the daemon may take before this shell gives up on it. Every route the tools use
// answers in well under a second on a healthy daemon, so 30 s already means something is stuck; without
// a limit a stalled daemon held the call for undici's default (about 5 minutes), and because requests
// are answered one after another, ping and tools/list waited behind it (2026-09-30 review). The env
// variable exists so a test can watch the timeout fire in milliseconds instead of seconds.
const CALL_TIMEOUT_MS = Number(process.env.SPECIALIST_SUBAGENTS_CALL_TIMEOUT_MS) || 30000;
const HEALTH_TIMEOUT_MS = Math.min(5000, CALL_TIMEOUT_MS);
// /events/wait is a long poll by design: it may legitimately take its whole requested timeoutMs (30 s
// default, 10 min cap, as in the daemon), so it gets that plus a margin for the reply to come back.
const WAIT_DEFAULT_MS = 30000;
const WAIT_MAX_MS = 600000;
const WAIT_MARGIN_MS = 10000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const port = () => Number(process.env.SPECIALIST_SUBAGENTS_PORT) || DEFAULT_PORT;

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function httpBase() {
  return `http://127.0.0.1:${port()}`;
}

const isTimeout = (err) => err?.name === 'TimeoutError';

// { up: true } when /health answers; otherwise { up: false, timedOut } where timedOut says the daemon
// accepted the connection and then said nothing (busy or stuck) as opposed to nothing listening at all.
async function health() {
  try {
    const token = process.env.SPECIALIST_SUBAGENTS_TOKEN?.trim();
    const res = await fetch(`${httpBase()}/health`, {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) return { up: false, timedOut: false };
    await res.json();
    return { up: true };
  } catch (err) {
    return { up: false, timedOut: isTimeout(err) };
  }
}

function timeoutFor(route) {
  if (!route.startsWith('/events/wait')) return CALL_TIMEOUT_MS;
  const asked = Number(new URL(route, 'http://127.0.0.1').searchParams.get('timeoutMs'));
  const waitMs = Number.isFinite(asked) && asked > 0 ? Math.min(asked, WAIT_MAX_MS) : WAIT_DEFAULT_MS;
  return waitMs + WAIT_MARGIN_MS;
}

// Connect, never spawn.
//
// The daemon's lifetime belongs to the machine, not to whichever client happened to call first: a
// watchdog started at logon (tools/watchdog.mjs, checking the port once a minute) keeps it up. A daemon
// started from inside this host lands in the host's job object and dies with it, which is how the wall
// page and every running seat vanished on host restarts until 2026-09-19. The bridge losing that
// privilege is the point — see tools/install-watchdog.ps1.
async function ensureDaemon() {
  const probe = await health();
  if (probe.up) return port();
  if (probe.timedOut) {
    throw new Error(
      message(`specialist-subagents 服务在 127.0.0.1:${port()} 上有东西在监听，但 ${HEALTH_TIMEOUT_MS / 1000} 秒内没有回答 /health：它可能很忙，也可能卡住了。`, `specialist-subagents is listening on 127.0.0.1:${port()} but did not answer /health within ${HEALTH_TIMEOUT_MS / 1000} seconds; it may be busy or stuck. `)
      + message('这次调用没有发出。稍后重试；如果一直这样，在终端里执行 ', 'This call was not sent. Retry later; if it persists, run ')
      + message(`node "${CLI_FILE}" status 看状态，并读 ${DAEMON_LOG} 的末尾找原因。`, `node "${CLI_FILE}" status and read the end of ${DAEMON_LOG}. `)
      + message(`看门狗不会重启一个还占着端口的服务，卡死的话要手动停掉它（node "${CLI_FILE}" stop），之后看门狗会在一分钟内起新的。`, `The watchdog does not restart a service still occupying the port. If stuck, stop it manually (node "${CLI_FILE}" stop); the watchdog can restart it within a minute. `)
      + daemonLogTail(),
    );
  }
  throw new Error(
    message(`specialist-subagents 服务没在跑（127.0.0.1:${port()} 上没有回应）。这次调用没有发出，这个 MCP 桥也不会自己去起服务。`, `specialist-subagents is not running (no response on 127.0.0.1:${port()}). This call was not sent; the MCP bridge never starts the daemon. `)
    + watchdogNote()
    + message(`现在就要用的话，在终端里执行：node "${CLI_FILE}" start`, `To start it now, run in a terminal: node "${CLI_FILE}" start`)
    + message('（服务起在那个终端的进程树里，那个终端或宿主退出时它会跟着停；要一直在，就按上面的说明装看门狗）。', ' (the daemon belongs to that terminal’s process tree and may stop with it; install the watchdog for persistence). ')
    + message(`服务自己的日志在 ${DAEMON_LOG}，起不来的原因会写在那里。`, `The service log is ${DAEMON_LOG}; startup failures are recorded there.`)
    + daemonLogTail(),
  );
}

const DAEMON_LOG = path.join(ROOT, '.data', 'daemon.log');
const CLI_FILE = path.join(ROOT, 'bin', 'specialist-subagents.mjs');

// What is actually keeping the daemon up on this machine. There is no scheduled task: on Windows a
// Startup-folder entry (tools/install-watchdog.ps1) launches tools/watchdog.mjs at logon, on macOS a
// LaunchAgent (tools/install-watchdog.sh) does, and either one checks the port once a minute and starts
// the daemon when nothing answers. This message used to name a scheduled task
// "specialist-subagents-watchdog" that never existed and promised "up to a minute" of waiting that the
// call never did (2026-09-30 review). Whether the entry is installed is checked, not assumed, because
// "nobody is going to start it" is the fact the caller needs when it is not.
function watchdogNote() {
  const watchdogLog = path.join(ROOT, '.data', 'watchdog.log');
  if (process.platform === 'win32') {
    const startup = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
    if (fs.existsSync(path.join(startup, 'specialist-subagents-watchdog.vbs'))) {
      return message('这台机器装了看门狗（启动文件夹里的 specialist-subagents-watchdog.vbs，登录时启动，之后每分钟检查一次端口，服务不在就起一个），', 'A watchdog is installed (Startup/specialist-subagents-watchdog.vbs); it starts at login and checks the port every minute. ')
        + message(`所以服务多半会在一分钟内自己回来；这次没连上，说明它刚掉线，或者看门狗本身没在跑（登录后被结束了）。看门狗的记录在 ${watchdogLog}。`, `The service may return within a minute; it may have just exited, or the watchdog may have stopped. Watchdog log: ${watchdogLog}. `);
    }
    return message('这台机器没有装看门狗（启动文件夹里没有 specialist-subagents-watchdog.vbs），没有任何东西会自动把服务拉起来。', 'No watchdog is installed (Startup/specialist-subagents-watchdog.vbs is absent); nothing will start the service automatically. ')
      + message(`装它：pwsh -File "${path.join(ROOT, 'tools', 'install-watchdog.ps1')}"（不需要管理员权限）。`, `Install it: pwsh -File "${path.join(ROOT, 'tools', 'install-watchdog.ps1')}" (no administrator rights required). `);
  }
  if (process.platform === 'darwin') {
    const launchAgents = path.join(os.homedir(), 'Library', 'LaunchAgents');
    const plistNew = path.join(launchAgents, 'com.specialist-subagents.watchdog.plist');
    const plistLegacy = path.join(launchAgents, 'com.homura.specialist-subagents-watchdog.plist');
    if (fs.existsSync(plistNew) || fs.existsSync(plistLegacy)) {
      const activeLabel = fs.existsSync(plistNew) ? 'com.specialist-subagents.watchdog' : 'com.homura.specialist-subagents-watchdog';
      return message(`这台机器装了看门狗（LaunchAgent ${activeLabel}，登录时启动，之后每分钟检查一次端口，服务不在就起一个），`, `A watchdog is installed (LaunchAgent ${activeLabel}); it starts at login and checks the port every minute. `)
        + message(`所以服务多半会在一分钟内自己回来；这次没连上，说明它刚掉线，或者看门狗本身没在跑。看门狗的记录在 ${watchdogLog}。`, `The service may return within a minute; it may have just exited, or the watchdog may have stopped. Watchdog log: ${watchdogLog}. `);
    }
    return message('这台机器没有装看门狗（~/Library/LaunchAgents 里没有 com.specialist-subagents.watchdog.plist），没有任何东西会自动把服务拉起来。', 'No watchdog is installed (~/Library/LaunchAgents/com.specialist-subagents.watchdog.plist is absent); nothing will start the service automatically. ')
      + message(`装它：bash "${path.join(ROOT, 'tools', 'install-watchdog.sh')}"。`, `Install it: bash "${path.join(ROOT, 'tools', 'install-watchdog.sh')}". `);
  }
  if (process.platform === 'linux') {
    if (fs.existsSync(path.join(os.homedir(), '.config', 'systemd', 'user', 'specialist-subagents-watchdog.service'))) {
      return message('这台机器装了看门狗（systemd 用户服务 specialist-subagents-watchdog，登录时启动，之后每分钟检查一次端口，服务不在就起一个），', 'A watchdog is installed (systemd user service specialist-subagents-watchdog); it starts at login and checks the port every minute. ')
        + message(`所以服务多半会在一分钟内自己回来；这次没连上，说明它刚掉线，或者看门狗本身没在跑（systemctl --user status specialist-subagents-watchdog）。看门狗的记录在 ${watchdogLog}。`, `The service may return within a minute; check systemctl --user status specialist-subagents-watchdog if it does not. Watchdog log: ${watchdogLog}. `);
    }
    return message('这台机器没有装看门狗（~/.config/systemd/user 里没有 specialist-subagents-watchdog.service），没有任何东西会自动把服务拉起来。', 'No watchdog is installed (~/.config/systemd/user/specialist-subagents-watchdog.service is absent); nothing will start the service automatically. ')
      + message(`装它：bash "${path.join(ROOT, 'tools', 'install-watchdog-linux.sh')}"。`, `Install it: bash "${path.join(ROOT, 'tools', 'install-watchdog-linux.sh')}". `);
  }
  return message('这个系统上没有现成的看门狗安装脚本（只有 Windows、macOS 和 Linux 的），没有任何东西会自动把服务拉起来。', 'No watchdog installer is available for this OS (Windows, macOS, and Linux only); nothing will start the service automatically. ');
}

// Everything the daemon says about its own life lands in that file (it runs detached, so nothing it
// prints would reach this shell). When it refuses to start — a contract that no longer matches
// roles.json, or a boundary that disagrees with the tool whitelist — this is the only place the
// caller can read why; "unreachable" alone would hide it.
function daemonLogTail() {
  try {
    const text = fs.readFileSync(DAEMON_LOG, 'utf8').trim();
    if (!text) return '';
    return message(`\n  服务日志末尾：${text.slice(-600)}`, `\n  Service log tail: ${text.slice(-600)}`);
  } catch {
    return '';
  }
}
async function api(method, route, body, signal) {
  signal?.throwIfAborted();
  const activePort = await ensureDaemon();
  signal?.throwIfAborted();
  const limitMs = timeoutFor(route);
  let res;
  let data;
  try {
    res = await fetch(`http://127.0.0.1:${activePort}${route}`, {
      method,
      headers: {
        'x-specialist-lang': resolveLang(),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(process.env.SPECIALIST_SUBAGENTS_TOKEN?.trim() ? { authorization: `Bearer ${process.env.SPECIALIST_SUBAGENTS_TOKEN.trim()}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(limitMs)]) : AbortSignal.timeout(limitMs),
    });
    data = await res.json().catch(() => ({}));
  } catch (err) {
    if (!isTimeout(err)) throw err;
    throw new Error(
      `the specialist-subagents daemon on 127.0.0.1:${activePort} did not answer ${method} ${route} within ${limitMs / 1000} s; it may be busy or stuck. `
      + `Check it with: node "${CLI_FILE}" status, and read the end of ${DAEMON_LOG}. `
      + (method === 'GET'
        ? 'Retrying a read is safe.'
        : 'The daemon may still have applied this write, so look (seat_list, seat_show, memory_read) before sending it again.'),
    );
  }
  if (!res.ok) throw new Error(data.error ?? `specialist-subagents daemon returned ${res.status}`);
  return data;
}

// R-6 (2026-10-21): a bridge started inside a seat. cli-runner puts the seat's id and whether its role
// may dispatch into the environment of every backend it runs, and the backend's MCP client starts this
// bridge with that environment. A Lead seat sees only the tools it dispatches and checks with; a member
// seat sees none; a host (no seat id) sees everything, as before. This is the narrow surface, not the
// guard: the daemon itself refuses a dispatch the caller's role does not allow (dispatchCaller).
const CALLER_SEAT = (process.env.SPECIALIST_CALLER_SEAT ?? '').trim() || null;
const CALLER_DISPATCHES = process.env.SPECIALIST_CALLER_DISPATCH === '1';
const LEAD_TOOL_SET = new Set(LEAD_TOOLS);
const REFINEMENT_TOOLS = new Set(['difficulty_report', 'difficulty_decide', 'candidates', 'candidate_decide']);

function resolveToolProfile(argv = process.argv.slice(2), env = process.env) {
  let profile = (env.SPECIALIST_TOOL_PROFILE ?? '').trim();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--profile') {
      profile = String(argv[i + 1] ?? '').trim();
      i += 1;
    } else if (arg.startsWith('--profile=')) {
      profile = arg.slice('--profile='.length).trim();
    }
  }
  const resolved = profile || 'full';
  if (resolved !== 'full' && resolved !== 'core') {
    throw new Error(`specialist-subagents: unknown tool profile "${resolved}" (expected "full" or "core").`);
  }
  return resolved;
}

const TOOL_PROFILE = resolveToolProfile();

function visibleTool(name) {
  if (CALLER_SEAT) return CALLER_DISPATCHES && LEAD_TOOL_SET.has(name);
  if (TOOL_PROFILE === 'core') return !REFINEMENT_TOOLS.has(name);
  return true;
}


const TOOLS = [
  {
    name: 'role_list',
    description: 'List the configured posts (roles): contract, tier, grant, deny_intent, spawn spec, and live dispatch route / backend quota health.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'seat_start',
    description: [
      'Hand a task to a role. Answers at once with the seat id; the run goes on by itself and lands in the ledger. If the host has completion notification integration, continue other work or end this turn; the host notifies or wakes you when the run ends, then use task_result. No separate wait is needed. Only clients without that integration use a background CLI wait or task_wait: in Claude Code, start `node <this repo>/bin/specialist-subagents.mjs wait <seat>` as a background Bash command (run_in_background) and go on with other work; the host wakes you with its output when the command ends (the reply\'s `next` gives the exact command). If background commands are unavailable, use task_wait. Do not poll seat_show, seat_list, task_result or other status tools to wait.',
      'Whether to dispatch at all. Two hard vetoes come first: never dispatch work that needs several rounds of back-and-forth with you, and never dispatch in parallel two writes that touch the same files. Otherwise dispatch only when R clearly exceeds H — R is the raw material you would have to read into your own context doing it yourself, H is the handoff (writing the brief, checking on it, reading the report, verifying it) — and the likelier a redo, the higher the bar. The result has to be checkable in one sentence; if you cannot say how you will check it, split the task further or do it yourself.',
      'Whom: substantial work inside a role\'s domain goes to that role (code to coder, web research to web_researcher, and so on; role_list lists them). Small one-shot jobs of any kind (read a batch of material and return the conclusion, run a string of commands, make one small change) go to handyman, whose point is to save your tokens. Every role except handyman and leader turns the difficulties it meets into its own skill, so dispatching to the right role both saves you tokens and feeds that loop; handyman\'s chores are one-off, so its difficulties are recorded but never distilled into a skill (roles.json skill_loop: false).',
      'With cwd the task goes to that role\'s expert for that directory (seat_list with cwd says who that is): the seat that last worked there comes back with its session and is told what changed in the directory since (a large change starts it over). A role that roles.json marks expert_by "domain" (web_researcher) is recognised by its field of knowledge instead: pass domain (a short label, e.g. "ai", "biology") and the same domain returns to the same expert with its session; such a role refuses cwd, the seat\'s directory is the service\'s own (chosen per domain), and the directory-change notices do not apply to it. Refused when the concurrency limit is reached.',
      'To continue with one specific expert, pass its seat id as seat (point dispatch): the task goes to exactly that expert, with its session and its record, whatever cwd or domain you would otherwise have to give. Refused, with the reason and what to do instead, when the seat does not exist, belongs to another role, is archived (the reply says why, and where its record went when it was merged), is a one-shot seat with nothing to continue, or is at work on another run right now. A cwd or domain passed along with seat must be the expert\'s own. The reply\'s note says who took the task, how many times it has been there, and why it was chosen (named, same directory, same field, newly opened).',
    ].join('\n\n'),
    inputSchema: {
      type: 'object',
      properties: {
        role: { type: 'string', description: 'Role id from role_list.' },
        task: { type: 'string', description: 'The task, in words.' },
        seat: { type: 'string', description: 'Point dispatch: the seat id of the expert (from seat_list) that must take this task. It must be a living expert of this role and not busy. Leave it out to let the service pick the expert by cwd or domain.' },
        cwd: { type: 'string', description: 'Absolute path of the directory the task is about. It picks the expert: one seat per role per directory, kept across calls. Pass it to a directory role only. Without it the seat runs once in a scratch directory of the service, where relative paths reach nothing of yours, and no expert is kept.' },
        domain: { type: 'string', description: 'For a role recognised by domain (roles.json expert_by "domain", e.g. web_researcher): the field of knowledge the task is about, e.g. "ai" or "biology". The same domain returns to the same expert, which keeps its session; leading/trailing spaces are trimmed and English is lower-cased. Do not pass cwd to such a role. Directory roles ignore this and refuse a non-empty domain.' },
        owner: { type: 'string', description: 'Who asked for this seat.' },
        parent: { type: 'string', description: 'Parent seat or session, if any.' },
        topic: { type: 'string', description: 'Optional short label that splits one directory into several experts (the object is directory + topic). With a topic the task goes to the expert with exactly that topic, and a topic the directory has no expert for opens a new expert for it (the reply lists the directory\'s other experts, so a mistyped topic shows). Without one it goes to the directory\'s only expert, or, when there are several, to the one without a topic; with several and no topic-less one the call is refused and lists the candidates. Ignored when seat names an expert directly.' },
        fork: { type: 'string', enum: ['context', 'fresh'], description: 'Hand the task to a fork of the expert (the one seat, cwd + topic or domain picks) instead of the expert itself, busy or not; the fork runs once and is closed, its record filed under the expert. "context": the fork starts from the expert\'s records, as the automatic fork of a busy expert does. "fresh": a new session with none of the expert\'s history (no session, records, hand-off, expertise note or backlog) — for falsifying or reviewing the expert\'s work, a second opinion that must not share its assumptions; its session never becomes the expert\'s. Where the object has no expert yet, a new expert takes the task as usual. Leave it out to hand the task to the expert itself.' },
      },
      required: ['role', 'task'],
      additionalProperties: false,
    },
  },
  {
    name: 'memory_write',
    description:
      'Record one memory for a role. Facts are injected into every run of that role; lessons and notes are injected newest first.',
    inputSchema: {
      type: 'object',
      properties: {
        role: { type: 'string', description: 'Role id from role_list.' },
        kind: { type: 'string', enum: ['fact', 'lesson', 'note'], description: 'fact is always handed to the role; lesson and note are recent-first.' },
        body: { type: 'string', description: 'The memory itself, at most 4000 characters; split anything longer into several memories.' },
        source: { type: 'string', description: 'Where it came from (seat id, session, URL).' },
      },
      required: ['role', 'kind', 'body'],
      additionalProperties: false,
    },
  },
  {
    name: 'memory_read',
    description: 'Read one role\'s memories, newest first (default 20).',
    inputSchema: {
      type: 'object',
      properties: {
        role: { type: 'string', description: 'Role id from role_list.' },
        limit: { type: 'integer', minimum: 1, description: 'How many to return, newest first (a whole number of at least 1). Default 20.' },
      },
      required: ['role'],
      additionalProperties: false,
    },
  },
  {
    name: 'seat_list',
    description: 'The living experts, one line each: name, seat id, role, directory (for a domain expert, its domain), state, how many runs it has had, how many items its unfinished-work list holds, and a sentence or two of what it knows there. The name says what the expert knows; to dispatch to one, pass its seat id to seat_start. Closed seats, seats without a directory or domain, seats of roles that no longer exist, seats that never ran and the refiner seats the skill loop starts for itself are left out. Pass role to see only one role\'s experts, cwd to see only who owns that directory, domain to see only who owns that field, or state to list every seat in one state (open, running, done, failed, interrupted, closed). full: true returns the raw rows of the seats table instead, for debugging only (large); while HSkills\' skills directory is missing, a second text block after the rows says so.',
    inputSchema: {
      type: 'object',
      properties: {
        role: { type: 'string', description: 'Role id from role_list: only the experts of this role.' },
        cwd: { type: 'string', description: 'Absolute path: only the seats that work in this directory.' },
        domain: { type: 'string', description: 'Only the domain experts of this field (e.g. "ai"), compared after the same normalisation seat_start applies.' },
        state: { type: 'string', description: 'Every seat in this state instead of the living experts.' },
        full: { type: 'boolean', description: 'Raw full rows (expertise, backlog, session file, directory state, timestamps) as a JSON array. Large; for debugging.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'seat_show',
    description: 'Inspect a seat\'s raw event log (events: true, tail, or run) and past run numbers. To read a run\'s result or final report, prefer task_result instead (default view without events also returns the newest run summary for compatibility).',
    inputSchema: {
      type: 'object',
      properties: {
        seat: { type: 'string' },
        events: { type: 'boolean', description: 'Return the raw event log (newest 200 events, the runs list and the seat row) instead of the report view.' },
        tail: { type: ['integer', 'string'], description: 'Raw events: how many of the newest to return, or "all" for every event.' },
        run: { type: 'integer', description: 'Raw events of one run only: the seq of the task event that started it.' },
      },
      required: ['seat'],
      additionalProperties: false,
    },
  },
  {
    name: 'task_wait',
    description: 'Block until a run ends, then answer with its result (the same text task_result gives: status, usage, verdict, unfinished list, final report). Hosts with completion notification integration do not need this blocking wait: continue other work or end the turn, then use task_result when the host notifies or wakes you. Only clients without that integration use a background CLI wait or this blocking fallback. Name the run by seat (its newest run at the time of the call) or by run number. On timeout it says the run is still going and how long it has run; clients without completion notifications can call task_wait again to keep waiting. Do not poll seat_show, seat_list, task_result or other status tools to wait. Some clients cut a single tool call short on their own (Codex, for example, has a per-call timeout); keep timeout_seconds below that.',
    inputSchema: {
      type: 'object',
      properties: {
        seat: { type: 'string', description: 'Seat id from seat_start; its newest run is the one waited for.' },
        run: { type: 'integer', minimum: 1, description: 'Run number (the seq of the run\'s task event), instead of seat.' },
        timeout_seconds: { type: 'integer', minimum: 1, maximum: 3600, description: 'How long to wait at most. Default 300.' },
        max_chars: { type: 'integer', minimum: 200, description: 'How much of the report to return. Default 4000; past it the reply gives the file with the full text.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'task_result',
    description: 'The result of one run: status, usage, verdict, the unfinished-work list it handed back, and its final report — the runner\'s own answer, without the tool-call lines of its output. The report is cut at max_chars (default 4000); when it is longer the reply names the file that holds all of it. Name the run by seat (its newest run) or by run number. A run still going says so: if the host has completion notification integration, continue other work or end the turn and read task_result after the host notifies or wakes you; only clients without that integration use a background CLI wait or task_wait. Do not poll status tools to wait.',
    inputSchema: {
      type: 'object',
      properties: {
        seat: { type: 'string', description: 'Seat id; its newest run is returned.' },
        run: { type: 'integer', minimum: 1, description: 'Run number (the seq of the run\'s task event), for an older run.' },
        max_chars: { type: 'integer', minimum: 200, description: 'How much of the report to return. Default 4000.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'seat_verdict',
    description:
      "Record your verdict on a seat's run (by default its newest; pass run for an earlier one) once you have checked what it handed back: accepted (used as it came), revised (usable only after you changed it) or rejected (not usable). Call it for every run you verify. revised and rejected need a note — what you changed or why it was unusable, in a sentence — and go into the difficulty ledger as evidence for the role's contract; the difficulty ledger otherwise only sees what a run paid on the way, never whether its output was right.",
    inputSchema: {
      type: 'object',
      properties: {
        seat: { type: 'string' },
        verdict: { type: 'string', enum: ['accepted', 'revised', 'rejected'] },
        note: { type: 'string', description: 'What you changed, or why it was unusable. Required for revised and rejected.' },
        run: { type: 'integer', minimum: 1, description: 'Which run the verdict is about: the run id from seat_show (the seq of the task event that started the run). Default: the newest run. Needed when you judge a run after the seat has already started a newer one.' },
      },
      required: ['seat', 'verdict'],
      additionalProperties: false,
    },
  },
  {
    name: 'seat_close',
    description:
      'Permanently retire/archive a seat (and kill its process tree if running). To stop a running task while KEEPING the expert and its records, use task_cancel instead. A running seat closed here is cancelled (not finished, backlog unchanged) and marked closed. Runs also stop automatically after timeout_minutes (default 60) as failed.',
    inputSchema: {
      type: 'object',
      properties: { seat: { type: 'string' }, reason: { type: 'string' } },
      required: ['seat'],
      additionalProperties: false,
    },
  },
  {
    name: 'seat_rename',
    description:
      'Give a living expert a new name, one that says what it knows (for example "explorer · seats & skill loop"): the lead picks experts by name in seat_list. The seat id does not change. Refused when the name is empty, longer than 80 characters, already taken by another living expert, or the seat is archived. The change is recorded as a rename event, old name to new.',
    inputSchema: {
      type: 'object',
      properties: {
        seat: { type: 'string', description: 'Seat id of the expert (from seat_list).' },
        name: { type: 'string', description: 'The new name, 1 to 80 characters after trimming; unique among living experts.' },
      },
      required: ['seat', 'name'],
      additionalProperties: false,
    },
  },
  {
    name: 'task_cancel',
    description:
      'Stop the run on a seat but KEEP the expert (unlike seat_close, which retires it). The run\'s process and everything it started are killed at once, a "cancelled" event records why (pass reason), and the expert goes back to idle: it is NOT archived, its half-written session stays its record, and its next task continues from that. Use this when a run went off the rails but the expert itself is still worth keeping. A fork is retired, since it had one run only.',
    inputSchema: {
      type: 'object',
      properties: {
        seat: { type: 'string', description: 'Seat id of the expert whose run to cancel.' },
        reason: { type: 'string', description: 'Why it was cancelled, recorded on the cancelled event.' },
      },
      required: ['seat'],
      additionalProperties: false,
    },
  },
  {
    name: 'seat_merge',
    description:
      'Merge one expert into another: seat A is continued for one hand-off run, that document is filed under B, A is archived (reason "Merged into B"), and B\'s NEXT task starts with the hand-off once (then no more). The two must be living experts of the SAME role. With name, B is also renamed. Refused when one is already archived; if A\'s hand-off run fails, A is left living and a "merge" event records why.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Seat id of the expert to fold in and archive.' },
        into: { type: 'string', description: 'Seat id of the expert that receives it and keeps running.' },
        name: { type: 'string', description: 'Optional: also rename B to this name.' },
      },
      required: ['from', 'into'],
      additionalProperties: false,
    },
  },
  {
    name: 'seat_split',
    description:
      'Split one expert into several: for each part a focused hand-off is written from the expert\'s session, a fresh expert is opened for the part (with its name, optional topic and cwd), its first task carries that hand-off, and the original is archived (reason "Split into X, Y"). parts is a list of { name, topic?, cwd? }, at least two.',
    inputSchema: {
      type: 'object',
      properties: {
        seat: { type: 'string', description: 'Seat id of the expert to split.' },
        parts: {
          type: 'array',
          description: 'The parts to split into.',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Name of the new expert.' },
              topic: { type: 'string', description: 'Optional topic label for the new expert.' },
              cwd: { type: 'string', description: 'Optional absolute working directory for the new expert.' },
            },
            required: ['name'],
            additionalProperties: false,
          },
        },
      },
      required: ['seat', 'parts'],
      additionalProperties: false,
    },
  },
  {
    name: 'difficulty_report',
    description:
      `The difficulty ledger in words: costs the posts paid that they did not want to pay (failed runs, tool errors, writes blocked by the boundary, searches that found nothing, detours, compaction, answers that could not conclude, unusually costly runs), grouped by role × kind × tool with counts, the cost of the runs involved and samples. Read it when ${resolveCallerTitle() ?? 'the user'} asks to look at the ledger; for each class propose where the fix belongs (contract / dispatch / service / tool_or_project / accept) and let ${resolveCallerTitle() ?? 'the user'} decide.`,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'difficulty_decide',
    description:
      `Record ${resolveCallerTitle() ?? 'the user'}'s verdict for one class of the difficulty ledger (class as printed in 【】 by difficulty_report). decision: contract (rewrite the role contract; then dispatch the refiner for a draft), dispatch (a lesson for whoever dispatches), service (a bug in this service), tool_or_project (write it to Hwiki as a pain point), accept (nothing to do for now). Earlier records of the class are closed; later ones count as new evidence.`,
    inputSchema: {
      type: 'object',
      properties: {
        class: { type: 'string', description: 'The class key, e.g. explorer|retry|bash.' },
        decision: { type: 'string', enum: ['contract', 'dispatch', 'service', 'tool_or_project', 'accept'] },
        note: { type: 'string', description: 'Why, in a sentence.' },
      },
      required: ['class', 'decision'],
      additionalProperties: false,
    },
  },
  {
    name: 'candidates',
    description:
      "The skill loop's candidate versions. When one role has collected 5 new open difficulties (classes already closed with difficulty_decide do not count) the service has the refiner write a candidate of that role's skill: the full new text plus a rationale per difficulty. A candidate is NOT enabled: only enabling writes it into the role's skill in HSkills, and every run of that role from the next one on carries the enabled text (each run's seat events name the skill version it carried). Without id: the candidates waiting for review (pending, and deferred ones), and how close each role is to its next one (n/5). With id: that candidate in full: the 5 difficulties it was written from, the refiner's rationale for each, the diff against the current skill, and where the candidate file is. state (pending / active / rejected / deferred / all) and role narrow the list.",
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer', minimum: 1, description: 'Show this candidate in full.' },
        role: { type: 'string', description: "Only this role's candidates." },
        state: { type: 'string', enum: ['pending', 'active', 'rejected', 'deferred', 'all'], description: 'Default: pending and deferred.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'dispatch_guide',
    description:
      "The dispatching side's manual: whether to dispatch at all, to which role, how to write the brief, what to do once it is out, and how to accept the result. The lead's manual already came with this server's instructions at connect; call this without role to read it again (when it was missing or cut), or with role for that role's caller guide (what the brief must carry, what comes back, what not to ask of it). Read-only; answers from the files in the service's dispatch/ directory.",
    inputSchema: {
      type: 'object',
      properties: {
        role: { type: 'string', description: "A role id from role_list (coder, explorer, tester, web_researcher, handyman, librarian). Leave it out for the lead's manual." },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'candidate_decide',
    description:
      "Review a skill candidate. Judge each of the difficulties it was written from with verdicts: real (it will keep coming back, worth writing into the skill), invalid (it was never a real problem: a wrong brief, a temporary fault, the post misread something), sporadic (it did happen but will not again). You may give some verdicts now and the rest later. Then decision: enable (needs every difficulty judged and at least one real; writes the candidate file's current text into the role's skill in HSkills and records a skill_versions row; before enabling, delete from the candidate file the changes that rest on invalid or sporadic difficulties), reject (needs every difficulty judged and a note saying why; writes nothing), defer (put it aside, no more reminders), or supersede (set aside a candidate written under an earlier rule without judging it; needs a note summarizing what in it is worth keeping, which the role's next refiner reads; its difficulties go back into the count, so the next refiner sees the whole backlog). Nothing is written to a skill except by decision enable. The HSkills git is not touched; committing the change is up to you.",
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer', minimum: 1, description: 'Candidate id from candidates.' },
        verdicts: {
          type: 'array',
          description: 'Your judgment per difficulty, e.g. [{"difficulty": 12, "verdict": "real"}].',
          items: {
            type: 'object',
            properties: {
              difficulty: { type: 'integer', description: 'Difficulty number (the #n that candidates shows).' },
              verdict: { type: 'string', enum: ['real', 'invalid', 'sporadic'] },
              note: { type: 'string', description: 'Why, in a sentence (optional).' },
            },
            required: ['difficulty', 'verdict'],
            additionalProperties: false,
          },
        },
        decision: { type: 'string', enum: ['enable', 'reject', 'defer', 'supersede'], description: 'Leave it out to only record verdicts.' },
        note: { type: 'string', description: 'Required for reject (why this version is not wanted) and for supersede (what in it is worth keeping); the refiner reads it next time.' },
        force: { type: 'boolean', description: 'Enable even though the skill changed after the candidate was written. Only when you have merged the candidate file by hand.' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
];

// One reminder of each kind per client session: this bridge process lives as long as the client's
// session does. The difficulty reminder (classes waiting for a verdict) and the candidate reminder (a
// skill candidate waiting for review) are separate, each shown at most once.
// `error` is not a reminder: while HSkills' skills directory is missing (skill-loop.mjs
// skillLibraryCheck) every seat_start and seat_list reply carries it, in every session, until it is
// fixed (2026-10-01,「マスター」: "照常开工但是一定要报错"). It goes first in the reply, the reminder last.
let reminded = false;
let candidateReminded = false;
// Text a handler hands back beside a structure, each sent as one more content block after the
// structure's JSON (seat_list full). A symbol key, so JSON.stringify leaves it out of the first block.
const MORE_BLOCKS = Symbol('more text blocks');
// `remind: false` asks for the error only and leaves the reminders for a reply that shows them.
async function notices({ remind = true } = {}) {
  try {
    const found = await api('GET', '/reminders');
    if (!remind) return { error: found?.hskills ?? null, reminder: null };
    const parts = [];
    if (!reminded && found?.difficulty) {
      reminded = true;
      parts.push(found.difficulty);
    }
    if (!candidateReminded && found?.candidate) {
      candidateReminded = true;
      parts.push(found.candidate);
    }
    return { error: found?.hskills ?? null, reminder: parts.length ? parts.join('\n') : null };
  } catch {
    // no reminder is better than a failed dispatch
  }
  return { error: null, reminder: null };
}
async function withReminder(reply) {
  const { error, reminder } = await notices();
  return { ...(error ? { error } : {}), ...reply, ...(reminder ? { reminder } : {}) };
}

// ---- Views for a model reader (2026-10-01) -------------------------------------------------------
// The raw rows stay one explicit argument away (seat_list full, seat_show events/tail/run); by
// default a tool answers in short lines a model can read without a schema.

const pad2 = (n) => String(n).padStart(2, '0');
function localTime(iso) {
  const d = new Date(iso ?? '');
  if (Number.isNaN(d.getTime())) return String(iso ?? '?');
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
function durationWords(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return message(`${s} 秒`, `${s} seconds`);
  const m = Math.floor(s / 60);
  if (m < 60) return message(`${m} 分 ${s % 60} 秒`, `${m} minutes ${s % 60} seconds`);
  return message(`${Math.floor(m / 60)} 小时 ${m % 60} 分`, `${Math.floor(m / 60)} hours ${m % 60} minutes`);
}
const RUN_STATUS_WORDS = {
  running: message('还在跑', 'running'),
  done: message('完成（退出码 0）', 'done (exit code 0)'),
  failed: message('失败', 'failed'),
  timeout: message('超时，服务结束了它的进程树', 'timed out; the service stopped its process tree'),
  cancelled: message('被取消（seat_close）', 'cancelled (seat_close)'),
  interrupted: message('中断：进程和结果都没了', 'interrupted: process and result are missing'),
  closed: message('座位已关闭', 'seat closed'),
  unknown: message('结局不明', 'unknown outcome'),
};

function seatLine(row) {
  const bits = [
    `[${row.name ?? row.seat}]`,
    row.seat,
    row.role,
    row.domain ? message(`${row.domain}（领域）`, `${row.domain} (domain)`) : (row.cwd ?? message('（没有目录）', '(no directory)')),
    row.state,
    message(`来过 ${row.visits ?? 0} 次`, `${row.visits ?? 0} visit(s)`),
    message(`未完成 ${row.backlog_items} 条`, `backlog ${row.backlog_items}`),
    row.expertise ? message(`专长：${row.expertise}`, `expertise: ${row.expertise}`) : message('还没有专长说明', 'no expertise note yet'),
  ];
  if (row.topic) bits.push(message(`主题：${row.topic}`, `topic: ${row.topic}`));
  if (row.suggest_split) bits.push(message('建议拆分', 'suggest split'));
  return bits.join(' · ');
}

// The text of one run, from GET /run. Shared by task_result, task_wait and seat_show.
function runText(summary, { withSeat = false } = {}) {
  const seat = summary.seat;
  const lines = [];
  if (withSeat) {
    lines.push(message(`座位 ${seat.seat}「${seat.name ?? seat.seat}」：岗位 ${seat.role}，目录 ${seat.cwd ?? '（没有，服务的临时目录）'}，座位状态 ${seat.state}，未完成清单 ${seat.backlog_items} 条。`, `Seat ${seat.seat} (${seat.name ?? seat.seat}): role ${seat.role}, cwd ${seat.cwd ?? '(service scratch directory)'}, state ${seat.state}, backlog ${seat.backlog_items} item(s).`));
    if (seat.expertise) lines.push(message(`专长：${seat.expertise}`, `Expertise: ${seat.expertise}`));
  }
  const r = summary.run;
  if (!r) {
    lines.push(message(`座位 ${seat.seat} 还没跑过任何一单。`, `Seat ${seat.seat} has never run.`));
    return lines.join('\n');
  }
  const timing = r.ended
    ? (r.ended_at ? message(`用时 ${durationWords(Date.parse(r.ended_at) - Date.parse(r.started_at))}`, `duration ${durationWords(Date.parse(r.ended_at) - Date.parse(r.started_at))}`) : '')
    : message(`已经跑了 ${durationWords(Date.now() - Date.parse(r.started_at))}`, `elapsed ${durationWords(Date.now() - Date.parse(r.started_at))}`);
  lines.push(message(`${r.latest ? '最近一单' : '这一单'}：运行 #${r.run}（座位 ${seat.seat}），${RUN_STATUS_WORDS[r.status] ?? r.status}；${localTime(r.started_at)} 开始${timing ? `，${timing}` : ''}。`, `${r.latest ? 'Latest run' : 'Run'}: run #${r.run} (seat ${seat.seat}), ${RUN_STATUS_WORDS[r.status] ?? r.status}; started ${localTime(r.started_at)}${timing ? `, ${timing}` : ''}.`));
  lines.push(message(`任务：${r.task}`, `Task: ${r.task}`));
  if (r.usage) lines.push(message(`用量：${r.usage}`, /^Usage:/i.test(r.usage) ? r.usage : `Usage: ${r.usage}`));
  for (const problem of r.problems) lines.push(message(`状况：${problem}`, `Issue: ${problem}`));
  if (r.stderr_tail.length) lines.push(message(`stderr 最后几行：\n${r.stderr_tail.join('\n')}`, `Last stderr lines:\n${r.stderr_tail.join('\n')}`));
  if (!r.ended) {
    if (r.last_output) lines.push(message(`最近一行输出：${r.last_output}`, `Last output: ${r.last_output}`));
    lines.push(message(`还没结束：宿主已有完成通知集成时，继续其他工作或结束本轮，完成时由宿主通知或唤醒，再用 task_result（run=${r.run}）取结果，无需阻塞 wait；没有完成通知集成时才用后台 CLI wait 或 task_wait（run=${r.run}），结束时直接带回报告。不要轮询 seat_show、seat_list、task_result 等状态来等待。`, `Still running: with host completion notifications, continue other work or end this turn, then read task_result (run=${r.run}) when notified. Otherwise use background CLI wait or task_wait (run=${r.run}). Do not poll status tools to wait.`));
    return lines.join('\n');
  }
  lines.push(r.verdict ? message(`验收：${r.verdict}`, `Verdict: ${r.verdict}`) : message(`验收：还没有。看过之后用 seat_verdict 记结论（seat=${seat.seat}, run=${r.run}）。`, `Verdict: not recorded. After review, use seat_verdict (seat=${seat.seat}, run=${r.run}).`));
  lines.push(r.backlog ? message(`它交回的未完成清单（${r.backlog_items} 条）：\n${r.backlog}`, `Reported backlog (${r.backlog_items} item(s)):\n${r.backlog}`) : message('未完成：这一单没有报告剩下的部分。', 'Backlog: this run reported no remaining work.'));
  const report = r.report;
  if (!report || !report.chars) {
    lines.push(message('报告：空的，这一单没有写出回答。', 'Report: empty; this run produced no answer.'));
  } else {
    const whence = report.source === 'runner' ? '' : message('，从它的输出里取的最后一段', ', last section extracted from output');
    lines.push(message(`报告（共 ${report.chars} 字${whence}${report.truncated ? `，下面是前 ${report.text.length} 字` : ''}）：`, `Report (${report.chars} characters${whence}${report.truncated ? `, first ${report.text.length} characters shown` : ''}):`));
    // Size and fingerprint of the whole report (not of the part shown), so a reader of the file can check it.
    if (report.sha256) lines.push(message(`（全文 ${report.bytes} 字节，sha256 ${report.sha256.slice(0, 12)}…）`, `(Full text ${report.bytes} bytes, sha256 ${report.sha256.slice(0, 12)}…)`));
    lines.push(report.text);
    if (report.truncated) {
      lines.push(report.file
        ? message(`……（没给完。全文在 ${report.file}，直接读这个文件；或 task_result 带更大的 max_chars）`, `… (Truncated. Read the full report at ${report.file}, or increase task_result max_chars.)`)
        : message('……（没给完；task_result 带更大的 max_chars 取更多）', '… (Truncated; increase task_result max_chars for more.)'));
    }
  }
  return lines.join('\n');
}

// seat may be written "seat-coder-3#1234" (the run key the ledger uses elsewhere).
function runTarget(args, tool) {
  let seat = typeof args.seat === 'string' && args.seat.trim() ? args.seat.trim() : null;
  let run = args.run === undefined || args.run === null || args.run === '' ? null : Number(args.run);
  if (seat && seat.includes('#')) {
    const [id, seq] = seat.split('#');
    seat = id;
    if (run === null) run = Number(seq);
  }
  if (run !== null && (!Number.isInteger(run) || run < 1)) throw new Error(message(`${tool}: run 要填运行号（正整数，那一单 task 事件的 seq），收到的是 ${args.run}`, `${tool}: run must be a positive integer (the task event seq); got ${args.run}`));
  if (!seat && run === null) throw new Error(message(`${tool}: 要给 seat（座位号）或 run（运行号），至少一个`, `${tool}: at least one of seat or run is required`));
  return { seat, run };
}

function runRoute({ seat, run, maxChars }) {
  const query = new URLSearchParams();
  if (seat) query.set('seat', seat);
  if (run !== null && run !== undefined) query.set('run', String(run));
  if (maxChars !== undefined && maxChars !== null) {
    const n = Number(maxChars);
    if (!Number.isFinite(n) || n < 1) throw new Error(message(`max_chars 要填正整数，收到的是 ${maxChars}`, `max_chars must be a positive integer; got ${maxChars}`));
    query.set('budget', String(Math.floor(n)));
  }
  return `/run?${query}`;
}

const TASK_WAIT_DEFAULT_S = 300;
const TASK_WAIT_MAX_S = 3600;
// One long poll at a time stays well inside the shell's own per-call timeout (the /events/wait call
// gets its timeoutMs plus a 10 s margin, see timeoutFor), so a long wait is a series of these.
const TASK_WAIT_SLICE_MS = 20000;
// A run's output arrives line by line and each line wakes the poll; re-reading the run at most once
// a second keeps a chatty run from turning the wait into a busy loop.
const TASK_WAIT_PACE_MS = 1000;

// The waiting core, shared by the task_wait tool and the CLI's `wait` (which a Claude Code lead runs
// as a background command: the host wakes the lead when it exits, so the lead never blocks).
// maxSeconds caps one call; the CLI passes a larger cap than the tool.
export async function waitForRun(args, { tool = 'task_wait', maxSeconds = TASK_WAIT_MAX_S, signal } = {}) {
  signal?.throwIfAborted();
  const target = runTarget(args, tool);
  const rawTimeout = args.timeout_seconds === undefined || args.timeout_seconds === null ? TASK_WAIT_DEFAULT_S : Number(args.timeout_seconds);
  if (!Number.isFinite(rawTimeout) || rawTimeout <= 0) throw new Error(message(`${tool}: timeout_seconds 要填正数（秒），收到的是 ${args.timeout_seconds}`, `${tool}: timeout_seconds must be positive; got ${args.timeout_seconds}`));
  const timeoutS = Math.min(rawTimeout, maxSeconds);
  const startedMs = Date.now();
  const deadline = startedMs + timeoutS * 1000;
  let summary = await api('GET', runRoute({ ...target, maxChars: args.max_chars }), undefined, signal);
  if (!summary.run) return { ended: false, status: null, text: message(`座位 ${summary.seat.seat} 还没跑过任何一单，没有可等的。`, `Seat ${summary.seat.seat} has never run; there is nothing to wait for.`) };
  // Pinned to the run that was newest when the call came in: a later dispatch to the same seat does
  // not move the target.
  const runId = summary.run.run;
  const seatId = summary.seat.seat;
  while (!summary.run.ended) {
    signal?.throwIfAborted();
    const left = deadline - Date.now();
    if (left <= 0) {
      const r = summary.run;
      return {
        ended: false,
        status: r.status,
        text: message(`等了 ${durationWords(Date.now() - startedMs)}，运行 #${runId}（座位 ${seatId}）还在跑，已经跑了 ${durationWords(Date.now() - Date.parse(r.started_at))}。`, `Waited ${durationWords(Date.now() - startedMs)}; run #${runId} (seat ${seatId}) is still running, elapsed ${durationWords(Date.now() - Date.parse(r.started_at))}. `)
          + (r.last_output ? message(`最近一行输出：${r.last_output}。`, `Last output: ${r.last_output}. `) : '')
          + message(`宿主已有完成通知集成时，继续其他工作或结束本轮，完成时由宿主通知或唤醒，再用 task_result（run=${runId}）取结果，无需另开 wait。没有完成通知集成时：`, `With host completion notifications, continue other work or end this turn, then read task_result (run=${runId}) when notified. Without notifications: `)
          + (tool === 'task_wait'
            ? message(`要接着等，再调 task_wait（run=${runId}）；`, `to continue waiting, call task_wait (run=${runId}); `)
            : message(`要接着等，后台再跑一次 node "${CLI_FILE.replaceAll('\\', '/')}" wait ${runId}；`, `to continue waiting, run node "${CLI_FILE.replaceAll('\\', '/')}" wait ${runId} in the background; `))
          + message('也可以先去做别的事，回头用 task_result 取。不要轮询 seat_show、seat_list、task_result 等状态来等待。', 'you may continue other work and read task_result later. Do not poll seat_show, seat_list, or task_result to wait.'),
      };
    }
    const waited = await api('GET', `/events/wait?since=${summary.ledger_seq}&seat=${encodeURIComponent(seatId)}&timeoutMs=${Math.min(left, TASK_WAIT_SLICE_MS)}`, undefined, signal);
    if (waited?.changed) await sleep(Math.min(TASK_WAIT_PACE_MS, Math.max(0, deadline - Date.now())));
    summary = await api('GET', runRoute({ run: runId, maxChars: args.max_chars }), undefined, signal);
  }
  return { ended: true, status: summary.run.status, text: message(`运行 #${runId} 结束了（这次等了 ${durationWords(Date.now() - startedMs)}）。\n${runText(summary)}`, `Run #${runId} ended (waited ${durationWords(Date.now() - startedMs)}).\n${runText(summary)}`) };
}

const codexCompletionBridge = new CodexCompletionBridge({
  waitForRun, stateDir: path.join(ROOT, '.data', 'codex-completions'),
});

async function taskWait(args) {
  return (await waitForRun(args)).text;
}

/** The guides there are, by name (file name without .md); the lead's manual is not a role and is left out. */
function guideRoles() {
  try {
    return fs.readdirSync(DISPATCH_DIR, { withFileTypes: true })
      .filter((f) => f.isFile() && f.name.endsWith('.md') && f.name !== `${LEAD_GUIDE}.md`)
      .map((f) => f.name.slice(0, -3))
      .sort();
  } catch {
    return [];
  }
}

export function readGuide(name, lang = resolveLang()) {
  if (!/^[a-z_-]+$/.test(name)) throw new Error('Invalid dispatch guide name');
  const localized = path.join(DISPATCH_DIR, 'zh-CN', `${name}.md`);
  let raw;
  try {
    raw = fs.readFileSync(lang === 'zh' ? localized : path.join(DISPATCH_DIR, `${name}.md`), 'utf8');
  } catch (err) {
    if (lang !== 'zh' || err.code !== 'ENOENT') throw err;
    raw = fs.readFileSync(path.join(DISPATCH_DIR, `${name}.md`), 'utf8');
  }
  raw = raw.replace(/^﻿/, '');
  const custom = resolveCallerTitle();
  return custom ? raw.replace(/the user|用户/g, () => custom) : raw;
}

/** The manual as instructions. A missing file must not break the handshake: the client then gets no instructions, and stderr says why. */
function leadInstructions() {
  try {
    return readGuide(LEAD_GUIDE);
  } catch (err) {
    process.stderr.write(message(`specialist-subagents mcp: 组长手册 ${path.join(DISPATCH_DIR, `${LEAD_GUIDE}.md`)} 读不到（${err.code ?? err.message}），这次握手不带 instructions；把文件放回去，新开的会话就会带上。\n`, `specialist-subagents mcp: could not read lead manual ${path.join(DISPATCH_DIR, `${LEAD_GUIDE}.md`)} (${err.code ?? err.message}); omitting instructions for this handshake. Restore the file for new sessions.\n`));
    return null;
  }
}

function dispatchGuide(args) {
  const role = typeof args.role === 'string' ? args.role.trim() : '';
  if (!role) return readGuide(LEAD_GUIDE);
  const roles = guideRoles();
  // Only a bare role id: the name becomes a file path, so nothing that could step out of dispatch/.
  if (!/^[a-z_]+$/.test(role) || !roles.includes(role)) {
    throw new Error(message(`没有 ${role} 的调用指南。有的是：${roles.join('、') || '（dispatch/ 里一份都没有）'}；不带 role 取组长手册。refiner 由服务自己派，组长不派，所以没有它的指南。`, `No caller guide for ${role}. Available: ${roles.join(', ') || '(none in dispatch/)'}. Omit role for the lead manual. The service dispatches refiner automatically, so it has no caller guide.`));
  }
  return readGuide(role);
}

// Follow the host's completion notifications when integrated; otherwise use a background CLI wait
// (for example, Claude Code's background Bash command) or task_wait. This is guidance, not host detection.
function afterDispatch(seat) {
  const cliPath = CLI_FILE.replaceAll('\\', '/');
  return message(
    `派完就去做别的，不要守着等。宿主已有完成通知集成时，继续其他工作或结束本轮，完成时由宿主通知或唤醒，再用 task_result（seat=${seat}）取结果；无需另开 wait 或调用阻塞的 task_wait。没有完成通知集成时才用后台 CLI wait 或 task_wait：Claude Code 可用 Bash 的后台运行（run_in_background）跑 node "${cliPath}" wait ${seat}，命令结束时宿主会叫醒你，报告就在它的输出里；不能后台运行命令时用 task_wait（seat=${seat}）。不要轮询 seat_show、seat_list、task_result 等状态来等待。`,
    `Move on immediately after dispatching—do not wait synchronously. If your host integrates completion notifications, continue other work or end this turn and call task_result (seat=${seat}) once woken/notified, without running wait or blocking on task_wait. Only when completion notifications are unavailable, use a background CLI wait or task_wait: in Claude Code run node "${cliPath}" wait ${seat} with run_in_background so the host wakes you with its report on completion; otherwise use task_wait (seat=${seat}). Never poll seat_show, seat_list, or task_result while waiting.`,
  );
}

const TOOL_HANDLERS = {
  role_list: async () => {
    const rows = await api('GET', '/roles');
    const status = await api('GET', '/backend/health').catch(() => null);
    if (status?.summary && Array.isArray(rows)) rows[MORE_BLOCKS] = [status.summary];
    return rows;
  },
  // The one dispatch path: the daemon spawns the runtime and answers with the seat it opened, so
  // the caller is free the moment the seat exists. A blocking twin existed until 2026-09-19 and was
  // deleted (FR-4): any work, not only long work, has to leave the caller free.
  seat_start: (args) => {
    if (!args.role) throw new Error('seat_start: role is required');
    if (typeof args.task !== 'string') throw new Error('seat_start: task is required');
    // H-3: a dispatch that names no owner is filed under the host that asked for it.
    const named = typeof args.owner === 'string' ? args.owner.trim() : '';
    return api('POST', '/seat/start', {
      role: args.role,
      task: args.task,
      owner: named || hostOwner(),
      parent: args.parent ?? null,
      cwd: args.cwd ?? null,
      domain: args.domain ?? null,
      topic: args.topic ?? null,
      seat: args.seat ?? null,
      fork: args.fork ?? null,
      // R-6: the seat this bridge runs in, from the environment the service set; the daemon decides.
      caller_seat: CALLER_SEAT,
    })
      .then((reply) => ({ ...reply, next: afterDispatch(reply.seat) }))
      .then(withReminder);
  },
  seat_verdict: (args) => {
    if (!args.seat || !args.verdict) throw new Error('seat_verdict: seat and verdict are required');
    return api('POST', '/seat/verdict', { seat: args.seat, verdict: args.verdict, note: args.note ?? null, run: args.run ?? null });
  },
  difficulty_report: async () => (await api('GET', '/difficulties')).text,
  difficulty_decide: (args) => {
    if (!args.class || !args.decision) throw new Error('difficulty_decide: class and decision are required');
    return api('POST', '/difficulties/decide', { class: args.class, decision: args.decision, note: args.note ?? null });
  },
  candidates: async (args) => {
    const query = new URLSearchParams();
    if (args.id !== undefined && args.id !== null && args.id !== '') query.set('id', String(args.id));
    if (args.role) query.set('role', args.role);
    if (args.state) query.set('state', args.state);
    const qs = query.toString();
    return (await api('GET', `/candidates${qs ? `?${qs}` : ''}`)).text;
  },
  candidate_decide: async (args) => {
    if (args.id === undefined || args.id === null || args.id === '') throw new Error('candidate_decide: id is required');
    return (await api('POST', '/candidates/decide', { id: args.id, verdicts: args.verdicts ?? [], decision: args.decision ?? null, note: args.note ?? null, force: args.force === true })).text;
  },
  memory_write: (args) => {
    if (!args.role || !args.kind || !args.body) throw new Error('memory_write: role, kind and body are required');
    return api('POST', '/memory/write', { role: args.role, kind: args.kind, body: args.body, source: args.source ?? null });
  },
  memory_read: (args) => {
    if (!args.role) throw new Error('memory_read: role is required');
    const limit = args.limit === undefined || args.limit === null ? 20 : Number(args.limit);
    if (!Number.isFinite(limit) || limit < 1) throw new Error(`memory_read: limit must be a whole number of at least 1, got ${args.limit}. Leave it out for the default of 20.`);
    return api('GET', `/memory/read?role=${encodeURIComponent(args.role)}&limit=${Math.floor(limit)}`);
  },
  // Always the same shape: the default is text (a header, one line per seat, and the reminder as a
  // last line when there is one; while HSkills' skills directory is missing, its error is the first
  // line, on every call). With full the first content block is always the bare array of rows and never
  // carries the reminder; while HSkills' skills directory is missing its error comes as a second text
  // block, so a lead who only ever lists with full still reads it (2026-10-01 review). Until 2026-10-01
  // a reminder turned the array into { reminder, seats } on one call only.
  seat_list: async (args) => {
    if (args.full) {
      const rows = await api('GET', `/seats${args.state ? `?state=${encodeURIComponent(args.state)}` : ''}`);
      const { error } = await notices({ remind: false });
      if (error && rows && typeof rows === 'object') rows[MORE_BLOCKS] = [error];
      return rows;
    }
    const query = new URLSearchParams({ view: 'compact' });
    if (args.state) query.set('state', args.state);
    if (args.cwd) query.set('cwd', args.cwd);
    if (args.domain) query.set('domain', args.domain);
    if (args.role) query.set('role', args.role);
    const rows = await api('GET', `/seats?${query}`);
    const columns = message(
      '每行：名字 · 座位 · 岗位 · 目录/领域 · 状态 · 来过几次 · 未完成条数 · 专长',
      'per row: name · seat · role · cwd/domain · state · visits · backlog · expertise',
    );
    const lines = [];
    if (args.cwd && !rows.length) {
      lines.push(args.state
        ? message(`目录 ${args.cwd} 没有状态为 ${args.state} 的座位。`, `No seats with state "${args.state}" for directory ${args.cwd}.`)
        : message(`目录 ${args.cwd} 还没有活着的目录专家：seat_start 带上这个 cwd，会新开一个座位做它的专家。`, `No living expert for directory ${args.cwd} yet; calling seat_start with this cwd opens one.`));
    } else if (args.cwd) {
      lines.push(message(`目录 ${args.cwd} 的座位 ${rows.length} 个（${columns}）：`, `${rows.length} seat(s) for directory ${args.cwd} (${columns}):`));
    } else if (args.domain && !rows.length) {
      lines.push(args.state
        ? message(`领域 ${args.domain} 没有状态为 ${args.state} 的座位。`, `No seats with state "${args.state}" for domain ${args.domain}.`)
        : message(`领域 ${args.domain} 还没有专家：seat_start 带上这个 domain，会新开一个座位做它的专家。`, `No expert for domain ${args.domain} yet; calling seat_start with this domain opens one.`));
    } else if (args.domain) {
      lines.push(message(`领域 ${args.domain} 的座位 ${rows.length} 个（${columns}）：`, `${rows.length} seat(s) for domain ${args.domain} (${columns}):`));
    } else if (args.state) {
      lines.push(message(`状态为 ${args.state} 的座位 ${rows.length} 个（${columns}）：`, `${rows.length} seat(s) with state "${args.state}" (${columns}):`));
    } else if (args.role) {
      lines.push(message(`${args.role} 的专家 ${rows.length} 个（${columns}）：`, `${rows.length} expert(s) for role ${args.role} (${columns}):`));
    } else {
      lines.push(message(
        `活着的专家 ${rows.length} 个：有目录或领域、没关闭、岗位还在、跑过活的才列（${columns}）。只看某个岗位带 role，某个目录归谁带 cwd，某个领域带 domain；点名派活把座位号给 seat_start 的 seat；改名用 seat_rename；原始完整行带 full: true。`,
        `${rows.length} living expert(s) (non-closed with cwd/domain, valid role, and at least one run; ${columns}). Filter with role, cwd, or domain; target one with seat_start.seat; rename with seat_rename; pass full: true for raw rows.`,
      ));
    }
    lines.push(...rows.map(seatLine));
    const { error, reminder } = await notices();
    if (error) lines.unshift(error);
    if (reminder) lines.push(message(`提醒：${reminder}`, `Reminder: ${reminder}`));
    return lines.join('\n');
  },
  // By default the newest run's result; the raw event log only when asked for it.
  seat_show: async (args) => {
    if (!args.seat) throw new Error('seat_show: seat is required');
    const given = (v) => v !== undefined && v !== null && v !== '';
    if (args.events === true || given(args.tail) || given(args.run)) {
      const query = new URLSearchParams();
      if (given(args.tail)) query.set('tail', String(args.tail));
      if (given(args.run)) query.set('run', String(args.run));
      const qs = query.toString();
      return api('GET', `/seats/${encodeURIComponent(args.seat)}${qs ? `?${qs}` : ''}`);
    }
    const summary = await api('GET', runRoute({ seat: args.seat, run: null }));
    const lines = [runText(summary, { withSeat: true })];
    const older = summary.recent_runs.filter((r) => r.run !== summary.run?.run);
    if (older.length) {
      lines.push(message(
        `这个座位更早的运行：${older.map((r) => `#${r.run}（${localTime(r.at)}）`).join('、')}。某一单的报告用 task_result（run=号），原始事件用 seat_show 带 run / tail / events: true。`,
        `Earlier runs on this seat: ${older.map((r) => `#${r.run} (${localTime(r.at)})`).join(', ')}. Use task_result (run=<id>) for a report, or seat_show with run / tail / events: true for raw events.`,
      ));
    }
    return lines.join('\n');
  },
  dispatch_guide: (args) => dispatchGuide(args),
  task_wait: (args) => taskWait(args),
  task_result: async (args) => {
    const target = runTarget(args, 'task_result');
    return runText(await api('GET', runRoute({ ...target, maxChars: args.max_chars })));
  },
  seat_rename: (args) => {
    if (!args.seat || typeof args.name !== 'string') throw new Error('seat_rename: seat and name are required');
    return api('POST', '/seat/rename', { seat: args.seat, name: args.name });
  },
  seat_close: (args) => {
    if (!args.seat) throw new Error('seat_close: seat is required');
    return api('POST', '/seat/close', { seat: args.seat, reason: args.reason ?? null });
  },
  task_cancel: (args) => {
    if (!args.seat) throw new Error('task_cancel: seat is required');
    return api('POST', '/task/cancel', { seat: args.seat, reason: args.reason ?? null });
  },
  seat_merge: (args) => {
    if (!args.from || !args.into) throw new Error('seat_merge: from and into are required');
    return api('POST', '/seat/merge', { from: args.from, into: args.into, name: args.name ?? null });
  },
  seat_split: (args) => {
    if (!args.seat) throw new Error('seat_split: seat is required');
    if (!Array.isArray(args.parts) || args.parts.length < 2) throw new Error(message('seat_split: parts 至少要两个', 'seat_split: parts must contain at least two entries'));
    return api('POST', '/seat/split', { seat: args.seat, parts: args.parts });
  },
};

// H-3 (2026-10-11): which host is asking for the work. The client says who it is at initialize
// (MCP `clientInfo`); the service keeps no list of hosts, it writes down what was reported, so a new
// host needs no change here. One shell serves one client session, so this is that session's host.
let clientInfo = null;

// The host's name, with its version when the client gave one: what `owner` is filled in with.
function hostOwner() {
  const name = String(clientInfo?.name ?? '').trim();
  if (!name) return null;
  const version = String(clientInfo?.version ?? '').trim();
  return version ? `${name} ${version}` : name;
}

async function handleRequest(request) {
  const { id, method, params } = request;
  if (method === 'initialize') {
    if (params?.clientInfo && typeof params.clientInfo === 'object') clientInfo = params.clientInfo;
    const result = { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: SERVER_INFO };
    // InitializeResult.instructions is in the 2024-11-05 schema already; clients MAY put it in the system prompt.
    // A member seat has no tools here, so it gets no dispatching manual either.
    const instructions = CALLER_SEAT && !CALLER_DISPATCHES ? null : leadInstructions();
    if (instructions) result.instructions = instructions;
    return { jsonrpc: '2.0', id, result };
  }
  if (method === 'ping') {
    return { jsonrpc: '2.0', id, result: {} };
  }
  if (method === 'tools/list') {
    return { jsonrpc: '2.0', id, result: { tools: TOOLS.filter((tool) => visibleTool(tool.name)) } };
  }
  if (method === 'tools/call') {
    const name = params?.name;
    const args = params?.arguments && typeof params.arguments === 'object' ? params.arguments : {};
    const handler = TOOL_HANDLERS[name];
    if (!handler) return { jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown tool: ${name}` } };
    if (!visibleTool(name)) {
      if (!CALLER_SEAT && TOOL_PROFILE === 'core') {
        return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `specialist-subagents error: ${name} is disabled under tool profile "core" (skill-refinement loop tools require profile "full").` }], isError: true } };
      }
      const why = CALLER_DISPATCHES ? message('座位里的 Leader 只用派单、等结果、取结果、看座位、记验收这几个工具', 'Leader seats only dispatch, wait, retrieve results, inspect seats, and record verdicts') : message('组员座位不派单，也不用这个服务的工具，活自己干完', 'Member seats complete their own work without dispatching or using service tools');
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: message(`specialist-subagents error: ${name} 在这个座位（${CALLER_SEAT}）里不可用：${why}。`, `specialist-subagents error: ${name} is unavailable in this seat (${CALLER_SEAT}): ${why}.`) }], isError: true } };
    }
    try {
      const value = await handler(args);
      if (name === 'seat_start' && codexCompletionBridge.enabled && value && typeof value === 'object') {
        value.codex_completion = await codexCompletionBridge.register(value, params?._meta);
        if (value.codex_completion.state === 'watching') {
          value.next = message(
            `已登记运行 #${value.run} 的本聊天完成通知，可结束本轮，无需 wait；完成后用 task_result（run=${value.run}）按原授权验收。`,
            `Chat completion notification registered for run #${value.run}. You can end this turn without running wait; once notified, inspect with task_result (run=${value.run}).`,
          );
        } else {
          value.next += message(
            ` 完成通知未登记：${value.codex_completion.reason}。`,
            ` Completion notification not registered: ${value.codex_completion.reason}.`,
          );
        }
      }
      // A tool that already answers in words is passed through as words, not as a quoted JSON string.
      // Structures go out without indentation: two-space indents were a fifth of seat_list's 108KB.
      const text = typeof value === 'string' ? value : JSON.stringify(value);
      const more = value && typeof value === 'object' && Array.isArray(value[MORE_BLOCKS]) ? value[MORE_BLOCKS] : [];
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }, ...more.map((line) => ({ type: 'text', text: line }))] } };
    } catch (err) {
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `specialist-subagents error: ${err.message}` }], isError: true } };
    }
  }
  return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
}

async function handleLine(line) {
  const text = line.trim();
  if (!text) return;
  let message;
  try {
    message = JSON.parse(text);
  } catch (err) {
    write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: `Parse error: ${err.message}` } });
    return;
  }
  if (message === null || typeof message !== 'object' || Array.isArray(message)) {
    write({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
    return;
  }
  const isNotification = !Object.prototype.hasOwnProperty.call(message, 'id');
  if (typeof message.method !== 'string') {
    if (!isNotification) write({ jsonrpc: '2.0', id: message.id, error: { code: -32600, message: 'Invalid Request' } });
    return;
  }
  const response = await handleRequest(message);
  if (!isNotification) write(response);
}

// task_wait may block for minutes. Requests are otherwise answered one after another, so it is taken
// out of that line: while one client waits on a run, its other calls (and ping) still get answers.
function isLongCall(line) {
  try {
    const message = JSON.parse(line);
    return message?.method === 'tools/call' && message.params?.name === 'task_wait';
  } catch {
    return false;
  }
}

export function startMcpStdio() {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.once('close', () => codexCompletionBridge.close());
  let chain = Promise.resolve();
  const report = (err) => {
    process.stderr.write(`specialist-subagents mcp: ${err.message}\n`);
  };
  rl.on('line', (line) => {
    if (isLongCall(line)) {
      handleLine(line).catch(report);
      return;
    }
    chain = chain.then(() => handleLine(line)).catch(report);
  });
  return rl;
}

// Node resolves symlinks and junctions in the main module's URL but leaves process.argv[1] as typed, so
// comparing them bare made `node <junction>/src/mcp-stdio.mjs` start nothing and exit 0 (the same trap that
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
if (isMain) startMcpStdio();
