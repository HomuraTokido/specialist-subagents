// A minimal MCP client over stdio (NDJSON JSON-RPC), talking to the copy of src/mcp-stdio.mjs
// that sits inside a sandbox, so it reaches the sandbox's daemon and nothing else.
import { spawn } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';

// `env` adds to the sandbox's environment: R-6's tests start the bridge the way a seat's backend does,
// with SPECIALIST_CALLER_SEAT and SPECIALIST_CALLER_DISPATCH set.
export function startMcp(service, env = {}, args = []) {
  const child = spawn(process.execPath, [path.join(service.root, 'src', 'mcp-stdio.mjs'), ...args], {
    cwd: service.root,
    env: { ...service.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const waiting = new Map();
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    waiting.get(message.id)?.(message);
    waiting.delete(message.id);
  });
  let next = 1;
  // `timeoutMs` for a call that is meant to take a while (a split writes one hand-off run per part);
  // the default stays short so a tool that does not answer is reported, not waited out.
  const request = (method, params, timeoutMs = 15000) => new Promise((resolve, reject) => {
    const id = next++;
    const timer = setTimeout(() => reject(new Error(`no MCP reply to ${method}`)), timeoutMs);
    waiting.set(id, (message) => { clearTimeout(timer); resolve(message); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  return {
    request,
    // H-3: how a client introduces itself. `clientInfo` is what an MCP client sends at initialize
    // ({ name, version }); the shell keeps it as the host that is asking for work.
    init(clientInfo = null) {
      return request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo });
    },
    // The tool's text payload (the first content block, and every block in `blocks`), and whether the
    // shell flagged it as an error.
    async tool(name, args = {}) {
      const reply = await request('tools/call', { name, arguments: args });
      const result = reply.result;
      return { text: result.content[0].text, blocks: result.content.map((c) => c.text), isError: Boolean(result.isError) };
    },
    // Resolves once the process has exited. It runs with the sandbox as its working directory, and on
    // Windows a process holds that directory until it is gone: removing the sandbox right after a kill
    // that was not waited for failed with EBUSY (wall.test.mjs H-3, every Windows CI run on 2026-10-21).
    // Callers await this before stopping the service, whose stop() removes the sandbox.
    close() {
      if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
      const exited = new Promise((resolve) => {
        const timer = setTimeout(resolve, 5000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
      });
      child.stdin.end();
      child.kill();
      return exited;
    },
  };
}
