// specialist-subagents seat-runner: replaces the old `pi -p ... --no-session` child process.
//
// Why this exists: the daemon used to spawn pi's own CLI per task, which meant every task got a
// throwaway session and pi's own system prompt (docs, AGENTS.md discovery, skills, prompt
// templates). A "seat" is supposed to be a standing expert that keeps its session across tasks
// and whose system prompt we fully own. The SDK gives us both: SessionManager to open/create a
// session file the daemon can hand back next time, and a custom ResourceLoader to replace pi's
// system prompt outright instead of layering onto it.
//
// This file is a CLI itself — the daemon spawns it with `node seat-runner.mjs --pi ... -p ...` —
// not a library, so argv/env parsing lives at the top level with no exported surface.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { offPeakCost } from './pricing.mjs';
import { closingPromptFor, splitClosing } from './closing.mjs';
import { commandMissing, expectedRule, missingMark } from './expected-traces.mjs';
import { message } from './presets.mjs';

// --- argv parsing -----------------------------------------------------------------------------
// Flags map 1:1 onto the contract in the task brief. --append-system-prompt may repeat; every
// other flag is single-valued. Anything unrecognized is a caller bug, not something to silently
// swallow, so it throws.
function parseArgv(argv) {
  const opts = {
    pi: undefined,
    provider: undefined,
    model: undefined,
    tools: [],
    appendSystemPrompt: [],
    task: undefined,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--pi':
        opts.pi = argv[++i];
        break;
      case '--provider':
        opts.provider = argv[++i];
        break;
      case '--model':
        opts.model = argv[++i];
        break;
      case '--thinking':
        opts.thinking = argv[++i];
        break;
      case '--tools':
        opts.tools = (argv[++i] ?? '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        break;
      case '--append-system-prompt':
        opts.appendSystemPrompt.push(argv[++i]);
        break;
      case '-p':
        opts.task = argv[++i];
        break;
      // The task read from a file: cli-runner hands it over this way, since a hand-off from another
      // backend's session put in front of it could pass Windows' command-line limit (2026-10-22:
      // seat-handyman-23, coming from a long Codex session, died with a bare spawn ENAMETOOLONG).
      case '--task-file':
        opts.task = fs.readFileSync(argv[++i], 'utf8');
        break;
      default:
        throw new Error(message(
          `未知参数「${arg}」：seat-runner 只认 --pi --provider --model --thinking --tools --append-system-prompt -p --task-file`,
          `Unknown option "${arg}": seat-runner only accepts --pi --provider --model --thinking --tools --append-system-prompt -p --task-file`,
        ));
    }
  }
  if (!opts.pi) throw new Error(message('缺 --pi：pi 的 cli.js 绝对路径', 'Missing --pi: absolute path to pi cli.js'));
  if (!opts.provider) throw new Error(message('缺 --provider', 'Missing --provider'));
  if (!opts.model) throw new Error(message('缺 --model', 'Missing --model'));
  if (opts.tools.length === 0) throw new Error(message('缺 --tools：至少给一个工具名', 'Missing --tools: at least one tool name is required'));
  if (!opts.task) throw new Error(message('缺 -p 或 --task-file：这次要交代的任务文本', 'Missing -p or --task-file: task prompt text is required'));
  return opts;
}

// --append-system-prompt values follow pi's own convention: a value that names an existing file
// is read as that file's content, anything else is used verbatim as text.
function resolveAppendSegment(value) {
  try {
    if (fs.existsSync(value) && fs.statSync(value).isFile()) {
      return fs.readFileSync(value, 'utf8');
    }
  } catch {
    // fall through to literal text — a path that half-exists (e.g. a broken symlink) is not
    // worth failing the whole run over, just treat the value as text
  }
  return value;
}

// One key argument per tool, picked for what a human skimming the log would want to see. Falls
// back to a trimmed JSON dump for tools this runner doesn't special-case.
function describeToolCall(toolName, args) {
  const a = args && typeof args === 'object' ? args : {};
  let key;
  switch (toolName) {
    case 'read':
      key = a.path ?? a.file_path;
      break;
    case 'grep':
      key = a.pattern;
      break;
    case 'find':
      key = a.pattern ?? a.glob ?? a.path;
      break;
    case 'ls':
      key = a.path ?? '.';
      break;
    default:
      key = a.path ?? a.file_path ?? a.pattern ?? a.query ?? a.command;
  }
  if (key === undefined || key === null) {
    const dump = JSON.stringify(a);
    key = dump && dump.length > 80 ? `${dump.slice(0, 80)}…` : dump;
  }
  return `· ${toolName} ${key}`;
}

// --- difficulty traces (FR-21) ----------------------------------------------------------------
function resultText(result) {
  const parts = Array.isArray(result?.content) ? result.content : [];
  return parts.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('\n').trim();
}

// A search that came back with nothing. Only for tools whose job is to find something; an empty
// write or edit result is normal.
const SEARCHY = new Set(['grep', 'find', 'ls']);
const NO_HIT = /(no (matches|results|files) found|no such file|找不到|未找到|没有结果|0 results|not found)/i;
function looksEmpty(tool, args, text) {
  if (SEARCHY.has(tool)) return text === '' || NO_HIT.test(text);
  if (tool === 'read') return NO_HIT.test(text.slice(0, 200));
  if (tool === 'bash') {
    const command = String(args?.command ?? '');
    if (!/\b(grep|rg|find|search|es\.exe|ls)\b/.test(command)) return false;
    return text === '' || NO_HIT.test(text.slice(0, 400));
  }
  return false;
}

function shortArgs(tool, args) {
  const line = describeToolCall(tool, args).replace(/^· /, '');
  return line.length > 120 ? `${line.slice(0, 120)}…` : line;
}

const UNCERTAIN = /(推断|无证据|没有证据|没找到|查不到|找不到|无法确认|不能确认|未能确认)/;

// What a bash call said about its own end. pi ends a failed command's output with "Command exited with
// code N" (pinned pi 0.87.0, core/tools/bash.js); a timeout, an abort or a kill ends with other words and
// has no code. `missing` is the command not getting to run at all: a shell, a package manager or a test
// runner saying what it was asked to run is not there (expected-traces.mjs commandMissing).
function bashFacts(tool, args, text, isError) {
  if (tool !== 'bash') return { command: null, exit_code: null, missing: false };
  const said = isError ? text.match(/Command exited with code (-?\d+)\s*$/) : null;
  return { command: String(args?.command ?? ''), exit_code: said ? Number(said[1]) : null, missing: Boolean(isError) && commandMissing(text) };
}

// A call's arguments as one string, keys sorted, so the same arguments written in another order are
// still the same call.
function canonicalArgs(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalArgs).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalArgs(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

// From ordered[i], a call whose failure is normal for the role: the identical call made again right
// after it, normal each time. Two or more such calls in a row, ordered[i] included, make one retry
// trace; one alone leaves nothing. Returns the index of the streak's last call.
function rerunStreak(ordered, i, normal, sameCall, traces) {
  const first = ordered[i];
  let j = i;
  while (j + 1 < ordered.length && normal(ordered[j + 1]) && sameCall(ordered[j + 1], first)) j += 1;
  if (j === i) return i;
  const streak = ordered.slice(i, j + 1);
  const after = ordered[j + 1];
  let outcome = message('，之后没再用它', '; not retried afterward');
  if (after && after.tool === first.tool) {
    if (!sameCall(after, first)) outcome = message(`，第 ${after.n} 次换了调用`, `; call changed at step #${after.n}`);
    else outcome = after.error || after.empty ? message(`，第 ${after.n} 次再跑出了别的问题`, `; failed differently at step #${after.n}`) : message(`，第 ${after.n} 次才有结果`, `; succeeded at step #${after.n}`);
  }
  traces.push({
    kind: 'retry',
    tool: first.tool,
    detail: message(
      `${first.tool} 原样重跑同一个调用 ${streak.length} 次，次次失败或没结果（第 ${streak.map((o) => o.n).join('、')} 次：${shortArgs(first.tool, first.args)}）${outcome}`,
      `${first.tool} repeated the identical call ${streak.length} times with failure or no output (calls ${streak.map((o) => `#${o.n}`).join(', ')}: ${shortArgs(first.tool, first.args)})${outcome}`,
    ),
  });
  return j;
}

// The role's expected_traces from roles.json, handed over by cli-runner: seat-runner knows no role (I3).
function expectedTracesFromEnv() {
  const raw = process.env.SPECIALIST_SEAT_EXPECTED_TRACES;
  if (!raw) return [];
  try {
    const rules = JSON.parse(raw);
    if (Array.isArray(rules)) return rules;
  } catch {
    // fall through to the note below
  }
  process.stderr.write(message(
    'SPECIALIST_SEAT_EXPECTED_TRACES 不是 JSON 数组：这一单的痕迹全部按困难记录。它由 cli-runner 从 roles.json 的 expected_traces 传过来，查那里。\n',
    'SPECIALIST_SEAT_EXPECTED_TRACES is not a JSON array: all traces in this run will be recorded as difficulties. Check expected_traces in roles.json via cli-runner.\n',
  ));
  return [];
}

function collectTraces(outcomes, finalText, traces, rules = []) {
  const ordered = [...outcomes].sort((a, b) => a.n - b.n);
  for (const o of ordered) {
    if (o.blocked) {
      traces.push({
        kind: 'blocked',
        tool: o.tool,
        detail: message(
          `第 ${o.n} 次调用 ${shortArgs(o.tool, o.args)} 被写入边界拦下`,
          `Call #${o.n} ${shortArgs(o.tool, o.args)} was blocked by the write boundary`,
        ),
      });
    }
  }
  // An outcome the role's contract makes normal (roles.json expected_traces: a tester's failing test, a
  // coder's search that finds nothing) is no failure here on its own: it is not recorded as an error or
  // an empty result, and it never joins a detour with outcomes that count. The one detour it can form is
  // with itself: the identical call (same tool, every argument equal) made two or more times in a row,
  // normal each time. A tester running the same failing test five times, or a coder repeating the
  // same search word for word, is going round in place; a coder trying several spellings is not, and
  // leaves nothing (2026-10-01). The Codex runner (cli-runner) does not detect retries at all,
  // normal or not: it records only commands' exit codes, a known gap.
  const facts = (o) => ({ command: o.command, exit_code: o.exit_code, missing: o.missing });
  const expected = (o) => Boolean(expectedRule(rules, { kind: o.error ? 'error' : 'empty', tool: o.tool, ...facts(o) }));
  const failed = (o) => o.error || o.empty;
  const normal = (o) => failed(o) && expected(o);
  const sameCall = (a, b) => a.tool === b.tool && canonicalArgs(a.args) === canonicalArgs(b.args);
  // A detour: the same tool failing or finding nothing at least twice in a row. A single failure is
  // recorded as itself (error / empty); inside a streak it is part of the detour, not counted twice.
  const bad = (o) => failed(o) && !expected(o);
  for (let i = 0; i < ordered.length; i += 1) {
    if (normal(ordered[i])) {
      i = rerunStreak(ordered, i, normal, sameCall, traces);
      continue;
    }
    if (!bad(ordered[i])) continue;
    let j = i;
    while (j + 1 < ordered.length && ordered[j + 1].tool === ordered[i].tool && bad(ordered[j + 1])) j += 1;
    const streak = ordered.slice(i, j + 1);
    if (streak.length === 1 && streak[0].error) {
      const o = streak[0];
      // The exit code goes into the sentence too: the output is cut to 120 characters, and a long one
      // would otherwise lose the "Command exited with code N" at its end once only the row is left.
      const code = Number.isInteger(o.exit_code) ? message(`（退出码 ${o.exit_code}）`, ` (exit code ${o.exit_code})`) : '';
      traces.push({
        kind: 'error',
        tool: o.tool,
        detail: message(
          `第 ${o.n} 次调用 ${shortArgs(o.tool, o.args)} 报错${code}：${o.text.slice(0, 120)}${o.missing ? missingMark() : ''}`,
          `Call #${o.n} ${shortArgs(o.tool, o.args)} failed${code}: ${o.text.slice(0, 120)}${o.missing ? missingMark() : ''}`,
        ),
        ...facts(o),
      });
    } else if (streak.length >= 2) {
      const after = ordered[j + 1];
      const outcome = after && after.tool === ordered[i].tool ? message(`，第 ${after.n} 次才有结果`, `; succeeded at step #${after.n}`) : message('，之后没再用它', '; not retried afterward');
      traces.push({
        kind: 'retry',
        tool: ordered[i].tool,
        detail: message(
          `${ordered[i].tool} 连续 ${streak.length} 次失败或没结果（第 ${streak.map((o) => o.n).join('、')} 次：${streak.map((o) => shortArgs(o.tool, o.args)).join('；')}）${outcome}`,
          `${ordered[i].tool} failed or returned nothing ${streak.length} times in a row (calls ${streak.map((o) => `#${o.n}`).join(', ')}: ${streak.map((o) => shortArgs(o.tool, o.args)).join('; ')})${outcome}`,
        ),
      });
    } else if (streak[0].empty && !traces.some((t) => t.kind === 'empty' && t.tool === streak[0].tool)) {
      traces.push({
        kind: 'empty',
        tool: streak[0].tool,
        detail: message(
          `第 ${streak[0].n} 次调用 ${shortArgs(streak[0].tool, streak[0].args)} 没有结果`,
          `Call #${streak[0].n} ${shortArgs(streak[0].tool, streak[0].args)} returned no output`,
        ),
        ...facts(streak[0]),
      });
    }
    i = j;
  }
  // web_researcher and explorer are told to write 查不到 / 推断 / 无法确认 where that is the truth.
  const hit = expectedRule(rules, { kind: 'uncertain', tool: null }) ? null : finalText.match(UNCERTAIN);
  if (hit) {
    const at = finalText.indexOf(hit[0]);
    const snippet = finalText.slice(Math.max(0, at - 40), at + 40).replace(/\s+/g, ' ');
    traces.push({
      kind: 'uncertain',
      tool: null,
      detail: message(`最终回答里有"${hit[0]}"：…${snippet}…`, `Final response contains "${hit[0]}": ...${snippet}...`),
    });
  }
}

// The answer is numbered to match the traces; take the part under each number.
function pickAnswer(answer, index) {
  if (!answer) return null;
  const pattern = new RegExp(`(?:^|\\n)\\s*${index}[.、)）]\\s*([\\s\\S]*?)(?=\\n\\s*\\d+[.、)）]|$)`);
  const m = answer.match(pattern);
  const text = (m ? m[1] : index === 1 ? answer : '').trim();
  return text ? text.slice(0, 600) : null;
}

function writeResult(resultPath, data) {
  try {
    fs.writeFileSync(resultPath, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    // if we can't even write the result file, say so on stderr — the daemon has nothing else to
    // go on if this fails silently
    process.stderr.write(message(`写结果文件「${resultPath}」失败：${err && err.message ? err.message : err}\n`, `Could not write result file ${resultPath}: ${err && err.message ? err.message : err}\n`));
  }
}

function tokenDelta(before, after) {
  return {
    input: after.input - before.input,
    output: after.output - before.output,
    cacheRead: after.cacheRead - before.cacheRead,
    cacheWrite: after.cacheWrite - before.cacheWrite,
    total: after.total - before.total,
  };
}

// The share of this run's spend that was billed off-peak, weighted by each turn's own cost, or null
// when the session file cannot be read. The runtime's price table is the *peak* one and it stamps
// every `usage.cost` with it, so an off-peak DeepSeek turn is recorded at twice what DeepSeek billed.
// Each turn is placed by its own timestamp (a run may straddle a peak boundary); only turns written
// after the run started count, so a reused session's older turns are left out.
function offPeakShare(sessionFile, startedAtIso, provider) {
  try {
    let weighted = 0;
    let total = 0;
    for (const line of fs.readFileSync(sessionFile, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      const turn = entry?.message?.usage?.cost?.total;
      if (typeof turn !== 'number' || turn <= 0) continue;
      if (entry.timestamp && entry.timestamp < startedAtIso) continue;
      total += turn;
      weighted += offPeakCost(turn, { provider: entry.message.provider ?? provider, at: entry.timestamp });
    }
    return total > 0 ? weighted / total : null;
  } catch {
    return null;
  }
}

// What this run really cost DeepSeek: the session's own cost delta, scaled by the off-peak share of
// the turns in it. With the session file unreadable we fall back to placing the whole run at the
// current instant — one process tick, so the approximation is only ever the time of one call.
function runCost({ sessionFile, startedAtIso, provider, statsDelta }) {
  const share = offPeakShare(sessionFile, startedAtIso, provider);
  if (share !== null) return statsDelta * share;
  return offPeakCost(statsDelta, { provider, at: new Date().toISOString() });
}

// How the run's session was loaded (C-1), set once the session is opened and written into every result.
let loadMode = null;

async function main() {
  const opts = parseArgv(process.argv.slice(2));
  const cwd = process.cwd();

  const seatName = process.env.SPECIALIST_SEAT_NAME || '本座位';
  const sessionFileEnv = process.env.SPECIALIST_SEAT_SESSION_FILE;
  const sessionDirEnv = process.env.SPECIALIST_SEAT_SESSION_DIR;
  const resultPath = process.env.SPECIALIST_SEAT_RESULT;
  if (!resultPath) throw new Error(message('缺环境变量 SPECIALIST_SEAT_RESULT：结果 JSON 写哪', 'Missing SPECIALIST_SEAT_RESULT: result JSON path is required'));
  if (!sessionDirEnv) throw new Error(message('缺环境变量 SPECIALIST_SEAT_SESSION_DIR：新建会话时用它做落盘目录', 'Missing SPECIALIST_SEAT_SESSION_DIR: session directory is required'));
  const expectedTraces = expectedTracesFromEnv();

  // --pi is .../pi-coding-agent/dist/bundle/cli.js; the package root (where dist/index.js — the
  // SDK's own entry point — lives) is two directories up from that file's directory.
  const packageRoot = path.resolve(path.dirname(opts.pi), '..', '..');
  const sdkEntry = pathToFileURL(path.join(packageRoot, 'dist', 'index.js')).href;
  const { createAgentSession, createEventBus, createExtensionRuntime, ModelRuntime, SessionManager, SettingsManager } = await import(sdkEntry);
  // Not re-exported from the package entry in 0.87.0 (pinned), so it is taken from its own module.
  const { loadExtensionFromFactory } = await import(
    pathToFileURL(path.join(packageRoot, 'dist', 'core', 'extensions', 'loader.js')).href
  );

  // No args: reads credentials from ~/.pi/agent, which is where the DeepSeek key already lives.
  const modelRuntime = await ModelRuntime.create();
  const model = modelRuntime.getModel(opts.provider, opts.model);
  if (!model) {
    throw new Error(message(
      `模型「${opts.provider}/${opts.model}」没找到：检查 provider/model 拼写，或 ~/.pi/agent 下有没有配好这个 provider 的凭据`,
      `Model "${opts.provider}/${opts.model}" not found: check provider/model spelling or credentials under ~/.pi/agent`,
    ));
  }

  const appendSegments = opts.appendSystemPrompt.map(resolveAppendSegment);
  const identitySentence =
    `你是「${seatName}」，长期驻守 ${cwd} 这个目录的专家，可用工具：${opts.tools.join('、')}。` +
    '之前的对话就是你读过的东西：先利用已有上下文，确实需要时再读文件。';
  const systemPrompt = [identitySentence, ...appendSegments].join('\n\n');

  // A seat writes only inside its own directory ("读可以到处读，写不能到处写"). The boundary is held
  // here, at the tool call, not in the prompt: edit and write are refused for any path that resolves
  // outside cwd. bash is not covered — a role that must stay inside its directory is not given bash.
  const runtime = createExtensionRuntime();
  const inside = (target) => {
    const resolved = path.resolve(cwd, String(target ?? ''));
    const rel = path.relative(cwd, resolved);
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
  };
  const writeBoundary = await loadExtensionFromFactory(
    (pi) => {
      pi.on('tool_call', (event) => {
        if (event.toolName !== 'write' && event.toolName !== 'edit') return undefined;
        const target = event.input?.path ?? event.input?.file_path;
        if (inside(target)) return undefined;
        return {
          block: true,
          reason: `拒绝：「${target}」在你的目录 ${cwd} 之外。你只能改这个目录里的文件；目录外的改动写成建议交回给派活的人。`,
        };
      });
    },
    cwd,
    createEventBus(),
    runtime,
    '<inline:write-boundary>',
  );

  // Fully custom ResourceLoader: no docs, no AGENTS.md/CLAUDE.md discovery, no skills or prompt
  // templates — only the system prompt we just built, plus the write boundary above.
  const resourceLoader = {
    getExtensions: () => ({ extensions: writeBoundary ? [writeBoundary] : [], errors: [], runtime }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };

  const resumesSession = Boolean(sessionFileEnv && fs.existsSync(sessionFileEnv));
  const sessionManager = resumesSession
    ? SessionManager.open(sessionFileEnv)
    : SessionManager.create(cwd, sessionDirEnv);
  // C-1: how this run's session was loaded. Continuing a pi session file is `resumed`; otherwise cli-runner
  // says (SPECIALIST_SEAT_LOAD: `loaded` when the previous log came along as text), and a run started
  // without it begins with nothing.
  loadMode = resumesSession ? 'resumed' : process.env.SPECIALIST_SEAT_LOAD || 'fresh';

  // C-4 (2026-10-11): pi compacts when the context passes the window minus reserveTokens, so the number
  // cli-runner passes (presets.json `compact.deepseek`, or the role's own) is the tokens kept free: the
  // smaller it is, the later the compaction. Without it pi's own default (16384) stands.
  const reserve = Number(process.env.SPECIALIST_SEAT_COMPACT_RESERVE);
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: true, ...(Number.isInteger(reserve) && reserve > 0 ? { reserveTokens: reserve } : {}) },
    retry: { enabled: true, maxRetries: 2 },
  });

  // Without a thinking level pi uses its default (medium), which it clamps to a level the model has:
  // high for DeepSeek, sent as reasoning_effort. A level from the presets replaces that default and
  // is clamped the same way (pi 0.87.0, checked 2026-10-01: deepseek-flash has low/high/max).
  const { session } = await createAgentSession({
    cwd,
    model,
    ...(opts.thinking ? { thinkingLevel: opts.thinking } : {}),
    modelRuntime,
    resourceLoader,
    tools: opts.tools,
    sessionManager,
    settingsManager,
  });

  // printEnabled gates BOTH the streamed text and the tool-call log lines. It's on for the main
  // task and off for the closing expertise-summary prompt, whose brief is "collect the text,
  // don't print this round's output."
  const state = { printEnabled: true, buffer: '', tracing: true, afterTool: 0 };
  // Difficulty traces (FR-21): what the run paid that it did not want to pay, read off the events,
  // never asked of the model in the abstract. Only the main task is traced, not the closing rounds.
  const calls = new Map(); // toolCallId -> { tool, args, n }
  const outcomes = []; // in completion order: { n, tool, args, ok, empty, error, blocked, text }
  const traces = [];
  let callCount = 0;
  // How the latest prompt ended, read off the events. In the pinned pi SDK a failed model call (quota,
  // network, auth, an aborted stream) does not make session.prompt() throw: the run ends with an
  // assistant message whose stopReason is 'error' or 'aborted' (agent.js handleRunFailure), and after
  // retries an auto_retry_end with success:false. Before 2026-09-30 nothing looked, so a dead
  // provider produced an empty "successful" run that still asked the closing question and wrote
  // backlog '' over the seat's real one.
  const turn = { assistant: null, retryEnd: null };
  session.subscribe((event) => {
    if (event.type === 'message_end' && event.message?.role === 'assistant') turn.assistant = event.message;
    else if (event.type === 'auto_retry_end') turn.retryEnd = event;
    if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
      const delta = event.assistantMessageEvent.delta;
      state.buffer += delta;
      if (state.printEnabled) process.stdout.write(delta);
      return;
    }
    if (event.type === 'tool_execution_start') {
      // Text before a tool call is narration on the way; the report is what follows the last call.
      state.afterTool = state.buffer.length;
      if (state.printEnabled) process.stdout.write(`\n${describeToolCall(event.toolName, event.args)}\n`);
      if (state.tracing) calls.set(event.toolCallId, { tool: event.toolName, args: event.args, n: ++callCount });
      return;
    }
    if (event.type === 'tool_execution_end' && state.tracing) {
      const call = calls.get(event.toolCallId) ?? { tool: event.toolName, args: {}, n: ++callCount };
      const text = resultText(event.result);
      const blocked = (text.startsWith('拒绝：') || text.startsWith('Refused:')) && (call.tool === 'write' || call.tool === 'edit');
      outcomes.push({
        ...call,
        text,
        blocked,
        error: Boolean(event.isError) && !blocked,
        empty: !event.isError && looksEmpty(call.tool, call.args, text),
        ...bashFacts(call.tool, call.args, text, event.isError),
      });
      return;
    }
    if (event.type === 'compaction_start' && state.tracing) {
      traces.push({
        kind: 'compaction',
        tool: null,
        detail: message(`触发了上下文压缩（${event.reason}）`, `Context compaction triggered (${event.reason})`),
      });
    }
  });

  const modelLabel = `${opts.provider}/${opts.model}`;
  // Everything the runtime writes from here on belongs to this run; the session file is read back
  // against this instant to price only this run's turns off the clock.
  const runStartedAtIso = new Date().toISOString();

  // One prompt, and how it ended: null when the model answered, otherwise the provider's own error
  // text. A prompt that throws is left to the caller.
  const runPrompt = async (text) => {
    turn.assistant = null;
    turn.retryEnd = null;
    await session.prompt(text);
    const last = turn.assistant;
    if (last && (last.stopReason === 'error' || last.stopReason === 'aborted')) {
      return last.errorMessage || (last.stopReason === 'aborted'
        ? message('模型调用被中断，没有给出原因', 'Model call aborted without a reason')
        : message('模型调用出错，没有给出原因', 'Model call failed without a reason'));
    }
    if (turn.retryEnd && turn.retryEnd.success === false) {
      return turn.retryEnd.finalError || message('重试之后仍然失败，没有给出原因', 'Retry failed without a reason');
    }
    return null;
  };
  const note = (text) => process.stderr.write(`${text}\n`);

  // The run's report for the service. `closing.backlog` is null when the closing round gave no
  // usable answer: exec.mjs keeps the seat's stored backlog for anything that is not a string.
  // The answer to the main task alone (no tool-call lines, no closing rounds): the run's report.
  let mainReport = '';
  const buildResult = (startStats, closing, difficultyAnswer) => {
    const endStats = session.getSessionStats();
    return {
      sessionFile: session.sessionFile,
      report: mainReport,
      tokens: tokenDelta(startStats.tokens, endStats.tokens),
      cost: runCost({
        sessionFile: session.sessionFile,
        startedAtIso: runStartedAtIso,
        provider: opts.provider,
        statsDelta: endStats.cost - startStats.cost,
      }),
      expertise: closing.expertise,
      backlog: closing.backlog,
      model: modelLabel,
      sessionTotal: { tokens: endStats.tokens, cost: endStats.cost },
      difficulties: traces.map((t, i) => ({ ...t, description: i < 4 ? pickAnswer(difficultyAnswer, i + 1) : null })),
      load: loadMode,
    };
  };
  const unknownClosing = { expertise: '', backlog: null };

  try {
    const startStats = session.getSessionStats();

    state.buffer = '';
    state.afterTool = 0;
    const mainFailure = await runPrompt(opts.task);
    process.stdout.write('\n');
    state.tracing = false;
    const finalText = state.buffer;
    mainReport = finalText.slice(state.afterTool).trim() || finalText.trim();
    collectTraces(outcomes, finalText, traces, expectedTraces);

    // A main prompt the provider refused is a failed run: say so, keep what it cost, and do not ask
    // the closing question of a session that has no answer in it.
    if (mainFailure) {
      const failureText = message(
        `${mainFailure}（${modelLabel} 这一单没有完成，会话里没有可用的回答，所以没有追问收尾。` +
          '多半是额度、网络或凭据出了问题：确认之后重新派活，或换一个后端。）',
        `${mainFailure} (${modelLabel} failed before producing an answer, so closing questions were skipped. ` +
          'This is usually caused by quota, network, or credentials; inspect and redispatch or switch backends.)',
      );
      note(failureText);
      writeResult(resultPath, { ...buildResult(startStats, unknownClosing, ''), error: failureText });
      return 1;
    }
    // The task itself is done: record it now, so a kill or crash during the closing rounds below
    // still leaves the session, the usage and the difficulties (they used to be written only at the
    // very end, 2026-09-30).
    writeResult(resultPath, buildResult(startStats, unknownClosing, ''));

    // Asked only when there is a trace, and only about those traces, so the model is never invited
    // to invent a difficulty. It describes; it does not diagnose — the cause is the lead's call.
    let difficultyAnswer = '';
    if (traces.length) {
      state.buffer = '';
      state.printEnabled = false;
      const listed = traces.slice(0, 4).map((t, i) => `${i + 1}. ${t.detail}`).join('\n');
      try {
        const failure = await runPrompt(
          '（服务消息，不是新任务）不要调用任何工具。刚才的运行里有这几处：\n' +
            `${listed}\n` +
            '对每一处按序号各写一两句：你当时想要什么，后来怎么办的（换了什么办法、有没有走通）。' +
            '只描述发生了什么，不要分析原因，不要客套。',
        );
        if (failure) {
          note(message(
            `追问困难经过的那一轮失败了（${failure}）：困难记录照常保留，只是没有座位自己的描述。`,
            `Difficulty follow-up failed (${failure}); recorded difficulties are preserved without the seat’s own description.`,
          ));
        } else difficultyAnswer = state.buffer.trim();
      } catch (err) {
        note(message(
          `追问困难经过的那一轮出错了（${err?.message ?? err}）：困难记录照常保留，只是没有座位自己的描述。`,
          `Difficulty follow-up errored (${err?.message ?? err}); recorded difficulties are preserved without the seat’s own description.`,
        ));
      }
    }
    state.buffer = '';
    state.printEnabled = false;
    let closing = unknownClosing;
    const closingPrompt = closingPromptFor(opts.task);
    if (closingPrompt) {
      try {
        const failure = await runPrompt(closingPrompt);
        if (failure) {
          note(message(
            `收尾问题没有得到回答（${failure}）：这一单的结果照常保留，座位的专长说明和「没做完」清单维持上次的样子，没有被清空。`,
            `Closing round failed (${failure}); the run result, stored expertise, and backlog are preserved as before.`,
          ));
        } else closing = splitClosing(state.buffer);
      } catch (err) {
        note(message(
          `收尾问题出错了（${err?.message ?? err}）：这一单的结果照常保留，座位的专长说明和「没做完」清单维持上次的样子，没有被清空。`,
          `Closing round errored (${err?.message ?? err}); the run result, stored expertise, and backlog are preserved as before.`,
        ));
      }
    }

    writeResult(resultPath, buildResult(startStats, closing, difficultyAnswer));
    return 0;
  } finally {
    session.dispose();
  }
}

main().then(
  (code) => {
    process.exit(code ?? 0);
  },
  (err) => {
    const message = err && err.message ? err.message : String(err);
    process.stderr.write(`${message}\n`);
    const resultPath = process.env.SPECIALIST_SEAT_RESULT;
    if (resultPath) {
      writeResult(resultPath, { error: message, ...(loadMode ? { load: loadMode } : {}) });
    }
    process.exit(1);
  },
);
