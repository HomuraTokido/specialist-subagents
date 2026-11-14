// A stand-in for the pi SDK entry that src/seat-runner.mjs imports (packageRoot/dist/index.js, where
// packageRoot is two levels above the --pi file). It implements only what seat-runner touches and
// reproduces the one behaviour the runner had to learn about: a failed model call does not throw
// from session.prompt(), it ends with an assistant message whose stopReason is 'error'.
//
// Mode comes from FAKE_PI_MODE (or, when FAKE_PI_MODE_FILE names a file, that file, read per prompt):
//   ok             every prompt is answered; the closing answer lists FAKE_PI_BACKLOG (default: nothing left)
//   main-error     the task prompt ends with an error message; the prompt() call itself resolves
//   closing-error  the task is answered; the closing prompt ends with an error message
// Every prompt is appended to FAKE_PI_CALLS (JSON lines) so a test can see what was asked, together
// with the system prompt seat-runner built for the session (`system`) and the settings it opened the
// session with (`settings`, C-4: compaction.reserveTokens). Each prompt is also appended to
// the session file, so the file exists afterwards and the service continues it on the seat's next run,
// the way it continues a real pi session.
//
// The task prompt can also carry tool calls and a chosen answer, for the difficulty traces:
//   FAKE_PI_TOOLS   JSON list of { tool, args, isError, text }, emitted as tool_execution_start/end
//                   pairs before the answer (only for the task, never for a service message)
//   FAKE_PI_ANSWER  the task's answer instead of PI-ANSWER
//
// With FAKE_PI_BRAIN=1 the answers come from tests/fakes/fake-brain.mjs instead (2026-10-11): a model
// that knows only what is in its context, here the system prompt, the session file's earlier turns
// (lines of { role, text }, written in this mode instead of the { prompt } line) and the prompt. The
// tools it reports are emitted as tool events, so the run's trace is the brain's own.
import fs from 'node:fs';
import path from 'node:path';
import { respond } from '../../fake-brain.mjs';

const mode = () => {
  try {
    if (process.env.FAKE_PI_MODE_FILE) return fs.readFileSync(process.env.FAKE_PI_MODE_FILE, 'utf8').trim();
  } catch {
    // no file: fall through to the variable
  }
  return process.env.FAKE_PI_MODE || 'ok';
};

export const createEventBus = () => ({});
export const createExtensionRuntime = () => ({});
export const ModelRuntime = { create: async () => ({ getModel: (provider, model) => ({ provider, id: model }) }) };
export const SessionManager = {
  create: (cwd, dir) => ({ file: path.join(dir, 'fake-session.jsonl') }),
  open: (file) => ({ file }),
};
// The settings it was given are kept, so a test can see what seat-runner passed (compaction.reserveTokens, C-4).
export const SettingsManager = { inMemory: (settings = {}) => ({ settings }) };

export async function createAgentSession({ sessionManager, resourceLoader, settingsManager }) {
  const listeners = [];
  const emit = (event) => listeners.forEach((fn) => fn(event));
  let prompts = 0;
  fs.mkdirSync(path.dirname(sessionManager.file), { recursive: true });
  const system = resourceLoader?.getSystemPrompt?.() ?? null;
  // The extensions seat-runner registered (the write boundary): their tool_call handlers run before a
  // write/edit in FAKE_PI_TOOLS is emitted, and a { block, reason } answer refuses the call.
  const extensions = resourceLoader?.getExtensions?.()?.extensions ?? [];
  const blockedBy = (toolName, input) => {
    for (const extension of extensions) {
      for (const handler of extension.handlers?.get?.('tool_call') ?? []) {
        const verdict = handler({ toolName, input });
        if (verdict?.block) return verdict.reason ?? 'blocked';
      }
    }
    return null;
  };
  const session = {
    sessionFile: sessionManager.file,
    subscribe: (fn) => listeners.push(fn),
    getSessionStats: () => ({ tokens: { input: prompts * 10, output: prompts * 5, cacheRead: 0, cacheWrite: 0, total: prompts * 15 }, cost: prompts * 0.001 }),
    dispose: () => {},
    async prompt(text) {
      prompts += 1;
      const closing = text.includes('未完成：');
      if (process.env.FAKE_PI_CALLS) fs.appendFileSync(process.env.FAKE_PI_CALLS, `${JSON.stringify({ text, closing, system, settings: settingsManager?.settings ?? null })}\n`);
      if (process.env.FAKE_PI_BRAIN === '1') {
        const history = [];
        try {
          for (const line of fs.readFileSync(sessionManager.file, 'utf8').split('\n')) {
            try {
              const entry = JSON.parse(line);
              if (entry && typeof entry.role === 'string' && typeof entry.text === 'string') history.push(entry.text);
            } catch {
              // not a turn line
            }
          }
        } catch {
          // no session file yet: nothing said before
        }
        // The file exists from the start, so a run killed mid-way still leaves a session to continue.
        fs.appendFileSync(sessionManager.file, '');
        const brain = await respond({ backend: 'pi', system: resourceLoader?.getSystemPrompt?.() ?? '', history, prompt: text, cwd: process.cwd() });
        brain.tools.forEach((tool, i) => {
          const toolCallId = `call-${prompts}-${i}`;
          const args = tool.tool === 'bash' ? { command: tool.arg } : { path: tool.arg };
          emit({ type: 'tool_execution_start', toolCallId, toolName: tool.tool, args });
          emit({ type: 'tool_execution_end', toolCallId, toolName: tool.tool, isError: Boolean(tool.isError), result: { content: [{ type: 'text', text: tool.output ?? '' }] } });
        });
        // What the tools returned stays in the session, between the question and the answer.
        const turn = [{ role: 'user', text }, ...(brain.transcript ? [{ role: 'tool', text: brain.transcript }] : []), { role: 'assistant', text: brain.answer }];
        fs.appendFileSync(sessionManager.file, turn.map((line) => `${JSON.stringify(line)}\n`).join(''));
        emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: brain.answer } });
        emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: brain.answer }], stopReason: 'stop' } });
        return;
      }
      fs.appendFileSync(sessionManager.file, `${JSON.stringify({ prompt: text.slice(0, 200) })}\n`);
      const failing = (mode() === 'main-error' && !closing) || (mode() === 'closing-error' && closing);
      // The difficulty follow-up starts like the closing question but is not it.
      const serviceMessage = text.startsWith('（服务消息');
      if (!serviceMessage && process.env.FAKE_PI_TOOLS) {
        JSON.parse(process.env.FAKE_PI_TOOLS).forEach((call, i) => {
          const toolCallId = `call-${prompts}-${i}`;
          emit({ type: 'tool_execution_start', toolCallId, toolName: call.tool, args: call.args ?? {} });
          const reason = call.tool === 'write' || call.tool === 'edit' ? blockedBy(call.tool, { path: call.args?.path }) : null;
          if (reason) {
            emit({ type: 'tool_execution_end', toolCallId, toolName: call.tool, isError: true, result: { content: [{ type: 'text', text: reason }] } });
            return;
          }
          emit({ type: 'tool_execution_end', toolCallId, toolName: call.tool, isError: Boolean(call.isError), result: { content: [{ type: 'text', text: call.text ?? '' }] } });
        });
      }
      const answer = closing
        ? `我读过这个目录。\n未完成：${process.env.FAKE_PI_BACKLOG ? `\n${process.env.FAKE_PI_BACKLOG}` : '无'}`
        : serviceMessage
        ? '1. 想看测试结果，换了命令。'
        : process.env.FAKE_PI_ANSWER || 'PI-ANSWER';
      if (failing) {
        emit({
          type: 'message_end',
          message: { role: 'assistant', content: [{ type: 'text', text: '' }], stopReason: 'error', errorMessage: 'quota exceeded (fake pi)' },
        });
        return;
      }
      emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: answer } });
      emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: answer }], stopReason: 'stop' } });
    },
  };
  return { session };
}
