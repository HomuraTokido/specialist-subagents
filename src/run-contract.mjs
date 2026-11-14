// specialist-subagents: the role contract a run carries (I4), and what a continued session is told when
// that contract changed after the session was last given it.
//
// The contract reaches the runtime as an --append-system-prompt segment, the file roles.json names.
// Codex, Grok and Claude see those segments only in a fresh session's first prompt, so a session that
// started under an older contract would keep working on it for as long as the seat keeps the session
// (2026-10-01:「マスター」decided a resumed session gets the new contract, the way it already gets a
// changed skill). The seat therefore records, per session, the contract version (roles.json's
// contract_version, which the startup gate keeps equal to roles/<role>.VERSION) and a hash of the
// contract text; a run that continues the session compares both with what it carries now. The hash
// catches an edit made while the version stayed the same, and an edit made after the daemon started
// (roles.json is read at startup, the contract file at every run). This is not the gate's old hash
// check (role-contract.mjs, dropped 2026-09-29): nothing is refused here, the hash only says whether a
// session has seen this text.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { message } from './presets.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HASH_SHOWN = 12;
const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');
const shortHash = (hash) => message(`sha256 前 ${HASH_SHOWN} 位 ${String(hash).slice(0, HASH_SHOWN)}`, `sha256 first ${HASH_SHOWN} chars ${String(hash).slice(0, HASH_SHOWN)}`);
const versionWords = (version) => (version === null ? message('没有版本号', 'unversioned') : `v${version}`);
const versionWordsZh = (version) => (version === null ? '没有版本号' : `v${version}`);

// The contract a run of `role` hands its runtime, read now from the file the runner reads a moment
// later. `carried` is false when the role's spawn args do not name the contract file: such a run has
// no contract segment, and its session is recorded as having seen none (version and hash null).
// A contract file that is named and cannot be read throws, and the caller ends the seat with the
// reason: the runner would otherwise hand the path itself over as the contract text.
export function runContract(role, spec) {
  const file = typeof spec?.contract === 'string' ? spec.contract : '';
  const version = typeof spec?.contract_version === 'string' && spec.contract_version.trim() ? spec.contract_version.trim() : null;
  const carried = Boolean(file) && (spec.spawn?.args ?? []).some((arg) => arg === file);
  if (!carried) return { role, file, version: null, text: '', hash: null, carried: false };
  const absolute = path.resolve(ROOT, file);
  let text;
  try {
    text = fs.readFileSync(absolute, 'utf8');
  } catch (err) {
    throw new Error(message(
      `${role} 的岗位合同 ${file} 读不出来（${err?.code ?? err?.message ?? err}）。座位没有在缺了合同的情况下开工：看这个文件在不在、是不是被别的程序占着，修好再派。`,
      `Could not read role contract ${file} for ${role} (${err?.code ?? err?.message ?? err}). Seat did not start without its contract; check that the file exists and is not locked, then retry.`,
    ));
  }
  return { role, file, version, text, hash: sha256(text), carried: true };
}

// Whether the session a run continues has to be handed the contract again. `previous` is what the seat
// recorded for that session: { version, hash }, both null for a session from before contracts were
// recorded, which counts as changed once (so existing experts receive the current contract on their
// next run). A run that carries no contract has nothing to hand over.
export function contractChanged(contract, previous) {
  if (!contract.carried) return false;
  const version = previous?.version ?? null;
  const hash = previous?.hash ?? null;
  return version === null || hash === null || version !== contract.version || hash !== contract.hash;
}

// What goes in front of the task when a continued session was given another contract (or none on
// record): a short notice and the whole current text. cli-runner puts it there only when Codex, Grok
// or Claude actually resume that session. `previous` is what the session was last given, not what it
// started with (exec updates the seat after every run), so the notice says "last given". With nothing
// on record it claims no update: most such sessions already carry today's text.
export function contractNoticeText(contract, previous) {
  const before = previous?.version ?? null;
  const now = versionWordsZh(contract.version);
  let head;
  if (before === null) head = `岗位合同现在是 ${now}（这段会话上次拿到的是哪一版没有记录），以下是现行合同全文`;
  else if (before === contract.version) head = `岗位合同的正文在这段会话上次拿到之后改过（版本号仍是 ${now}），以下是新合同全文`;
  else head = `岗位合同现在是 ${now}（这段会话上次拿到的是 v${before}），以下是新合同全文`;
  return `（服务消息）${head}，以它为准。\n\n${contract.text.trim()}`;
}

// The run's record of the contract it carried, as a seat event (I4). `previous` is what the seat
// recorded for the session this run continues (null: a fresh session).
export function contractEventText(contract, previous = null) {
  if (!contract.carried) {
    return message(
      `这一单没有带岗位合同：${contract.role} 在 roles.json 里的启动参数没有合同文件${contract.file ? ` ${contract.file}` : ''}。`,
      `This run carried no role contract: ${contract.role}'s spawn args in roles.json do not include the contract file${contract.file ? ` ${contract.file}` : ''}.`,
    );
  }
  let line = message(
    `这一单带的是 ${contract.role} 的岗位合同 ${versionWords(contract.version)}，全文的 ${shortHash(contract.hash)}，取自 ${contract.file}。`,
    `This run carried role contract ${versionWords(contract.version)} for ${contract.role} (${shortHash(contract.hash)}) from ${contract.file}.`,
  );
  if (previous !== null && contractChanged(contract, previous)) {
    const before = previous.version === null || previous.hash === null
      ? message('哪一版没有记录（开始记录合同版本之前开的会话都是这样），按变了算', 'no version on record (legacy session opened before contract tracking), treated as changed')
      : message(` ${versionWords(previous.version)}，全文的 ${shortHash(previous.hash)}，和这次不同`, `${versionWords(previous.version)} (${shortHash(previous.hash)}), which differs`);
    line += message(
      ` 接着的会话上次带的是${before}：在 Codex / Grok / Claude 上接着那段会话时，任务前面附上这次的合同全文（DeepSeek 每次都重建系统提示，不另附）。`,
      ` Previous session carried ${before}: prepended the current contract text before the task for Codex / Grok / Claude (DeepSeek rebuilds its system prompt every run).`,
    );
  }
  return line;
}
