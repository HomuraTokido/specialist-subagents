// specialist-subagents expected traces: what a role's contract asks it to do is not that role's difficulty.
import { language, message } from './presets.mjs';
//
// The difficulty ledger (FR-21) reads a run's traces off its tool events and its final answer. Some of
// those traces are a post doing its job: web_researcher and explorer must write 查不到 / 推断 / 无法确认
// where that is the truth (the `uncertain` trace), a tester that correctly runs a failing test gets a
// non-zero exit, and a coder confirms old references are gone with a search that finds nothing. Counted
// as difficulties they filled the skill loop's batch of 5 with evidence of the skill being obeyed, and
// the refiner would have rewritten the skill against it (2026-10-01 review of contracts against skills;
// the ledger already held 6 web_researcher|uncertain rows, every sample an honest 查不到).
//
// Which traces are normal for which role is data, not code (I3): an optional `expected_traces` list per
// role in roles.json. Each rule names one trace kind and, where needed, narrows it:
//   kind      uncertain | empty | error (required). Nothing else can be made normal: a failed run
//             (timeouts included), a blocked write, a retry, a compaction, an unusually costly run and
//             the lead's revised / rejected verdicts always count.
//   tools     the trace's tool must be one of these (optional)
//   command   a regular expression, case-insensitive, the command must match (optional). It is matched
//             against soleCommand() below: the shell wrapper Codex puts around every command removed,
//             and only the first command of a pipeline, so `^` means "the command starts with".
//   max_exit  the command's exit code must be known and between 1 and this, at most 125 (optional).
//             126 / 127 (not executable, not found), signal deaths (128 and up), a command that did
//             not get to run (commandMissing below: a shell, a package manager or a test runner saying
//             what it was asked to run is not there, all with exit 1) and calls with no exit code at
//             all (timeouts, aborts, refusals) never match.
//   why       one sentence: which part of the contract or skill makes this trace normal (required)
// An `error` rule must name both `command` and `max_exit`, so every other tool error of the role counts.
// An `uncertain` trace has no tool and no command, so its rule names only `kind` and `why`.
// A command line of several statements (&&, ||, ; or a line break) matches no rule that names `command`
// or `max_exit`: its exit code may belong to any of them (`npm run build && rg x` exiting 1 is usually
// the build), so it keeps counting (2026-10-01 review).
//
// The one matcher below is applied in four places: seat-runner (DeepSeek) does not record matching
// outcomes or ask the seat about them, and never puts them in a retry with other outcomes (a retry formed
// of other outcomes always counts); only the identical call made two or more times in a row, matching
// each time, makes a retry of its own (2026-10-01). cli-runner (Codex) leaves matching commands out
// before it keeps four, and detects no retries at all, a known gap; exec.mjs does not write a matching
// trace into the ledger; and store.mjs leaves matching
// rows that are already in the ledger out of difficulty_report, the reminder, the wall and the skill
// loop's count. roles.json reaches the ledger's roles table only when the service starts, so removing
// a rule makes those old rows count again after a restart, not before.

export const EXPECTABLE_KINDS = Object.freeze(['uncertain', 'empty', 'error']);
export const MAX_EXPECTED_EXIT = 125;
const RULE_KEYS = ['kind', 'tools', 'command', 'max_exit', 'why'];

// What a command prints when it did not get to run at all. Bash says "command not found" with exit 127,
// which max_exit already refuses; PowerShell and cmd say it with exit 1, which looks like a failing test
// or an empty search. Codex runs every command through PowerShell on this machine, so the text has to be
// read. Package managers and test runners do the same when what they were asked to run is not there,
// also with exit 1 (each checked on this machine, 2026-10-01 review): `npm test` with no test script,
// `npm ci` with no package.json or lock file, `node --test` on a file that does not exist, `python -m
// pytest` with pytest not installed. The line-start ones accept the "：" a ledger row puts before the
// output, so a DeepSeek row written before the mark below existed is still read right.
const COMMAND_MISSING = new RegExp([
  'command not found',
  'is not recognized as (?:an internal or external command|the name of a cmdlet|a name of a cmdlet)',
  '不是内部或外部命令',
  '无法将.{0,80}项识别为',
  'Missing script:', // npm, pnpm
  'error Command "[^"\\n]*" not found', // yarn 1
  "Couldn't find a script named", // yarn 2 and later
  'error: Script not found', // bun
  'npm (?:ERR!|error) code ENOENT', // npm with no package.json or lock file
  "(?:^|\\n|：)Could not find '", // node --test
  '(?:^|\\n|：)ERROR: file (?:or directory )?not found: ', // pytest
  'python[\\w.]*(?:\\.exe)?: No module named ', // python -m with the module not installed
].join('|'), 'i');
export function commandMissing(output) {
  return COMMAND_MISSING.test(String(output ?? ''));
}
// The words the runners put in a trace's detail when commandMissing was true, so a row in the ledger
// still says it after the output itself is gone.
export const MISSING_MARK_ZH = '（没跑起来：找不到这个命令，或它要跑的脚本、测试文件、模块）';
export const MISSING_MARK_EN = ' (did not start: command, script, test file, or module not found)';
export function missingMark(lang = language()) {
  return message(MISSING_MARK_ZH, MISSING_MARK_EN, lang);
}
export const MISSING_MARK = missingMark();

// The command a rule's `command` is matched against, or null when there is none or the line holds
// several statements. Codex reports each command with the shell it ran it in, for example
//   "C:\Program Files\PowerShell\7\pwsh.exe" -NoProfile -Command 'rg -n oldName src'
// so that wrapper and its quotes come off first. Then `&&`, `||`, `;` followed by a space and line breaks
// mean several statements. Of a pipeline only the first command is kept: `rg x | head` is a search,
// `node build.mjs | grep -v warn` is a build. Quotes are not parsed: a `|` inside a quoted pattern only
// cuts off the end of the line, after the command word a rule looks at, and an `&&` or `; ` inside one
// makes the line count, which is the safe side.
const SHELL_WRAPPER = /^\s*(?:"(?:[^"]*[\\/])?|'(?:[^']*[\\/])?|(?:\S*[\\/])?)(?:pwsh|powershell|bash|sh|zsh|cmd)(?:\.exe)?["']?\s+(?:[-/]{1,2}[A-Za-z][\w-]*(?:\s+[A-Za-z]\w*)?\s+)*?(?:-Command|-c|-lc|\/c)\s+([\s\S]*)$/i;
const SEVERAL_STATEMENTS = /&&|\|\||;(?=\s|$)|[\r\n]/;
export function soleCommand(command) {
  if (typeof command !== 'string' || !command.trim()) return null;
  let line = command.trim();
  const wrapped = line.match(SHELL_WRAPPER);
  if (wrapped) {
    line = wrapped[1].trim();
    const quoted = line.match(/^(['"])([\s\S]*)\1$/);
    if (quoted) line = quoted[2].trim();
  }
  if (SEVERAL_STATEMENTS.test(line)) return null;
  return line.split('|')[0].trim() || null;
}

// The command, exit code and "did not get to run" of a trace. New traces carry them as fields (the
// runners add `command`, `exit_code`, `missing`); a row in the ledger has only its detail sentence, in
// the shapes the runners write:
//   Codex     命令 <command> 退出码 <n>   |   命令 <command> 没有结果（退出码 1）
//   DeepSeek  第 <n> 次调用 <tool> <argument> 报错：<output>…Command exited with code <n>
//             第 <n> 次调用 <tool> <argument> 报错（退出码 <n>）：<output>   (since 2026-10-01)
//             第 <n> 次调用 <tool> <argument> 没有结果
// DeepSeek's detail keeps only the first 120 characters of the output, so an older row whose output was
// long has lost its exit code; with no known exit code it matches no max_exit rule and keeps counting.
export function traceFacts(trace) {
  const detail = String(trace?.detail ?? '');
  let command = typeof trace?.command === 'string' ? trace.command : null;
  if (command === null) {
    const codexZh = detail.match(/^命令 ([\s\S]*?) (?:没有结果（退出码 -?\d+）|退出码 -?\d+)/);
    const codexEn = detail.match(/^Command ([\s\S]*?) (?:returned no results \(exit code -?\d+\)|exit code -?\d+)/);
    const piZh = detail.match(/^第 \d+ 次调用 \S+ ([\s\S]*?) (?:报错(?:（退出码 -?\d+）)?：|没有结果$)/);
    const piEn = detail.match(/^Call #\d+ \S+ ([\s\S]*?) (?:failed(?: \(exit code -?\d+\))?:|returned no output$)/);
    command = codexZh?.[1] ?? codexEn?.[1] ?? piZh?.[1] ?? piEn?.[1] ?? null;
  }
  let exitCode = Number.isInteger(trace?.exit_code) ? trace.exit_code : null;
  if (exitCode === null) {
    const said = [...detail.matchAll(/(?:Command exited with code |\bexit code |退出码 )(-?\d+)/g)].at(-1);
    exitCode = said ? Number(said[1]) : null;
  }
  const missing = trace?.missing === true || detail.includes(MISSING_MARK_ZH) || detail.includes(MISSING_MARK_EN) || commandMissing(detail);
  return { command, exitCode, missing };
}

const compiled = new Map();
function matches(pattern, text) {
  try {
    if (!compiled.has(pattern)) compiled.set(pattern, new RegExp(pattern, 'i'));
    return compiled.get(pattern).test(text);
  } catch {
    // A pattern the startup gate would have refused: it matches nothing, so the trace keeps counting.
    return false;
  }
}

// The rule in `rules` that makes this trace normal for its role, or null when it counts as a difficulty.
// `trace` is a runner trace ({ kind, tool, detail, command?, exit_code?, missing? }) or a ledger row.
// The checks the startup gate makes are repeated here, so a malformed roles.json can only make a trace
// count, never hide a real error.
export function expectedRule(rules, trace) {
  if (!Array.isArray(rules) || !rules.length || !trace) return null;
  for (const rule of rules) {
    if (!rule || typeof rule !== 'object' || rule.kind !== trace.kind || !EXPECTABLE_KINDS.includes(rule.kind)) continue;
    if (rule.kind === 'error' && (rule.command === undefined || rule.max_exit === undefined)) continue;
    if (Array.isArray(rule.tools) && !rule.tools.includes(trace.tool)) continue;
    if (rule.command !== undefined || rule.max_exit !== undefined) {
      const { command, exitCode, missing } = traceFacts(trace);
      const sole = soleCommand(command);
      // Several statements on one line: the exit code may be any of theirs.
      if (command !== null && sole === null) continue;
      if (rule.command !== undefined && !(typeof rule.command === 'string' && sole !== null && matches(rule.command, sole))) continue;
      if (rule.max_exit !== undefined) {
        const top = Math.min(Number(rule.max_exit), MAX_EXPECTED_EXIT);
        if (missing || !Number.isInteger(exitCode) || exitCode < 1 || exitCode > top) continue;
      }
    }
    return rule;
  }
  return null;
}

// The startup gate's check of one role's `expected_traces` (role-contract.mjs): a list of sentences,
// empty when the field is absent or right. A rule the gate refuses would otherwise either never match
// (a typo in a field name) or hide real difficulties (an error rule with no exit-code bound).
export function checkExpectedTraces(id, value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    return [message(
      `${id}: expected_traces 要写成数组，每条一个规则对象，收到「${JSON.stringify(value)}」；不写就是这个岗位所有痕迹都算困难`,
      `${id}: expected_traces must be an array of rule objects, received ${JSON.stringify(value)}; omit it to record all traces for this role as difficulties`,
    )];
  }
  const problems = [];
  value.forEach((rule, index) => {
    const at = message(`${id}: expected_traces 第 ${index + 1} 条`, `${id}: expected_traces[${index}]`);
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
      problems.push(message(
        `${at}要写成对象（kind、why，按需加 tools / command / max_exit）`,
        `${at} must be an object (kind, why, plus optional tools / command / max_exit)`,
      ));
      return;
    }
    const unknown = Object.keys(rule).filter((key) => !RULE_KEYS.includes(key));
    if (unknown.length) {
      problems.push(message(
        `${at}有不认得的字段 ${unknown.join('、')}：只认 ${RULE_KEYS.join(' / ')}，写错的字段会让规则悄悄不起作用`,
        `${at} has unknown field(s) ${unknown.join(', ')}: only ${RULE_KEYS.join(' / ')} are supported; typos silently disable a rule`,
      ));
    }
    if (!EXPECTABLE_KINDS.includes(rule.kind)) {
      problems.push(message(
        `${at}的 kind 只能是 ${EXPECTABLE_KINDS.join(' / ')}，收到「${rule.kind}」；运行失败、写入被拦、换法重试、上下文压缩、token 超常和验收结论永远算困难`,
        `${at}.kind must be one of ${EXPECTABLE_KINDS.join(' / ')}, got ${JSON.stringify(rule.kind)}; failed, blocked, retry, compaction, costly, and verdict traces always count`,
      ));
    }
    if (typeof rule.why !== 'string' || !rule.why.trim()) {
      problems.push(message(
        `${at}没写 why：用一句话说合同或 skill 的哪一句让这种痕迹成了本职`,
        `${at} is missing why: give a one-sentence explanation of why the contract or skill makes this trace expected`,
      ));
    }
    if (rule.tools !== undefined && !(Array.isArray(rule.tools) && rule.tools.length && rule.tools.every((tool) => typeof tool === 'string' && tool.trim()))) {
      problems.push(message(
        `${at}的 tools 要写成非空的工具名数组，比如 ["bash"]`,
        `${at}.tools must be a non-empty array of tool names, e.g. ["bash"]`,
      ));
    }
    if (rule.command !== undefined) {
      if (typeof rule.command !== 'string' || !rule.command) {
        problems.push(message(
          `${at}的 command 要写成正则表达式字符串`,
          `${at}.command must be a regular expression string`,
        ));
      } else {
        try {
          new RegExp(rule.command, 'i');
        } catch (err) {
          problems.push(message(
            `${at}的 command 不是合法的正则：${err.message}`,
            `${at}.command is not a valid regular expression: ${err.message}`,
          ));
        }
      }
    }
    if (rule.max_exit !== undefined && !(Number.isInteger(rule.max_exit) && rule.max_exit >= 1 && rule.max_exit <= MAX_EXPECTED_EXIT)) {
      problems.push(message(
        `${at}的 max_exit 要写成 1 到 ${MAX_EXPECTED_EXIT} 的整数，收到「${rule.max_exit}」；126、127 和信号退出永远算困难`,
        `${at}.max_exit must be an integer from 1 to ${MAX_EXPECTED_EXIT}, got ${JSON.stringify(rule.max_exit)}; 126, 127, and signal exits always count`,
      ));
    }
    if (rule.kind === 'error' && (rule.command === undefined || rule.max_exit === undefined)) {
      problems.push(message(
        `${at}是 error 规则，必须同时写 command 和 max_exit：只有命令自己用退出码说出的结果能算本职，这个岗位别的工具报错照常计数`,
        `${at} is an error rule and requires both command and max_exit: only exit codes reported by matched commands are expected; other tool errors still count`,
      ));
    }
    if (rule.kind === 'uncertain' && (rule.tools !== undefined || rule.command !== undefined || rule.max_exit !== undefined)) {
      problems.push(message(
        `${at}是 uncertain 规则：这种痕迹来自最终回答，没有工具和命令，只写 kind 和 why（写了 tools / command / max_exit 就永远匹配不上）`,
        `${at} is an uncertain rule matching final responses only: set only kind and why (tools / command / max_exit can never match)`,
      ));
    }
  });
  return problems;
}
