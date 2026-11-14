import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { resolveRuntime } from './role-contract.mjs';
import { resolveAgyBinary } from './cli-runner.mjs';
import { language, message } from './presets.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SUBSCRIPTION_COMMANDS = ['codex', 'claude', 'agy', 'grok'];

function executableExists(command, env) {
  const result = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', [command], {
    env, stdio: 'ignore', windowsHide: true,
  });
  return result.status === 0;
}

export function detectEnvironment({ env = process.env, runtimePath = resolveRuntime().runtime, commandExists } = {}) {
  const exists = commandExists ?? ((command) => command === 'agy' ? Boolean(resolveAgyBinary({ env })) : executableExists(command, env));
  return {
    subscriptionClis: SUBSCRIPTION_COMMANDS.filter((command) => exists(command)),
    piInstalled: fs.existsSync(runtimePath),
    deepseekKey: Boolean(env.DEEPSEEK_API_KEY?.trim()),
  };
}

function installPi(prefix, env) {
  // npm.cmd needs a command shell on Windows; quote the prefix as a single argument.
  const args = ['--prefix', process.platform === 'win32' ? `"${prefix}"` : prefix, 'install', '@earendil-works/pi-coding-agent@1.5.2'];
  return spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, {
    env, stdio: 'inherit', shell: process.platform === 'win32', windowsHide: true,
  }).status === 0;
}

export async function ensureOnboarding({
  mode = 'start', interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY),
  nonInteractive = false, reset = false,
  env = process.env, runtimePath = resolveRuntime().runtime, commandExists,
  root = ROOT, question, install = installPi, log = console.error,
} = {}) {
  if (nonInteractive) interactive = false;
  const copy = (zh, en) => message(zh, en, language(env));
  const stateFile = path.join(root, '.data', 'onboarding.json');
  let state = {};
  try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')) ?? {}; } catch { /* first start */ }
  if (reset) {
    state = {};
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, '{}\n');
  }
  const detected = detectEnvironment({ env, runtimePath, commandExists });
  const hasSubscription = detected.subscriptionClis.length > 0;
  const available = hasSubscription || (detected.piInstalled && detected.deepseekKey);
  const noBackend = copy('未检测到可用执行后端：请安装并登录 Codex / Claude Code / Antigravity / Grok，或安装 pi 并配置 DEEPSEEK_API_KEY。', 'No usable backend detected: install and sign in to Codex / Claude Code / Antigravity / Grok, or install pi and configure DEEPSEEK_API_KEY.');
  if (!interactive) {
    if (!available) log(noBackend);
    return { ok: mode === 'start' || available };
  }

  if (detected.piInstalled || state.skippedPiInstall === true) {
    if (!available) log(noBackend);
    return { ok: available };
  }

  log(copy(`检测到的订阅 CLI：${detected.subscriptionClis.join('、') || '无'}（使用前请确认已登录）。`, `Detected subscription CLIs: ${detected.subscriptionClis.join(', ') || 'none'} (sign in before use).`));
  let rl;
  let choice;
  try {
    if (!question) rl = createInterface({ input: process.stdin, output: process.stdout });
    choice = await (question ?? ((prompt) => rl.question(prompt)))(
      copy('[1] 立即自动安装 pi 执行器到 ../runtimes/pi（需联网） [2] 跳过，仅使用本机已有订阅 CLI（默认）：', '[1] Install pi into ../runtimes/pi now (requires network) [2] Skip; use installed subscription CLIs only (default): '),
    );
  } finally {
    rl?.close();
  }
  if (String(choice).trim() !== '1') {
    if (!hasSubscription) { log(noBackend); return { ok: false }; }
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, `${JSON.stringify({ ...state, skippedPiInstall: true }, null, 2)}\n`);
    return { ok: true };
  }

  let installed = false;
  try { installed = await install(path.resolve(root, '..', 'runtimes', 'pi'), env); } catch { /* report below */ }
  if (!installed) {
    if (hasSubscription) {
      log(copy('pi 安装失败，继续使用本机已有订阅 CLI。', 'pi installation failed; continuing with installed subscription CLIs.'));
      return { ok: true };
    }
    log(copy('当前网络不可用且本机未检测到任何已安装的订阅 CLI（Codex / Claude Code / Antigravity / Grok），无法完成开箱激活', 'Installation failed and no subscription CLI was detected (Codex / Claude Code / Antigravity / Grok); onboarding could not finish.'));
    return { ok: false };
  }
  if (mode === 'demo' && !hasSubscription && !detected.deepseekKey) {
    log(noBackend);
    return { ok: false };
  }
  return { ok: true };
}
