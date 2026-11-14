// A stand-in for the Claude Code CLI (2026-10-24). cli-runner runs a pinned SPECIALIST_CLAUDE_BIN that
// ends in .mjs with node, so this is a whole `claude -p --output-format stream-json` for one call: the
// prompt on stdin, `--resume <id>` to continue, the session log where cli-runner looks for it
// ($CLAUDE_CONFIG_DIR/projects/<dir>/<session id>.jsonl, Claude's own line format so the service can read
// it back as text, C-1). Its "model" is fake-brain.mjs, as fake-codex-brain's is: it answers only from
// what the session and the prompt hold. Every call is recorded to $FAKE_CLAUDE_CALLS when that is set.
//
// Modes, read from the JSON file named by FAKE_CLAUDE_MODE_FILE on every call so a test can change them
// between dispatches: { "main": mode, "takeover": mode }. "takeover" applies to a call whose prompt is
// a takeover brief (cli-runner freshNote), "main" to any other task call; the closing question always
// answers.
//   refuse-after-tools  writes half.js cut off inside a function and adds a line to notes.txt when it
//                       exists, reports those two tool calls, then the safety filter's system event
//                       (model_refusal_no_fallback, as on 2026-10-24) and exits 1 with no result
//   refuse-early        the same event before any tool call
//   (anything else)     the brain answers
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { respond } from './fake-brain.mjs';

const args = process.argv.slice(2);
const prompt = fs.readFileSync(0, 'utf8');
const resumeAt = args.indexOf('--resume');
const sessionId = resumeAt >= 0 ? args[resumeAt + 1] : randomUUID();
// The closing question is the whole prompt and starts with it (a prompt carrying an earlier session as
// text holds that session's closing questions further in).
const closing = prompt.trimStart().startsWith('（服务消息，不是新任务）');
const takeover = prompt.includes('从现场接着做');

let modes = {};
try {
  modes = JSON.parse(fs.readFileSync(process.env.FAKE_CLAUDE_MODE_FILE, 'utf8'));
} catch {
  // no mode file: behave normally
}
const mode = closing ? '' : ((takeover ? modes.takeover : modes.main) ?? '');

if (process.env.FAKE_CLAUDE_CALLS) {
  fs.appendFileSync(process.env.FAKE_CLAUDE_CALLS, `${JSON.stringify({ args, prompt, closing, takeover, mode, resumed: resumeAt >= 0 })}\n`);
}

const sessionDir = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', 'fake-project');
fs.mkdirSync(sessionDir, { recursive: true });
const sessionFile = path.join(sessionDir, `${sessionId}.jsonl`);
const history = [];
if (resumeAt >= 0) {
  try {
    for (const line of fs.readFileSync(sessionFile, 'utf8').split('\n')) {
      try {
        const content = JSON.parse(line)?.message?.content;
        const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map((part) => part?.text ?? part?.content ?? '').join('\n') : '';
        if (text) history.push(text);
      } catch {
        // not a turn line
      }
    }
  } catch {
    // no session yet: nothing in it
  }
}
const log = (entry) => fs.appendFileSync(sessionFile, `${JSON.stringify(entry)}\n`);
log({ type: 'user', message: { role: 'user', content: prompt } });

const say = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
say({ type: 'system', subtype: 'init', session_id: sessionId });
const refusal = () => {
  say({ type: 'system', subtype: 'model_refusal_no_fallback', uuid: randomUUID(), original_model: 'claude-sonnet-5-5', message: "Sonnet 5.5's safeguards flagged this message", details: ['reasoning_extraction'] });
  process.exit(1);
};
if (mode === 'refuse-early') refusal();
if (mode === 'refuse-after-tools') {
  const cwd = process.cwd();
  fs.writeFileSync(path.join(cwd, 'half.js'), 'export function half() {\n  const x = 1;\n');
  const notes = path.join(cwd, 'notes.txt');
  if (fs.existsSync(notes)) fs.appendFileSync(notes, '改到一半的一行\n');
  say({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: path.join(cwd, 'half.js') } }] } });
  say({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: notes } }] } });
  refusal();
}

const { answer, tools, transcript } = await respond({ backend: 'claude', history, prompt, cwd: process.cwd() });
for (const t of tools) say({ type: 'assistant', message: { content: [{ type: 'tool_use', name: t.tool, input: { command: t.arg } }] } });
if (transcript) log({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: transcript }] } });
log({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: answer }] } });
say({ type: 'assistant', message: { content: [{ type: 'text', text: answer }] } });
say({
  type: 'result', subtype: 'success', is_error: false, result: answer, session_id: sessionId,
  usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  modelUsage: { 'claude-sonnet-5-5': {} },
});
