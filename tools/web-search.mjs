#!/usr/bin/env node
// Web search for the seats: Tavily first, Brave when Tavily fails, one call.
//
//   node tools/web-search.mjs "<query>" [--count N] [--freshness day|week|month|year]
//
// Why a wrapper and not tvly alone (2026-09-29): Tavily's plan ran out, tvly answered "exceeds your
// plan's set usage limit", and seat-web_researcher-12 slept 20s, 60s, 240s, 300s, 600s between
// retries for 17 minutes. A quota does not come back by waiting. This script falls back to Brave
// through hbmartin/agent-web-search (`--strategy fallback`), and when every engine fails it says so
// in words, including that retrying will not help.
//
// Keys come from the environment, or from the user's registry environment when the daemon was
// started before a key was added (it inherits the watchdog's environment from logon). Where the
// agent-web-search CLI lives is machine-local: AGENT_WEB_SEARCH_CLI, or "agentWebSearch" in
// .runtime.json at this repository's root.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENGINES = [
  { id: 'tavily', key: 'TAVILY_API_KEY' },
  { id: 'brave', key: 'BRAVE_API_KEY' },
];

function say(line) {
  process.stdout.write(`${line}\n`);
}

function userEnv(name) {
  if (process.platform !== 'win32') return '';
  const out = spawnSync('reg', ['query', 'HKCU\\Environment', '/v', name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  const match = /REG_(?:EXPAND_)?SZ\s+(.+)$/m.exec(out.stdout ?? '');
  return match ? match[1].trim() : '';
}

function cliPath() {
  if (process.env.AGENT_WEB_SEARCH_CLI) return process.env.AGENT_WEB_SEARCH_CLI;
  try {
    const pointer = JSON.parse(fs.readFileSync(path.join(ROOT, '.runtime.json'), 'utf8'));
    if (typeof pointer.agentWebSearch === 'string' && pointer.agentWebSearch.trim()) return pointer.agentWebSearch.trim();
  } catch {
    // no pointer file
  }
  return '';
}

const args = process.argv.slice(2);
if (!args.length || args[0] === '-h' || args[0] === '--help') {
  say('用法：node tools/web-search.mjs "<查询>" [--count N] [--freshness day|week|month|year]。先用 Tavily，失败时自动换 Brave，输出 Markdown。');
  process.exit(args.length ? 0 : 2);
}

const cli = cliPath();
if (!cli || !fs.existsSync(cli)) {
  say(`没法搜索：找不到 agent-web-search 的 CLI（${cli || '没有配置'}）。在 ${path.join(ROOT, '.runtime.json')} 里写 "agentWebSearch": "<cli.js 的绝对路径>"。这不是暂时故障，不要重试，停下来在回复里说明。`);
  process.exit(3);
}

const env = { ...process.env, NODE_USE_ENV_PROXY: '1' };
const engines = [];
for (const engine of ENGINES) {
  const value = env[engine.key] || userEnv(engine.key);
  if (value) {
    env[engine.key] = value;
    engines.push(engine.id);
  }
}
if (!engines.length) {
  say('没法搜索：TAVILY_API_KEY 和 BRAVE_API_KEY 都没有配置。这不是暂时故障，不要重试，停下来在回复里说明。');
  process.exit(3);
}

const run = spawnSync(
  process.execPath,
  [cli, ...args, '--engine', engines.join(','), '--strategy', 'fallback', '--format', 'json'],
  { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 90000, maxBuffer: 32 * 1024 * 1024 },
);

let report = null;
try {
  report = JSON.parse(run.stdout);
} catch {
  // A search that was killed (the 90 s timeout, or output past maxBuffer) has no exit code and usually
  // no output; telling the caller to "check the query wording" then sent it rewriting a query that was
  // fine (2026-09-30 review). spawnSync says why in run.error / run.signal, so say that first.
  const killed = run.error || run.signal || run.status === null;
  if (killed) {
    const why = run.error?.code === 'ETIMEDOUT' ? '超过 90 秒没有出结果，被终止了'
      : run.error?.code === 'ENOBUFS' ? '输出超过缓冲上限，被终止了'
        : run.error ? `没能运行或被终止了（${run.error.message}）`
          : `被信号 ${run.signal} 终止了`;
    say(`搜索命令${why}。这是搜索引擎或网络一侧的问题，不是查询写法的问题。`);
    say('可以换个更窄的查询再试一次；连续两次都这样就停下，在回复里说明搜索不可用，不要反复重试。');
    process.exit(1);
  }
  say(`搜索命令没有正常返回（退出码 ${run.status}）：${String(run.stderr || run.stdout || '').trim().slice(0, 400)}`);
  say('先检查查询写法；同一条查询不要反复重试。');
  process.exit(1);
}

const answered = engines.map((id) => report[id]).filter(Boolean);
const ok = answered.find((r) => r.ok && Array.isArray(r.results) && r.results.length);
const failures = answered.filter((r) => !r.ok).map((r) => {
  const message = r.error?.message ?? '失败';
  const status = r.error?.status && !message.includes(String(r.error.status)) ? `（HTTP ${r.error.status}）` : '';
  return `${r.engine}：${message}${status}`;
});

// Brave marks matches with <strong> and escapes quotes; the reader is a model, not a browser.
function plain(text) {
  return String(text ?? '')
    .replace(/<[^>]+>/g, '')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

if (!ok) {
  const empty = answered.some((r) => r.ok);
  if (empty && !failures.length) {
    say('搜索成功但没有结果：换个说法或关键词再搜，不要原样重试。');
    process.exit(0);
  }
  say(`所有搜索引擎都失败了：${failures.join('；') || '没有返回'}。`);
  say('额度用尽、超出套餐、401/403 这类错误不会因为等待而恢复：不要 sleep 后重试，停下来，在回复里说明搜索不可用以及已经查到的部分。');
  process.exit(1);
}

say(`# 搜索结果（引擎：${ok.engine}${failures.length ? `；先试过但失败：${failures.join('；')}` : ''}）`);
ok.results.forEach((r, i) => {
  const date = r.publishedDate ? `，${String(r.publishedDate).slice(0, 10)}` : '';
  const snippet = plain(r.snippet ?? (r.snippets ?? []).join(' ')).slice(0, 500);
  say(`\n${i + 1}. ${plain(r.title) || '(无标题)'}\n   ${r.url}${date}${snippet ? `\n   ${snippet}` : ''}`);
});
