// specialist-subagents role contracts: the gate a daemon passes before it serves anything.
//
// Two kinds of drift are silent without it. A contract can change without its version number —
// then "what did I tweak" can never be told apart from "what the post itself learned". (A sha256 of
// each contract used to be checked here too; it was dropped on 2026-09-29: git already records
// every edit, and the hash only made each change touch three files and refused the whole service
// when one was missed.) And a role's declared boundary (tier / grant / deny_intent) can
// part ways with the tool whitelist it actually runs with — the running process then has abilities
// nobody declared. Both are checked at startup, and a mismatch refuses the start: no port is bound,
// nothing runs on a boundary that does not match its own spec.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkExpectedTraces } from './expected-traces.mjs';
import { checkCompact, KINDS, message } from './presets.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROLES_FILE = path.join(ROOT, 'roles.json');

// The one place the two vocabularies meet: a capability name -> the runtime tool names it means.
// This table is the assertion itself, not a comment about one (FR-16): a role may not declare one
// boundary and run with another. `search` and `web` are the same road on this host — tvly for the
// open web, the hwiki CLI for the local wiki — and both are reached through bash, because the role
// runtimes have no HTTP tool of their own.
// `dispatch` (R-6, 2026-10-21) is handing work to member roles through this service. It is not a tool
// of any runtime: cli-runner reads `dispatch` in the whitelist as "start this seat with the service's
// MCP server" (claude --mcp-config, codex -c mcp_servers), so this table is what keeps that switch tied
// to a role that declared it.
export const CAPABILITY_TOOLS = Object.freeze({
  read: ['read', 'grep', 'find', 'ls'],
  write: ['edit', 'write'],
  shell: ['bash'],
  search: ['bash'],
  web: ['bash'],
  dispatch: ['dispatch'],
});

// Capabilities a role must not have, for the deny names that are not capability names in the table
// above. `delegate` is the one such name here: it has no tool of its own, and upstream calls it
// subagent / subagent_fork (disabled in both presets, FR-11). A deny name in neither table is refused
// at startup (boundaryCheck), not read as a tool name.
const DENY_TOOLS = Object.freeze({
  delegate: ['subagent', 'subagent_fork'],
});

// The flag roles.json hands a runtime its tool whitelist with. A runtime that spells it differently
// is a startup refusal ("no tool whitelist"), not a check that quietly finds nothing to compare.
const TOOLS_FLAG = '--tools';

// Where the role runtime lives is machine-local state: the pi CLI sits in a different place on every
// host, so the tracked spec names it with a placeholder and the path is resolved here. Resolving in
// code (rather than writing a path into roles.json) is what keeps that file portable — and allows
// the gate below to refuse a machine path outright instead of trusting whoever edits it.
export const RUNTIME_PLACEHOLDER = '{runtime}';
const RUNTIME_POINTER = path.join(ROOT, '.runtime.json');
const RUNTIME_DEFAULT = path.join(
  ROOT, '..', 'runtimes', 'pi', 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'bundle', 'cli.js'
);

// Resolution order, and why each step exists: an explicit environment variable for a launcher that
// wants to pin it; a pointer file for everything else (the daemon is spawned by whichever client
// came first, so its environment is not ours to control, while a file on disk is always readable);
// and last the sibling-directory convention this checkout uses, so a machine with the usual layout
// needs no configuration at all.
export function resolveRuntime() {
  const fromEnv = process.env.SPECIALIST_SUBAGENTS_RUNTIME;
  if (typeof fromEnv === 'string' && fromEnv.trim()) {
    return { runtime: path.resolve(fromEnv.trim()), source: 'env SPECIALIST_SUBAGENTS_RUNTIME' };
  }
  {
    const pointer = readRuntimePointer();
    if (typeof pointer.runtime === 'string' && pointer.runtime.trim()) {
      return { runtime: path.resolve(ROOT, pointer.runtime.trim()), source: rel(RUNTIME_POINTER) };
    }
  }
  return { runtime: path.resolve(RUNTIME_DEFAULT), source: message(`默认约定（${rel(RUNTIME_DEFAULT)}）`, `default convention (${rel(RUNTIME_DEFAULT)})`) };
}

function rel(file) {
  return path.relative(ROOT, file).split(path.sep).join('/');
}

function readRuntimePointer() {
  let raw;
  try {
    raw = fs.readFileSync(RUNTIME_POINTER, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(message('应为 JSON 对象', 'expected a JSON object'));
    return parsed;
  } catch (err) {
    throw new Error(message(`.runtime.json 解析错误：${err.message}`, `Parse error in .runtime.json: ${err.message}`), { cause: err });
  }
}

/** Custom title for the human caller (`SPECIALIST_SUBAGENTS_CALLER_TITLE` or `.runtime.json` `caller_title` / `user_title`), or null when unconfigured. */
export function resolveCallerTitle() {
  const fromEnv = process.env.SPECIALIST_SUBAGENTS_CALLER_TITLE;
  if (typeof fromEnv === 'string' && fromEnv.trim()) return fromEnv.trim();
  const pointer = readRuntimePointer();
  for (const key of ['caller_title', 'user_title']) {
    if (typeof pointer[key] === 'string' && pointer[key].trim()) return pointer[key].trim();
  }
  return null;
}

/** Human caller label for runtime messages; defaults to `fallback` when no custom title is configured. */
export function callerLabel(fallback = message('用户', 'the user')) {
  return resolveCallerTitle() ?? fallback;
}

// Where the external skills repository sits on this machine: explicit env var first, then
// `.runtime.json` {"skills"|"hskills": "<path>"}. When unconfigured, returns root: null (no probing
// of author-specific default paths).
export function resolveSkillsRoot() {
  for (const key of ['SPECIALIST_SUBAGENTS_SKILLS', 'SPECIALIST_SUBAGENTS_HSKILLS']) {
    const fromEnv = process.env[key];
    if (typeof fromEnv === 'string' && fromEnv.trim()) {
      return { root: path.resolve(fromEnv.trim()), source: `env ${key}`, explicit: true };
    }
  }
  const pointer = readRuntimePointer();
  for (const key of ['skills', 'hskills']) {
    if (typeof pointer[key] === 'string' && pointer[key].trim()) {
      return { root: path.resolve(ROOT, pointer[key].trim()), source: `${rel(RUNTIME_POINTER)}: ${key}`, explicit: true };
    }
  }
  return { root: null, source: null, explicit: false };
}

// The skill directory a role's skill lives in, under <HSkills>/skills/: roles.json may name it
// (`skill`), otherwise h-<role> with underscores turned into hyphens, the way HSkills names its post
// skills (h-explorer, h-tester, h-web-researcher). The code never names a role itself (I3).
export function skillNameFor(role, spec = null) {
  if (typeof spec?.skill === 'string' && spec.skill.trim()) return spec.skill.trim();
  return `h-${String(role).replace(/_/g, '-')}`;
}

// How long a run of a role may last before the service kills it: `timeout_minutes` in roles.json
// (fractions allowed), 60 when absent. exec.mjs enforces it; skill-loop.mjs reads it to tell a refiner
// run that is merely slow from one nobody is watching any more.
export const DEFAULT_TIMEOUT_MINUTES = 60;
export function timeoutMinutes(spec) {
  const minutes = Number(spec?.timeout_minutes);
  return Number.isFinite(minutes) && minutes > 0 ? minutes : DEFAULT_TIMEOUT_MINUTES;
}

// The post that writes skill candidates is named in roles.json, not in code (I3): the one role whose
// spec says `"skill_refiner": true`. The skill loop dispatches that role and no other.
export function skillRefinerOf(specs) {
  const posts = specs.filter((spec) => spec?.skill_refiner === true);
  return posts.length === 1 ? posts[0].id : null;
}

// The contract's VERSION file sits next to it and carries the role's stem: roles/explorer.md +
// roles/explorer.VERSION. Same stem on purpose — moving or renaming a contract moves one thing.
export function versionFileFor(contractFile) {
  const ext = path.extname(contractFile);
  return path.join(path.dirname(contractFile), `${path.basename(contractFile, ext)}.VERSION`);
}

// The tool whitelist a role's spawn spec declares. null means "no whitelist to compare against".
export function toolsFromSpec(spec) {
  const args = spec?.spawn?.args;
  if (!Array.isArray(args)) return null;
  const at = args.indexOf(TOOLS_FLAG);
  if (at < 0 || typeof args[at + 1] !== 'string') return null;
  return args[at + 1].split(',').map((name) => name.trim()).filter(Boolean);
}

// FR-15 and FR-16 item 2: the contract exists, and its version is the one roles.json records.
// A contract without a version number cannot be told apart from a post's own experience.
function contractCheck(id, spec, failures) {
  if (typeof spec.contract !== 'string' || !spec.contract.trim()) {
    failures.push(message(`${id}: roles.json 里没有 contract 路径`, `${id}: roles.json is missing the contract path`));
    return;
  }
  const file = path.resolve(ROOT, spec.contract);
  if (!fs.existsSync(file)) {
    failures.push(message(`${id}: 合同文件 ${spec.contract} 不存在`, `${id}: contract file ${spec.contract} does not exist`));
    return;
  }
  const versionFile = versionFileFor(file);
  if (!fs.existsSync(versionFile)) {
    failures.push(message(`${id}: 合同 ${spec.contract} 没有配套的版本文件 ${rel(versionFile)}`, `${id}: contract ${spec.contract} has no version file ${rel(versionFile)}`));
  } else if (typeof spec.contract_version !== 'string' || !spec.contract_version.trim()) {
    failures.push(message(`${id}: roles.json 没记 contract_version（合同版本号）`, `${id}: roles.json is missing contract_version`));
  } else {
    const actual = fs.readFileSync(versionFile, 'utf8').trim();
    if (actual !== spec.contract_version) {
      failures.push(message(`${id}: 合同版本不符 —— ${rel(versionFile)} 写「${actual}」，roles.json 记「${spec.contract_version}」`, `${id}: contract version mismatch: ${rel(versionFile)} has ${actual}, roles.json has ${spec.contract_version}`));
    }
  }
}

function expectedTraceProblem(problem) {
  const phrases = [
    [' 要写成数组，每条一个规则对象，收到「', ' must be an array of rule objects; got '],
    ['」；不写就是这个岗位所有痕迹都算困难', '; omitted means all traces count as difficulties'],
    ['要写成对象（kind、why，按需加 tools / command / max_exit）', 'must be an object with kind and why, optionally tools / command / max_exit'],
    ['有不认得的字段 ', 'has unknown fields '],
    ['：只认 ', '; allowed fields: '],
    ['，写错的字段会让规则悄悄不起作用', '; misspelled fields would silently disable the rule'],
    ['的 kind 只能是 ', 'kind must be '],
    ['，收到「', '; got '],
    ['」；运行失败、写入被拦、换法重试、上下文压缩、token 超常和验收结论永远算困难', '; failed runs, blocked writes, retries, compaction, unusual token use, and verdicts always count'],
    ['没写 why：用一句话说合同或 skill 的哪一句让这种痕迹成了本职', 'is missing why: explain which contract or skill requirement makes the trace expected'],
    ['的 tools 要写成非空的工具名数组，比如 ["bash"]', 'tools must be a nonempty array of tool names, for example ["bash"]'],
    ['的 command 要写成正则表达式字符串', 'command must be a regular-expression string'],
    ['的 command 不是合法的正则：', 'command is not a valid regular expression: '],
    ['的 max_exit 要写成 1 到 ', 'max_exit must be an integer from 1 to '],
    [' 的整数', ''],
    ['」；126、127 和信号退出永远算困难', '; exit codes 126, 127, and signal exits always count'],
    ['是 error 规则，必须同时写 command 和 max_exit：只有命令自己用退出码说出的结果能算本职，这个岗位别的工具报错照常计数', 'is an error rule and requires command and max_exit; only command exit-code outcomes can be expected, while other tool errors still count'],
    ['是 uncertain 规则：这种痕迹来自最终回答，没有工具和命令，只写 kind 和 why（写了 tools / command / max_exit 就永远匹配不上）', 'is an uncertain rule from the final answer: specify only kind and why; tools / command / max_exit would never match'],
    ['、', ', '],
  ];
  let english = problem.replace(/ 第 (\d+) 条/g, ' rule $1: ');
  for (const [zh, en] of phrases) english = english.replaceAll(zh, en);
  return message(problem, english);
}

// FR-16 items 1 and 3: grant must account for exactly the tools the role runs with, and no denied
// capability may show up in that whitelist. Both directions matter: a tool nobody granted is a
// widened boundary, and a capability that is not covered is a promise the runtime does not keep.
function boundaryCheck(id, spec, failures) {
  if (typeof spec.tier !== 'string' || !spec.tier.trim()) failures.push(message(`${id}: roles.json 没记 tier`, `${id}: roles.json is missing tier`));
  // Optional name of the role's skill directory in HSkills (skillNameFor); it becomes a path segment.
  // The same rule HSkills' lint applies to a skill name (NAME_RE in lint_skills.py, 64 characters at most),
  // so a name this accepts can never make an enabled skill fail the lint.
  if (spec.skill !== undefined && !(typeof spec.skill === 'string' && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(spec.skill) && spec.skill.length <= 64)) {
    failures.push(message(`${id}: skill 要写成 HSkills 里的目录名（小写字母、数字，用单个连字符隔开，不以连字符开头或结尾，64 字以内），收到「${spec.skill}」；不写就是 h-${id.replace(/_/g, '-')}`, `${id}: skill must be an HSkills directory name (lowercase letters and digits, single hyphens, no leading or trailing hyphens, at most 64 characters); got ${spec.skill}. Default: h-${id.replace(/_/g, '-')}`));
  }
  // Optional: marks the post that writes skill candidates (skillRefinerOf). Anything but true or false is
  // refused rather than read as "not the refiner".
  if (spec.skill_refiner !== undefined && typeof spec.skill_refiner !== 'boolean') {
    failures.push(message(`${id}: skill_refiner 要写成 true 或 false，收到「${spec.skill_refiner}」；它标出替各岗位写 skill 候选版本的那个岗位`, `${id}: skill_refiner must be true or false; got ${spec.skill_refiner}. It identifies the role that writes skill candidates`));
  }
  // Optional: `skill_loop: false` takes a post out of the skill loop (skill-loop.mjs): its
  // difficulties are still recorded, but a full batch never dispatches a refiner for it.
  if (spec.skill_loop !== undefined && typeof spec.skill_loop !== 'boolean') {
    failures.push(message(`${id}: skill_loop 只能写 true 或 false（false = 这个岗位不走 skill 循环：困难照记，攒满也不派 refiner）`, `${id}: skill_loop must be true or false (false records difficulties without dispatching a refiner)`));
  }
  // Optional: how the post recognises its expert (store.mjs / exec.mjs). Omitted means a directory
  // expert, the behaviour every post had before; "domain" makes the post's expert a field of
  // knowledge (web_researcher) and its dispatches take a `domain` instead of a `cwd`. A value that is
  // neither is refused rather than silently read as "directory".
  if (spec.expert_by !== undefined && spec.expert_by !== 'directory' && spec.expert_by !== 'domain') {
    failures.push(message(`${id}: expert_by 只能是 "directory"（按目录，默认）或 "domain"（按领域），收到「${spec.expert_by}」`, `${id}: expert_by must be "directory" (default) or "domain"; got ${spec.expert_by}`));
  }
  // Optional run limit (exec.mjs): a value that is not a positive number would silently fall back to the
  // default, so it is refused here instead.
  if (spec.timeout_minutes !== undefined && !(Number.isFinite(spec.timeout_minutes) && spec.timeout_minutes > 0)) {
    failures.push(message(`${id}: timeout_minutes 要写成大于 0 的数（分钟），收到「${spec.timeout_minutes}」；不写就是 60 分钟`, `${id}: timeout_minutes must be positive; got ${spec.timeout_minutes}. Default: 60 minutes`));
  }
  // Optional (C-4, 2026-10-11): when this role's sessions are compacted, per backend, in place of the
  // default in presets.json. A malformed one would be passed to a CLI as a flag value, so it is refused here.
  const compactProblem = checkCompact(spec.compact, `${id}: compact`);
  if (compactProblem) failures.push(message(`${compactProblem}（正整数；grok 是窗口的百分比 1 到 100；deepseek 是留给压缩的余量 token 数）`, `${compactProblem} (positive integer; grok: window percentage 1–100; deepseek: tokens reserved for compaction)`));
  // Optional (R-7, 2026-10-24): a note appended to the prompt only on one backend. A key the runtime does
  // not know would be handed to nobody, and a value that is not text would reach the prompt as something
  // else, so both are refused here.
  if (spec.backend_notes !== undefined) {
    const notes = spec.backend_notes;
    if (typeof notes !== 'object' || notes === null || Array.isArray(notes)) {
      failures.push(message(`${id}: backend_notes 要写成对象（后端 → 说明），收到「${JSON.stringify(notes)}」`, `${id}: backend_notes must be an object mapping backends to notes; got ${JSON.stringify(notes)}`));
    } else {
      for (const [kind, note] of Object.entries(notes)) {
        if (!KINDS.includes(kind)) {
          failures.push(message(`${id}: backend_notes 里的后端「${kind}」不认得（只能是 ${KINDS.join(' / ')}）`, `${id}: unknown backend ${kind} in backend_notes; expected ${KINDS.join(' / ')}`));
          continue;
        }
        if (typeof note !== 'string' || !note.trim()) {
          failures.push(message(`${id}: backend_notes.${kind} 要写成非空的字符串（只有落在 ${kind} 上的那一单才拼进提示），收到「${JSON.stringify(note)}」`, `${id}: backend_notes.${kind} must be a nonempty string, included only for ${kind} runs; got ${JSON.stringify(note)}`));
        }
      }
    }
  }
  // Optional: the traces this role's contract makes normal, left out of the difficulty ledger
  // (expected-traces.mjs). A malformed rule is refused rather than left to match nothing or too much.
  failures.push(...checkExpectedTraces(id, spec.expected_traces).map(expectedTraceProblem));

  // The runtime placeholder, and no machine path in the spec: hardcoding a host path is exactly what
  // this change removed from roles.json, and this gate is what keeps it removed.
  const spawnArgs = Array.isArray(spec?.spawn?.args) ? spec.spawn.args : [];
  if (!spawnArgs.includes(RUNTIME_PLACEHOLDER)) {
    failures.push(message(`${id}: spawn.args 里没有 ${RUNTIME_PLACEHOLDER} 占位符（运行时路径不能写死在 roles.json 里）`, `${id}: spawn.args is missing ${RUNTIME_PLACEHOLDER}; do not hardcode the runtime path in roles.json`));
  }
  const machinePath = spawnArgs.find((arg) => typeof arg === 'string' && /^[A-Za-z]:[\\/]|^\/Users\//.test(arg));
  if (machinePath) {
    failures.push(message(`${id}: spawn.args 里写了机器绝对路径「${machinePath}」——换成 ${RUNTIME_PLACEHOLDER} 或相对路径`, `${id}: spawn.args contains machine-specific absolute path ${machinePath}; use ${RUNTIME_PLACEHOLDER} or a relative path`));
  }

  const tools = toolsFromSpec(spec);
  if (tools === null || tools.length === 0) {
    failures.push(message(`${id}: spawn.args 里没有可核对的 ${TOOLS_FLAG} 工具白名单`, `${id}: spawn.args is missing a verifiable ${TOOLS_FLAG} tool allowlist`));
    return;
  }

  if (!Array.isArray(spec.grant)) {
    failures.push(message(`${id}: roles.json 没记 grant`, `${id}: roles.json is missing grant`));
  } else {
    const covered = new Set();
    for (const capability of spec.grant) {
      const mapped = CAPABILITY_TOOLS[capability];
      if (!mapped) {
        failures.push(
          message(`${id}: grant 里的能力名「${capability}」没有映射（认得的只有 ${Object.keys(CAPABILITY_TOOLS).join(' / ')}）`, `${id}: unmapped grant capability ${capability}; expected ${Object.keys(CAPABILITY_TOOLS).join(' / ')}`)
        );
        continue;
      }
      const missing = mapped.filter((tool) => !tools.includes(tool));
      if (missing.length) {
        failures.push(
          message(`${id}: grant 声明「${capability}」，但工具白名单（${tools.join(',')}）里没有 ${missing.join('、')}`, `${id}: grant declares ${capability}, but tool allowlist (${tools.join(',')}) is missing ${missing.join(', ')}`)
        );
      }
      for (const tool of mapped) covered.add(tool);
    }
    const extra = tools.filter((tool) => !covered.has(tool));
    if (extra.length) {
      failures.push(
        message(`${id}: 工具白名单里有 ${extra.join('、')}，而 grant（${spec.grant.join(' / ')}）没有覆盖它——能力比声明的多`, `${id}: tool allowlist contains ${extra.join(', ')} outside grant (${spec.grant.join(' / ')}); capabilities exceed the declaration`)
      );
    }
  }

  // deny_intent is a list of capability names (the grant vocabulary, plus `delegate`). Anything else is a
  // typo that would deny nothing: a role whose "no writing" is spelled `wirte` would pass the tool check
  // below with a boundary nobody declared, so an unknown name is refused rather than read as a tool name.
  if (spec.deny_intent !== undefined && !Array.isArray(spec.deny_intent)) {
    failures.push(message(`${id}: deny_intent 要写成能力名的数组，收到「${spec.deny_intent}」`, `${id}: deny_intent must be an array of capability names; got ${spec.deny_intent}`));
  }
  const deny = Array.isArray(spec.deny_intent) ? spec.deny_intent : [];
  const knownIntents = [...Object.keys(CAPABILITY_TOOLS), ...Object.keys(DENY_TOOLS)];
  for (const capability of deny) {
    if (!knownIntents.includes(capability)) {
      failures.push(message(`${id}: deny_intent 里的能力名「${capability}」不认得（认得的只有 ${knownIntents.join(' / ')}）`, `${id}: unknown deny_intent capability ${capability}; expected ${knownIntents.join(' / ')}`));
      continue;
    }
    // A capability both granted and denied is a spec that contradicts itself, whatever the whitelist says.
    if (Array.isArray(spec.grant) && spec.grant.includes(capability)) {
      failures.push(message(`${id}: 「${capability}」既在 grant 里又在 deny_intent 里，规格自相矛盾`, `${id}: ${capability} appears in both grant and deny_intent; contradictory specification`));
      continue;
    }
    // A denied capability is read with the same vocabulary grant is: `write` means edit/write, so a
    // whitelist that hands the role only `edit` is still a breach. `delegate` is the exception with
    // no tool of its own (DENY_TOOLS names the subagent tools it stands for).
    const denied = CAPABILITY_TOOLS[capability] ?? DENY_TOOLS[capability];
    const hit = denied.filter((tool) => tools.includes(tool));
    if (hit.length) {
      failures.push(message(`${id}: deny_intent 声明「${capability}」，工具白名单却给了 ${hit.join('、')}`, `${id}: deny_intent forbids ${capability}, but the tool allowlist grants ${hit.join(', ')}`));
    }
  }
}

function okLine(id, spec) {
  return message(
    `契约通过：${id} ${spec.contract} v${spec.contract_version} 档位=${spec.tier} 权限=${spec.grant.join('/')} 工具=${toolsFromSpec(spec).join(',')}`,
    `contract ok: ${id} ${spec.contract} v${spec.contract_version} tier=${spec.tier} grant=${spec.grant.join('/')} tools=${toolsFromSpec(spec).join(',')}`,
  );
}

// Reads roles.json and checks every role from scratch: this is the daemon's startup gate, so it
// runs before the port is bound and before anything is spawned.
export function checkRoleSpecs() {
  let roles;
  try {
    roles = JSON.parse(fs.readFileSync(ROLES_FILE, 'utf8'));
  } catch (err) {
    return { roles: [], ok: [], warnings: [], failures: [message(`roles.json 读不动：${err.message}`, `Could not read roles.json: ${err.message}`)] };
  }
  const failures = [];
  const warnings = [];
  const ok = [];
  // Subscription CLIs work without pi; only the metered fallback needs this optional runtime.
  const { runtime, source } = resolveRuntime();
  if (!fs.existsSync(runtime)) {
    warnings.push(
      message(`按量兜底执行器 pi 未安装：${runtime}（来源：${source}）；已登录 Codex / Claude Code / Antigravity / Grok 时可直接使用。需 DeepSeek 按量兜底时再安装 @earendil-works/pi-coding-agent@1.5.2 或配置 .runtime.json。`, `Optional metered fallback pi is not installed: ${runtime} (source: ${source}). Signed-in Codex / Claude Code / Antigravity / Grok can be used directly. For DeepSeek fallback, install @earendil-works/pi-coding-agent@1.5.2 or configure .runtime.json.`)
    );
  }
  for (const [id, spec] of Object.entries(roles)) {
    const before = failures.length;
    contractCheck(id, spec, failures);
    boundaryCheck(id, spec, failures);
    if (failures.length === before) ok.push(okLine(id, spec));
  }
  // Two posts claiming to be the refiner would leave the skill loop to guess which one to dispatch.
  const refiners = Object.entries(roles).filter(([, spec]) => spec?.skill_refiner === true).map(([id]) => id);
  if (refiners.length > 1) {
    failures.push(message(`roles.json 里有 ${refiners.length} 个岗位标了 skill_refiner（${refiners.join('、')}）：只能有一个，其余的去掉这个字段`, `roles.json declares ${refiners.length} skill_refiner roles (${refiners.join(', ')}); only one is permitted`));
  }
  return { roles: Object.keys(roles), ok, failures, warnings, runtime, runtimeSource: source };
}

export function assertRoleSpecs() {
  const report = checkRoleSpecs();
  if (report.failures.length) {
    const err = new Error(
      message(`岗位规格核对失败，拒绝启动（${report.failures.length} 处）：\n`, `Role contract check failed; refusing startup (${report.failures.length} issue(s)):\n`) +
        report.failures.map((failure) => `  - ${failure}`).join('\n') +
        message('\n修 roles.json / roles/<role>.md / roles/<role>.VERSION 再启动；本服务不静默降级。', '\nFix roles.json / roles/<role>.md / roles/<role>.VERSION before restarting; the service does not silently degrade.')
    );
    err.failures = report.failures;
    throw err;
  }
  return report;
}

// Runnable on its own for a read-only look at the same gate the daemon applies at startup:
// `node src/role-contract.mjs` prints one line per role and exits non-zero on any mismatch.
// Node resolves symlinks and junctions in the main module's URL but leaves process.argv[1] as typed, so
// comparing them bare made `node <junction>/src/role-contract.mjs` print nothing and exit 0: a gate that
// passes by not running (2026-09-30 review). Both sides go through realpath.
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
  const report = checkRoleSpecs();
  for (const line of report.ok) console.log(line);
  for (const warning of report.warnings) console.error(`warning: ${warning}`);
  for (const failure of report.failures) console.error(`- ${failure}`);
  if (report.failures.length) process.exit(1);
  console.log(message(`role 契约全部通过：共 ${report.roles.length} 个`, `role contracts ok: ${report.roles.length} role(s)`));
  console.log(message(`runtime: ${report.runtime}（来源：${report.runtimeSource}）`, `runtime: ${report.runtime} (source: ${report.runtimeSource})`));
}
