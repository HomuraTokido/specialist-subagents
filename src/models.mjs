// What models each backend offers, for the settings page's drop-downs. Three backends can say so
// themselves (checked 2026-10-01): `codex debug models` prints Codex's catalog as JSON, `grok models`
// prints Grok's list, and pi's `--list-models` lists what its configured keys reach; `agy models`
// (2026-10-21) prints Antigravity's as "<slug>\t<name>", the effort part of the slug. Claude Code has
// no such command, so its list is written here: the aliases its --help names, which always mean the
// newest model of that line. The answer is cached for ten minutes; a backend that cannot be asked
// returns its error in place of a list, and the page says so.

import { execSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveRuntime } from './role-contract.mjs';
import { language, message } from './presets.mjs';

const CACHE_MS = 10 * 60 * 1000;
const ASK_TIMEOUT_MS = 30000;
let cached = null;

const CLAUDE_MODELS = ['fable', 'opus', 'sonnet', 'haiku'];
const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']; // claude --help, --effort
// pi 0.87.0's levels for deepseek-flash (deepseek-v4-pro has high and max only); a level a model
// lacks is clamped upward by pi, so offering all three is safe.
const DEEPSEEK_EFFORTS = ['low', 'high', 'max'];
// Codex's ultra hands the task to its own subagents, which a seat of this service must not do.
const CODEX_EXCLUDED_EFFORTS = new Set(['ultra']);

// grok --help names no values; the CLI's own cache lists each model's menu (grok-4.7: low, medium,
// high, xhigh; checked 2026-10-01).
function grokEfforts(id) {
  try {
    const cache = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.grok', 'models_cache.json'), 'utf8'));
    const menu = cache.models?.[id]?.info?.reasoning_efforts ?? [];
    return menu.map((e) => e?.value).filter((v) => typeof v === 'string');
  } catch {
    return [];
  }
}

function ask(command, args) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (err) {
      resolve({ code: -1, stdout: '', stderr: String(err?.message ?? err) });
      return;
    }
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill(), ASK_TIMEOUT_MS);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (err) => { stderr += String(err?.message ?? err); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

function codexEntry() {
  const pinned = process.env.SPECIALIST_CODEX_JS;
  if (pinned && fs.existsSync(pinned)) return pinned;
  try {
    const root = execSync('npm root -g', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: 5000 }).trim();
    const entry = path.join(root, '@openai', 'codex', 'bin', 'codex.js');
    return fs.existsSync(entry) ? entry : null;
  } catch {
    return null;
  }
}
function pathBinary(name, env) {
  if (env.SPECIALIST_NO_HOST_PATH === '1') return null;
  const result = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', [name], {
    env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
  });
  if (result.status !== 0) return null;
  return result.stdout.split(/\r?\n/).map((s) => s.trim()).find((file) => file && fs.existsSync(file)) ?? null;
}

export function grokBinary(env = process.env, home = os.homedir()) {
  if (Object.hasOwn(env, 'SPECIALIST_GROK_BIN')) return env.SPECIALIST_GROK_BIN && fs.existsSync(env.SPECIALIST_GROK_BIN) ? env.SPECIALIST_GROK_BIN : null;
  const local = path.join(home, '.grok', 'bin', process.platform === 'win32' ? 'grok.exe' : 'grok');
  return fs.existsSync(local) ? local : pathBinary(process.platform === 'win32' ? 'grok.exe' : 'grok', env);
}

export function agyBinary(env = process.env, home = os.homedir()) {
  if (Object.hasOwn(env, 'SPECIALIST_AGY_BIN')) return env.SPECIALIST_AGY_BIN && fs.existsSync(env.SPECIALIST_AGY_BIN) ? env.SPECIALIST_AGY_BIN : null;
  // The same places as cli-runner.mjs, in the same order (why there: MSIX redirection of AppData).
  const candidates = process.platform === 'win32'
    ? [path.join(home, '.local', 'bin', 'agy.exe'), path.join(home, 'AppData', 'Local', 'agy', 'bin', 'agy.exe')]
    : [path.join(home, '.local', 'bin', 'agy')];
  return candidates.find((file) => fs.existsSync(file)) ?? pathBinary(process.platform === 'win32' ? 'agy.exe' : 'agy', env);
}

function failed(why) {
  return { models: [], error: why };
}

async function codexModels(lang) {
  const copy = (zh, en) => message(zh, en, lang);
  const entry = codexEntry();
  if (!entry) return failed(copy('找不到 Codex CLI', 'Codex CLI not found'));
  const res = await ask(process.execPath, [entry, 'debug', 'models']);
  try {
    const catalog = JSON.parse(res.stdout);
    const models = (catalog.models ?? [])
      .filter((m) => m.visibility === 'list' && m.slug)
      .map((m) => ({
        id: m.slug,
        efforts: (m.supported_reasoning_levels ?? [])
          .map((level) => level?.effort ?? level)
          .filter((e) => typeof e === 'string' && !CODEX_EXCLUDED_EFFORTS.has(e)),
      }));
    return { models, error: null };
  } catch {
    return failed(copy(`codex debug models 没给出 JSON（退出码 ${res.code}）`, `codex debug models did not return JSON (exit code ${res.code})`));
  }
}

async function grokModels(lang) {
  const copy = (zh, en) => message(zh, en, lang);
  const bin = grokBinary();
  if (!bin) return failed(copy('找不到 Grok CLI', 'Grok CLI not found'));
  const res = await ask(bin, ['models']);
  const models = [];
  for (const line of res.stdout.split(/\r?\n/)) {
    const hit = /^\s+[-*]\s+(\S+)/.exec(line);
    if (hit) models.push({ id: hit[1], efforts: grokEfforts(hit[1]), default: line.includes('(default)') });
  }
  return models.length ? { models, error: null } : failed(copy(`grok models 没列出模型（退出码 ${res.code}）`, `grok models did not list models (exit code ${res.code})`));
}

// The effort is part of each slug (gemini-4-argon-medium), so no separate menu is offered.
async function antigravityModels(lang) {
  const copy = (zh, en) => message(zh, en, lang);
  const bin = agyBinary();
  if (!bin) return failed(copy('找不到 Antigravity CLI', 'Antigravity CLI not found'));
  const res = await ask(bin, ['models']);
  const models = [];
  for (const line of res.stdout.split(/\r?\n/)) {
    const hit = /^(\S+)\t/.exec(line);
    if (hit) models.push({ id: hit[1], efforts: [] });
  }
  return models.length ? { models, error: null } : failed(copy(`agy models 没列出模型（退出码 ${res.code}）`, `agy models did not list models (exit code ${res.code})`));
}

async function deepseekModels(lang) {
  const copy = (zh, en) => message(zh, en, lang);
  let runtime;
  try {
    runtime = resolveRuntime().runtime;
  } catch (err) {
    return failed(String(err?.message ?? err));
  }
  const res = await ask(process.execPath, [runtime, '--list-models']);
  const models = [];
  for (const line of res.stdout.split(/\r?\n/)) {
    const [provider, id] = line.trim().split(/\s+/);
    // cli-runner hands pi provider "deepseek"; models behind other providers cannot be reached that way.
    if (provider === 'deepseek' && id) models.push({ id, efforts: DEEPSEEK_EFFORTS });
  }
  return models.length ? { models, error: null } : failed(copy(`pi --list-models 没列出 deepseek 的模型（退出码 ${res.code}）`, `pi --list-models did not list DeepSeek models (exit code ${res.code})`));
}

export async function listModels({ fresh = false, lang = language() } = {}) {
  if (!fresh && cached && cached.lang === lang && Date.now() - cached.at < CACHE_MS) return cached.value;
  const [codex, grok, antigravity, deepseek] = await Promise.all([codexModels(lang), grokModels(lang), antigravityModels(lang), deepseekModels(lang)]);
  const value = {
    codex,
    grok,
    claude: { models: CLAUDE_MODELS.map((id) => ({ id, efforts: CLAUDE_EFFORTS })), error: null, written: true },
    antigravity,
    deepseek,
    asked_at: new Date().toISOString(),
  };
  cached = { at: Date.now(), value, lang };
  return value;
}
