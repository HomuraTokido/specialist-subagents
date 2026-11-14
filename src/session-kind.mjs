// Which backend wrote a session file (2026-10-11). exec.mjs needs it to decide whether a fork of a busy
// expert can continue a copy of the expert's session (pi: a plain file one process continues) or must
// start its own (Codex, Claude, Grok and Antigravity keep sessions in their own stores and resume them by
// id, so a copy of the file would still be the same session). cli-runner.mjs imports the same function to
// choose how to resume, so there is one rule.
import path from 'node:path';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

export function sessionKind(file) {
  if (!file) return null;
  const codex = path.basename(file).match(new RegExp(`^rollout-.*?(${UUID})\\.jsonl$`));
  if (codex) return { kind: 'codex', id: codex[1] };
  const parent = path.basename(path.dirname(file));
  if (path.basename(file) === 'chat_history.jsonl' && new RegExp(`^${UUID}$`).test(parent)) return { kind: 'grok', id: parent };
  // Antigravity: ~/.gemini/antigravity-cli/brain/<conversation id>/.system_generated/logs/transcript.jsonl
  const brain = path.basename(path.dirname(path.dirname(path.dirname(file))));
  if (path.basename(file) === 'transcript.jsonl' && parent === 'logs' && new RegExp(`^${UUID}$`).test(brain)) return { kind: 'antigravity', id: brain };
  // pi's own files are <timestamp>_<uuid>.jsonl, so a bare <uuid>.jsonl under a projects/ folder is Claude's.
  const claude = path.basename(file).match(new RegExp(`^(${UUID})\\.jsonl$`));
  if (claude && path.basename(path.dirname(path.dirname(file))) === 'projects') return { kind: 'claude', id: claude[1] };
  return { kind: 'pi', id: null };
}
