// specialist-subagents cli-runner: a seat that runs on the backend and model the wall's buttons and
// the presets choose (presets.mjs), then the other backends in order, at the same level.
//
// Why this exists: pi reaches models through API keys, so a seat on pi always spends API money.
// Codex CLI signed in with a ChatGPT account, and Grok CLI signed in with grok.com, use their
// subscriptions. The web page selects which backend goes first and whether at the heavy level; an
// unavailable CLI falls through to the next one, and DeepSeek (through seat-runner and pi) ends the
// chain wherever it stands. Quota is recorded for display only.
//
// The argv is seat-runner's with the backends added, so roles.json's startup gate (runtime
// placeholder, tool whitelist matching the grant) checks the role like any other:
//   --pi {runtime}              the pi CLI, used only for DeepSeek
//   --role {role}               whose presets apply (presets.json, .data/presets.json)
//   --network                   the role's work needs the internet, which Codex's sandbox lacks
//   --tools a,b,c               write/edit in the list -> the CLI's workspace sandbox, else read-only
//   --append-system-prompt X    a file path or literal text
//   -p TASK
//
// A seat keeps one session file, and it tells which backend wrote it:
//   Codex: ~/.codex/sessions/**/rollout-*-<thread id>.jsonl, resumed with `codex exec resume`
//   Grok:  ~/.grok/sessions/<cwd>/<session id>/chat_history.jsonl, resumed with `grok --resume`
//   Claude: ~/.claude/projects/<cwd>/<session id>.jsonl, resumed with `claude -p --resume`
//   Antigravity: ~/.gemini/antigravity-cli/brain/<conversation id>/.system_generated/logs/transcript.jsonl,
//          resumed with `agy --conversation <id>`
//   pi:    anything else, continued by seat-runner
// No backend can continue another's session, so a task that lands elsewhere starts fresh. Since
// 2026-10-11 (C-1) it is handed the previous session's conversation as text (sessionText, newest 60000
// characters, the file's path named in it), and the seat's last expertise note; the result file's `load`
// says which way the session was loaded: resumed, loaded or fresh.
//
// The --append-system-prompt segments (contract, the role's skill, its memory) reach Codex, Grok and
// Claude only in a fresh session's first prompt; a resumed one gets the task alone. When the role's
// contract or skill changed after the session started, the service names a file in
// SPECIALIST_SEAT_RESUME_NOTICE (exec.mjs): for each that changed, a short notice and the full new
// text, contract first, put in front of the task only when one of those three resumes the session.
// A fresh session has the new texts in its system prompt already, and DeepSeek's seat-runner rebuilds
// its system prompt every run, so neither gets them a second time.
//
// The prompt itself never goes on a command line. Contract, skill, memory and task together can pass
// what Windows allows for one (spawn throws ENAMETOOLONG at about 32,700 characters), and each of the
// three would then count as "did not start" and the run would slide to DeepSeek; a skill can run to
// 500 lines. Codex reads it from stdin (`codex exec ... -`, also after `resume <id>`), Claude from
// stdin (`-p` with no prompt argument), Grok from a file (`--prompt-file`, next to the result file).
// Each form was checked on 2026-10-01 with a 40,000-character prompt, fresh and resumed (Codex
// 0.161.0-alpha.2, Grok 1.0.44, Claude Code 2.1.284). Antigravity (2026-10-21, agy 1.4.4) reads it from
// stdin as one stream-json user message (`--input-format stream-json`).
//
// Since 2026-10-05 the daemon can hand *this* runner the task the same way: `--task-file <path>`
// instead of `-p <text>`, chosen automatically when the spawn command would pass the platform's
// command-line limit (exec.mjs, overBudget). Before that, an oversized brief killed the seat with a
// bare ENAMETOOLONG and no report (seat-explorer-46), which told the dispatcher nothing.

import { execSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { closingPromptFor, originalTask, splitClosing } from './closing.mjs';
import { commandMissing, expectedRule, missingMark, soleCommand } from './expected-traces.mjs';
import { equivalentCost } from './pricing.mjs';
import { LEAD_TOOLS } from './lead-tools.mjs';
import { codexQuotaIn, compactFor, KINDS, loadSettings, message, planFor, readBackendHealth, readChoice, recordBackendOutcome } from './presets.mjs';
import { sessionKind } from './session-kind.mjs';
import { changedFiles, changedFilesText, worktreeSnapshot } from './takeover.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// The commands whose exit 1 means "nothing found" or "differences found" (Codex traces, below).
const QUIET_ONE = /^(rg|grep|findstr|Select-String|git\s+diff)(\.exe)?\b/i;

function parseArgv(argv) {
  const opts = {
    runtime: null, role: null, network: false,
    tools: [], appendSystemPrompt: [], task: null, taskFile: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--pi':
        opts.runtime = argv[++i];
        break;
      case '--role':
        opts.role = argv[++i];
        break;
      case '--network':
        opts.network = true;
        break;
      case '--tools':
        opts.tools = (argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
        break;
      case '--append-system-prompt':
        opts.appendSystemPrompt.push(argv[++i]);
        break;
      case '-p':
        opts.task = argv[++i];
        break;
      // The daemon switches to this form when the task would push the spawn command past what the
      // platform allows (exec.mjs, overBudget): a path is short, the text is the same text.
      case '--task-file':
        opts.taskFile = argv[++i];
        break;
      default:
        throw new Error(
          message(`未知参数「${arg}」：cli-runner 只认 --pi --role --network --tools --append-system-prompt -p --task-file`, `Unknown argument ${arg}: cli-runner accepts --pi --role --network --tools --append-system-prompt -p --task-file`),
        );
    }
  }
  if (opts.taskFile !== null) {
    if (opts.task !== null) throw new Error(message('--task-file 和 -p 只能给一个：任务正文给两份，不知道用哪份', 'Use only one of --task-file and -p; the task cannot be specified twice'));
    try {
      opts.task = fs.readFileSync(opts.taskFile, 'utf8');
    } catch (err) {
      throw new Error(message(`--task-file 读不到「${opts.taskFile}」：${err.message}`, `Could not read --task-file ${opts.taskFile}: ${err.message}`));
    }
  }
  if (!opts.task) throw new Error(message('缺 -p 或 --task-file：任务正文', 'Missing -p or --task-file: task text is required'));
  if (!opts.role) throw new Error(message('缺 --role：按哪个岗位的预设选模型（roles.json 里写 --role {role}）', 'Missing --role: specify the role used to select model presets (roles.json: --role {role})'));
  return opts;
}

function resolveSegment(value) {
  if (fs.existsSync(value) && fs.statSync(value).isFile()) return fs.readFileSync(value, 'utf8');
  return value;
}

function walkFiles(root, visit) {
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(full);
      else visit(full, e.name);
    }
  }
}

// Which backend wrote a seat's session file, and the id to resume it by: src/session-kind.mjs, shared
// with exec.mjs (forks), so the two can never disagree.

// ---- The previous session as text (C-1) ---------------------------------------------------------

// 2026-10-11: PRD §3 "记录是文字": to a model, continuing a session is feeding its log back into the
// context, the same thing as feeding it a document. So a session no backend can continue (it was written
// by another one) is not lost; this turns its log into the conversation as plain text, and the fresh
// session starts with it. Until then the fresh session got only the file's path and had to go and read it.
//
// The budget is in characters, not tokens: the logs are mostly Chinese and code, and about three
// characters per token is the estimate the rest of the service uses (L-4).
export const HANDOFF_BUDGET = 60000;
const TURN_LABELS = { user: '用户', assistant: '助手', tool: '工具结果', summary: '压缩摘要' };

// The text of a content value: a string, or the text parts of an array (Claude and pi: {type:'text'},
// Codex: {type:'input_text'|'output_text'}). Parts that carry no text of their own (a tool call, the
// model's thinking) give nothing: they are not part of what was said.
function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => (typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : ''))
    .filter(Boolean)
    .join('\n');
}

function roleOf(raw) {
  switch (String(raw ?? '').toLowerCase()) {
    case 'user': case 'human':
      return 'user';
    case 'assistant': case 'agent': case 'model':
      return 'assistant';
    case 'tool': case 'toolresult': case 'tool_result': case 'function': case 'function_call_output': case 'custom_tool_call_output':
      return 'tool';
    default:
      return null;
  }
}

// What a tool result carries: a string, a { content } / { output } wrapper, or text parts.
function toolOutputText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return contentText(value);
  if (value && typeof value === 'object') return toolOutputText(value.output ?? value.content ?? value.text ?? '');
  return '';
}

// Antigravity's transcript is one step per line, upper-case types: USER_INPUT (the request wrapped in
// <USER_REQUEST>, followed by metadata the CLI adds), PLANNER_RESPONSE (the model; a step that only calls
// tools has no content), GENERIC (a tool's result), SYSTEM_MESSAGE (the CLI's own notices, not said by
// anyone in the conversation).
const AGY_REQUEST = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/;
function antigravityTurns(obj) {
  const text = typeof obj.content === 'string' ? obj.content.trim() : '';
  if (!text || obj.source === 'SYSTEM' || obj.type === 'SYSTEM_MESSAGE') return [];
  if (obj.type === 'USER_INPUT') return [{ role: 'user', text: AGY_REQUEST.exec(text)?.[1] ?? text }];
  if (obj.type === 'PLANNER_RESPONSE') return [{ role: 'assistant', text }];
  return [{ role: 'tool', text }];
}

// The turns one JSON line of a session log holds, oldest first. Generic on purpose: the logs are written
// by five programs and the test fakes by a sixth. A line that yields nothing (a header, a token count, a
// tool call, thinking) yields [].
//   fake / simple:  { role, text }
//   Codex rollout:  { type:'response_item', payload:{ type:'message', role, content:[{type:'input_text'|'output_text', text}] } }
//                   { type:'response_item', payload:{ type:'function_call_output', output } }
//                   (event_msg lines repeat the same words and are skipped)
//   Claude Code:    { type:'user'|'assistant', message:{ role, content: string | [{type:'text'|'tool_result', ...}] } }
//   pi:             { type:'message', message:{ role:'user'|'assistant'|'toolResult', content:[{type:'text', text}] } }
//                   { type:'compaction', summary }
//   Antigravity:    { step_index, source:'USER_EXPLICIT'|'MODEL'|'SYSTEM', type:'USER_INPUT'|'PLANNER_RESPONSE'|…, content }
function turnsOfLine(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return [];
  if (typeof obj.step_index === 'number' && typeof obj.source === 'string' && typeof obj.type === 'string') return antigravityTurns(obj);
  if (['event_msg', 'turn_context', 'session_meta', 'session', 'compacted'].includes(obj.type)) return [];
  if (obj.type === 'compaction') {
    const summary = typeof obj.summary === 'string' ? obj.summary.trim() : '';
    return summary ? [{ role: 'summary', text: summary }] : [];
  }
  const inner = obj.payload && typeof obj.payload === 'object' ? obj.payload : obj.message && typeof obj.message === 'object' ? obj.message : obj;
  const innerType = typeof inner.type === 'string' ? inner.type : '';
  if (obj.isCompactSummary) {
    const text = contentText(inner.content ?? inner.text).trim();
    return text ? [{ role: 'summary', text }] : [];
  }
  const role = roleOf(inner.role) ?? roleOf(innerType) ?? roleOf(obj.role) ?? roleOf(obj.type);
  if (!role) return [];
  if (role === 'tool') {
    const text = toolOutputText(inner.output ?? inner.content ?? inner.text).trim();
    return text ? [{ role, text }] : [];
  }
  const turns = [];
  // Claude puts a tool's result inside a user message, as a content part of its own.
  const parts = Array.isArray(inner.content) ? inner.content : [];
  for (const part of parts) {
    if (part?.type === 'tool_result' || part?.type === 'function_call_output') {
      const text = toolOutputText(part.content ?? part.output).trim();
      if (text) turns.push({ role: 'tool', text });
    }
  }
  const text = contentText(inner.content ?? inner.text).trim();
  if (text) turns.unshift({ role, text });
  return turns;
}

// Every turn of the session log, oldest first: [{ role: 'user'|'assistant'|'tool'|'summary', text }].
export function sessionTurns(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const turns = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    turns.push(...turnsOfLine(obj));
  }
  return turns;
}

// The conversation of a session log as plain text, oldest first, a blank line between turns:
//   【用户】…  【助手】…  【工具结果】…
// `kind` (codex, grok, claude, pi) is what sessionKind() said wrote the file; the reading is by shape and
// does not need it, so a log in a format this does not know gives '' rather than a wrong reading.
// Over `budget` characters the newest turns that fit are kept, and a first line says how much of the
// start is not there and where it is (the file, and the hand-off document when there is one).
export function sessionText(file, kind, { budget = HANDOFF_BUDGET, handoffFile = '' } = {}) {
  void kind;
  const turns = sessionTurns(file);
  const blocks = turns.map((turn) => `【${TURN_LABELS[turn.role]}】${turn.text}`);
  if (!blocks.length) return '';
  const total = blocks.reduce((sum, block) => sum + block.length, 0) + 2 * (blocks.length - 1);
  if (total <= budget) return blocks.join('\n\n');
  const kept = [];
  let used = 0;
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const cost = blocks[i].length + (kept.length ? 2 : 0);
    if (used + cost > budget) break;
    kept.unshift(blocks[i]);
    used += cost;
  }
  // Not even the newest turn fits: its end is the newest thing there is.
  if (!kept.length) {
    kept.push(`【${TURN_LABELS[turns.at(-1).role]}】…${turns.at(-1).text.slice(-(budget - 20))}`);
    used = kept[0].length;
  }
  const left = total - used;
  const where = `完整原文在 ${file}${handoffFile ? `，交接文档在 ${handoffFile}` : ''}`;
  return `（这段记录太长，更早的 ${left} 个字没有放进来；${where}。下面是最近的部分）\n\n${kept.join('\n\n')}`;
}

// What a fresh session is told when the seat's previous session cannot continue. The reason depends on
// whether there is a previous session file to hand over: with one, it belongs to another backend and this
// one cannot resume it; without one, the service chose not to continue it (a directory that changed a
// lot, exec.mjs) or the file is gone. Until 2026-09-30 both cases said "another model", which was false
// for the second and contradicted the service's own note about the directory change.
//
// 2026-10-11 (C-1): with a previous session file, the note carries that session's conversation as text
// (sessionText) instead of only its path. A file that gives no text (a format this does not read) falls
// back to the old note, the path to read it by.
export function handoffNote(previousSession, expertise, kind = null, handoffFile = '') {
  if (!previousSession && !expertise) return '';
  const text = previousSession ? sessionText(previousSession, kind, { handoffFile }) : '';
  if (previousSession && text) {
    return [
      `（服务消息）你是这个对象的常驻专家；上一段会话是用另一个模型跑的，接不上，这是一个新会话。下面是那段会话的记录（原文在 ${previousSession}），就当是你自己读过、说过的：\n\n${text}`,
      expertise ? `你上次留下的专长说明：\n${expertise}` : '',
    ].filter(Boolean).join('\n\n');
  }
  const reason = previousSession
    ? '上一段会话是用另一个模型跑的，接不上'
    : '上一段会话没有沿用（这个目录自上次以来改动很大，或那段会话的记录文件已经不在了）';
  const lines = [`（服务消息）你是这个目录的常驻专家，但${reason}，这是一个新会话。`];
  if (expertise) lines.push(`你上次留下的专长说明：\n${expertise}`);
  if (previousSession) lines.push(`上一段会话的完整记录在 ${previousSession}，需要时可以读，不需要就别读。`);
  return lines.join('\n');
}

// A fork (C-3) of a busy expert: the expert's own session is still being written by the expert's run,
// so it is never continued here, only read. The fork starts a fresh session handed that log as text, the
// same loading C-1 does across backends (2026-10-11: without it a Codex, Claude or Grok fork started from
// nothing and counted as a blank start).
export function forkNote(recordFile, expertise, kind = null, handoffFile = '') {
  const text = recordFile ? sessionText(recordFile, kind, { handoffFile }) : '';
  const lines = ['（服务消息）你是这个对象常驻专家的分身：专家本人正在跑另一单，这一单由你并行接手，跑完后你的记录会归回专家。'];
  if (text) lines.push(`下面是专家到目前为止的会话记录（原文在 ${recordFile}），就当是你自己读过、说过的：\n\n${text}`);
  else if (recordFile) lines.push(`专家的会话记录在 ${recordFile}，需要时可以读。`);
  if (expertise) lines.push(`专家留下的专长说明：\n${expertise}`);
  return lines.join('\n\n');
}

// A session started on purpose without the seat's history (2026-10-24), in one of two shapes:
//   - a fresh fork (seat_start fork "fresh"): an independent second look at the expert's object, for
//     falsifying or reviewing, where the expert's own understanding is what is being doubted, so its
//     session, records, hand-off and backlog are all left out (exec.mjs passes none of them);
//   - a takeover (takeOver below): the seat's session was stopped halfway by the backend model's safety
//     filter, and a new session, with none of that session's history, carries on from what is on disk.
// Both get their role's contract, skill and memory like any fresh session; this note says why nothing else.
export function freshNote({ takeover = null } = {}) {
  if (!takeover) {
    return '（服务消息）你是这个对象的一个不带历史的新实例：服务有意没给你这个对象专家的会话、记录、交接和未完成清单，' +
      '用途是独立复核或第二意见。只凭现场（文件、命令输出）和这一单的任务判断；不要去找、也不要采信专家以前的结论，要用的事实自己核实。';
  }
  return [
    `（服务消息）这一单原本由这个对象的常驻专家在做，做到一半，它的会话被后端停下了（${takeover.stopped}）。` +
      '你是一个新会话，没有它的会话历史，从现场接着做这一单：',
    '- 先读下面这些已改动文件的当前内容，弄清做到了哪一步；',
    '- 不要重做已经完成的部分，也不要回滚它的改动；改动停在半路或本身有错（例如函数写到一半、语法不通）时，把它补完或改对；',
    '- 做完照常交报告，说清哪些是接手前已经有的、哪些是你做的。',
    `这一单到被停下时改动过的文件（路径相对工作目录）：\n${takeover.files}`,
  ].join('\n');
}

// R-7 (2026-10-24): a role may write a note per backend in roles.json (`backend_notes`), and only the
// note of the backend this run lands on goes into its prompt. It is put in front of the prompt the seat
// gets, with the same separator the other hand-offs use.
export function withBackendNote(note, base) {
  return note ? `${note}\n\n---\n\n${base}` : base;
}

// ---- Compaction (C-4) ----------------------------------------------------------------------------

// 2026-10-11: each backend compacts its session (summarises the old turns and drops them) when the
// context reaches a threshold, and a compaction loses detail, so the service sets the threshold as late
// as the backend allows (presets.json `compact`) unless the role says otherwise (roles.json `compact`).
// The knobs are the ones doc/impl/compaction.md found in each CLI's source and docs.
const CODEX_DEFAULT_WINDOW = 272000;
const CODEX_MAX_WINDOW = 872000;

// Codex: the limit in tokens. Its effective limit is the smaller of the setting and 0.9 of the window, and
// the window is 272000 unless it is raised, so a limit past 0.9 of that raises the window to the largest
// one the model has.
export function codexCompactArgs(limit, window = CODEX_DEFAULT_WINDOW) {
  if (!Number.isInteger(limit) || limit <= 0) return [];
  return [
    '-c', `model_auto_compact_token_limit=${limit}`,
    ...(limit > 0.9 * window ? ['-c', `model_context_window=${CODEX_MAX_WINDOW}`] : []),
  ];
}

// ---- Dispatching from a seat (R-6) ---------------------------------------------------------------

// 2026-10-21: a role whose tool whitelist has `dispatch` (Lead) runs with this service's MCP server, so it
// can hand work to member roles; every other seat runs with no MCP server of this service at all. The
// bridge is started with the seat's id and the dispatch flag in its environment: it shows a Lead only
// the tools it dispatches and checks with, and the daemon refuses anything the calling role may not do.
export const DISPATCH_SERVER = 'specialist-subagents';
const MCP_BRIDGE = path.join(ROOT, 'src', 'mcp-stdio.mjs');

export function dispatchServer(seatId) {
  return { command: process.execPath, args: [MCP_BRIDGE], env: { SPECIALIST_CALLER_SEAT: seatId ?? '', SPECIALIST_CALLER_DISPATCH: '1' } };
}

// Codex takes MCP servers as config keys; the user config is ignored (--ignore-user-config), so this is
// the only server it gets. The name has no hyphen, which would need quoting inside a dotted key.
// Its tools are approved up front: a seat runs with approval_policy "never", under which Codex refuses
// an MCP call it would ask about (2026-10-22: a Lead's seat_start came back "MCP tool call requires
// approval, but approval policy is never"; a probe server answered once default_tools_approval_mode
// was "approve", Codex 0.162.1). It covers this server only, whose bridge shows a Lead nothing but
// its own tools.
export function codexDispatchArgs(server) {
  const key = 'mcp_servers.specialist_subagents';
  const env = Object.entries(server.env).map(([name, value]) => `${name} = ${tomlString(value)}`).join(', ');
  return [
    '-c', `${key}.command=${tomlString(server.command)}`,
    '-c', `${key}.args=[${server.args.map(tomlString).join(', ')}]`,
    '-c', `${key}.env={ ${env} }`,
    '-c', `${key}.default_tools_approval_mode="approve"`,
  ];
}

// The model this run used, from the keys of the result's modelUsage. On a resumed session those keys
// are the whole session's, in the order first used (2026-10-22 probe: an Opus run resumed with
// --model sonnet reported claude-opus-5-5 then claude-sonnet-5-5), so the first key named the Lead's
// earlier Opus run on a run that was all Sonnet. The key the requested alias names wins, then the
// last one; the alias itself when there are none.
export function claudeModel(models, alias) {
  const named = [...models].reverse().find((id) => id.includes(alias));
  return named ?? models.at(-1) ?? alias;
}

// Claude Code: `--autocompact <tokens>`. (CLAUDE_CODE_AUTO_COMPACT_WINDOW would do the same, but claudeEnv()
// deletes every CLAUDE_CODE_ variable, so the flag is the way.)
// `dispatch` (R-6): the one MCP server a Lead gets, given with --mcp-config; --strict-mcp-config still
// keeps every other server out, and its tools are allowed by the server's name. --safe-mode turns off
// --mcp-config's servers too (2026-10-22: the Lead's first run reported no seat_start in its tool list;
// a probe server showed up only once --safe-mode was gone), so a Lead runs with --setting-sources ""
// in its place: no user, project or local settings, so none of their hooks or plugins. The same probe
// found no CLAUDE.md in either form: --restricted and the other flags already keep it out.
export function claudeArgs({ model, effort = null, tools = '', resumeId = null, compact = null, dispatch = null }) {
  const allowed = dispatch ? [tools, `mcp__${DISPATCH_SERVER}`].filter(Boolean).join(',') : tools;
  return [
    '-p', '--model', model, '--output-format', 'stream-json', '--verbose',
    ...(effort ? ['--effort', effort] : []),
    ...(dispatch ? ['--setting-sources', ''] : ['--safe-mode']), '--restricted', '--strict-mcp-config',
    ...(dispatch ? ['--mcp-config', JSON.stringify({ mcpServers: { [DISPATCH_SERVER]: dispatch } })] : []),
    '--tools', tools, '--allowedTools', allowed,
    '--permission-mode', 'dontAsk', '--permission-prompts', 'none',
    ...(compact ? ['--autocompact', String(compact)] : []),
    ...(resumeId ? ['--resume', resumeId] : []),
  ];
}

// Grok: the percent of the window, in the environment of its process.
export function grokEnv(base, percent) {
  return percent ? { ...base, GROK_AUTO_COMPACT_THRESHOLD_PERCENT: String(percent) } : base;
}

// `input`, when given, is written to the child's stdin and stdin is closed after it (the prompt, see the
// header); otherwise stdin is not opened at all.
function spawnCollect(command, args, { cwd, onLine, env, input } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { cwd, env: env ?? process.env, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (err) {
      resolve({ code: 1, stdout: '', stderr: String(err?.message ?? err) });
      return;
    }
    if (input !== undefined) {
      // A CLI that exits before reading (no login, bad flag) closes the pipe under the write: that is
      // its own failure, reported through its exit code and stderr, not a crash of this runner.
      child.stdin.on('error', () => {});
      child.stdin.end(input, 'utf8');
    }
    let stdout = '';
    let stderr = '';
    let pending = '';
    // A pipe hands over chunks of at most 64KB, cut wherever the bytes happen to fall. Decoding each
    // chunk alone turned a multi-byte character split across two chunks into U+FFFD (a single large
    // JSON line of Chinese text lost 15 characters, 2026-09-30 review); a StringDecoder holds the
    // incomplete tail bytes back until the next chunk completes them.
    const outDecoder = new StringDecoder('utf8');
    const errDecoder = new StringDecoder('utf8');
    let settled = false;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      const tailOut = outDecoder.end();
      const tailErr = errDecoder.end();
      stdout += tailOut;
      stderr += tailErr;
      if (onLine) {
        pending += tailOut;
        let nl;
        while ((nl = pending.indexOf('\n')) >= 0) {
          onLine(pending.slice(0, nl));
          pending = pending.slice(nl + 1);
        }
        if (pending.length > 0) {
          onLine(pending);
          pending = '';
        }
      }
      resolve({ code: code ?? 1, stdout, stderr });
    };
    child.stdout.on('data', (chunk) => {
      const text = outDecoder.write(chunk);
      stdout += text;
      if (!onLine) return;
      pending += text;
      let nl;
      while ((nl = pending.indexOf('\n')) >= 0) {
        onLine(pending.slice(0, nl));
        pending = pending.slice(nl + 1);
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += errDecoder.write(chunk);
    });
    child.on('error', (err) => {
      stderr += String(err?.message ?? err);
      finish(1);
    });
    child.on('close', (code) => finish(code));
  });
}

function lastLines(text, n = 3) {
  return String(text ?? '').trim().split('\n').slice(-n).join(' ');
}

// What a backend reports when it did not finish. `worked` is the fallback rule (2026-09-30): only a
// backend that failed before doing anything (auth, quota, spawn failure, an immediate error) hands
// the task to the next one. One that failed after tool activity may have edited files or run
// commands, so the task is not started again elsewhere; the run is reported as failed, naming the
// backend and how far it got, and the caller decides whether to redispatch.
// `refused` (2026-10-24): the backend's model stopped the run itself, its safety filter flagging the
// conversation; a run stopped that way after tool activity is taken over once by a session without the
// seat's history (takeOver), where any other failure after tool activity stops the run.
function failure(reason, { worked = false, refused = false, progress = '', sessionFile = null, usage = [], label = null, quota = null } = {}) {
  return { failed: reason, worked, refused, progress, sessionFile, usage, label, quota };
}

// ---- Codex -------------------------------------------------------------------------------------

// Node refuses to spawn a .cmd shim without a shell, and a shell would have to re-quote the prompt,
// so the npm package's own JS entry is run with this node instead. SPECIALIST_CODEX_JS pins it.
function codexEntry() {
  const pinned = process.env.SPECIALIST_CODEX_JS;
  if (pinned && fs.existsSync(pinned)) return pinned;
  try {
    const root = execSync('npm root -g', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: 5000 }).trim();
    const entry = path.join(root, '@openai', 'codex', 'bin', 'codex.js');
    return fs.existsSync(entry) ? entry : null;
  } catch {
    return null;
  }
}

function codexSessionsDir() {
  return path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions');
}

function codexRollout(threadId) {
  let found = null;
  walkFiles(codexSessionsDir(), (full, name) => {
    if (!found && name.endsWith(`${threadId}.jsonl`)) found = full;
  });
  return found;
}

// A command Codex's Windows sandbox never started. On 2026-10-22, with the Codex desktop app open,
// every command of a seat came back as `Failed to create unified exec process: helper_unknown_error:
// setup refresh had errors` (exit_code -1): CLI 0.162.1's sandbox setup could not update the ACL of
// the app's running node_repl.exe, an upstream bug fixed in 0.163.0 (openai/codex #51634, PR #51822;
// Hwiki codex-cli/codex-codex-cli-setup-refresh-had-errors-node-repl-exe). The model then reported
// that it could do nothing and Codex exited 0, so the run passed as done and never moved on: a
// handyman spent 14 times its usual tokens retrying. Commands like this are attempts, not work.
export const CODEX_UNSTARTED = /Failed to create unified exec process:\s*(.*)/;

async function codexExec(entry, common, cwd, resumeId, prompt, echo) {
  // `-`: the prompt comes on stdin (header), for a fresh session and after `resume <id>` alike.
  const args = [entry, 'exec', ...common, ...(resumeId ? ['resume', resumeId] : []), '-'];
  const out = { id: null, text: '', commands: [], usage: [], error: null, toolItems: 0, unstarted: 0, sandboxError: null, failed: false };
  const messages = [];
  // Anything Codex did besides talk or think counts as work: a command, a file change, an MCP call.
  const toolIds = new Set();
  // Commands the sandbox never started (see CODEX_UNSTARTED): attempts, not work.
  const unstartedIds = new Set();
  let lastTurn = null;
  const res = await spawnCollect(process.execPath, args, {
    cwd,
    input: prompt,
    onLine: (line) => {
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        return;
      }
      if (ev.type === 'thread.started') out.id = ev.thread_id;
      else if (ev.type === 'turn.completed') {
        lastTurn = 'completed';
        if (ev.usage) out.usage.push(ev.usage);
      } else if (ev.type === 'turn.failed' || ev.type === 'error') {
        out.error = ev.error?.message ?? ev.message ?? message('运行失败', 'Run failed');
        // A bare `error` event can be a reconnect notice that the run then recovers from; only a
        // failed turn with no completed one after it is a failed run.
        if (ev.type === 'turn.failed') lastTurn = 'failed';
      } else if (ev.type === 'item.started') {
        const kind = ev.item?.type;
        if (kind && kind !== 'agent_message' && kind !== 'reasoning' && kind !== 'error') toolIds.add(ev.item.id ?? `${kind}#${toolIds.size}`);
      } else if (ev.type === 'item.completed') {
        const item = ev.item ?? {};
        if (item.type && item.type !== 'agent_message' && item.type !== 'reasoning' && item.type !== 'error') toolIds.add(item.id ?? `${item.type}#${toolIds.size}`);
        if (item.type === 'agent_message') {
          messages.push(item.text ?? '');
          if (echo) process.stdout.write(`${item.text ?? ''}\n`);
        } else if (item.type === 'command_execution') {
          out.commands.push(item);
          if (echo) process.stdout.write(`\n· ${String(item.command ?? '').slice(0, 160)}\n`);
          const unstarted = CODEX_UNSTARTED.exec(String(item.aggregated_output ?? ''));
          if (unstarted) {
            unstartedIds.add(item.id ?? `unstarted#${unstartedIds.size}`);
            out.sandboxError = unstarted[1].trim();
          }
        }
      }
    },
  });
  // Partial output with a failing exit status is a failure, not a success (it used to pass as one).
  out.failed = res.code !== 0 || lastTurn === 'failed';
  if (out.failed && !out.error) out.error = lastLines(res.stderr) || message(`codex 退出码 ${res.code}`, `codex exit code ${res.code}`);
  out.toolItems = toolIds.size;
  out.unstarted = unstartedIds.size;
  out.text = messages.at(-1) ?? '';
  out.produced = messages.length > 0;
  out.id = out.id ?? resumeId;
  return out;
}

// The user's global $CODEX_HOME/AGENTS.md is the user's own rules for interactive Codex (for instance:
// verify yourself, commit locally), and Codex always loads it: no flag or config key turns it off,
// --ignore-user-config included (Hwiki ai-tooling/codex-cli-disable-global-agents-md-codex-home). A
// separate CODEX_HOME would drop it, but on Windows that home lacks the elevated sandbox's setup state
// and the first command reinstalls it, resetting the machine-wide sandbox accounts' passwords
// (branch fix/codex-home, left unmerged). So the seat is told, as a developer instruction, which
// Codex ranks above AGENTS.md (a user message), that those rules are not its own; a probe on
// 2026-10-01 had the model answer that they do not apply to the seat. The sentence names no action
// (web_researcher's contract itself asks for a local Hwiki commit): the contract decides.
const CODEX_SEAT_NOTE =
  '这次运行是 specialist-subagents 服务派出的专家座位。上下文里如果有用户全局的 AGENTS.md，' +
  '那是用户自己交互使用 Codex 时的规则，不适用于这里；这里以任务开头给出的岗位合同和岗位 skill 为准，' +
  '两者冲突时以岗位合同为准。';
// A TOML basic string for `-c key=value`: JSON's escapes (quotes, backslashes, control characters,
// \uXXXX) are all valid TOML escapes.
function tomlString(text) {
  return JSON.stringify(text);
}

async function runCodexBackend(backend, ctx) {
  const entry = codexEntry();
  if (!entry) return failure(message('codex 没跑起来（找不到 Codex CLI）', 'codex did not start (Codex CLI not found)'));
  // No user config: the seat must not see the user's own MCP servers (the specialist-subagents one
  // among them would let it delegate) or native subagents; auth still comes from CODEX_HOME.
  // Dropping the config also drops the Windows sandbox mode, without which every command is refused,
  // so it is put back here; nobody is there to approve, so approval is off and the sandbox is the
  // boundary. The global AGENTS.md is still loaded; CODEX_SEAT_NOTE above says it is not the seat's.
  const common = [
    '--json', '-m', backend.model, '-s', ctx.writes ? 'workspace-write' : 'read-only',
    ...(backend.effort ? ['-c', `model_reasoning_effort="${backend.effort}"`] : []),
    '--skip-git-repo-check', '--ignore-user-config',
    '-c', `developer_instructions=${tomlString(CODEX_SEAT_NOTE)}`,
    '-c', 'agents.enabled=false', '-c', 'approval_policy=never',
    // No network inside Codex's sandbox on Windows: sandbox_workspace_write.network_access=true was
    // tried on 2026-09-23 and curl still could not connect. A task that has to install or fetch
    // belongs on Grok (its workspace profile allows network) or DeepSeek.
    ...(process.platform === 'win32' ? ['-c', 'windows.sandbox=elevated'] : []),
    // C-4: compact late, at the role's threshold or the default (the latest Codex allows).
    ...codexCompactArgs(ctx.compact?.codex, backend.context_tokens ?? CODEX_DEFAULT_WINDOW),
    // R-6: a Lead gets this service's MCP server, and only that one.
    ...(ctx.dispatch ? codexDispatchArgs(dispatchServer(ctx.seatId)) : []),
  ];
  const resumeId = ctx.previous?.kind === 'codex' ? ctx.previous.id : null;
  const run = await codexExec(entry, common, ctx.cwd, resumeId, resumeId ? ctx.resumePrompt : ctx.freshPrompt, true);
  const mapUsage = (list) => list.map((u) => ({
    input: (u.input_tokens ?? 0) - (u.cached_input_tokens ?? 0),
    cacheRead: u.cached_input_tokens ?? 0,
    cacheWrite: u.cache_write_input_tokens ?? 0,
    output: u.output_tokens ?? 0,
  }));
  const rollout = run.id ? codexRollout(run.id) : null;
  const after = rollout ? codexQuotaIn(rollout) : null;
  // Every tool step was a command the sandbox never started: nothing was done, whatever the exit code,
  // so the task goes on to the next backend (CODEX_UNSTARTED).
  if (run.unstarted && run.unstarted === run.toolItems) {
    return failure(message(`codex 没跑起来（沙箱起不来，${run.unstarted} 条命令一条都没执行：${String(run.sandboxError).slice(0, 80)}；Codex 桌面版开着时 CLI 0.162.1 会这样，升到 0.163.0 以上可修）`, `codex did not start (sandbox startup failed; none of ${run.unstarted} commands executed: ${String(run.sandboxError).slice(0, 80)}; CLI 0.162.1 can fail with the desktop app open; upgrade to 0.163.0 or later)`), { quota: after });
  }
  if (run.failed || !run.produced) {
    const reason = String(run.error ?? message('没有输出', 'No output')).slice(0, 120);
    if (!run.toolItems) return failure(message(`codex 没跑起来（${reason}）`, `codex did not start (${reason})`), { quota: after });
    return failure(message(`codex 干到一半失败了（${reason}）`, `codex failed after starting work (${reason})`), {
      worked: true,
      progress: message(`它已经动过手：执行了 ${run.toolItems} 次命令或工具调用${run.produced ? '，也写出了部分回答' : ''}`, `Work already started: ${run.toolItems} command or tool calls${run.produced ? ', with a partial answer' : ''}`),
      sessionFile: rollout,
      usage: mapUsage(run.usage),
      label: `openai-codex/${backend.model}`,
      quota: after,
    });
  }
  ctx.checkpoint({ sessionFile: rollout, usage: mapUsage(run.usage), label: `openai-codex/${backend.model}`, report: run.text });

  const closingPrompt = closingPromptFor(ctx.task);
  const note = closingPrompt
    ? await codexExec(entry, common, ctx.cwd, run.id, closingPrompt, false)
    : { failed: true, produced: false, usage: [] };
  // A closing question that failed or said nothing is "unknown", not "nothing left": null leaves the
  // seat's stored backlog alone (closing.mjs, exec.mjs).
  const closing = note.failed || !note.produced ? { expertise: '', backlog: null } : splitClosing(note.text);
  const finalQuota = (rollout ? codexQuotaIn(rollout) : null) ?? after;
  return {
    sessionFile: rollout,
    report: run.text,
    usage: mapUsage([...run.usage, ...note.usage]),
    expertise: closing.expertise,
    backlog: closing.backlog,
    quota: finalQuota,
    label: message(`openai-codex/${backend.model}${finalQuota ? `，订阅额度：5 小时窗口 ${finalQuota.fiveHour}%，周 ${finalQuota.weekly}%` : ''}`, `openai-codex/${backend.model}${finalQuota ? `, subscription quota: 5-hour ${finalQuota.fiveHour}%, weekly ${finalQuota.weekly}%` : ''}`),
    // The role's expected traces (roles.json expected_traces) are left out before four are kept, so a
    // tester's four failing tests cannot push a real error out of the record.
    difficulties: run.commands
      .filter((c) => typeof c.exit_code === 'number' && c.exit_code !== 0)
      .map((c) => {
        // PowerShell and cmd report a command that is not there with exit 1, and so do npm and the test
        // runners when what they were asked to run is not there; that would read as an empty search or a
        // failing test, and the output says which it was.
        const missing = commandMissing(String(c.aggregated_output ?? '').slice(-2000));
        // Search and diff tools exit 1 for "nothing found" / "differences found": a finding, not an
        // error. Counting them as errors put false entries in the difficulty ledger (2026-09-23). Only
        // when the command is one: the search word anywhere in the line made `npm run build && rg x`
        // with a broken build "no result" (2026-10-01 review).
        const quietOne = !missing && c.exit_code === 1 && QUIET_ONE.test(soleCommand(String(c.command)) ?? '');
        const line = message(`命令 ${String(c.command).slice(0, 100)}`, `Command ${String(c.command).slice(0, 100)}`);
        const facts = { command: String(c.command).slice(0, 2000), exit_code: c.exit_code, missing };
        return quietOne
          ? { kind: 'empty', tool: 'bash', detail: message(`${line} 没有结果（退出码 1）`, `${line} returned no results (exit code 1)`), description: null, ...facts }
          : { kind: 'error', tool: 'bash', detail: message(`${line} 退出码 ${c.exit_code}${missing ? missingMark() : ''}`, `${line} exit code ${c.exit_code}${missing ? missingMark() : ''}`), description: null, ...facts };
      })
      .filter((trace) => !expectedRule(ctx.expectedTraces, trace))
      .slice(0, 4),
  };
}

// ---- Grok --------------------------------------------------------------------------------------

function grokBinary() {
  const pinned = process.env.SPECIALIST_GROK_BIN;
  if (pinned && fs.existsSync(pinned)) return pinned;
  const home = path.join(os.homedir(), '.grok', 'bin', process.platform === 'win32' ? 'grok.exe' : 'grok');
  return fs.existsSync(home) ? home : null;
}

function grokSessionFile(sessionId) {
  let found = null;
  walkFiles(path.join(os.homedir(), '.grok', 'sessions'), (full, name) => {
    if (!found && name === 'chat_history.jsonl' && path.basename(path.dirname(full)) === sessionId) found = full;
  });
  return found;
}

// Which Grok sandbox a seat runs in. Nobody is there to approve a tool call, so every seat runs
// --always-approve and the kernel sandbox (Landlock and seccomp on Linux) is what holds the line.
// `--permission-mode dontAsk` was used for read-only seats until 2026-10-25: it cancels every shell
// command that is not on an allow list, and the first cancelled call ends the whole run ("User
// cancelled the execution"), so web_researcher and tester on Grok returned one opening sentence and
// nothing else. On Linux the read-only profile also blocks child network, so a read-only seat that
// needs the internet (web_researcher, --network) gets the workspace profile: its cwd is the service's
// own per-domain directory, which is the only project path it can write.
function grokSandboxArgs(ctx) {
  const profile = ctx.writes || ctx.network ? 'workspace' : 'read-only';
  return ['--sandbox', profile, '--always-approve'];
}

async function grokRun(bin, backend, ctx, resumeId, prompt) {
  // The prompt goes in a file (header); the task call and the closing question take turns with it.
  const promptFile = path.join(ctx.promptDir, 'grok-prompt.md');
  try {
    fs.writeFileSync(promptFile, prompt, 'utf8');
  } catch (err) {
    return { text: '', id: resumeId, usage: null, cost: null, error: message(`写不了交给 Grok 的提示文件 ${promptFile}（${err?.code ?? err?.message ?? err}）`, `Could not write Grok prompt file ${promptFile} (${err?.code ?? err?.message ?? err})`) };
  }
  // No subagents: the seat does the work itself. Grok has no MCP servers configured on this machine,
  // so it cannot reach specialist-subagents; if one is ever added, deny it here.
  const args = [
    '--prompt-file', promptFile, '-m', backend.model, '--output-format', 'json', '--no-subagents', '--cwd', ctx.cwd,
    ...(backend.effort ? ['--reasoning-effort', backend.effort] : []),
    ...grokSandboxArgs(ctx),
    ...(resumeId ? ['--resume', resumeId] : []),
  ];
  // C-4: compact late, at the role's percent of the window or the default (100).
  const res = await spawnCollect(bin, args, { cwd: ctx.cwd, env: grokEnv(process.env, ctx.compact?.grok) });
  let out = null;
  try {
    out = JSON.parse(res.stdout);
  } catch {
    out = null;
  }
  const text = typeof out?.text === 'string' ? out.text : '';
  const structuredErr = (typeof out?.error === 'string' && out.error.trim()) || (typeof out?.message === 'string' && out.message.trim()) || '';
  const error = res.code !== 0 || !text || out?.is_error ? structuredErr || lastLines(res.stderr) || lastLines(res.stdout) || message(`grok 退出码 ${res.code}`, `grok exit code ${res.code}`) : null;
  return { text, id: out?.sessionId ?? resumeId, usage: out?.usage ?? null, cost: out?.total_cost_usd ?? null, error };
}

// Grok's one-shot JSON does not list tool calls, so "did it work" is read from what it billed: a
// call refused up front (auth, quota) bills nothing, one that ran the model has output tokens.
function grokSpent(run) {
  return (run.usage?.output_tokens ?? 0) > 0 || (typeof run.cost === 'number' && run.cost > 0);
}

async function runGrokBackend(backend, ctx) {
  const bin = grokBinary();
  if (!bin) return failure(message('grok 没跑起来（找不到 Grok CLI）', 'grok did not start (Grok CLI not found)'));
  const resumeId = ctx.previous?.kind === 'grok' ? ctx.previous.id : null;
  const run = await grokRun(bin, backend, ctx, resumeId, resumeId ? ctx.resumePrompt : ctx.freshPrompt);
  const mapUsage = (list) => list.filter(Boolean).map((u) => ({
    input: u.input_tokens ?? 0,
    cacheRead: u.cache_read_input_tokens ?? 0,
    cacheWrite: u.cache_creation_input_tokens ?? 0,
    output: u.output_tokens ?? 0,
  }));
  if (run.error) {
    const reason = String(run.error).slice(0, 120);
    if (!grokSpent(run)) return failure(message(`grok 没跑起来（${reason}）`, `grok did not start (${reason})`));
    return failure(message(`grok 干到一半失败了（${reason}）`, `grok failed after starting work (${reason})`), {
      worked: true,
      progress: message(`Grok 不报告调用了哪些工具，只知道它已经花了 ${run.usage?.output_tokens ?? 0} 个输出 token，可能已经改过文件`, `Grok does not identify tool calls; it has used ${run.usage?.output_tokens ?? 0} output tokens and may have changed files`),
      sessionFile: run.id ? grokSessionFile(run.id) : null,
      usage: mapUsage([run.usage]),
      label: `xai-grok/${backend.model}`,
    });
  }
  process.stdout.write(`${run.text}\n`);
  ctx.checkpoint({ sessionFile: run.id ? grokSessionFile(run.id) : null, usage: mapUsage([run.usage]), label: `xai-grok/${backend.model}`, report: run.text });

  const closingPrompt = closingPromptFor(ctx.task);
  const note = closingPrompt
    ? await grokRun(bin, backend, ctx, run.id, closingPrompt)
    : { text: '', id: run.id, usage: null, cost: null, error: message('收尾依据不可用', 'Closing evidence unavailable') };
  const closing = note.error ? { expertise: '', backlog: null } : splitClosing(note.text);
  const usage = mapUsage([run.usage, note.usage]);
  const equivalent = [run.cost, note.cost].filter((c) => typeof c === 'number').reduce((a, b) => a + b, 0);
  return {
    sessionFile: run.id ? grokSessionFile(run.id) : null,
    report: run.text,
    usage,
    expertise: closing.expertise,
    backlog: closing.backlog,
    // Subscription, not money: the CLI's dollar figure is only what the same tokens would cost.
    label: message(`xai-grok/${backend.model}，订阅额度（按 API 价折合 $${equivalent.toFixed(4)}）`, `xai-grok/${backend.model}, subscription usage (API-equivalent $${equivalent.toFixed(4)})`),
    difficulties: [],
  };
}

// ---- Claude ------------------------------------------------------------------------------------

// Claude Code signed in with a Claude subscription (2026-09-29). Flags, each checked that day with
// a probe in a scratch directory:
//   --safe-mode           no CLAUDE.md, skills, hooks, plugins or MCP servers of the user's; the
//                         subscription login still works (--bare would force an API key instead)
//   --restricted          file tools confined to the working directory: a Write outside it came back
//                         as a permission denial, not a file. Bash, when the role has it, is not
//                         confined — the same as the DeepSeek seat's bash.
//   --strict-mcp-config   no MCP servers at all: the specialist-subagents one would let it delegate
//   --tools/--allowedTools the role's whitelist mapped to Claude's tool names; no Agent, no web
//   dontAsk + --permission-prompts none   nobody is there to approve; what is not allowed is denied
function claudeBinary() {
  const pinned = process.env.SPECIALIST_CLAUDE_BIN;
  if (pinned && fs.existsSync(pinned)) return pinned;
  for (const name of process.platform === 'win32' ? ['claude.exe', 'claude'] : ['claude']) {
    const home = path.join(os.homedir(), '.local', 'bin', name);
    if (fs.existsSync(home)) return home;
  }
  return null;
}

const CLAUDE_TOOLS = { read: 'Read', grep: 'Grep', find: 'Glob', ls: 'Glob', bash: 'Bash', edit: 'Edit', write: 'Write' };

// The subscription login, not whatever the daemon's environment happens to carry: an API key would
// bill per token, and variables left by a Claude Code session would make this one think it is nested.
//
// CLAUDE_CODE_GIT_BASH_PATH survives the sweep: on Windows the CLI refuses to start without Git Bash, and
// a machine whose Git for Windows is not in the default place tells it where with exactly this variable.
// Stripping it made the Claude backend fail on such a machine and the run fall through to another backend
// (2026-09-30 review). It is configuration, not session state, so it cannot make the CLI think it is nested.
const CLAUDE_ENV_KEEP = new Set(['CLAUDE_CODE_GIT_BASH_PATH']);

function claudeEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (CLAUDE_ENV_KEEP.has(key)) continue;
    if (key === 'CLAUDECODE' || key.startsWith('CLAUDE_CODE_') || key === 'CLAUDE_AGENT_SDK_VERSION') delete env[key];
  }
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.ANTHROPIC_BASE_URL;
  return env;
}

function claudeSessionFile(sessionId) {
  let found = null;
  walkFiles(path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects'), (full, name) => {
    if (!found && name === `${sessionId}.jsonl`) found = full;
  });
  return found;
}

// stream-json (which -p only allows with --verbose) instead of json: the one-shot result arrived
// only when the whole run was over, so the page showed nothing for half an hour while a seat ran a
// test suite (2026-09-29). Each tool call and message is echoed as it happens, the way Codex's are.
function claudeToolLine(item) {
  const input = item.input ?? {};
  const what = input.command ?? input.file_path ?? input.pattern ?? input.path ?? JSON.stringify(input);
  return `\n· ${item.name} ${String(what).replace(/\s+/g, ' ').slice(0, 160)}\n`;
}

// 2026-10-23/24: Claude Code reports a turn its model's safety filter stopped as a system event,
// {"type":"system","subtype":"model_refusal_no_fallback",...} (the API said "Sonnet 5.5's safeguards
// flagged this message"), and the run ends without a result. Until then the reason the run reported was
// that line cut at 120 characters. What the event says about it, in a few words.
const REFUSAL_SUBTYPE = /^model_refusal/;
function refusalWords(ev) {
  const bits = [String(ev.subtype)];
  for (const key of ['message', 'reason', 'details', 'error']) {
    const value = ev[key];
    if (typeof value === 'string' && value.trim()) bits.push(value.trim());
    else if (Array.isArray(value) && value.length) bits.push(value.map(String).join(', '));
  }
  return bits.join(message('：', ': ')).replace(/\s+/g, ' ').slice(0, 160);
}

async function claudeRun(bin, backend, ctx, resumeId, prompt, echo) {
  const tools = [...new Set(ctx.tools.map((t) => CLAUDE_TOOLS[t]).filter(Boolean))].join(',');
  // `-p` with no prompt argument: the prompt comes on stdin (header).
  const args = claudeArgs({ model: backend.model, effort: backend.effort, tools, resumeId, compact: ctx.compact?.claude, dispatch: ctx.dispatch ? dispatchServer(ctx.seatId) : null });
  // A model id newer than the CLI prints a warning line before the JSON, so every line is tried and
  // the ones that are not events are skipped; the event of type result carries what the run returns.
  let out = null;
  let toolCalls = 0;
  let refusal = null;
  // A pinned script (the tests' stand-in for the CLI) is run with this node: Windows spawns no .mjs.
  const script = /\.m?js$/i.test(bin);
  const res = await spawnCollect(script ? process.execPath : bin, script ? [bin, ...args] : args, {
    cwd: ctx.cwd,
    env: claudeEnv(),
    input: prompt,
    onLine: (line) => {
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        return;
      }
      if (ev?.type === 'system' && REFUSAL_SUBTYPE.test(String(ev.subtype ?? ''))) refusal = refusalWords(ev);
      if (ev?.type === 'result') out = ev;
      else if (ev?.type === 'assistant' && Array.isArray(ev.message?.content)) {
        for (const item of ev.message.content) {
          if (item.type === 'tool_use') toolCalls += 1;
          if (!echo) continue;
          if (item.type === 'text' && item.text) process.stdout.write(`${item.text}\n`);
          else if (item.type === 'tool_use') process.stdout.write(claudeToolLine(item));
        }
      }
    },
  });
  const text = typeof out?.result === 'string' ? out.result : '';
  const structuredErr = (out?.is_error && typeof out?.result === 'string' && out.result.trim()) || (typeof out?.error === 'string' && out.error.trim()) || '';
  const error = res.code !== 0 || !text || out?.is_error ? structuredErr || lastLines(res.stderr) || lastLines(res.stdout) || message(`claude 退出码 ${res.code}`, `claude exit code ${res.code}`) : null;
  // The event is the evidence; the subtype in the error lines is the fallback for an event that was missed.
  refusal = refusal ?? (/model_refusal\w*/.exec(error ?? '')?.[0] ?? null);
  return { text, id: out?.session_id ?? resumeId, usage: out?.usage ?? null, models: Object.keys(out?.modelUsage ?? {}), denials: out?.permission_denials ?? [], error, toolCalls, refusal };
}

async function runClaudeBackend(backend, ctx) {
  const bin = claudeBinary();
  if (!bin) return failure(message('claude 没跑起来（找不到 Claude Code CLI）', 'claude did not start (Claude Code CLI not found)'));
  const resumeId = ctx.previous?.kind === 'claude' ? ctx.previous.id : null;
  // The report itself was echoed as it streamed, so it is not written again here.
  const run = await claudeRun(bin, backend, ctx, resumeId, resumeId ? ctx.resumePrompt : ctx.freshPrompt, true);
  const mapUsage = (list) => list.filter(Boolean).map((u) => ({
    input: u.input_tokens ?? 0,
    cacheRead: u.cache_read_input_tokens ?? 0,
    cacheWrite: u.cache_creation_input_tokens ?? 0,
    output: u.output_tokens ?? 0,
  }));
  if (run.error || run.refusal) {
    const reason = run.refusal ? message(`被后端模型的安全过滤拦下：${run.refusal}`, `Stopped by the backend model’s safety filter: ${run.refusal}`) : String(run.error).slice(0, 120);
    // Stopped before any tool call: nothing was done, and the next backend starts the task (it is handed
    // the seat's history as text like any other change of backend, C-1).
    if (!run.toolCalls) return failure(message(`claude 没跑起来（${reason}）`, `claude did not start (${reason})`), { refused: Boolean(run.refusal) });
    return failure(message(`claude 干到一半失败了（${reason}）`, `claude failed after starting work (${reason})`), {
      worked: true,
      refused: Boolean(run.refusal),
      progress: message(`它已经动过手：调用了 ${run.toolCalls} 次工具`, `Work already started: ${run.toolCalls} tool calls`),
      sessionFile: run.id ? claudeSessionFile(run.id) : null,
      usage: mapUsage([run.usage]),
      label: `anthropic-claude/${claudeModel(run.models, backend.model)}`,
    });
  }
  ctx.checkpoint({ sessionFile: run.id ? claudeSessionFile(run.id) : null, usage: mapUsage([run.usage]), label: `anthropic-claude/${claudeModel(run.models, backend.model)}`, report: run.text });

  const closingPrompt = closingPromptFor(ctx.task);
  const note = closingPrompt
    ? await claudeRun(bin, backend, ctx, run.id, closingPrompt, false)
    : { text: '', id: run.id, usage: null, cost: null, error: message('收尾依据不可用', 'Closing evidence unavailable') };
  const closing = note.error ? { expertise: '', backlog: null } : splitClosing(note.text);
  const usage = mapUsage([run.usage, note.usage]);
  // The model the alias resolved to (roles.json names an alias such as `sonnet`, so a new Sonnet is
  // picked up by updating the CLI, not by editing this repository).
  const model = claudeModel(run.models, backend.model);
  // Priced from our own table, cache writes included: the CLI's own figure was unreliable for a
  // model id newer than the CLI (2.1.282 priced a small Sonnet 5.5 probe at several times list).
  // A model the table does not know is said to be unpriced, not priced at zero.
  const priced = usage.map((u) => equivalentCost(model, u));
  const equivalent = priced.every((c) => c !== null) ? priced.reduce((a, b) => a + b, 0) : null;
  return {
    sessionFile: run.id ? claudeSessionFile(run.id) : null,
    report: run.text,
    usage,
    expertise: closing.expertise,
    backlog: closing.backlog,
    label: message(`anthropic-claude/${model}，订阅额度（${equivalent === null ? `${model} 不在 src/pricing.mjs 的价格表里，没有折合` : `按 API 价折合 $${equivalent.toFixed(4)}`}）`, `anthropic-claude/${model}, subscription usage (${equivalent === null ? `${model} has no price in src/pricing.mjs; no equivalent cost` : `API-equivalent $${equivalent.toFixed(4)}`})`),
    difficulties: run.denials.slice(0, 4).map((d) => ({
      kind: 'blocked',
      tool: String(d.tool_name ?? '').toLowerCase() || null,
      detail: message(`${d.tool_name} 被拒：${JSON.stringify(d.tool_input ?? {}).slice(0, 120)}`, `${d.tool_name} denied: ${JSON.stringify(d.tool_input ?? {}).slice(0, 120)}`),
      description: null,
    })),
  };
}

// ---- Antigravity -------------------------------------------------------------------------------

// Google's `agy` (2026-10-21, 1.4.4), signed in with the Google AI Pro subscription: on 2026-06-18 Gemini
// CLI stopped serving that tier, which is now reached only through this CLI. Besides Gemini it offers
// Claude Opus / Sonnet 5.5 on Google's quota. Flags, each checked that day in a scratch directory:
//   --input-format stream-json   the prompt arrives on stdin as one {"event":"user"} line (header);
//                                it requires --output-format stream-json, which streams step_update
//                                events (tool steps, text deltas, per-step usage) and ends in `result`
//   --conversation <id>          resumes; the transcript stays under brain/<id>/ on this machine
//   --disable-slash-commands     a task that starts with "/" is text, not a command or a skill
//   --dangerously-skip-permissions   a role that writes or runs commands: nobody is there to approve
// Not --sandbox ("terminal restrictions"): probed on 2026-10-22 on Windows, it refused to run node.exe,
// by name and by full path, so a tester could not run a JS project's tests, while git ran and a
// Set-Content outside the working directory went through. It kept the commands a seat needs and not the
// writes it should keep in, so a role is held to its directory by its contract, as Claude's Bash is.
// There is no read-only switch: `--mode plan` writes nothing but ends WAITING on a plan for a human to
// approve, which no seat can use. Without the skip flag the CLI's own headless policy applies: shell
// commands are soft-denied, but reading and writing files inside the workspace is allowed. So a read-only
// role on this backend is held to read-only by its contract, not by a sandbox, and the skip flag adds
// nothing for it but the commands. A role with a shell and no write tools (tester, web_researcher) took
// the policy before 2026-10-22 and could not run one: a tester's command came back "a tool required
// the "command" permission that headless mode cannot prompt for", and the run slid to the next backend.
// Its MCP servers are the user's global ~/.gemini/config/mcp_config.json (hwiki and unityMCP on this
// machine); specialist-subagents is not among them, so a seat here cannot delegate. If it is ever added
// there, this backend needs a way to turn it off before it is used again.
// agy resolution: explicit SPECIALIST_AGY_BIN, then home defaults, then PATH unless tests disable it.
//   ~/.local/bin/agy(.exe)  first: `install.ps1 --dir %USERPROFILE%\.local\bin`, next to claude.exe.
//     The installer's own default, %LOCALAPPDATA%\agy\bin, is unsafe on Windows when the install runs
//     from a packaged (MSIX) app such as the Claude desktop app: a new folder under AppData is redirected
//     into that package's private LocalCache, so the daemon, started outside the package, never sees it
//     (it reported "not found" for a path that existed for every process inside the package).
//   ~/AppData/Local/agy/bin/agy.exe  the installer's default, for an install made outside such an app.
// Not %LOCALAPPDATA% itself: the tests' sandbox moves HOME and USERPROFILE only, and a lookup through
// LOCALAPPDATA found the real agy there and ran a real model inside a test.
export function resolveAgyBinary({ env = process.env, home = env.USERPROFILE || env.HOME || os.homedir() } = {}) {
  const pinned = env.SPECIALIST_AGY_BIN?.trim();
  if (env.SPECIALIST_AGY_BIN !== undefined) return pinned && fs.existsSync(pinned) ? pinned : null;
  const candidates = process.platform === 'win32'
    ? [path.join(home, '.local', 'bin', 'agy.exe'), path.join(home, 'AppData', 'Local', 'agy', 'bin', 'agy.exe')]
    : [path.join(home, '.local', 'bin', 'agy')];
  const found = candidates.find((file) => fs.existsSync(file));
  if (found) return found;
  if (env.SPECIALIST_NO_HOST_PATH !== '1') {
    const result = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', ['agy'], {
      env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: 5000,
    });
    if (result.status === 0) {
      const first = result.stdout.split(/\r?\n/).map((line) => line.trim())
        .find((line) => line && (process.platform !== 'win32' || !/\.(cmd|bat)$/i.test(line)) && fs.existsSync(line));
      if (first) return first;
    }
  }
  return null;
}

function agyBinary() {
  return resolveAgyBinary();
}

// R-6: agy has no per-run MCP flag; it reads the user's global ~/.gemini/config/mcp_config.json (and a
// workspace .agents/mcp_config.json, which would mean writing into the project). So a Lead on agy needs
// this service registered there once (see doc/connect.md), and every agy seat then starts the bridge; the
// bridge shows a member seat no tools (it inherits the seat's environment: SPECIALIST_CALLER_SEAT set,
// SPECIALIST_CALLER_DISPATCH not 1), and the daemon refuses its dispatches anyway.
// What keeps an Antigravity Lead from dispatching, or null. Two things must be in agy's global config:
// the server itself (mcp_config.json), and a grant for each Lead tool (config.json's
// userSettings.globalPermissionGrants.allow, `mcp(<server>/<tool>)`). Without the grant agy's headless
// mode denies the call: on 2026-10-22 a Lead read seat_start's schema and was refused at the call with
// "user denied permission for mcp(specialist-subagents/seat_start)". A role that writes or runs commands
// runs with --dangerously-skip-permissions, which approves the calls as well, so the grants are checked
// only for a Lead with neither (the Lead has both since 2026-10-22, contract 2.0.0).
export function agyDispatchProblem(home = os.homedir(), unattended = false) {
  const dir = path.join(home, '.gemini', 'config');
  let server = null;
  try {
    server = JSON.parse(fs.readFileSync(path.join(dir, 'mcp_config.json'), 'utf8'))?.mcpServers?.[DISPATCH_SERVER];
  } catch {}
  if (!server || server.disabled === true) {
    return message(`agy 的 ~/.gemini/config/mcp_config.json 里没有 ${DISPATCH_SERVER} 这个 MCP 服务；在 ~/.gemini/config/mcp_config.json（或 ~/.gemini/antigravity/mcp_config.json）登记一次，配法见 doc/connect.md`, `agy has no ${DISPATCH_SERVER} MCP server in ~/.gemini/config/mcp_config.json. Register it there (or ~/.gemini/antigravity/mcp_config.json); see doc/connect.md, including globalPermissionGrants for headless calls`);
  }
  if (unattended) return null;
  let allow = [];
  try {
    allow = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'))?.userSettings?.globalPermissionGrants?.allow ?? [];
  } catch {}
  const missing = LEAD_TOOLS.map((tool) => `mcp(${DISPATCH_SERVER}/${tool})`).filter((grant) => !allow.includes(grant));
  if (missing.length) {
    return message(`agy 的 ~/.gemini/config/config.json 里 userSettings.globalPermissionGrants.allow 缺 ${missing.join('、')}；无头模式会拒绝没有授权的 MCP 调用，把这几条加进去，配法见 doc/connect.md`, `agy ~/.gemini/config/config.json is missing userSettings.globalPermissionGrants.allow entries: ${missing.join(', ')}. Headless mode denies ungranted MCP calls; add these grants. Register the server in ~/.gemini/config/mcp_config.json; see doc/connect.md`);
  }
  return null;
}

function agySessionFile(conversationId) {
  if (!conversationId) return null;
  const file = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'brain', conversationId, '.system_generated', 'logs', 'transcript.jsonl');
  return fs.existsSync(file) ? file : null;
}

// The user's ~/.gemini/GEMINI.md (global rules for her own interactive use) and the workspace's
// AGENTS.md / GEMINI.md are always loaded by agy, with no flag to turn them off; like Codex, the seat is
// told in front of its first prompt that they are not its rules.
// agy also carries its own subagent tools (define_subagent, invoke_subagent, browser_subagent,
// manage_subagents) and, unlike Grok's --no-subagents, no flag removes them; a seat that spawns them
// spends the subscription several times over for one task, so the same note asks it not to.
const AGY_SEAT_NOTE =
  '（服务消息）这次运行是 specialist-subagents 服务派出的专家座位。上下文里如果有用户全局的 GEMINI.md 或工作区的 AGENTS.md，' +
  '那是用户自己交互使用时的规则，不适用于这里；这里以下面给出的岗位合同和岗位 skill 为准，两者冲突时以岗位合同为准。' +
  '这一单你自己做完：不要开子代理（define_subagent、invoke_subagent、browser_subagent、manage_subagents 都不用），也不要开后台任务。';

function agyToolLine(step) {
  const params = step.tool_info?.parameters ?? {};
  const what = params.CommandLine ?? params.Path ?? params.TargetFile ?? params.Query ?? JSON.stringify(params);
  return `\n· ${step.tool_name} ${String(what).replace(/\s+/g, ' ').slice(0, 160)}\n`;
}

// Whether a role runs on agy with the skip flag: it writes, or it runs commands (see the header).
export function agyUnattended(tools) {
  return ['write', 'edit', 'bash'].some((tool) => tools.includes(tool));
}

export function agyArgs({ model, effort = null, unattended = false, resumeId = null }) {
  return [
    '--input-format', 'stream-json', '--output-format', 'stream-json', '--disable-slash-commands',
    '--model', model,
    ...(effort ? ['--effort', effort] : []),
    ...(unattended ? ['--dangerously-skip-permissions'] : []),
    ...(resumeId ? ['--conversation', resumeId] : []),
  ];
}

async function agyRun(bin, backend, ctx, resumeId, prompt, echo) {
  const args = agyArgs({ model: backend.model, effort: backend.effort, unattended: agyUnattended(ctx.tools), resumeId });
  const userEvent = { event: 'user', message: { content: resumeId ? prompt : `${AGY_SEAT_NOTE}\n\n${prompt}` } };
  let result = null;
  let id = resumeId;
  let toolCalls = 0;
  const toolErrors = [];
  // The result's usage counts the whole conversation, earlier runs included; each step reports its own.
  const steps = [];
  const res = await spawnCollect(bin, args, {
    cwd: ctx.cwd,
    input: `${JSON.stringify(userEvent)}\n`,
    onLine: (line) => {
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        return;
      }
      if (ev?.event === 'init') id = ev.conversation_id ?? id;
      else if (ev?.event === 'result') result = ev.result ?? null;
      else if (ev?.event === 'step_update') {
        const step = ev.step_update ?? {};
        if (step.state === 'DONE' && step.usage) steps.push(step.usage);
        if (step.step_type === 'tool' && step.state === 'DONE') {
          toolCalls += 1;
          if (step.tool_info?.error) toolErrors.push(step);
          if (echo) process.stdout.write(agyToolLine(step));
        } else if (step.step_type === 'agent_response' && echo && step.text_delta) {
          process.stdout.write(step.text_delta);
        }
      }
    },
  });
  const text = typeof result?.response === 'string' ? result.response.trim() : '';
  const error = res.code !== 0 || result?.status !== 'SUCCESS' || !text
    ? result?.error || lastLines(res.stderr) || (result?.status ? message(`agy 结束状态 ${result.status}`, `agy final status ${result.status}`) : message(`agy 退出码 ${res.code}`, `agy exit code ${res.code}`))
    : null;
  const usage = steps.length ? steps : resumeId || !result?.usage ? [] : [result.usage];
  return { text, id: result?.conversation_id || id, usage, error, toolCalls, toolErrors };
}

async function runAntigravityBackend(backend, ctx) {
  const bin = agyBinary();
  if (!bin) return failure(message('antigravity 没跑起来（找不到 Antigravity CLI：请检查 SPECIALIST_AGY_BIN、家目录默认路径 ~/.local/bin/agy、~/AppData/Local/agy/bin/agy.exe 与 PATH 中的 agy；显式设置 SPECIALIST_AGY_BIN 时不回退查找。装法与配置见 doc/connect.md）', 'antigravity did not start (Antigravity CLI not found: check SPECIALIST_AGY_BIN, ~/.local/bin/agy, ~/AppData/Local/agy/bin/agy.exe and agy on PATH; explicit SPECIALIST_AGY_BIN disables fallback. See doc/connect.md)'));
  const dispatchProblem = ctx.dispatch ? agyDispatchProblem(os.homedir(), agyUnattended(ctx.tools)) : null;
  if (dispatchProblem) return failure(message(`antigravity 没跑起来（这个岗位要派单，但 ${dispatchProblem}）`, `antigravity did not start (this role needs dispatch, but ${dispatchProblem})`));
  const resumeId = ctx.previous?.kind === 'antigravity' ? ctx.previous.id : null;
  const run = await agyRun(bin, backend, ctx, resumeId, resumeId ? ctx.resumePrompt : ctx.freshPrompt, true);
  process.stdout.write('\n');
  // agy's input_tokens leave out what was read from the cache, which it counts apart; output includes thinking.
  const mapUsage = (list) => list.filter(Boolean).map((u) => ({
    input: u.input_tokens ?? 0,
    cacheRead: u.cache_read_tokens ?? 0,
    cacheWrite: 0,
    output: u.output_tokens ?? 0,
  }));
  const label = `google-antigravity/${backend.model}`;
  if (run.error) {
    const reason = String(run.error).slice(0, 120);
    if (!run.toolCalls) return failure(message(`antigravity 没跑起来（${reason}）`, `antigravity did not start (${reason})`));
    return failure(message(`antigravity 干到一半失败了（${reason}）`, `antigravity failed after starting work (${reason})`), {
      worked: true,
      progress: message(`它已经动过手：调用了 ${run.toolCalls} 次工具`, `Work already started: ${run.toolCalls} tool calls`),
      sessionFile: agySessionFile(run.id),
      usage: mapUsage(run.usage),
      label,
    });
  }
  ctx.checkpoint({ sessionFile: agySessionFile(run.id), usage: mapUsage(run.usage), label, report: run.text });

  const closingPrompt = closingPromptFor(ctx.task);
  const note = closingPrompt
    ? await agyRun(bin, backend, ctx, run.id, closingPrompt, false)
    : { text: '', id: run.id, usage: [], error: message('收尾依据不可用', 'Closing evidence unavailable') };
  const closing = note.error ? { expertise: '', backlog: null } : splitClosing(note.text);
  const usage = mapUsage([...run.usage, ...note.usage]);
  const priced = usage.map((u) => equivalentCost(backend.model, u));
  const equivalent = priced.length && priced.every((c) => c !== null) ? priced.reduce((a, b) => a + b, 0) : null;
  return {
    sessionFile: agySessionFile(run.id),
    report: run.text,
    usage,
    expertise: closing.expertise,
    backlog: closing.backlog,
    label: message(`${label}，订阅额度（${equivalent === null ? `${backend.model} 不在 src/pricing.mjs 的价格表里，没有折合` : `按 API 价折合 $${equivalent.toFixed(4)}`}）`, `${label}, subscription usage (${equivalent === null ? `${backend.model} has no price in src/pricing.mjs; no equivalent cost` : `API-equivalent $${equivalent.toFixed(4)}`})`),
    difficulties: run.toolErrors
      .map((step) => ({
        kind: 'error',
        tool: String(step.tool_name ?? '').toLowerCase() || null,
        detail: message(`${step.tool_name} 出错：${String(step.tool_info?.error?.message ?? step.tool_info?.error?.type ?? '').slice(0, 120)}`, `${step.tool_name} failed: ${String(step.tool_info?.error?.message ?? step.tool_info?.error?.type ?? '').slice(0, 120)}`),
        description: null,
      }))
      .filter((trace) => !expectedRule(ctx.expectedTraces, trace))
      .slice(0, 4),
  };
}

// ---- DeepSeek fallback -------------------------------------------------------------------------

// The pi leg: the same task handed to seat-runner, which writes the result file itself.
function runPi(opts, ctx, reasons, backend) {
  if (!opts.runtime || !fs.existsSync(opts.runtime)) {
    throw new Error(message('按量兜底执行器 pi 未安装。执行 node bin/specialist-subagents.mjs start 按引导安装，或执行 npm --prefix ../runtimes/pi install @earendil-works/pi-coding-agent@1.5.2。', 'Optional metered fallback pi is not installed. Run node bin/specialist-subagents.mjs start for onboarding, or npm --prefix ../runtimes/pi install @earendil-works/pi-coding-agent@1.5.2.'));
  }
  const why = reasons.join(message('；', '; '));
  if (!opts.runtime) throw new Error(message(`${why}，轮到 DeepSeek，但这个岗位没给 --pi {runtime}`, `${why}; DeepSeek fallback requires --pi {runtime} for this role`));
  // "改由" when something before it did not run (a backend failed or was skipped), "由" when DeepSeek was the pick.
  process.stdout.write(message(`（${why}，这一单${reasons.length > 1 ? '改由' : '由'} deepseek/${backend.model} 干）\n`, `(${why}; running on deepseek/${backend.model})\n`));
  const piSession = ctx.previous?.kind === 'pi' ? ctx.previousSession : null;
  const handoff = piSession ? '' : ctx.handoff;
  // The task goes over as it came, never with the resume notice: seat-runner puts the contract and the
  // skill, like every --append-system-prompt segment, into the system prompt it builds for this run,
  // resumed session or not, so the notice would hand the same text over twice.
  // Like every other backend's prompt, none of it goes on the command line: a hand-off from another
  // backend's session is added here, after the daemon's length check, and on 2026-10-22 one from a long
  // Codex session made this spawn fail with a bare ENAMETOOLONG (seat-handyman-23). The task goes in a
  // file, and so does each system-prompt segment, which seat-runner reads back as a file's content.
  const task = withBackendNote(ctx.backendNote, handoff ? `${handoff}\n\n---\n\n任务：\n${opts.task}` : opts.task);
  const taskFile = path.join(ctx.promptDir, 'pi-task.md');
  const segmentFiles = [];
  try {
    fs.writeFileSync(taskFile, task, 'utf8');
    opts.appendSystemPrompt.forEach((segment, i) => {
      const file = path.join(ctx.promptDir, `pi-system-${i + 1}.md`);
      fs.writeFileSync(file, resolveSegment(segment), 'utf8');
      segmentFiles.push(file);
    });
  } catch (err) {
    throw new Error(message(`${why}，轮到 DeepSeek，但写不了交给它的提示文件（${ctx.promptDir}：${err?.code ?? err?.message ?? err}）`, `${why}; could not write the DeepSeek prompt file (${ctx.promptDir}: ${err?.code ?? err?.message ?? err})`));
  }
  const args = [
    path.join(ROOT, 'src', 'seat-runner.mjs'),
    '--pi', opts.runtime, '--provider', 'deepseek', '--model', backend.model,
    ...(backend.effort ? ['--thinking', backend.effort] : []),
    '--tools', opts.tools.join(','),
    ...segmentFiles.flatMap((file) => ['--append-system-prompt', file]),
    '--task-file', taskFile,
  ];
  return new Promise((resolve) => {
    let settled = false;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      resolve(code ?? 1);
    };
    let child;
    try {
      child = spawn(process.execPath, args, {
        stdio: ['ignore', 'inherit', 'inherit'],
        windowsHide: true,
        // seat-runner knows no role: the traces this role's contract makes normal go over with the run.
        env: {
          ...process.env,
          SPECIALIST_SEAT_SESSION_FILE: piSession ?? '',
          // C-1: how this run's session was loaded, which seat-runner writes into its result file; and C-4:
          // the tokens pi keeps free before it compacts.
          SPECIALIST_SEAT_LOAD: ctx.load,
          SPECIALIST_SEAT_COMPACT_RESERVE: ctx.compact?.deepseek ? String(ctx.compact.deepseek) : '',
          SPECIALIST_SEAT_RESUME_NOTICE: '',
          SPECIALIST_SEAT_SKILL_NOTICE: '',
          SPECIALIST_SEAT_EXPECTED_TRACES: JSON.stringify(ctx.expectedTraces ?? []),
        },
      });
    } catch (err) {
      process.stderr.write(message(`拉起 seat-runner 失败：${err?.message ?? err}\n`, `Could not start seat-runner: ${err?.message ?? err}\n`));
      return finish(1);
    }
    child.on('error', (err) => {
      process.stderr.write(message(`seat-runner 进程错误：${err?.message ?? err}\n`, `seat-runner process error: ${err?.message ?? err}\n`));
      finish(1);
    });
    child.on('close', (code) => finish(code));
  });
}

// ---- main --------------------------------------------------------------------------------------

// Every stop by a backend model's safety filter in this run, in order (2026-10-25): before any tool call
// (the next backend took the task), halfway (a session without the history took over), or in the
// takeover itself. Each written result carries the list, so the service records each one, the task
// finished or not; until then only a refusal that ended the run left a trace, as a plain run failure.
const runRefusals = [];
function noteRefusal(backend, outcome) {
  if (outcome?.refused) runRefusals.push({ backend: backend.kind, stage: outcome.worked ? 'halfway' : 'before_tools', reason: outcome.failed, progress: outcome.progress || '' });
}

function writeResult(resultPath, data) {
  const tmpPath = `${resultPath}.${process.pid}.tmp`;
  try {
    const out = runRefusals.length ? { ...data, refusals: runRefusals } : data;
    fs.writeFileSync(tmpPath, JSON.stringify(out, null, 2), 'utf8');
    fs.renameSync(tmpPath, resultPath);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    process.stderr.write(message(`写结果文件「${resultPath}」失败：${err && err.message ? err.message : err}\n`, `Could not write result file ${resultPath}: ${err && err.message ? err.message : err}\n`));
  }
}

function sumUsage(list) {
  const t = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  for (const u of list) {
    t.input += u.input;
    t.cacheRead += u.cacheRead;
    t.cacheWrite += u.cacheWrite;
    t.output += u.output;
  }
  t.total = t.input + t.cacheRead + t.cacheWrite + t.output;
  return t;
}

// ---- Takeover after a refusal ------------------------------------------------------------------
//
// 2026-10-24: three Claude coder runs (seat-coder-18 and its forks 33 and 34) were stopped halfway by
// the model's safety filter, each after 10 to 26 tool calls; one left compact-pointer.js cut off inside a
// function. The rule above (no second backend after tool activity) left the task where it stopped, and
// the dispatcher finished it by hand. A refusal is not a failure of the work, and what triggers it may
// be the session's own history as much as the task (the forks shared the expert's), so the task is
// carried on once, by a session that has none of that history: Codex first, a new Claude session when
// Codex cannot start. It is told which files the stopped session changed and to read them before going
// on; its result is this run's result. Its own failure after tool activity stops the run, with the list.
const TAKEOVER_ORDER = ['codex', 'claude'];

async function takeOver({ opts, ctx, plan, roles, preamble, outcome, changes, snapshot, reasons, resultPath }) {
  const listed = changedFilesText(changes);
  const stopped = message(`${outcome.failed}。${outcome.progress}`, `${outcome.failed}. ${outcome.progress}`);
  process.stdout.write(message(`（拦截：${stopped}。这一单到这里改动过的文件：\n${listed}\n改由不带这个座位历史的新会话从现场接着做，只接手一次）\n`, `(Stopped: ${stopped}. Files changed so far:\n${listed}\nA fresh session without this seat’s history will take over once.)\n`));
  // The seat keeps the session it had: the takeover's session starts with none of the expert's history,
  // and continuing it next time would leave the expert with only this one task.
  const keptSession = outcome.sessionFile ?? ctx.previousSession ?? null;
  const usage = [...outcome.usage];
  const brief = originalTask(opts.task);
  const tried = [];
  for (const next of TAKEOVER_ORDER.map((kind) => plan.chain.find((b) => b.kind === kind)).filter(Boolean)) {
    const note = roles[opts.role]?.backend_notes?.[next.kind]?.trim() || '';
    const takeoverCtx = {
      ...ctx,
      previous: null,
      previousSession: null,
      handoff: '',
      resumePrompt: '',
      freshPrompt: [preamble, note, freshNote({ takeover: { stopped: outcome.failed, files: listed } }), `任务：\n${brief}`].filter(Boolean).join('\n\n---\n\n'),
      checkpoint: (partial) => ctx.checkpoint({ ...partial, sessionFile: keptSession, usage: [...usage, ...partial.usage] }),
    };
    process.stdout.write(message(`（接手：${next.kind}:${next.model}${next.effort ? ` 推理 ${next.effort}` : ''}，新会话，不带这个座位的会话、记录和未完成清单）\n`, `(Takeover: ${next.kind}:${next.model}${next.effort ? `, reasoning ${next.effort}` : ''}; fresh session without this seat’s history, records, or backlog.)\n`));
    const result = await { codex: runCodexBackend, claude: runClaudeBackend }[next.kind](next, takeoverCtx);
    recordBackendOutcome(ROOT, next.kind, { ok: !result.failed, reason: result.failed ?? null, worked: Boolean(result.worked), refused: Boolean(result.refused), quota: result.quota ?? null });
    noteRefusal(next, result);
    if (result.failed && !result.worked) {
      tried.push(result.failed);
      process.stdout.write(message(`（${result.failed}，接手换下一家）\n`, `(${result.failed}; trying the next takeover backend.)\n`));
      continue;
    }
    usage.push(...result.usage);
    if (result.failed) {
      const failureMessage =
        message(`${stopped}。服务让 ${next.kind} 的新会话（不带这个座位的历史）接手了一次，它也没做完：${result.failed}。${result.progress}。只接手一次，这一单到这里停下。`, `${stopped}. A fresh ${next.kind} session without this seat’s history attempted the single allowed takeover and also failed: ${result.failed}. ${result.progress}. This run is now stopped.`) +
        message(`这一单到现在改动过的文件：\n${changedFilesText(changedFiles(ctx.cwd, snapshot))}\n先看这些文件的现状和座位事件，再决定接着做还是重新派活。（${reasons.join('；')}）`, `Files changed by this run:\n${changedFilesText(changedFiles(ctx.cwd, snapshot))}\nRead their current contents and seat events before deciding whether to continue or redispatch. (${reasons.join('; ')})`);
      process.stderr.write(`${failureMessage}\n`);
      writeResult(resultPath, {
        error: failureMessage,
        sessionFile: keptSession,
        load: ctx.load,
        changes: changedFiles(ctx.cwd, snapshot).files,
        takeover: { stopped: outcome.failed, by: result.label ?? next.kind, failed: result.failed, files: changes.files, session: result.sessionFile ?? null },
        tokens: sumUsage(usage),
        model: message(`${result.label ?? next.kind}（${reasons.join('；')}；${outcome.failed}，接手的新会话也没做完）`, `${result.label ?? next.kind} (${reasons.join('; ')}; ${outcome.failed}; takeover also failed)`),
      });
      return 1;
    }
    writeResult(resultPath, {
      sessionFile: keptSession,
      report: message(`（服务消息）这一单的原会话做到一半被停下（${outcome.failed}，${outcome.progress}），由 ${next.kind} 的新会话（不带这个座位的历史）从现场接着做完。`, `(Service notice) The original session stopped after starting work (${outcome.failed}, ${outcome.progress}). A fresh ${next.kind} session without this seat’s history continued from disk and completed the task. `) +
        message(`被停下时已改动的文件：\n${listed}\n\n下面是接手会话的报告。\n\n${result.report ?? ''}`, `Files already changed when stopped:\n${listed}\n\nTakeover session report:\n\n${result.report ?? ''}`),
      tokens: sumUsage(usage),
      // A session with none of the expert's history knows this task only; what the expert knows stays as it was.
      expertise: '',
      backlog: result.backlog,
      model: message(`${result.label}（${reasons.join('；')}；${outcome.failed}，改由 ${next.kind} 的新会话接手）`, `${result.label} (${reasons.join('; ')}; ${outcome.failed}; fresh ${next.kind} session took over)`),
      difficulties: result.difficulties,
      load: ctx.load,
      takeover: { stopped: outcome.failed, by: result.label, files: changes.files, session: result.sessionFile ?? null },
    });
    return 0;
  }
  const failureMessage =
    message(`${stopped}。要换不带这个座位历史的新会话接手，但${tried.length ? `都没起来（${tried.join('；')}）` : '这个岗位的后端里没有 codex 也没有 claude'}，这一单到这里停下。`, `${stopped}. Could not start a fresh takeover session: ${tried.length ? tried.join('; ') : 'neither codex nor claude is allowed for this role'}. This run is stopped.`) +
    message(`这一单改动过的文件：\n${listed}\n先看这些文件的现状和座位事件，再决定接着做还是重新派活。（${reasons.join('；')}）`, `Files changed by this run:\n${listed}\nRead their current contents and seat events before deciding whether to continue or redispatch. (${reasons.join('; ')})`);
  process.stderr.write(`${failureMessage}\n`);
  writeResult(resultPath, {
    error: failureMessage,
    sessionFile: keptSession,
    load: ctx.load,
    changes: changes.files,
    takeover: { stopped: outcome.failed, by: null, failed: tried.join(message('；', '; ')) || message('没有可接手的后端', 'No takeover backend available'), files: changes.files, session: null },
    ...(usage.length ? { tokens: sumUsage(usage), model: message(`${outcome.label ?? 'claude'}（${reasons.join('；')}）`, `${outcome.label ?? 'claude'} (${reasons.join('; ')})`) } : {}),
  });
  return 1;
}

// How the run's session was loaded (C-1), kept where the last-resort handler at the bottom can reach it.
let loadMode = null;

async function main() {
  const opts = parseArgv(process.argv.slice(2));
  const resultPath = process.env.SPECIALIST_SEAT_RESULT;
  if (!resultPath) throw new Error(message('缺环境变量 SPECIALIST_SEAT_RESULT：结果 JSON 写哪', 'Missing SPECIALIST_SEAT_RESULT: result JSON destination is required'));
  // A fresh fork (exec.mjs, seat_start fork "fresh"): no history of any kind, whatever else is set.
  const fresh = (process.env.SPECIALIST_SEAT_FRESH ?? '').trim() === '1';
  const sessionFileEnv = fresh ? '' : process.env.SPECIALIST_SEAT_SESSION_FILE;
  const previousSession = sessionFileEnv && fs.existsSync(sessionFileEnv) ? sessionFileEnv : null;
  // The hand-off document (exec.mjs names it once it writes them, L-1): named in the note when the
  // previous session's text had to be cut, so the seat knows where the whole of it is summarised.
  const handoffFile = (process.env.SPECIALIST_SEAT_HANDOFF_FILE ?? '').trim();
  const previous = sessionKind(previousSession);
  // A fork gets the expert's session to read, not to continue (forkNote above): with no previous session
  // of its own, `previous` stays null, so no backend resumes anything and every one gets the note.
  const recordEnv = (process.env.SPECIALIST_SEAT_RECORD_FILE ?? '').trim();
  const forkRecord = !fresh && !previousSession && recordEnv && fs.existsSync(recordEnv) ? recordEnv : null;
  const expertiseEnv = fresh ? '' : (process.env.SPECIALIST_SEAT_EXPERTISE ?? '').trim();
  const handoff = fresh
    ? freshNote()
    : forkRecord
      ? forkNote(forkRecord, expertiseEnv, sessionKind(forkRecord)?.kind ?? null, handoffFile)
      : handoffNote(previousSession, expertiseEnv, previous?.kind ?? null, handoffFile);
  const preamble = opts.appendSystemPrompt.map(resolveSegment).filter((s) => s.trim()).join('\n\n');
  // A file the service wrote, the contract notice and the skill notice already in that order; a
  // missing or unreadable one means no notice, never a failed run. SPECIALIST_SEAT_SKILL_NOTICE is the
  // name before 2026-10-01 (skill notice only, same file format): a daemon started before this change
  // keeps its exec.mjs in memory and still sets that one, while this runner is read from disk at every
  // run, and that exec records the new skill hash, so a notice dropped here would never come again.
  // Drop the fallback once no daemon from before the rename is running.
  let resumeNotice = '';
  const noticeFile = process.env.SPECIALIST_SEAT_RESUME_NOTICE || process.env.SPECIALIST_SEAT_SKILL_NOTICE;
  if (noticeFile) {
    try {
      resumeNotice = fs.readFileSync(noticeFile, 'utf8').trim();
    } catch {
      resumeNotice = '';
    }
  }

  const ctx = {
    cwd: process.cwd(),
    // Where Grok's prompt file goes: the seat's run directory, which holds the result file too.
    promptDir: path.dirname(path.resolve(resultPath)),
    task: opts.task,
    // What Codex, Grok and Claude are sent when they resume the seat's session (see the header).
    resumePrompt: resumeNotice ? `${resumeNotice}\n\n---\n\n${opts.task}` : opts.task,
    writes: opts.tools.includes('write') || opts.tools.includes('edit'),
    network: opts.network,
    tools: opts.tools,
    // R-6: this seat's id (exec.mjs), and whether its role may dispatch (`dispatch` in its whitelist,
    // which the startup gate ties to the role's grant).
    seatId: (process.env.SPECIALIST_SEAT_ID ?? '').trim() || null,
    dispatch: opts.tools.includes('dispatch'),
    previousSession,
    previous,
    handoff,
    load: 'fresh',
  };
  // The directory as this run found it, so a backend stopped halfway can say what it changed (takeover.mjs).
  const snapshot = worktreeSnapshot(ctx.cwd);
  // Every backend this runner starts, and every MCP server those start, inherits these: an MCP bridge
  // of this service started anywhere inside the seat (agy reads the user's global MCP config) knows it
  // is in a seat, which one, and whether that seat may dispatch.
  process.env.SPECIALIST_CALLER_SEAT = ctx.seatId ?? '';
  process.env.SPECIALIST_CALLER_DISPATCH = ctx.dispatch ? '1' : '0';

  const roles = JSON.parse(fs.readFileSync(path.join(ROOT, 'roles.json'), 'utf8'));
  // The traces this role's contract makes normal (expected-traces.mjs); the startup gate checked them.
  ctx.expectedTraces = Array.isArray(roles[opts.role]?.expected_traces) ? roles[opts.role].expected_traces : [];
  const settings = loadSettings(ROOT, Object.keys(roles));
  // C-4: where each backend compacts, for this role: its own setting in roles.json, else the default.
  ctx.compact = Object.fromEntries(KINDS.map((kind) => [kind, compactFor(settings, roles[opts.role], kind)]));
  const plan = planFor(opts.role, settings, readChoice(ROOT), { network: opts.network, backends: roles[opts.role]?.backends ?? null, health: readBackendHealth(ROOT) });
  const reasons = [...plan.notes];
  const failures = [];
  // A finished main task is written down before the closing question is asked, so a backend that dies
  // in the closing round still leaves its session, usage and difficulties (2026-09-30).
  // `report` is the backend's final answer on its own, without the tool-call lines echoed to stdout:
  // the service keeps it as the run's report (task_result, seat_show), 2026-10-01.
  ctx.checkpoint = (partial) => writeResult(resultPath, {
    sessionFile: partial.sessionFile,
    report: partial.report ?? '',
    tokens: sumUsage(partial.usage),
    expertise: '',
    backlog: null,
    model: message(`${partial.label}（${reasons.join('；')}）`, `${partial.label} (${reasons.join('; ')})`),
    difficulties: partial.difficulties ?? [],
    load: ctx.load,
  });
  // R-7 (2026-10-24): a note written for one backend goes only into the prompt of the run that lands on
  // that backend. It is added to both the fresh prompt and the resume prompt: a resumed session may have
  // been opened before the note was written, so the note would never reach it otherwise.
  const baseResumePrompt = ctx.resumePrompt;
  for (const backend of plan.chain) {
    const note = roles[opts.role]?.backend_notes?.[backend.kind]?.trim() || '';
    ctx.resumePrompt = withBackendNote(note, baseResumePrompt);
    // pi's session files are the ones sessionKind() calls 'pi'; DeepSeek is the backend that continues them.
    const resumes = ctx.previous?.kind === (backend.kind === 'deepseek' ? 'pi' : backend.kind);
    // C-1: how this run's session is loaded: the backend continues the log (resumed), a fresh session is
    // given the previous log as text or the seat's expertise note (loaded), or it starts with nothing (fresh).
    ctx.load = resumes ? 'resumed' : handoff && !fresh ? 'loaded' : 'fresh';
    loadMode = ctx.load;
    if (backend.kind === 'deepseek') {
      process.stdout.write(message(`（装载方式：${ctx.load}）\n`, `(Loading mode: ${ctx.load})\n`));
      ctx.backendNote = note;
      process.exitCode = await runPi(opts, ctx, reasons, backend);
      return;
    }
    // A fresh session gets the preamble (contract, skill, memory, in roles.json's order), the handoff
    // when it takes over from another backend, and the task. It never gets the resume notice: the
    // preamble already carries the current contract and skill. The backend's note sits right after the
    // preamble, before the handoff and the task.
    const takesOver = ctx.previous && !resumes;
    ctx.freshPrompt = [preamble, note, takesOver || !ctx.previous ? handoff : '', `任务：\n${opts.task}`].filter(Boolean).join('\n\n---\n\n');
    if (failures.length) process.stdout.write(message(`（${failures.at(-1)}，改用 ${backend.kind}:${backend.model}${backend.effort ? ` 推理 ${backend.effort}` : ''}）\n`, `(${failures.at(-1)}; switching to ${backend.kind}:${backend.model}${backend.effort ? `, reasoning ${backend.effort}` : ''})\n`));
    process.stdout.write(message(`（装载方式：${ctx.load}）\n`, `(Loading mode: ${ctx.load})\n`));
    const run = { codex: runCodexBackend, grok: runGrokBackend, claude: runClaudeBackend, antigravity: runAntigravityBackend }[backend.kind];
    const outcome = await run(backend, ctx);
    recordBackendOutcome(ROOT, backend.kind, { ok: !outcome.failed, reason: outcome.failed ?? null, worked: Boolean(outcome.worked), refused: Boolean(outcome.refused), quota: outcome.quota ?? null });
    noteRefusal(backend, outcome);
    if (outcome.failed && outcome.worked) {
      const changes = changedFiles(ctx.cwd, snapshot);
      // Stopped by the model's safety filter: carried on once, from what is on disk, by a session that
      // has none of this seat's history (takeOver).
      if (outcome.refused) {
        process.exitCode = await takeOver({ opts, ctx, plan, roles, preamble, outcome, changes, snapshot, reasons, resultPath });
        return;
      }
      // No fallback: this backend already changed things, and a second one would redo the same work
      // on top of them. Say who failed, how far it got and which files it changed; the caller decides.
      const failureMessage =
        message(`${outcome.failed}。${outcome.progress}。因为它已经动过手，这一单没有换别的后端重跑（换了会把同样的活做两遍，还可能和它留下的改动打架）。`, `${outcome.failed}. ${outcome.progress}. Work already started, so this run was not retried on another backend; that could duplicate work and conflict with existing changes. `) +
        message(`这一单改动过的文件：\n${changedFilesText(changes)}\n先看这些文件的现状和座位事件，再决定接着做还是重新派活。（${reasons.join('；')}）`, `Files changed by this run:\n${changedFilesText(changes)}\nRead their current contents and seat events before deciding whether to continue or redispatch. (${reasons.join('; ')})`);
      process.stderr.write(`${failureMessage}\n`);
      writeResult(resultPath, {
        error: failureMessage,
        sessionFile: outcome.sessionFile,
        load: ctx.load,
        changes: changes.files,
        ...(outcome.usage.length ? { tokens: sumUsage(outcome.usage), model: message(`${outcome.label ?? backend.kind}（${reasons.join('；')}）`, `${outcome.label ?? backend.kind} (${reasons.join('; ')})`) } : {}),
      });
      process.exitCode = 1;
      return;
    }
    if (outcome.failed) {
      failures.push(outcome.failed);
      reasons.push(outcome.failed);
      continue;
    }
    writeResult(resultPath, {
      sessionFile: outcome.sessionFile,
      report: outcome.report ?? '',
      tokens: sumUsage(outcome.usage),
      // Subscription quota, not money: no cost, so the ledger prints tokens and the label only.
      expertise: outcome.expertise,
      backlog: outcome.backlog,
      model: message(`${outcome.label}（${reasons.join('；')}）`, `${outcome.label} (${reasons.join('; ')})`),
      difficulties: outcome.difficulties,
      load: ctx.load,
    });
    return;
  }
  const own = roles[opts.role]?.backends;
  throw new Error(message(`${reasons.join('；')}，后面没有别的后端可换了${Array.isArray(own) ? `（这个岗位只用 ${own.join('、')}，roles.json 的 backends 写死了，不落到别家）` : '（presets.json 的 order 里 deepseek 应该排在最后兜底）'}`, `${reasons.join('; ')}; no backends remain${Array.isArray(own) ? ` (this role is restricted to ${own.join(', ')} by roles.json backends)` : ' (deepseek should be last in presets.json order as the final fallback)'}`));
}

// Run only as the program: the pure parts above are imported by the tests, and importing must not start a run.
function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return pathToFileURL(fs.realpathSync(fileURLToPath(import.meta.url))).href === pathToFileURL(fs.realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main().then(
    () => process.exit(process.exitCode ?? 0),
    (err) => {
      const failureMessage = err && err.message ? err.message : String(err);
      process.stderr.write(`${failureMessage}\n`);
      const resultPath = process.env.SPECIALIST_SEAT_RESULT;
      if (resultPath) writeResult(resultPath, { error: failureMessage, ...(loadMode ? { load: loadMode } : {}) });
      process.exit(1);
    },
  );
}
