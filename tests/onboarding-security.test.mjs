import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { detectEnvironment, ensureOnboarding } from '../src/onboarding.mjs';
import { checkRoleSpecs } from '../src/role-contract.mjs';
import { agyDispatchProblem, resolveAgyBinary } from '../src/cli-runner.mjs';
import { REPO, isolatedEnv, startService, tempDir } from './lib/sandbox.mjs';
import { startMcp } from './lib/mcp.mjs';

function request(service, method, route, headers = {}, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${service.base}${route}`, { method, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, text, json: JSON.parse(text) }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

describe('local HTTP request boundary', () => {
  it('rejects browser attacks and non-JSON bodies while allowing same-origin JSON and empty shutdown', async () => {
    const service = await startService();
    try {
      for (const host of ['attacker.invalid', '127.0.0.1.attacker.invalid', 'localhost.attacker.invalid:80']) {
        const result = await request(service, 'GET', '/health', { host });
        assert.equal(result.status, 403);
        assert.equal(result.json.error, 'forbidden host');
      }
      for (const host of [`localhost:${service.port}`, `[::1]:${service.port}`, `127.0.0.1:${service.port}`]) {
        assert.equal((await request(service, 'GET', '/health', { host })).status, 200);
      }
      const post = (headers, body = '{"mode":"best","max":false}') => request(service, 'POST', '/backend', headers, body);
      for (const origin of ['https://attacker.invalid', `http://localhost:${service.port + 1}`, 'null']) {
        assert.equal((await post({ origin, 'content-type': 'application/json' })).status, 403);
      }
      for (const site of ['cross-site', 'same-site']) {
        assert.equal((await post({ 'sec-fetch-site': site, 'content-type': 'application/json' })).status, 403);
      }
      for (const type of [undefined, 'text/plain', 'application/x-www-form-urlencoded']) {
        const result = await post(type ? { 'content-type': type } : {});
        assert.equal(result.status, 415);
        assert.equal(result.json.error, 'content-type must be application/json');
      }
      for (const host of ['127.0.0.1', 'localhost']) {
        assert.equal((await post({
          origin: `http://${host}:${service.port}`, 'sec-fetch-site': 'same-origin',
          'content-type': 'Application/JSON; charset=utf-8',
        })).status, 200);
      }
      assert.equal((await post({ 'sec-fetch-site': 'none', 'content-type': 'application/json' })).status, 200);
      assert.equal((await request(service, 'POST', '/shutdown')).status, 200);
    } finally {
      await service.stop();
    }
  });

  it('requires a token except for health, and forwards it from CLI and MCP', async () => {
    const service = await startService({ env: { SPECIALIST_SUBAGENTS_TOKEN: ' local-test-token ' } });
    const authorization = 'Bearer local-test-token';
    let mcp;
    try {
      assert.equal((await request(service, 'GET', '/health')).status, 200);
      assert.equal((await request(service, 'GET', '/roles')).status, 401);
      assert.equal((await request(service, 'GET', '/roles', { authorization: 'Bearer wrong' })).status, 401);
      assert.equal((await request(service, 'POST', '/shutdown')).status, 401);
      assert.equal((await request(service, 'GET', '/roles', { authorization })).status, 200);
      mcp = startMcp(service);
      await mcp.init();
      const reply = await mcp.tool('seat_list');
      assert.equal(reply.isError, false, reply.text);
      const cli = spawnSync(process.execPath, [path.join(REPO, 'bin', 'specialist-subagents.mjs'), 'pool'], {
        env: service.env, encoding: 'utf8', windowsHide: true, timeout: 20000,
      });
      assert.equal(cli.status, 0, cli.stderr);
      assert.doesNotMatch(cli.stdout, /unknown/);
    } finally {
      await mcp?.close();
      await request(service, 'POST', '/shutdown', { authorization }).catch(() => {});
      await service.stop();
    }
  });
});

describe('optional pi and onboarding', () => {
  it('reports missing pi as a warning, with no contract failures', () => {
    const previous = process.env.SPECIALIST_SUBAGENTS_RUNTIME;
    process.env.SPECIALIST_SUBAGENTS_RUNTIME = path.join(REPO, 'tests', 'missing-pi-runtime.js');
    try {
      const report = checkRoleSpecs();
      assert.deepEqual(report.failures, []);
      assert.equal(report.warnings.length, 1);
      assert.match(report.warnings[0], /pi is not installed/);
    } finally {
      if (previous === undefined) delete process.env.SPECIALIST_SUBAGENTS_RUNTIME;
      else process.env.SPECIALIST_SUBAGENTS_RUNTIME = previous;
    }
  });

  async function inSandbox(run) {
    const root = tempDir('ssa-onboarding-');
    const logs = [];
    const options = {
      root, env: {}, runtimePath: path.join(root, 'pi.js'), commandExists: () => false,
      log: (text) => logs.push(text),
    };
    try { await run(options, logs); } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }

  it('detects subscription commands, runtime and trimmed API key', async () => inSandbox(async (options) => {
    fs.writeFileSync(options.runtimePath, '');
    assert.deepEqual(detectEnvironment({ ...options, env: { DEEPSEEK_API_KEY: ' key ' }, commandExists: (cmd) => ['codex', 'agy'].includes(cmd) }), {
      subscriptionClis: ['codex', 'agy'], piInstalled: true, deepseekKey: true,
    });
    assert.equal(detectEnvironment({ ...options, env: { DEEPSEEK_API_KEY: ' ' } }).deepseekKey, false);
  }));

  it('never asks or installs in noninteractive mode; start passes and empty demo fails', async () => inSandbox(async (options, logs) => {
    const opts = { ...options, interactive: false, question: () => assert.fail('stdin must not be read'), install: () => assert.fail('must not install') };
    assert.deepEqual(await ensureOnboarding(opts), { ok: true });
    assert.deepEqual(await ensureOnboarding({ ...opts, mode: 'demo' }), { ok: false });
    assert.equal(logs.length, 2);
    assert.equal(fs.existsSync(path.join(options.root, '.data', 'onboarding.json')), false);
    assert.deepEqual(await ensureOnboarding({ ...opts, mode: 'demo', commandExists: (cmd) => cmd === 'grok' }), { ok: true });
    fs.writeFileSync(options.runtimePath, '');
    assert.deepEqual(await ensureOnboarding({ ...opts, mode: 'demo', env: { DEEPSEEK_API_KEY: 'key' } }), { ok: true });
  }));

  it('persists a default skip with a subscription and does not ask again', async () => inSandbox(async (options) => {
    const opts = { ...options, interactive: true, commandExists: (cmd) => cmd === 'claude' };
    assert.deepEqual(await ensureOnboarding({ ...opts, question: async () => '' }), { ok: true });
    assert.equal(JSON.parse(fs.readFileSync(path.join(options.root, '.data', 'onboarding.json'))).skippedPiInstall, true);
    assert.deepEqual(await ensureOnboarding({ ...opts, question: () => assert.fail('skip must persist') }), { ok: true });
  }));

  it('explicit noninteractive reset clears saved onboarding choices without asking', async () => inSandbox(async (options, logs) => {
    const file = path.join(options.root, '.data', 'onboarding.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{"skippedPiInstall":true}');
    await ensureOnboarding({ ...options, interactive: true, nonInteractive: true, reset: true, question: () => assert.fail('must not ask') });
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {});
    assert.match(logs.at(-1), /No usable backend detected/);
    await ensureOnboarding({ ...options, nonInteractive: true, env: { SPECIALIST_SUBAGENTS_LANG: 'zh' } });
    assert.match(logs.at(-1), /未检测到可用执行后端/);
  }));

  it('refuses an interactive skip without a subscription', async () => inSandbox(async (options) => {
    assert.deepEqual(await ensureOnboarding({ ...options, interactive: true, question: async () => '2' }), { ok: false });
    assert.equal(fs.existsSync(path.join(options.root, '.data', 'onboarding.json')), false);
  }));

  it('fails offline without a subscription and continues with one', async () => inSandbox(async (options, logs) => {
    const opts = { ...options, interactive: true, question: async () => '1', install: async () => false };
    assert.deepEqual(await ensureOnboarding(opts), { ok: false });
    assert.match(logs.at(-1), /Installation failed.*onboarding could not finish/);
    assert.deepEqual(await ensureOnboarding({ ...opts, commandExists: (cmd) => cmd === 'codex' }), { ok: true });
  }));

  it('installs to the sibling runtime directory and handles an existing runtime without a prompt', async () => inSandbox(async (options) => {
    const opts = { ...options, interactive: true, env: { DEEPSEEK_API_KEY: 'key' }, question: async () => '1' };
    assert.deepEqual(await ensureOnboarding({ ...opts, mode: 'demo', install: async (prefix, env) => {
      assert.equal(prefix, path.resolve(options.root, '..', 'runtimes', 'pi'));
      assert.equal(env.DEEPSEEK_API_KEY, 'key');
      fs.writeFileSync(options.runtimePath, '');
      return true;
    } }), { ok: true });
    assert.deepEqual(await ensureOnboarding({ ...opts, question: () => assert.fail('pi already exists') }), { ok: true });
  }));
});

describe('shared Antigravity executable resolution', () => {
  async function withHome(run) {
    const root = tempDir('ssa-agy-resolution-');
    const env = isolatedEnv(root);
    try { await run(root, env); } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }

  const plant = (file, content = '') => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return file;
  };

  it('gives explicit overrides priority and never falls back from a missing or empty override', async () => withHome(async (root, env) => {
    const fallback = plant(path.join(env.HOME, '.local', 'bin', process.platform === 'win32' ? 'agy.exe' : 'agy'));
    const pinned = plant(path.join(root, 'pinned-agy'));
    assert.equal(resolveAgyBinary({ env: { ...env, SPECIALIST_AGY_BIN: ` ${pinned} ` } }), pinned);
    assert.equal(resolveAgyBinary({ env: { ...env, SPECIALIST_AGY_BIN: path.join(root, 'missing') } }), null);
    assert.equal(resolveAgyBinary({ env: { ...env, SPECIALIST_AGY_BIN: '' } }), null);
    assert.equal(resolveAgyBinary({ env: { ...env, SPECIALIST_AGY_BIN: '   ' } }), null);
    assert.equal(resolveAgyBinary({ env }), fallback);
  }));

  it('finds each home default and lets onboarding recognize it without a custom detector', async () => withHome(async (root, env) => {
    const defaults = process.platform === 'win32'
      ? [['.local', 'bin', 'agy.exe'], ['AppData', 'Local', 'agy', 'bin', 'agy.exe']]
      : [['.local', 'bin', 'agy']];
    for (let i = 0; i < defaults.length; i += 1) {
      const home = path.join(root, `home-${i}`);
      const file = plant(path.join(home, ...defaults[i]));
      const homeEnv = { ...env, USERPROFILE: home, HOME: home };
      assert.equal(resolveAgyBinary({ env: homeEnv }), file);
      assert.ok(detectEnvironment({ env: homeEnv, runtimePath: path.join(root, 'missing-pi') }).subscriptionClis.includes('agy'));
    }
  }));

  it('skips PATH when requested and otherwise finds agy in a custom PATH directory', async () => withHome(async (root, env) => {
    const bin = path.join(root, 'custom bin');
    const file = plant(path.join(bin, process.platform === 'win32' ? 'agy.exe' : 'agy'), process.platform === 'win32' ? 'MZ' : '#!/bin/sh\nexit 0\n');
    if (process.platform !== 'win32') fs.chmodSync(file, 0o755);
    const pathEnv = Object.fromEntries(Object.entries(env).filter(([key]) => key.toLowerCase() !== 'path'));
    pathEnv.PATH = [bin, process.platform === 'win32' ? path.join(env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows', 'System32') : '/usr/bin'].join(path.delimiter);
    pathEnv.PATHEXT = '.COM;.EXE;.BAT;.CMD';
    assert.equal(resolveAgyBinary({ env: pathEnv }), null);
    delete pathEnv.SPECIALIST_NO_HOST_PATH;
    assert.equal(resolveAgyBinary({ env: pathEnv }), file);
  }));

  it('points missing MCP registration and permission instructions to doc/connect.md', async () => withHome(async (root, env) => {
    const missing = agyDispatchProblem(env.HOME);
    assert.match(missing, /^agy has no specialist-subagents MCP server in ~\/\.gemini\/config\/mcp_config\.json/);
    assert.match(missing, /doc\/connect\.md/);
    assert.doesNotMatch(missing, /agy mcp add/);
    plant(path.join(env.HOME, '.gemini', 'config', 'mcp_config.json'), JSON.stringify({ mcpServers: { 'specialist-subagents': { command: 'node' } } }));
    const grants = agyDispatchProblem(env.HOME);
    assert.match(grants, /globalPermissionGrants/);
    assert.match(grants, /doc\/connect\.md/);
    assert.doesNotMatch(grants, /agy mcp add/);
  }));
});
