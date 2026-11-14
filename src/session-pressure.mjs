// How close a session is to its backend's context limit (2026-10-11, L-4 / C-1).
//
// Two independent signals say an expert's session has grown too long to keep as one:
//   1. the session already compacted once — a summary turn in the log means detail was dropped, and the
//      session has crossed the backend's own threshold;
//   2. the session's estimated token count (characters / 3, the rough estimate the rest of the service
//      uses, cli-runner.mjs) passes half of the backend's context window.
//
// Half, and not the whole window: a session that reaches the whole window has already been forced to
// compact, losing detail on the way. The service would rather hand the lead a "建议拆分" signal before
// that. The context length comes from presets.mjs' DEFAULT_CONTEXT_TOKENS (per backend), never hard-coded
// here, so a backend's window change reaches this without touching the service.

import fs from 'node:fs';
import { sessionKind } from './session-kind.mjs';
import { sessionTurns } from './cli-runner.mjs';
import { DEFAULT_CONTEXT_TOKENS } from './presets.mjs';

// The characters-per-token estimate the service uses everywhere (Chinese and code are the bulk of the
// logs; HANDOFF_BUDGET in cli-runner.mjs is already on this basis).
export const CHARS_PER_TOKEN = 3;

// A session kind as sessionKind names it, mapped to the context window presets keys. pi is DeepSeek's
// runner, so its window is the deepseek one.
const KIND_TO_PRESET = { codex: 'codex', grok: 'grok', claude: 'claude', antigravity: 'antigravity', pi: 'deepseek' };

// The context window (tokens) for the backend that wrote a session, or null when unknown.
export function contextTokensFor(file) {
  const kind = sessionKind(file)?.kind;
  const key = kind ? KIND_TO_PRESET[kind] : null;
  return key ? DEFAULT_CONTEXT_TOKENS[key] : null;
}

// How many characters the session log holds, and whether it already compacted (a summary turn means the
// backend compressed old turns and dropped detail). Missing files read as empty.
function inspect(file) {
  if (!file) return { chars: 0, hasCompaction: false };
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return { chars: 0, hasCompaction: false };
  }
  const turns = sessionTurns(file);
  return { chars: raw.length, hasCompaction: turns.some((turn) => turn.role === 'summary') };
}

// { chars, estTokens, context, half, overHalf, hasCompaction, suggest }.
// `suggest` (建议拆分) is true when the session compacted once already or has passed half the window.
// Without a known context window (an unknown backend) only the compaction marker can suggest a split.
export function sessionPressure(file) {
  const { chars, hasCompaction } = inspect(file);
  const estTokens = Math.floor(chars / CHARS_PER_TOKEN);
  const context = contextTokensFor(file);
  const half = context === null ? null : Math.floor(context / 2);
  const overHalf = half !== null && estTokens > half;
  return { chars, estTokens, context, half, overHalf, hasCompaction, suggest: hasCompaction || overHalf };
}

// C-1's first active hand-off node: a session's text has crossed this many characters once, and the
// service then writes a hand-off document (at most once per node, store.handoffNodeDone).
export const HANDOFF_NODE_LARGE_CHARS = 60000;
