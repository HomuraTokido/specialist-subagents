import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { createHash, randomUUID } from 'node:crypto';

const MAX_FRAME = 8 * 1024 * 1024;
const TIMEOUT_MS = 3000;
const nonempty = (value) => typeof value === 'string' && value.trim().length > 0;
const validRun = (value) => Number.isSafeInteger(value) && value > 0;
const failure = (message, deliveryUnknown = false) => Object.assign(new Error(message), { deliveryUnknown });

// Only the metadata supplied by the MCP transport can identify the caller.
export function callerMetadata(meta) {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null;
  let turn = meta['x-codex-turn-metadata'];
  if (typeof turn === 'string') {
    try { turn = JSON.parse(turn); } catch { return null; }
  }
  const threadId = turn?.thread_id ?? meta['openai/threadId'];
  const turnId = turn?.turn_id ?? meta['openai/turnId'];
  if (!nonempty(threadId) || !nonempty(turnId)) return null;
  // Conflicting official fields are ambiguous, rather than a reason to guess.
  if ((meta['openai/threadId'] !== undefined && meta['openai/threadId'] !== threadId)
    || (meta['openai/turnId'] !== undefined && meta['openai/turnId'] !== turnId)) return null;
  return { threadId, turnId };
}

export class NativeAppClient {
  constructor(pipePath) {
    this.pipePath = pipePath;
    this.socket = null;
    this.connecting = null;
    this.pending = new Map();
    this.buffer = Buffer.alloc(0);
    this.closed = false;
  }

  async connect() {
    if (this.closed) throw failure('App client closed');
    if (this.connecting) return this.connecting;
    if (this.socket && !this.socket.destroyed) return;
    if (!nonempty(this.pipePath)) throw failure('App pipe unavailable');
    this.connecting = new Promise((resolve, reject) => {
      const socket = net.createConnection(this.pipePath);
      this.socket = socket;
      let connected = false;
      const timer = setTimeout(() => socket.destroy(failure('App connection timed out')), TIMEOUT_MS);
      const disconnect = () => {
        clearTimeout(timer);
        if (!connected) reject(failure('App connection unavailable'));
        if (this.socket === socket) {
          this.socket = null;
          this.buffer = Buffer.alloc(0);
          for (const pending of this.pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(failure('App disconnected', pending.sent));
          }
          this.pending.clear();
        }
      };
      socket.once('connect', () => { connected = true; clearTimeout(timer); resolve(); });
      socket.on('error', disconnect);
      socket.once('close', disconnect);
      socket.on('data', (chunk) => {
        if (this.socket !== socket) return;
        this.buffer = Buffer.concat([this.buffer, chunk]);
        while (this.buffer.length >= 4) {
          const length = this.buffer.readUInt32LE(0);
          if (length === 0 || length > MAX_FRAME) {
            socket.destroy(failure('Invalid App frame length'));
            return;
          }
          if (this.buffer.length < length + 4) return;
          let message;
          try { message = JSON.parse(this.buffer.subarray(4, length + 4).toString('utf8')); }
          catch { socket.destroy(failure('Invalid App frame JSON')); return; }
          this.buffer = this.buffer.subarray(length + 4);
          if (!message || message.jsonrpc !== '2.0') {
            socket.destroy(failure('Invalid App JSON-RPC response'));
            return;
          }
          const pending = this.pending.get(message.id);
          if (!pending) continue;
          clearTimeout(pending.timer);
          this.pending.delete(message.id);
          if (message.error) pending.reject(failure('App rejected request'));
          else if (Object.hasOwn(message, 'result')) pending.resolve(message.result);
          else pending.reject(failure('App response missing result', pending.sent));
        }
      });
    });
    try { await this.connecting; } finally { this.connecting = null; }
  }

  async request(method, params) {
    await this.connect();
    const socket = this.socket;
    if (this.closed || !socket || socket.destroyed) throw failure('App disconnected');
    const id = randomUUID();
    const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    if (body.length > MAX_FRAME) throw failure('App request too large');
    const frame = Buffer.allocUnsafe(4 + body.length);
    frame.writeUInt32LE(body.length, 0);
    body.copy(frame, 4);
    return new Promise((resolve, reject) => {
      const pending = { resolve, reject, sent: false, timer: null };
      pending.timer = setTimeout(() => {
        this.pending.delete(id);
        reject(failure('App request timed out', pending.sent));
        socket.destroy();
      }, TIMEOUT_MS);
      this.pending.set(id, pending);
      try {
        // Once handed to the socket, a missing response cannot prove non-delivery.
        pending.sent = true;
        socket.write(frame);
      } catch {
        clearTimeout(pending.timer);
        this.pending.delete(id);
        reject(failure('App write failed', pending.sent));
        socket.destroy();
      }
    });
  }

  close() {
    this.closed = true;
    this.buffer = Buffer.alloc(0);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(failure('App client closed', pending.sent));
    }
    this.pending.clear();
    this.socket?.destroy();
  }
}

export class CodexCompletionBridge {
  constructor({ waitForRun, env = process.env, stateDir, appClient } = {}) {
    this.waitForRun = waitForRun;
    this.controller = new AbortController();
    this.env = env;
    this.stateDir = stateDir;
    this.appClient = appClient;
    this.enabled = env.SPECIALIST_SUBAGENTS_CODEX_NOTIFY === '1';
    this.closed = false;
    this.registrations = new Map();
    this.watchers = new Set();
    this.recovered = new Set();
  }

  key(threadId, run) { return createHash('sha256').update(JSON.stringify([threadId, run])).digest('hex'); }
  file(receipt) { return path.join(this.stateDir, `${this.key(receipt.threadId, receipt.run)}.json`); }
  read(file) {
    const receipt = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!nonempty(receipt.threadId) || !nonempty(receipt.turnId) || !validRun(receipt.run)
      || !nonempty(receipt.seat) || this.file(receipt) !== file) throw failure('Invalid completion receipt');
    return receipt;
  }
  save(receipt, createOnly = false) {
    fs.mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
    const file = this.file(receipt);
    const temporary = `${file}.${randomUUID()}.tmp`;
    // Explicit allowlist: never persist prompts, pipe paths, credentials or App responses.
    const data = Object.fromEntries(['threadId', 'turnId', 'run', 'seat', 'state', 'error', 'created_at', 'updated_at']
      .map((key) => [key, receipt[key] ?? null]));
    try {
      fs.writeFileSync(temporary, `${JSON.stringify(data)}\n`, { mode: 0o600, flag: 'wx' });
      if (createOnly) {
        try { fs.linkSync(temporary, file); } catch (err) { if (err.code !== 'EEXIST') throw err; }
      } else fs.renameSync(temporary, file);
    } finally {
      try { fs.unlinkSync(temporary); } catch (err) { if (err.code !== 'ENOENT') this.log('Receipt cleanup failed'); }
    }
  }
  log(message) { process.stderr.write(`specialist-subagents codex completion: ${message}\n`); }
  setState(receipt, state, error = null) {
    receipt.state = state;
    receipt.error = error;
    receipt.updated_at = new Date().toISOString();
    this.save(receipt);
  }
  unavailable(reason) { return { state: 'unavailable', reason }; }

  claimSending(receipt) {
    // Two MCP processes may restore the same chat. Serialize the read/transition,
    // without holding a lock during App I/O. A crash leaves a fail-closed lock.
    const lock = `${this.file(receipt)}.lock`;
    try { fs.mkdirSync(lock, { mode: 0o700 }); }
    catch (err) {
      if (err.code !== 'EEXIST') throw err;
      this.log('Completion delivery claim already held; no resend');
      return false;
    }
    try {
      if (this.read(this.file(receipt)).state !== 'watching') return false;
      this.setState(receipt, 'sending');
      return true;
    } finally { fs.rmdirSync(lock); }
  }

  async register(started, metadata) {
    if (!this.enabled) return this.unavailable('Codex completion notifications disabled');
    if (this.closed) return this.unavailable('Completion bridge closed');
    const caller = callerMetadata(metadata);
    if (!caller) return this.unavailable('Missing or ambiguous caller thread/turn metadata');
    if (!validRun(started?.run) || !nonempty(started?.seat)) return this.unavailable('Invalid run or seat');
    const key = this.key(caller.threadId, started.run);
    if (this.registrations.has(key)) return this.registrations.get(key);
    const registration = this.registerCaller(started, caller);
    this.registrations.set(key, registration);
    try { return await registration; } finally { this.registrations.delete(key); }
  }

  async registerCaller(started, caller) {
    let receipt = { ...caller, run: started.run, seat: started.seat, state: 'watching',
      error: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
    try {
      if (fs.existsSync(this.file(receipt))) receipt = this.read(this.file(receipt));
      if (receipt.state !== 'watching') return this.unavailable(`Receipt is ${receipt.state}; no automatic resend`);
      if (this.watchers.has(this.key(receipt.threadId, receipt.run))) return { state: 'watching', run: receipt.run };
      if (!this.appClient) {
        if (!nonempty(this.env.CODEX_APP_TOOLS_PIPE_PATH)) throw failure('App pipe unavailable');
        this.appClient = new NativeAppClient(this.env.CODEX_APP_TOOLS_PIPE_PATH);
      }
      const listed = await this.appClient.request('tools/list', { threadStartKind: 'all' });
      if (!listed?.tools?.some((tool) => tool.name === 'send_message_to_thread' && tool.namespace === 'codex_app')) {
        throw failure('App completion tool unavailable');
      }
      if (this.closed) throw failure('Completion bridge closed');
      // Another registration may have restored this receipt while discovery was pending.
      this.save(receipt, true);
      receipt = this.read(this.file(receipt));
      if (receipt.state !== 'watching') return this.unavailable(`Receipt is ${receipt.state}; no automatic resend`);
      this.recover(caller.threadId);
      this.watch(receipt);
      return { state: 'watching', run: receipt.run };
    } catch {
      const reason = 'App access or completion registration unavailable';
      this.log(reason);
      // Do not overwrite a watcher or an in-flight/delivered receipt on a later failed registration.
      if (!this.watchers.has(this.key(receipt.threadId, receipt.run)) && receipt.state === 'watching') {
        try {
          this.save({ ...receipt, state: 'delivery_failed', error: reason, updated_at: new Date().toISOString() }, true);
        } catch { this.log('Receipt write failed'); }
      }
      return this.unavailable(reason);
    }
  }

  recover(threadId) {
    if (this.recovered.has(threadId)) return;
    for (const name of fs.readdirSync(this.stateDir)) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      try {
        const receipt = this.read(path.join(this.stateDir, name));
        if (receipt.threadId === threadId && receipt.state === 'watching') this.watch(receipt);
      } catch { this.log('Completion receipt unreadable'); }
    }
    this.recovered.add(threadId);
  }

  watch(receipt) {
    const key = this.key(receipt.threadId, receipt.run);
    if (this.closed || this.watchers.has(key)) return;
    this.watchers.add(key);
    // The run is fixed here; a later dispatch to this seat cannot change the target.
    Promise.resolve().then(() => this.closed ? null : this.waitForRun(
      { run: receipt.run, timeout_seconds: 86400, max_chars: 2000 },
      { tool: 'codex_notify', maxSeconds: 86400, signal: this.controller.signal },
    )).then(async (result) => {
      if (this.closed) return; // Keep watching receipts resumable after MCP shutdown.
      if (result?.ended !== true) {
        this.setState(receipt, 'delivery_failed', 'Wait ended without a terminal run');
        this.log('Wait ended without a terminal run');
        return;
      }
      // Re-read before sending: sending/unknown/delivered receipts never cause a second call.
      if (!this.claimSending(receipt)) return;
      try {
        const status = typeof result.status === 'string' && /^[a-z_]+$/.test(result.status) ? result.status : 'unknown';
        const prompt = `运行 #${receipt.run}（座位 ${receipt.seat}）已结束，status=${status}。请用 task_result(run=${receipt.run}) 取回结果，并按原授权验收。`;
        const response = await this.appClient.request('tools/call', {
          namespace: 'codex_app', tool: 'send_message_to_thread',
          arguments: { threadId: receipt.threadId, prompt },
          callerSource: 'codex', hostId: 'local', threadId: receipt.threadId,
          turnId: receipt.turnId, callId: randomUUID(),
        });
        if (response?.success !== true) throw failure('App did not confirm delivery');
        if (this.closed) throw failure('Bridge closed during delivery', true);
        this.setState(receipt, 'delivered');
      } catch (err) {
        const state = err.deliveryUnknown !== false ? 'delivery_unknown' : 'delivery_failed';
        this.setState(receipt, state, state === 'delivery_unknown' ? 'App delivery outcome unknown' : 'App delivery rejected or unavailable');
        this.log(receipt.error);
      }
    }).catch(() => {
      if (this.closed) return;
      try { this.setState(receipt, receipt.state === 'sending' ? 'delivery_unknown' : 'delivery_failed', 'Completion watcher failed'); }
      catch { /* Leave sending intact if persistence failed: it must never be resent. */ }
      this.log('Completion watcher failed');
    });
  }

  close() {
    this.closed = true;
    this.controller.abort();
    if (this.enabled) this.appClient?.close();
  }
}
