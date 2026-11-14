// O-2: isolated completion binding, terminal events, receipts and delivery failures.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { CodexCompletionBridge, callerMetadata } from '../src/codex-completion-bridge.mjs';

const meta = { 'openai/threadId': 'caller', 'openai/turnId': 'turn-1' };
const started = { run: 41, seat: 'seat-coder-1', task: 'PRIVATE TASK' };
const tick = () => new Promise((resolve) => setImmediate(resolve));
function fixture(t, enabled = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-bridge-'));
  const stateDir = path.join(root, 'receipts');
  const requests = [], waits = [], completions = new Map();
  const appClient = {
    closed: false,
    async request(method, params) {
      requests.push({ method, params });
      if (method === 'tools/list') return { tools: [{ namespace: 'codex_app', name: 'send_message_to_thread' }] };
      return { success: true };
    },
    close() { this.closed = true; },
  };
  const options = { stateDir, appClient, env: { SPECIALIST_SUBAGENTS_CODEX_NOTIFY: enabled ? '1' : '0' },
    waitForRun(args, config) {
      waits.push({ args, config });
      return new Promise((resolve) => completions.set(args.run, resolve));
    } };
  const bridge = new CodexCompletionBridge(options);
  t.after(() => { bridge.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const receipts = () => fs.readdirSync(stateDir).filter((name) => name.endsWith('.json'))
    .map((name) => JSON.parse(fs.readFileSync(path.join(stateDir, name), 'utf8')));
  return { bridge, options, appClient, requests, waits, completions, receipts, stateDir };
}
const sends = (f) => f.requests.filter((r) => r.method === 'tools/call');

test('O-2: only official metadata binds the caller, including JSON turn metadata', async (t) => {
  const f = fixture(t);
  const turn = { thread_id: 'caller', turn_id: 'actual-turn' };
  for (const value of [turn, JSON.stringify(turn)]) {
    assert.deepEqual(callerMetadata({ 'x-codex-turn-metadata': value }), { threadId: 'caller', turnId: 'actual-turn' });
  }
  for (const metadata of [undefined, { owner: 'caller', parent: 'turn' }, { 'openai/threadId': 'caller' },
    { 'x-codex-turn-metadata': '{bad' }, { ...meta, 'x-codex-turn-metadata': turn }]) {
    assert.equal((await f.bridge.register(started, metadata)).state, 'unavailable');
  }
  for (const run of [0, -1, '41', 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal((await f.bridge.register({ ...started, run }, meta)).state, 'unavailable');
  }
  assert.equal(f.requests.length, 0);
  assert.equal(fs.existsSync(f.stateDir), false);
  await f.bridge.register(started, { 'x-codex-turn-metadata': JSON.stringify(turn) });
  f.completions.get(41)({ ended: true, status: 'done', text: 'PRIVATE REPORT' });
  await tick();
  const call = sends(f)[0].params;
  assert.equal(call.threadId, 'caller');
  assert.equal(call.arguments.threadId, 'caller');
  assert.equal(call.turnId, 'actual-turn');
  assert.equal(call.namespace, 'codex_app');
  assert.equal(call.tool, 'send_message_to_thread');
  assert.equal(call.callerSource, 'codex');
  assert.equal(call.hostId, 'local');
  assert.match(call.callId, /^[\da-f-]{36}$/);
  assert.doesNotMatch(call.arguments.prompt, /PRIVATE/);
});

test('O-2: duplicate registration watches and sends once, keeping the fixed run after seat reuse', async (t) => {
  const f = fixture(t);
  await Promise.all([f.bridge.register(started, meta), f.bridge.register(started, meta)]);
  await f.bridge.register({ ...started, run: 42 }, meta);
  assert.deepEqual(f.waits.map((w) => w.args.run), [41, 42]);
  assert.deepEqual(f.waits[0], { args: { run: 41, timeout_seconds: 86400, max_chars: 2000 },
    config: { tool: 'codex_notify', maxSeconds: 86400, signal: f.bridge.controller.signal } });
  assert.ok(f.waits[0].config.signal instanceof AbortSignal);
  assert.equal(f.waits[0].config.signal.aborted, false);
  f.completions.get(41)({ ended: true, status: 'done' });
  f.completions.get(41)({ ended: true, status: 'done' });
  await tick();
  await f.bridge.register(started, meta);
  assert.equal(sends(f).length, 1);
  assert.match(sends(f)[0].params.arguments.prompt, /task_result\(run=41\)/);
  assert.deepEqual(f.receipts().map((r) => r.state).sort(), ['delivered', 'watching']);
  for (const name of fs.readdirSync(f.stateDir)) {
    assert.match(name, /^[a-f0-9]{64}\.json$/);
    const mode = fs.statSync(path.join(f.stateDir, name)).mode;
    if (process.platform === 'win32') {
      // Windows mode bits here verify read/write attributes, not ACL isolation.
      assert.equal(mode & 0o600, 0o600);
    } else {
      assert.equal(mode & 0o777, 0o600);
    }
  }
  assert.doesNotMatch(JSON.stringify(f.receipts()), /PRIVATE|PIPE|prompt/);
});

test('O-2: failed, cancelled and timeout terminal runs notify; ordinary output cannot', async (t) => {
  const f = fixture(t);
  for (const [index, status] of ['failed', 'cancelled', 'timeout'].entries()) {
    const run = 50 + index;
    await f.bridge.register({ ...started, run }, meta);
    f.completions.get(run)({ ended: true, status });
    await tick();
    assert.match(sends(f).at(-1).params.arguments.prompt, new RegExp(`status=${status}`));
  }
  await f.bridge.register(started, meta);
  f.completions.get(41)({ ended: false, status: 'running', text: 'output event' });
  await tick();
  assert.equal(sends(f).length, 3);
  assert.equal(f.receipts().find((r) => r.run === 41).state, 'delivery_failed');
});

test('O-2: disconnect after send stays unknown and never resends, even after restart', async (t) => {
  const f = fixture(t);
  const request = f.appClient.request.bind(f.appClient);
  f.appClient.request = async (method, params) => {
    if (method !== 'tools/call') return request(method, params);
    f.requests.push({ method, params });
    throw Object.assign(new Error('disconnected'), { deliveryUnknown: true });
  };
  await f.bridge.register(started, meta);
  f.completions.get(41)({ ended: true, status: 'done' });
  await tick();
  assert.equal(f.receipts()[0].state, 'delivery_unknown');
  f.bridge.close();
  const restarted = new CodexCompletionBridge(f.options);
  t.after(() => restarted.close());
  assert.equal((await restarted.register(started, meta)).state, 'unavailable');
  assert.equal(sends(f).length, 1);
});

test('O-2: App discovery rejection and unconfirmed delivery never report success', async (t) => {
  const f = fixture(t);
  f.appClient.request = async () => { throw new Error('unavailable'); };
  assert.equal((await f.bridge.register(started, meta)).state, 'unavailable');
  assert.equal(f.waits.length, 0);
  assert.equal(f.receipts()[0].state, 'delivery_failed');
  f.appClient.request = async (method) => method === 'tools/list'
    ? { tools: [{ namespace: 'codex_app', name: 'send_message_to_thread' }] } : { success: false };
  await f.bridge.register({ ...started, run: 42 }, meta);
  f.completions.get(42)({ ended: true, status: 'done' });
  await tick();
  assert.equal(f.receipts().find((r) => r.run === 42).state, 'delivery_failed');
});

test('O-2: first valid registration restores only same-chat watching receipts', async (t) => {
  const f = fixture(t);
  await f.bridge.register(started, meta);
  await f.bridge.register({ ...started, run: 42 }, { ...meta, 'openai/threadId': 'other' });
  f.bridge.close();
  assert.ok(f.waits.every((w) => w.config.signal.aborted));
  assert.ok(f.receipts().every((r) => r.state === 'watching'));
  f.waits.length = 0;
  const restarted = new CodexCompletionBridge(f.options);
  t.after(() => restarted.close());
  await restarted.register({ ...started, run: 43 }, meta);
  assert.deepEqual(f.waits.map((w) => w.args.run).sort(), [41, 43]);
  assert.ok(f.waits.every((w) => !w.config.signal.aborted));
  f.completions.get(41)({ ended: true, status: 'done' });
  await tick();
  assert.equal(sends(f)[0].params.threadId, 'caller');
});

test('O-2: disabled bridge has no external actions or receipt directory', async (t) => {
  const f = fixture(t, false);
  assert.equal((await f.bridge.register(started, meta)).state, 'unavailable');
  assert.equal(f.requests.length, 0);
  assert.equal(f.waits.length, 0);
  assert.equal(fs.existsSync(f.stateDir), false);
});

test('O-2: a persisted sending receipt is never resent on a new MCP bridge', async (t) => {
  const f = fixture(t);
  await f.bridge.register(started, meta);
  f.bridge.close();
  const name = fs.readdirSync(f.stateDir).find((entry) => entry.endsWith('.json'));
  const file = path.join(f.stateDir, name);
  const receipt = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...receipt, state: 'sending' }));
  const restarted = new CodexCompletionBridge(f.options);
  t.after(() => restarted.close());
  assert.equal((await restarted.register(started, meta)).state, 'unavailable');
  assert.equal(sends(f).length, 0);
});
