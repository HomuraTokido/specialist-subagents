import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, it } from 'node:test';
import { agyArgs, agyDispatchProblem, agyUnattended, claudeArgs, claudeModel, codexCompactArgs, codexDispatchArgs, dispatchServer, grokEnv, sessionTurns, withBackendNote } from '../src/cli-runner.mjs';
import { LEAD_TOOLS } from '../src/lead-tools.mjs';
import { DEFAULT_COMPACT, DEFAULT_CONTEXT_TOKENS, KINDS, checkCompact, checkSettings, compactFor, healthDbFile, loadSettings, planFor, readBackendHealth, readLatestCodexQuota, recordBackendOutcome, withAllKinds } from '../src/presets.mjs';
import { sessionKind } from '../src/session-kind.mjs';
import { FAKE_PI_CLI, REPO, isolatedEnv, startService, tempDir } from './lib/sandbox.mjs';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

await describe('compaction', { concurrency: false }, async () => {
// [C-4] Compaction late and configurable: the threshold each backend compacts at is the latest it allows
// unless the role says otherwise, and it reaches the process the service really starts. Codex, DeepSeek
// and the settings go through the real service on the fakes; Claude's and Grok's launchers have no fake
// to run, so the pure functions that build their arguments and environment are tested directly.








const readLog = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []);
const rolesOf = () => Object.keys(JSON.parse(fs.readFileSync(path.join(REPO, 'roles.json'), 'utf8')));
const presetsOf = () => JSON.parse(fs.readFileSync(path.join(REPO, 'presets.json'), 'utf8'));

// Edit one role's spec in the sandbox copy of roles.json.
const editRole = (id, edit) => (root) => {
  const file = path.join(root, 'roles.json');
  const roles = JSON.parse(fs.readFileSync(file, 'utf8'));
  edit(roles[id]);
  fs.writeFileSync(file, JSON.stringify(roles, null, 2));
};

describe('the settings carry the windows and the thresholds', () => {
  it('[C-4] presets.json gives every level its window and every backend its default threshold', () => {
    const settings = loadSettings(REPO, rolesOf());
    for (const [kind, window] of Object.entries({ codex: 272000, grok: 256000, claude: 1000000, deepseek: 1000000 })) {
      for (const level of ['standard', 'max']) assert.equal(settings.levels[kind][level].context_tokens, window, `${kind} ${level}`);
    }
    assert.deepEqual(settings.compact, { codex: 784800, claude: 1000000, deepseek: 16384, grok: 100 });
    assert.deepEqual(presetsOf().compact, settings.compact, 'written in the file, not only filled in');
  });

  it('[C-4] an old settings file without them stays valid, and the defaults fill in', () => {
    const old = presetsOf();
    delete old.compact;
    for (const kind of Object.keys(old.levels)) for (const level of Object.keys(old.levels[kind])) delete old.levels[kind][level].context_tokens;
    const checked = checkSettings(old, rolesOf());
    assert.equal(checked.error, undefined);
    assert.deepEqual(checked.value.compact, DEFAULT_COMPACT);
    assert.equal(checked.value.levels.codex.standard.context_tokens, DEFAULT_CONTEXT_TOKENS.codex);
    // A saved file with only part of `compact` keeps the rest of the defaults.
    const partial = checkSettings({ ...presetsOf(), compact: { codex: 500000 } }, rolesOf());
    assert.deepEqual(partial.value.compact, { ...DEFAULT_COMPACT, codex: 500000 });
  });

  it('[C-4] refuses a threshold that is not a positive integer, a percent over 100, or a backend nobody knows', () => {
    const bad = (compact) => checkSettings({ ...presetsOf(), compact }, rolesOf()).error;
    assert.match(bad({ codex: 0 }), /compact\.codex must be a positive integer/);
    assert.match(bad({ claude: -5 }), /compact\.claude must be a positive integer/);
    assert.match(bad({ deepseek: 1.5 }), /compact\.deepseek must be a positive integer/);
    assert.match(bad({ codex: '784800' }), /compact\.codex must be a positive integer/);
    assert.match(bad({ grok: 101 }), /compact\.grok.*between 1 and 100/);
    assert.match(bad({ grok: 0 }), /compact\.grok must be a positive integer/);
    assert.match(bad({ gemini: 5 }), /compact\.gemini is not a backend/);
    assert.match(bad([1]), /compact must be an object/);
    assert.equal(bad({ grok: 100, codex: 1 }), undefined, '100 percent and a small token count are fine');
    const levels = presetsOf();
    levels.levels.codex.standard.context_tokens = 0;
    assert.match(checkSettings(levels, rolesOf()).error, /levels\.codex\.standard\.context_tokens must be a positive integer/);
    assert.equal(checkCompact(undefined, 'x'), null);
  });

  it('[C-4] a role\'s own threshold wins over the default, backend by backend', () => {
    const settings = loadSettings(REPO, rolesOf());
    const spec = { compact: { codex: 300000, grok: 80 } };
    assert.equal(compactFor(settings, spec, 'codex'), 300000);
    assert.equal(compactFor(settings, spec, 'grok'), 80);
    assert.equal(compactFor(settings, spec, 'claude'), 1000000, 'not mentioned: the default');
    assert.equal(compactFor(settings, undefined, 'deepseek'), 16384);
  });

  it('[C-4] the startup gate refuses a role compact that is malformed, and ships none of its own', async () => {
    const roles = JSON.parse(fs.readFileSync(path.join(REPO, 'roles.json'), 'utf8'));
    for (const [id, spec] of Object.entries(roles)) assert.equal(spec.compact, undefined, `${id} ships no override`);
    await assert.rejects(startService({ prepare: editRole('coder', (spec) => { spec.compact = { codex: 0 }; }) }), /coder: compact\.codex must be a positive integer/);
    await assert.rejects(startService({ prepare: editRole('coder', (spec) => { spec.compact = { grok: 150 }; }) }), /coder: compact\.grok.*between 1 and 100/);
    await assert.rejects(startService({ prepare: editRole('coder', (spec) => { spec.compact = 5; }) }), /coder: compact must be an object/);
  });
});

describe('the launchers carry the threshold', () => {
  it('[C-4] Codex: -c model_auto_compact_token_limit, and the larger window when the limit passes 0.9 of the default one', () => {
    assert.deepEqual(codexCompactArgs(784800), ['-c', 'model_auto_compact_token_limit=784800', '-c', 'model_context_window=872000']);
    assert.deepEqual(codexCompactArgs(244800), ['-c', 'model_auto_compact_token_limit=244800'], 'exactly 0.9 of 272000 needs no larger window');
    assert.deepEqual(codexCompactArgs(244801), ['-c', 'model_auto_compact_token_limit=244801', '-c', 'model_context_window=872000']);
    assert.deepEqual(codexCompactArgs(100000), ['-c', 'model_auto_compact_token_limit=100000']);
    assert.deepEqual(codexCompactArgs(undefined), []);
  });

  it('[C-4] Claude: --autocompact <tokens> in the argument list, the rest of the list as it was', () => {
    const args = claudeArgs({ model: 'sonnet', effort: 'high', tools: 'Read,Bash', resumeId: 'abc', compact: 1000000 });
    const at = args.indexOf('--autocompact');
    assert.ok(at > 0);
    assert.equal(args[at + 1], '1000000');
    assert.deepEqual(args.slice(0, 3), ['-p', '--model', 'sonnet']);
    assert.deepEqual(args.slice(args.indexOf('--effort'), args.indexOf('--effort') + 2), ['--effort', 'high']);
    assert.deepEqual(args.slice(-2), ['--resume', 'abc']);
    assert.ok(args.includes('--safe-mode') && args.includes('--restricted') && args.includes('--strict-mcp-config'));
    assert.equal(claudeArgs({ model: 'sonnet', tools: 'Read' }).includes('--autocompact'), false, 'no setting, no flag');
    assert.equal(claudeArgs({ model: 'sonnet', tools: 'Read', compact: 600000 })[claudeArgs({ model: 'sonnet', tools: 'Read', compact: 600000 }).indexOf('--autocompact') + 1], '600000');
  });

  it('[G-1] Claude: the usage line names the model this run asked for, not the session\'s first one', () => {
    assert.equal(claudeModel(['claude-opus-5-5', 'claude-sonnet-5-5'], 'sonnet'), 'claude-sonnet-5-5', 'resumed with sonnet after an opus run');
    assert.equal(claudeModel(['claude-sonnet-5-5', 'claude-opus-5-5'], 'opus'), 'claude-opus-5-5');
    assert.equal(claudeModel(['claude-sonnet-5-5'], 'claude-sonnet-5-5'), 'claude-sonnet-5-5', 'a full id as well as an alias');
    assert.equal(claudeModel([], 'sonnet'), 'sonnet', 'no keys: the alias');
  });

  it('[C-4] Grok: GROK_AUTO_COMPACT_THRESHOLD_PERCENT in its environment, the rest of the environment kept', () => {
    const env = grokEnv({ PATH: '/bin', HOME: '/h' }, 100);
    assert.equal(env.GROK_AUTO_COMPACT_THRESHOLD_PERCENT, '100');
    assert.equal(env.PATH, '/bin');
    assert.equal(grokEnv({ PATH: '/bin' }, 80).GROK_AUTO_COMPACT_THRESHOLD_PERCENT, '80');
    assert.equal('GROK_AUTO_COMPACT_THRESHOLD_PERCENT' in grokEnv({ PATH: '/bin' }, undefined), false);
  });
});

// 2026-10-21: Antigravity CLI (`agy`) joined as the fifth backend, before DeepSeek.
describe('the Antigravity backend', () => {
  it('a saved order from before it gets it in front of deepseek instead of losing the whole file', () => {
    assert.deepEqual(withAllKinds(['grok', 'codex', 'claude', 'deepseek']), ['grok', 'codex', 'claude', 'antigravity', 'deepseek']);
    assert.deepEqual(withAllKinds(['codex', 'grok', 'claude']), ['codex', 'grok', 'claude', 'antigravity'], 'no deepseek: appended, the check then refuses');
    assert.deepEqual(withAllKinds([...KINDS]), KINDS, 'a full order is left alone');
    const saved = { ...presetsOf(), order: withAllKinds(['codex', 'grok', 'claude', 'deepseek']) };
    assert.equal(checkSettings(saved, rolesOf()).error, undefined);
    assert.equal(presetsOf().order.at(-2), 'antigravity', 'presets.json lists it right before deepseek');
  });

  it('its transcript is recognised by path and read as a conversation', () => {
    const dir = tempDir('ssa-agy-');
    const id = 'aefb827f-ab92-4721-a07f-5b5628be8dce';
    const file = path.join(dir, 'brain', id, '.system_generated', 'logs', 'transcript.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const lines = [
      { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', content: '<USER_REQUEST>\n读 note.txt\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\ntime\n</ADDITIONAL_METADATA>' },
      { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', tool_calls: [{ name: 'read_file' }] },
      { step_index: 2, source: 'MODEL', type: 'GENERIC', content: '1: the secret word is pelican' },
      { step_index: 3, source: 'SYSTEM', type: 'SYSTEM_MESSAGE', content: 'subagents stopped' },
      { step_index: 4, source: 'MODEL', type: 'PLANNER_RESPONSE', content: 'pelican' },
    ];
    fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n'));
    assert.deepEqual(sessionKind(file), { kind: 'antigravity', id });
    assert.deepEqual(sessionTurns(file), [
      { role: 'user', text: '读 note.txt' },
      { role: 'tool', text: '1: the secret word is pelican' },
      { role: 'assistant', text: 'pelican' },
    ]);
    assert.equal(sessionKind(path.join(dir, 'projects', 'x', `${id}.jsonl`)).kind, 'claude', 'Claude\'s files still read as Claude\'s');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('the prompt goes on stdin, a role that writes or runs commands skips approval inside the sandbox, a resume names the conversation', () => {
    const readOnly = agyArgs({ model: 'gemini-4-argon-medium' });
    assert.deepEqual(readOnly.slice(0, 5), ['--input-format', 'stream-json', '--output-format', 'stream-json', '--disable-slash-commands']);
    assert.ok(!readOnly.includes('-p') && !readOnly.includes('--print'), 'no prompt on the command line');
    assert.equal(readOnly.includes('--dangerously-skip-permissions'), false);
    assert.equal(agyUnattended(['read', 'grep', 'find', 'ls']), false, 'explorer');
    assert.equal(agyUnattended(['read', 'grep', 'find', 'ls', 'bash']), true, 'tester and web_researcher: commands need it too');
    assert.equal(agyUnattended(['read', 'grep', 'find', 'ls', 'edit', 'write']), true, 'librarian');
    const writing = agyArgs({ model: 'gemini-4-argon-high', effort: 'high', unattended: true, resumeId: 'c1' });
    assert.ok(writing.includes('--dangerously-skip-permissions'));
    assert.equal(writing.includes('--sandbox'), false, 'agy\'s sandbox refused node.exe and did not keep writes in the directory');
    assert.deepEqual(writing.slice(writing.indexOf('--effort'), writing.indexOf('--effort') + 2), ['--effort', 'high']);
    assert.deepEqual(writing.slice(-2), ['--conversation', 'c1']);
  });
});

// 2026-10-21 (R-6): the Lead role runs on three backends only, and gets this service's MCP server.
describe('[R-6] the Lead role', () => {
  it('[R-6] walks only its own backends, in its own order, and never falls to Grok or DeepSeek', () => {
    const roles = JSON.parse(fs.readFileSync(path.join(REPO, 'roles.json'), 'utf8'));
    assert.deepEqual(roles.leader.backends, ['claude', 'codex', 'antigravity']);
    assert.equal(roles.leader.grant.includes('dispatch'), true);
    const settings = loadSettings(REPO, rolesOf());
    const chainOf = (choice) => planFor('leader', settings, choice, { backends: roles.leader.backends }).chain.map((step) => step.kind);
    assert.deepEqual(chainOf({ mode: 'best', max: false }), ['claude', 'codex', 'antigravity']);
    assert.deepEqual(chainOf({ mode: 'codex', max: false }), ['codex', 'claude', 'antigravity']);
    const outside = planFor('leader', settings, { mode: 'deepseek', max: false }, { backends: roles.leader.backends });
    assert.deepEqual(outside.chain.map((step) => step.kind), ['claude', 'codex', 'antigravity']);
    assert.match(outside.notes[0], /excluding DeepSeek/);
    assert.equal(planFor('coder', settings, { mode: 'best', max: false }).chain.at(-1).kind, 'deepseek', 'other roles keep the full chain');
  });

  it('[R-6] Claude gets the one MCP server and its tools allowed; Codex gets it as config keys; others get nothing', () => {
    const server = dispatchServer('seat-leader-1');
    assert.deepEqual(server.env, { SPECIALIST_CALLER_SEAT: 'seat-leader-1', SPECIALIST_CALLER_DISPATCH: '1' });
    const args = claudeArgs({ model: 'opus', tools: 'Read,Grep,Glob', dispatch: server });
    const config = JSON.parse(args[args.indexOf('--mcp-config') + 1]);
    assert.deepEqual(Object.keys(config.mcpServers), ['specialist-subagents']);
    assert.equal(args.includes('--strict-mcp-config'), true, 'every other server stays out');
    assert.equal(args.includes('--safe-mode'), false, '--safe-mode would turn the --mcp-config server off too');
    assert.equal(args[args.indexOf('--setting-sources') + 1], '', 'no user, project or local settings in its place');
    assert.equal(args[args.indexOf('--allowedTools') + 1], 'Read,Grep,Glob,mcp__specialist-subagents');
    const plain = claudeArgs({ model: 'sonnet', tools: 'Read' });
    assert.equal(plain.includes('--mcp-config'), false);
    assert.equal(plain.includes('--safe-mode'), true);
    assert.equal(plain[plain.indexOf('--allowedTools') + 1], 'Read');
    const codex = codexDispatchArgs(server).filter((arg) => arg !== '-c');
    assert.match(codex[0], /^mcp_servers\.specialist_subagents\.command="/);
    assert.match(codex[1], /^mcp_servers\.specialist_subagents\.args=\[".*mcp-stdio\.mjs"\]$/);
    assert.equal(codex[2], 'mcp_servers.specialist_subagents.env={ SPECIALIST_CALLER_SEAT = "seat-leader-1", SPECIALIST_CALLER_DISPATCH = "1" }');
    assert.equal(codex[3], 'mcp_servers.specialist_subagents.default_tools_approval_mode="approve"', 'approval_policy never would refuse the calls otherwise');
  });

  it('[R-6] Antigravity: a Lead runs only with the server registered and every Lead tool granted', () => {
    const home = tempDir('ssa-agy-home-');
    const dir = path.join(home, '.gemini', 'config');
    fs.mkdirSync(dir, { recursive: true });
    assert.match(agyDispatchProblem(home), /has no specialist-subagents MCP server/);
    fs.writeFileSync(path.join(dir, 'mcp_config.json'), JSON.stringify({ mcpServers: { 'specialist-subagents': { command: 'node' } } }));
    const grants = LEAD_TOOLS.map((tool) => `mcp(specialist-subagents/${tool})`);
    const write = (allow) => fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ userSettings: { globalPermissionGrants: { allow } } }));
    write(['command(Get-Item)', ...grants.slice(1)]);
    const problem = agyDispatchProblem(home);
    assert.match(problem, /missing userSettings\.globalPermissionGrants\.allow entries: mcp\(specialist-subagents\/seat_start\)\./, 'names the grant that is missing');
    assert.doesNotMatch(problem, /task_wait/, 'and only that one');
    assert.equal(agyDispatchProblem(home, true), null, 'a writing Lead runs with --dangerously-skip-permissions, which approves the calls');
    write(['command(Get-Item)', ...grants]);
    assert.equal(agyDispatchProblem(home), null);
    fs.rmSync(home, { recursive: true, force: true });
  });
});

// 2026-10-24 (R-7): a role may write a note per backend in roles.json, and only the backend this run lands
// on gets it. cli-runner reads the note for the current backend and puts it in front of the prompt with
// withBackendNote; these are the cases that decide what the prompt then holds.
describe('[R-7] the note a backend gets', () => {
  const roles = JSON.parse(fs.readFileSync(path.join(REPO, 'roles.json'), 'utf8'));
  // What cli-runner computes for one backend: its note, trimmed, or '' when the role has none for it.
  const noteFor = (role, kind) => roles[role]?.backend_notes?.[kind]?.trim() || '';
  const task = '任务：\n查一下搜索接口';

  it('[R-7] web_researcher on Antigravity gets its note, on Claude it gets none of it', () => {
    const onAgy = withBackendNote(noteFor('web_researcher', 'antigravity'), task);
    assert.match(onAgy, /search_web/);
    assert.ok(onAgy.endsWith(task), 'the note goes in front, the task itself unchanged');
    assert.equal(withBackendNote(noteFor('web_researcher', 'claude'), task), task, 'another backend reads none of it');
    assert.equal(withBackendNote(noteFor('coder', 'antigravity'), task), task, 'a role that wrote no notes is untouched');
  });

  it('[R-7] a resumed session gets it too, since it may have been opened before the note was written', () => {
    const resume = `（服务消息）这是续接的提示\n\n---\n\n${task}`;
    const onAgy = withBackendNote(noteFor('web_researcher', 'antigravity'), resume);
    assert.match(onAgy, /search_web/);
    assert.ok(onAgy.endsWith(resume), 'the resume prompt itself is left as it was');
    assert.equal(withBackendNote(noteFor('web_researcher', 'claude'), resume), resume);
  });
});

describe('the threshold reaches the process the service starts', () => {
  const services = [];
  const dirs = [];
  afterEach(async () => {
    while (services.length) await services.pop().stop();
    while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  // One coder run to its end on the service; the backend is the one the choice names.
  async function oneRun({ mode, env = {}, prepare = null }) {
    const scratch = tempDir('ssa-compact-');
    dirs.push(scratch);
    const work = path.join(scratch, 'work');
    fs.mkdirSync(work);
    const piCalls = path.join(scratch, 'pi-calls.jsonl');
    const service = await startService({
      env: { SPECIALIST_SUBAGENTS_RUNTIME: FAKE_PI_CLI, FAKE_PI_CALLS: piCalls, ...env },
      prepare: async (root) => {
        fs.mkdirSync(path.join(root, '.data'), { recursive: true });
        fs.writeFileSync(path.join(root, '.data', 'backend-prefer.json'), JSON.stringify({ mode, max: false }));
        if (prepare) await prepare(root);
      },
    });
    services.push(service);
    const started = await service.call('POST', '/seat/start', { role: 'coder', task: '干活', cwd: work });
    assert.equal(started.status, 200, started.text);
    const done = await service.waitSeat(started.json.seat);
    assert.equal(done.seat.state, 'done', service.log());
    return { codexCalls: readLog(service.env.FAKE_CODEX_CALLS), piCalls: readLog(piCalls) };
  }
  const flag = (args, key) => args.find((arg) => typeof arg === 'string' && arg.startsWith(`${key}=`));

  it('[C-4] Codex gets the latest threshold the backend allows, with the larger window', async () => {
    const { codexCalls } = await oneRun({ mode: 'codex' });
    assert.ok(codexCalls.length >= 1);
    for (const call of codexCalls) {
      assert.equal(flag(call.args, 'model_auto_compact_token_limit'), 'model_auto_compact_token_limit=784800');
      assert.equal(flag(call.args, 'model_context_window'), 'model_context_window=872000');
    }
  });

  it('[C-4] Codex gets the role\'s own threshold when roles.json sets one, and no larger window for a low one', async () => {
    const { codexCalls } = await oneRun({ mode: 'codex', prepare: editRole('coder', (spec) => { spec.compact = { codex: 200000 }; }) });
    assert.ok(codexCalls.length >= 1);
    for (const call of codexCalls) {
      assert.equal(flag(call.args, 'model_auto_compact_token_limit'), 'model_auto_compact_token_limit=200000');
      assert.equal(flag(call.args, 'model_context_window'), undefined);
    }
  });

  it('[C-4] the settings page\'s saved threshold (.data/presets.json) is honoured', async () => {
    const { codexCalls } = await oneRun({
      mode: 'codex',
      prepare: (root) => fs.writeFileSync(path.join(root, '.data', 'presets.json'), JSON.stringify({ ...presetsOf(), compact: { ...DEFAULT_COMPACT, codex: 500000 } })),
    });
    assert.equal(flag(codexCalls[0].args, 'model_auto_compact_token_limit'), 'model_auto_compact_token_limit=500000');
  });

  it('[C-4] DeepSeek: seat-runner opens the session with the reserve, and keeps its other settings', async () => {
    const { piCalls } = await oneRun({ mode: 'deepseek' });
    assert.ok(piCalls.length >= 1);
    for (const call of piCalls) {
      assert.deepEqual(call.settings, { compaction: { enabled: true, reserveTokens: 16384 }, retry: { enabled: true, maxRetries: 2 } });
    }
  });

  it('[C-4] DeepSeek: the role\'s own reserve reaches seat-runner', async () => {
    const { piCalls } = await oneRun({ mode: 'deepseek', prepare: editRole('coder', (spec) => { spec.compact = { deepseek: 50000 }; }) });
    assert.ok(piCalls.length >= 1);
    for (const call of piCalls) assert.equal(call.settings.compaction.reserveTokens, 50000);
  });
});
});

await describe('startup-gate', { concurrency: false }, async () => {
// R-3: the startup gate refuses a role whose declared boundary part ways with what it runs with.
// Each case edits roles.json in a throwaway copy of the service and expects the daemon not to come up,
// naming the role and what is wrong (the refusal is the whole point: no port bound, nothing served).






// Edit one role's spec in the sandbox copy of roles.json.
const editRole = (id, edit) => (root) => {
  const file = path.join(root, 'roles.json');
  const roles = JSON.parse(fs.readFileSync(file, 'utf8'));
  edit(roles[id]);
  fs.writeFileSync(file, JSON.stringify(roles, null, 2));
};

// Change the --tools whitelist of a role's spawn args.
const withTools = (spec, edit) => {
  const at = spec.spawn.args.indexOf('--tools');
  spec.spawn.args[at + 1] = edit(spec.spawn.args[at + 1].split(',')).join(',');
};

const refused = (id, edit, pattern) => assert.rejects(startService({ prepare: editRole(id, edit) }), pattern);

describe('the startup gate refuses a boundary that does not match the role', () => {
  it('[R-3] a whitelist tool that grant does not cover', async () => {
    await refused('explorer', (spec) => withTools(spec, (tools) => [...tools, 'edit']), /explorer: tool allowlist contains edit.*capabilities exceed the declaration/s);
  });

  it('[R-3] a granted capability whose tool is missing from the whitelist', async () => {
    await refused('explorer', (spec) => withTools(spec, (tools) => tools.filter((tool) => tool !== 'find')), /explorer: grant declares read, but tool allowlist .* is missing find/s);
  });

  it('[R-3] a deny_intent that contradicts grant', async () => {
    await refused('coder', (spec) => { spec.deny_intent = ['delegate', 'write']; }, /coder: .*write.*(appears in both grant and deny_intent|deny_intent forbids write)/s);
  });

  it('[R-3] a deny_intent that names an intent nobody knows', async () => {
    await refused('explorer', (spec) => { spec.deny_intent = ['delegate', 'wirte']; }, /explorer: unknown deny_intent capability wirte/);
  });

  it('[R-3] an expert_by that is neither "domain" nor absent', async () => {
    await refused('explorer', (spec) => { spec.expert_by = 'dir'; }, /explorer: expert_by must be.*got dir/s);
  });

  it('[R-7] backend_notes that is not an object, names an unknown backend, or holds an empty note', async () => {
    await refused('web_researcher', (spec) => { spec.backend_notes = ['antigravity']; }, /web_researcher: backend_notes must be an object/);
    await refused('web_researcher', (spec) => { spec.backend_notes = { gemini: '用 gemini 的搜索' }; }, /web_researcher: unknown backend gemini in backend_notes/);
    await refused('web_researcher', (spec) => { spec.backend_notes = { antigravity: '   ' }; }, /web_researcher: backend_notes\.antigravity must be a nonempty string/);
    await refused('web_researcher', (spec) => { spec.backend_notes = { antigravity: 5 }; }, /web_researcher: backend_notes\.antigravity must be a nonempty string/);
  });

  it('[R-7] a note for a known backend passes the gate, and the shipped roles.json keeps its own', async () => {
    const service = await startService({ prepare: editRole('web_researcher', (spec) => { spec.backend_notes = { antigravity: '你跑在 Antigravity 上。' }; }) });
    try {
      const { status } = await service.call('GET', '/health');
      assert.equal(status, 200);
    } finally {
      await service.stop();
    }
    const roles = JSON.parse(fs.readFileSync(path.join(REPO, 'roles.json'), 'utf8'));
    assert.match(roles.web_researcher.backend_notes.antigravity, /search_web/);
  });

  it('[R-3] the untouched roles.json passes the same gate', async () => {
    const service = await startService();
    try {
      const { status } = await service.call('GET', '/health');
      assert.equal(status, 200);
    } finally {
      await service.stop();
    }
  });
});
});

await describe('write-boundary', { concurrency: false }, async () => {
// R-4: a seat's edit / write may only land inside its own directory, checked in code. seat-runner
// (src/seat-runner.mjs) registers a tool_call handler through the pi SDK's loadExtensionFromFactory;
// the fake pi SDK runs that handler before each write/edit it is told to emit (FAKE_PI_TOOLS), so
// the real check is exercised here. A refused call comes back as an error whose text starts with 拒绝：
// and shows up in the result file as a `blocked` difficulty (not as an `error`).







function run(tools) {
  const root = tempDir('ssa-wb-');
  const cwd = path.join(root, 'seat');
  fs.mkdirSync(path.join(cwd, 'sub'), { recursive: true });
  const resultFile = path.join(root, 'result.json');
  const env = isolatedEnv(root, { SPECIALIST_SEAT_RESULT: resultFile, SPECIALIST_SEAT_SESSION_DIR: path.join(root, 'sessions'), FAKE_PI_MODE: 'ok', FAKE_PI_CALLS: path.join(root, 'calls.jsonl'), FAKE_PI_TOOLS: JSON.stringify(tools(root)) });
  delete env.SPECIALIST_SEAT_EXPECTED_TRACES;
  delete env.FAKE_PI_BRAIN;
  const res = spawnSync(
    process.execPath,
    [path.join(REPO, 'src', 'seat-runner.mjs'), '--pi', FAKE_PI_CLI, '--provider', 'fake', '--model', 'm', '--tools', 'read,write,edit', '-p', 'TASK'],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env },
  );
  assert.equal(res.status, 0, res.stderr);
  const result = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
  fs.rmSync(root, { recursive: true, force: true });
  return result;
}

const write = (p) => ({ tool: 'write', args: { path: p, content: 'x' }, text: 'ok' });

describe('the write boundary (R-4)', () => {
  it('[R-4] write/edit outside the seat directory are refused with 拒绝：, an edit inside is not', () => {
    const result = run((root) => [write('../outside.txt'), write(path.join(root, 'abs-outside.txt')), { tool: 'edit', args: { path: 'inside.txt' }, text: 'edited' }]);
    const blocked = result.difficulties.filter((d) => d.kind === 'blocked');
    assert.equal(blocked.length, 2, JSON.stringify(result.difficulties));
    assert.deepEqual(blocked.map((d) => d.tool), ['write', 'write']);
    assert.match(blocked[0].detail, /Call #1 .*outside\.txt.*blocked by the write boundary/);
    assert.match(blocked[1].detail, /Call #2 .*abs-outside\.txt.*blocked by the write boundary/);
    assert.equal(result.difficulties.filter((d) => d.kind === 'error').length, 0, 'a refusal is blocked, not error');
    assert.ok(!result.difficulties.some((d) => /inside\.txt/.test(d.detail)), 'the edit inside is not refused');
  });

  it('[R-4] a path that only looks inside through .. is refused', () => {
    const result = run(() => [write('sub/../../x.txt')]);
    assert.deepEqual(result.difficulties.map((d) => d.kind), ['blocked'], JSON.stringify(result.difficulties));
    assert.match(result.difficulties[0].detail, /x\.txt.*blocked by the write boundary/);
  });

  it('[R-4] a path that goes down and comes back inside is allowed', () => {
    const result = run(() => [write('sub/../ok.txt')]);
    assert.deepEqual(result.difficulties, []);
  });
});
});

await describe('backend-health and codex quota regressions', { concurrency: false }, async () => {
  const writeRollout = (file, pct, mtimeMs, { withTimestamp = true } = {}) => {
    const line = JSON.stringify({
      ...(withTimestamp ? { timestamp: new Date(mtimeMs).toISOString() } : {}),
      payload: {
        rate_limits: {
          limit_id: 'codex',
          primary: { used_percent: pct, resets_at: 4_000_000_000 },
          secondary: { used_percent: 10, resets_at: 4_000_000_000 },
        },
      },
    });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${line}\n`);
    const when = new Date(mtimeMs);
    fs.utimesSync(file, when, when);
  };

  it('reads the newest rollout in a date directory even when more than ten files are there', () => {
    const sessionsDir = tempDir('ssa-quota-');
    const day = path.join(sessionsDir, '2026', '11', '14');
    const base = 1_700_000_000_000;
    for (let n = 1; n <= 12; n += 1) {
      const pct = n === 12 ? 99 : 20;
      writeRollout(path.join(day, `rollout-${String(n).padStart(2, '0')}.jsonl`), pct, base + n * 1000);
    }
    try {
      assert.equal(readLatestCodexQuota({ sessionsDir }).fiveHour, 99);
    } finally {
      fs.rmSync(sessionsDir, { recursive: true, force: true });
    }
  });

  it('does not thaw a quota cooldown with a rollout older than the fault, and does thaw with a later one', () => {
    const root = tempDir('ssa-health-');
    const sessionsDir = path.join(root, 'sessions');
    const day = path.join(sessionsDir, '2026', '11', '14');
    try {
      recordBackendOutcome(root, 'codex', { ok: false, worked: false, reason: '429 quota exceeded', nowMs: 2_000_000 });
      writeRollout(path.join(day, 'old.jsonl'), 20, 1_900_000);
      const blocked = readBackendHealth(root, { sessionsDir, nowMs: 2_001_000 });
      assert.equal(blocked.codex.ok, false);
      assert.equal(blocked.codex.until, 2_000_000 + 15 * 60 * 1000);
      writeRollout(path.join(day, 'new.jsonl'), 20, 2_005_000);
      const thawed = readBackendHealth(root, { sessionsDir, nowMs: 2_001_000 });
      assert.equal(thawed.codex.ok, true);
      assert.equal(thawed.codex.until, undefined);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('cools a full weekly window until weeklyResetsAt, not for fifteen minutes', () => {
    const root = tempDir('ssa-weekly-');
    const nowMs = 1_800_000_000_000;
    const weeklyResetsAt = Math.floor((nowMs + 3 * 86400_000) / 1000);
    try {
      recordBackendOutcome(root, 'codex', {
        ok: false,
        worked: false,
        reason: '429 rate limit',
        quota: { fiveHour: 30, weekly: 100, weeklyResetsAt },
        nowMs,
      });
      const saved = readBackendHealth(root, { nowMs: nowMs + 1000 });
      assert.equal(saved.codex.ok, false);
      assert.equal(saved.codex.until, weeklyResetsAt * 1000);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('reads a resumed rollout in an older date directory by its latest mtime', () => {
    const sessionsDir = tempDir('ssa-resumed-quota-');
    const base = 1_700_000_000_000;
    try {
      writeRollout(path.join(sessionsDir, '2026', '11', '10', 'resumed.jsonl'), 42, base + 3000);
      writeRollout(path.join(sessionsDir, '2026', '11', '12', 'old.jsonl'), 91, base + 1000);
      writeRollout(path.join(sessionsDir, '2026', '11', '14', 'old.jsonl'), 91, base + 2000);
      assert.equal(readLatestCodexQuota({ sessionsDir }).fiveHour, 42);
    } finally {
      fs.rmSync(sessionsDir, { recursive: true, force: true });
    }
  });

  it('finds the newest rollout past 2000 files in one directory, and returns null when truncated past maxStats', () => {
    const sessionsDir = tempDir('ssa-2001-quota-');
    const day = path.join(sessionsDir, '2026', '11', '14');
    const base = 1_700_000_000_000;
    try {
      for (let n = 1; n <= 2001; n += 1) {
        const pct = n === 2001 ? 99 : 20;
        writeRollout(path.join(day, `rollout-${String(n).padStart(4, '0')}.jsonl`), pct, base + n * 1000);
      }
      assert.equal(readLatestCodexQuota({ sessionsDir }).fiveHour, 99);
      assert.equal(readLatestCodexQuota({ sessionsDir, maxStats: 2000 }), null);
    } finally {
      fs.rmSync(sessionsDir, { recursive: true, force: true });
    }
  });

  it('does not thaw a cooldown from an untimestamped quota line when unrelated writes update mtime', () => {
    const root = tempDir('ssa-untimestamped-quota-');
    const sessionsDir = path.join(root, 'sessions');
    const file = path.join(sessionsDir, '2026', '11', '14', 'old.jsonl');
    try {
      writeRollout(file, 20, 1_900_000, { withTimestamp: false });
      recordBackendOutcome(root, 'codex', { ok: false, worked: false, reason: '429 quota exceeded', nowMs: 2_000_000 });
      fs.appendFileSync(file, `${JSON.stringify({ payload: { message: 'unrelated write' } })}\n`);
      const when = new Date(2_010_000);
      fs.utimesSync(file, when, when);
      const health = readBackendHealth(root, { sessionsDir, nowMs: 2_001_000 });
      assert.equal(health.codex.ok, false);
      assert.equal(health.codex.until, 2_000_000 + 15 * 60 * 1000);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('updates both backends with active file and SQLite readers without lock or tmp files', () => {
    const root = tempDir('ssa-health-readers-');
    let fd = null;
    let reader = null;
    try {
      assert.equal(recordBackendOutcome(root, 'codex', { ok: true }).updated, true);
      fd = fs.openSync(healthDbFile(root), 'r');
      reader = new DatabaseSync(healthDbFile(root), { readOnly: true });
      reader.exec('BEGIN');
      reader.prepare('SELECT kind, entry_json FROM backend_health').all();
      for (let i = 0; i < 20; i += 1) {
        const result = i % 2 === 0
          ? recordBackendOutcome(root, 'codex', { ok: true })
          : recordBackendOutcome(root, 'grok', { ok: false, worked: false, reason: '401 unauthorized' });
        assert.equal(result.updated, true, JSON.stringify(result));
      }
      assert.deepEqual(fs.readdirSync(path.join(root, '.data')).filter((name) => /\.(tmp|lock)$/.test(name)), []);
      const health = readBackendHealth(root, { sessionsDir: path.join(root, 'no-sessions') });
      assert.equal(health.codex.ok, true);
      assert.equal(health.grok.ok, false);
      assert.match(health.grok.reason, /401 unauthorized/);
    } finally {
      try {
        if (reader) reader.close();
      } finally {
        if (fd !== null) fs.closeSync(fd);
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it('returns an update error instead of throwing when the SQLite path is a directory', () => {
    const root = tempDir('ssa-health-open-error-');
    try {
      fs.mkdirSync(healthDbFile(root), { recursive: true });
      let result;
      assert.doesNotThrow(() => { result = recordBackendOutcome(root, 'codex', { ok: true }); });
      assert.equal(result.updated, false);
      assert.equal(typeof result.error, 'string');
      assert.ok(result.error.length > 0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps both backends when two processes write the health database at once', async () => {
    const root = tempDir('ssa-race-');
    const href = pathToFileURL(path.join(REPO, 'src', 'presets.mjs')).href;
    const source = [
      `import { recordBackendOutcome } from ${JSON.stringify(href)};`,
      'const root = process.env.HEALTH_ROOT;',
      'const which = process.env.HEALTH_WHICH;',
      'for (let i = 0; i < 5; i += 1) {',
      "  const res = which === 'grok'",
      "    ? recordBackendOutcome(root, 'grok', { ok: false, worked: false, reason: '401 unauthorized', nowMs: Date.now() })",
      "    : recordBackendOutcome(root, 'codex', { ok: true, nowMs: Date.now() });",
      "  if (!res?.updated) { console.error(JSON.stringify(res)); process.exit(2); }",
      '}',
    ].join('\n');
    const run = (which) => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
        env: { ...process.env, HEALTH_ROOT: root, HEALTH_WHICH: which },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderr = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`${which} exited ${code}: ${stderr}`));
      });
    });
    try {
      await Promise.all([run('grok'), run('codex')]);
      const health = readBackendHealth(root);
      assert.equal(health.grok.ok, false);
      assert.match(health.grok.reason, /401 unauthorized/);
      assert.equal(health.codex.ok, true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
