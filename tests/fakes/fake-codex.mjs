// A stand-in for the Codex CLI's JS entry (cli-runner runs `node <SPECIALIST_CODEX_JS> exec ...`).
// It speaks just enough of `codex exec --json` for one run plus the closing question, records every
// call to $FAKE_CODEX_CALLS, and writes the rollout file cli-runner looks for under $CODEX_HOME.
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
// `-` as the prompt: read it from stdin, as `codex exec` does (cli-runner never puts it in argv).
const prompt = args.at(-1) === '-' ? fs.readFileSync(0, 'utf8') : args.at(-1);
const resumeAt = args.indexOf('resume');
const threadId = resumeAt >= 0 ? args[resumeAt + 1] : '11111111-2222-3333-4444-555555555555';
// The closing question is the whole prompt and starts with it; a prompt that only carries an earlier
// session as text (C-1) holds that session's closing questions further in, and is a task.
const closing = prompt.trimStart().startsWith('（服务消息，不是新任务）');

fs.appendFileSync(process.env.FAKE_CODEX_CALLS, `${JSON.stringify({ args, prompt, closing })}\n`);

const sessions = path.join(process.env.CODEX_HOME, 'sessions');
fs.mkdirSync(sessions, { recursive: true });
fs.writeFileSync(path.join(sessions, `rollout-2026-01-01T00-00-00-${threadId}.jsonl`), '{}\n');

// Failure modes, read from the file named by FAKE_CODEX_MODE_FILE on every call so a test can change
// them between dispatches. One mode per call kind, so the other call in the same run still succeeds:
//   main-fail-early       the task call fails before doing anything (usage limit, auth)
//   main-fail-after-tools the task call runs a command, writes half an answer, then fails
//   sandbox-unstarted     the task call's commands never start, and it exits 0 anyway (below)
//   closing-fail          the task call is fine; the closing question fails
//   closing-big           the closing answer is one huge line of Chinese text, so that pipe chunks
//                         cut through multi-byte characters
let mode = '';
try {
  mode = fs.readFileSync(process.env.FAKE_CODEX_MODE_FILE, 'utf8').trim();
} catch {
  // no mode file: behave normally
}

const say = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
say({ type: 'thread.started', thread_id: threadId });
if (!closing && mode === 'main-fail-early') {
  say({ type: 'turn.failed', error: { message: 'usage limit reached (fake)' } });
  process.exit(1);
}
if (!closing && mode === 'main-fail-after-tools') {
  say({ type: 'item.started', item: { id: 'cmd1', type: 'command_execution', command: 'echo hi' } });
  say({ type: 'item.completed', item: { id: 'cmd1', type: 'command_execution', command: 'echo hi', exit_code: 0 } });
  say({ type: 'item.completed', item: { type: 'agent_message', text: 'HALF-AN-ANSWER' } });
  say({ type: 'turn.failed', error: { message: 'stream disconnected (fake)' } });
  process.exit(1);
}
// sandbox-unstarted: every command comes back unstarted, as CLI 0.162.1's sandbox did with the desktop
// app open (2026-10-22), and the model says so; Codex still exits 0.
if (!closing && mode === 'sandbox-unstarted') {
  ['Get-Content numbers.txt', 'Get-ChildItem'].forEach((command, i) => {
    const item = { id: `cmd-${i}`, type: 'command_execution', command };
    say({ type: 'item.started', item });
    say({ type: 'item.completed', item: { ...item, status: 'failed', exit_code: -1, aggregated_output: 'Failed to create unified exec process: helper_unknown_error: setup refresh had errors' } });
  });
  say({ type: 'item.completed', item: { type: 'agent_message', text: '命令执行器起不来，什么都没做。' } });
  say({ type: 'turn.completed', usage: { input_tokens: 1000, cached_input_tokens: 200, output_tokens: 50 } });
  process.exit(0);
}
if (closing && mode === 'closing-fail') {
  say({ type: 'turn.failed', error: { message: 'rate limited (fake)' } });
  process.exit(1);
}
// FAKE_CODEX_COMMANDS: a JSON list of { command, exit_code, aggregated_output } the task call reports
// as finished commands before its answer, for the difficulty traces.
if (!closing && process.env.FAKE_CODEX_COMMANDS) {
  JSON.parse(process.env.FAKE_CODEX_COMMANDS).forEach((c, i) => {
    const item = { id: `cmd-${i}`, type: 'command_execution', command: c.command };
    say({ type: 'item.started', item });
    say({ type: 'item.completed', item: { ...item, aggregated_output: c.aggregated_output ?? '', exit_code: c.exit_code, status: c.exit_code === 0 ? 'completed' : 'failed' } });
  });
}
const text = closing && mode === 'closing-big'
  ? `${'专长'.repeat(100000)}\n未完成：无`
  : closing
  ? '我读过 demo 目录，能回答里面的构建问题。\n未完成：\n- 还没读 docs/\n- 还没跑集成测试'
  : 'FAKE-CODEX-ANSWER';
say({ type: 'item.completed', item: { type: 'agent_message', text } });
say({ type: 'turn.completed', usage: { input_tokens: 1000, cached_input_tokens: 200, output_tokens: 50 } });
