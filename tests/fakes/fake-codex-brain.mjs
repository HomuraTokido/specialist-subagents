// A Codex CLI stand-in whose "model" is fake-brain.mjs (2026-10-11): same surface as fake-codex.mjs
// (cli-runner runs `node <SPECIALIST_CODEX_JS> exec --json … [resume <id>] -` with the prompt on
// stdin), but it answers from what its session really holds. The session is the rollout file under
// $CODEX_HOME/sessions, one JSON line per turn { role, text }, so a resumed session knows exactly what
// the earlier turns said and a fresh one knows nothing: the service has to hand the expert its records.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { respond } from './fake-brain.mjs';

const args = process.argv.slice(2);
// `-` as the prompt: read it from stdin, as `codex exec` does (cli-runner never puts it in argv).
const prompt = args.at(-1) === '-' ? fs.readFileSync(0, 'utf8') : args.at(-1);
const resumeAt = args.indexOf('resume');
const threadId = resumeAt >= 0 ? args[resumeAt + 1] : crypto.randomUUID();
const closing = prompt.includes('服务消息，不是新任务');

// A controlled pipe failure for the closing-context regression: the main answer has already been
// produced when the following closing invocation reads this file, so it must keep that answer and the
// service must keep the earlier backlog.  Normal fake runs never set this switch.
if (!closing && process.env.FAKE_CLOSING_CONTEXT_BREAK_FILE && process.env.SPECIALIST_SEAT_CLOSING_CONTEXT) {
  try {
    if (fs.readFileSync(process.env.FAKE_CLOSING_CONTEXT_BREAK_FILE, 'utf8').trim() === '1') {
      fs.writeFileSync(process.env.SPECIALIST_SEAT_CLOSING_CONTEXT, '{', 'utf8');
    }
  } catch {
    // an absent switch is the normal case
  }
}

if (process.env.FAKE_CODEX_CALLS) fs.appendFileSync(process.env.FAKE_CODEX_CALLS, `${JSON.stringify({ args, prompt, closing })}\n`);

const sessions = path.join(process.env.CODEX_HOME, 'sessions');
fs.mkdirSync(sessions, { recursive: true });
const rollout = path.join(sessions, `rollout-2026-01-01T00-00-00-${threadId}.jsonl`);

// The file exists from the first moment, so a run killed mid-way still leaves a session to find.
if (!fs.existsSync(rollout)) fs.writeFileSync(rollout, '{}\n');

const history = [];
if (resumeAt >= 0) {
  try {
    for (const line of fs.readFileSync(rollout, 'utf8').split('\n')) {
      try {
        const entry = JSON.parse(line);
        if (typeof entry?.text === 'string') history.push(entry.text);
      } catch {
        // not a turn line
      }
    }
  } catch {
    // no rollout: a session with nothing in it
  }
}

// `-c developer_instructions="<TOML basic string>"`: JSON's escapes are TOML's, so JSON.parse reads it.
let system = '';
args.forEach((arg, i) => {
  if (args[i - 1] === '-c' && arg.startsWith('developer_instructions=')) {
    try {
      system = JSON.parse(arg.slice('developer_instructions='.length));
    } catch {
      // the preamble is in the prompt anyway
    }
  }
});

const say = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
say({ type: 'thread.started', thread_id: threadId });

const { answer, tools, transcript } = await respond({ backend: 'codex', system, history, prompt, cwd: process.cwd() });
tools.forEach((t, i) => {
  const item = { id: `cmd-${crypto.randomUUID()}-${i}`, type: 'command_execution', command: t.tool === 'bash' ? t.arg : `${t.tool} ${t.arg}` };
  say({ type: 'item.started', item });
  say({ type: 'item.completed', item: { ...item, aggregated_output: t.output ?? '', exit_code: t.isError ? 1 : 0, status: t.isError ? 'failed' : 'completed' } });
});
say({ type: 'item.completed', item: { type: 'agent_message', text: answer } });

// The tools' results are part of the session, between the question and the answer, as in a real rollout.
const turn = [{ role: 'user', text: prompt }, ...(transcript ? [{ role: 'tool', text: transcript }] : []), { role: 'assistant', text: answer }];
fs.appendFileSync(rollout, turn.map((line) => `${JSON.stringify(line)}\n`).join(''));
say({ type: 'turn.completed', usage: { input_tokens: 1000, cached_input_tokens: 200, output_tokens: 50 } });
