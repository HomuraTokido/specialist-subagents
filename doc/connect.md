# Connecting to specialist-subagents

This is the deployment and client connection guide. Requirements remain authoritative in [`doc/PRD.md`](./PRD.md). [Chinese guide](./connect.zh-CN.md).

Replace `<repo>` with the absolute path of your Git clone. Install Git and Node.js >= 22.19.0, clone the repository, and use a normal terminal. Escape backslashes in JSON/TOML or use forward slashes.

The service is a local HTTP daemon backed by SQLite. All MCP clients on a machine share its roles, persistent seats, records, and memory. A seat is a persistent expert slot; protocol names such as `seat_start` and `seat-coder-16` remain stable.

## Start the service

```sh
git clone https://github.com/HomuraTokido/specialist-subagents.git
cd specialist-subagents
node bin/specialist-subagents.mjs start
node bin/specialist-subagents.mjs status
```

Start listens in the foreground and is idempotent. Expect `daemon: running` with health JSON. Start the daemon from a normal terminal or install a watchdog: a daemon started inside a host's process/job can die with that host. The MCP bridge only connects; it never starts a daemon.

The default address is `http://127.0.0.1:43130`. Configure `SPECIALIST_SUBAGENTS_PORT` for both daemon and clients, or pass global `--port <number>` (takes precedence). Shut down interrupted runs are reconciled as `interrupted` on restart.

On first interactive start, onboarding offers optional pi installation or existing subscription CLIs. `start --non-interactive` never prompts; missing backends produce a warning without blocking daemon startup. `start --reset-onboarding` clears saved onboarding choices, including `skippedPiInstall`. For actual work, including `demo`, have at least one installed and logged-in Codex / Claude Code / Antigravity / Grok CLI, or a configured runtime with its API key (pi with `DEEPSEEK_API_KEY`). Detecting a binary does not prove authentication.

## Connect an MCP client

Any stdio MCP client can use command `node` and arguments `["<repo>/bin/specialist-subagents.mjs", "mcp"]`. The wire protocol is NDJSON JSON-RPC 2.0: one JSON object per line.

**Claude Code**, user scope:

```sh
claude mcp add -s user specialist-subagents -- node "<repo>/bin/specialist-subagents.mjs" mcp
```

Alternatively add this to project `.mcp.json`, preserving existing servers:

```json
{
  "mcpServers": {
    "specialist-subagents": {
      "command": "node",
      "args": ["<repo>/bin/specialist-subagents.mjs", "mcp"]
    }
  }
}
```

**Codex**, in `~/.codex/config.toml`:

```toml
[mcp_servers.specialist-subagents]
command = "node"
args = ["<repo>/bin/specialist-subagents.mjs", "mcp"]
```

**Antigravity**: register the same `mcpServers` object in `~/.gemini/config/mcp_config.json` (some host versions use `~/.gemini/antigravity/mcp_config.json`). Preserve existing entries. The `agy` execution backend is separate from the calling MCP host.

For headless MCP calls without unattended permissions, add the specific grants needed by the role under `userSettings.globalPermissionGrants.allow` in `~/.gemini/config/config.json`, for example `mcp(specialist-subagents/seat_start)`. A leader needs each tool in `src/lead-tools.mjs`; add all its required grants. Missing grants cause headless permission denial. The runner's unattended mode bypasses that grant check; it does not replace MCP server registration.

The service resolves agy from `SPECIALIST_AGY_BIN`, then `~/.local/bin/agy` (Windows: `agy.exe`, then `~/AppData/Local/agy/bin/agy.exe`), then PATH. An explicit empty or missing override disables fallback. `SPECIALIST_NO_HOST_PATH=1` disables PATH lookup.

**OpenCode**, in project `opencode.json`:

```json
{
  "mcp": {
    "specialist-subagents": {
      "type": "local",
      "command": ["node", "<repo>/bin/specialist-subagents.mjs", "mcp"],
      "enabled": true
    }
  }
}
```

**Grok CLI backend**: install and sign in to grok. The service can execute work through it regardless of which MCP client dispatched the work.

Set optional environment variables through the client's `env` configuration (OpenCode: `environment`). With `SPECIALIST_SUBAGENTS_TOKEN`, set the same token for daemon and clients. CLI/MCP send the bearer header automatically. Every HTTP route except GET /health requires that header; typing the monitor URL in an ordinary browser address bar cannot supply it. Use an authenticated local proxy or client when token protection is enabled.

## Language

Web UI, CLI, MCP initialize.instructions, top-level `dispatch/*.md`, and this guide default to English. Set `SPECIALIST_SUBAGENTS_LANG=zh` for Chinese CLI/MCP instructions and daemon page defaults; use `?lang=en` or `?lang=zh` and the EN / 中文 links to override the browser language. Requests retain the selected language.

Chinese dispatch originals live in `dispatch/zh-CN/`. `roles/*.md` deliberately remain unchanged in Chinese as authentic production engineering samples; changing UI language does not translate those contracts. `SPECIALIST_SUBAGENTS_CALLER_TITLE` customizes "the user" in English and the corresponding label in Chinese.

## Verify a connection

1. Call `role_list`: expect eight roles, including grant, deny_intent, and spawn metadata: coder, explorer, tester, web_researcher, handyman, librarian, refiner, leader.
2. Call `seat_start` with `{"role":"coder","task":"Do not use tools. Output only: hello from coder"}`. It returns immediately with a seat ID, running state, selection note, and next action. Without cwd this is a one-shot seat; supply an existing absolute cwd for persistent directory experts. web_researcher requires domain and rejects cwd.
3. With host completion notifications, continue other work and read `task_result` when notified. Otherwise run the returned CLI `wait` command in the background (Claude Code Bash: `run_in_background`), or use `task_wait` without background-command support. Expect a done result with the greeting.

A real dispatch consumes backend usage. Do not poll seat_show, seat_list, or task_result to wait.

## Tool surface (19 tools)

The default full profile exposes all 19 tools. `mcp --profile core` or `SPECIALIST_TOOL_PROFILE=core` exposes 15, hiding difficulty_report, difficulty_decide, candidates, and candidate_decide.

| Tool | Purpose |
| --- | --- |
| `role_list` | Role contracts, tiers, permissions, and dispatch metadata |
| `dispatch_guide` | Lead manual without role; caller guide with role; read fresh from disk |
| `seat_start` | Nonblocking dispatch; name a persistent expert using seat, or select by cwd/domain and optional topic |
| `task_wait` | Blocking fallback wait by seat or run; default 300 seconds; returns task_result on completion |
| `task_result` | Run status, usage, verdict, backlog, final report; default report budget 4000 characters, adjustable with max_chars |
| `seat_list` | Living experts, names, roles, objects, visits, backlog, expertise; filters role/cwd/domain/state; full:true returns raw rows |
| `seat_show` | Seat and newest result; request events:true, tail, or run explicitly for raw events |
| `seat_rename` | Unique semantic expert name, 1–80 trimmed characters; stable seat ID |
| `seat_close` | Archive an idle seat or kill a running seat's process tree and record cancellation |
| `task_cancel` | Cancel a run while preserving the expert and its records |
| `seat_merge` | Merge same-role experts through a handoff; archive source only after successful handoff |
| `seat_split` | Focused handoffs to parts with names and optional topic/cwd; archive original |
| `seat_verdict` | accepted, revised, or rejected; note required for the latter two; optional run |
| `memory_read` | Newest role memory first; default limit 20, minimum 1 |
| `memory_write` | fact (injected every run), lesson, or note; maximum 4000 characters |
| `difficulty_report` | Difficulties grouped by role, kind, and tool, with frequency, cost, and examples |
| `difficulty_decide` | Classify a difficulty as contract, dispatch, service, tool_or_project, or accept |
| `candidates` | Pending skill candidates or details by id, evidence, diff, and file path |
| `candidate_decide` | Classify supporting difficulties as real/invalid/sporadic; enable, reject with note, or defer |

Named dispatch validates role, object, archival state, and eligibility; busy persistent experts can use parallel instances according to the service contract. Directory identity follows real paths, including symlinks and junctions. Domain roles use domain names; inspect the roster and reuse them. Without a unique match, the service asks the caller to choose.

## Operating rules

Dispatch and acceptance policy lives in `dispatch/team-leader.md`; role caller guides are in `dispatch/<role>.md`. The MCP handshake supplies the lead manual; guides are read fresh for new sessions without restarting.

Concurrency is limited to 10 with no queue; excess dispatch is refused. Role memory is shared across clients: facts persist and affect later runs. Never edit `.data/ledger.sqlite3` directly. Cancel with task_cancel to preserve an expert, or seat_close to archive it; do not force-kill processes outside the service's cancellation path.

Roles except handyman and leader participate in the skill loop. Five new difficulties trigger a refiner candidate; it is not enabled automatically. Review with candidates and candidate_decide. Only enable writes the current candidate into the external skills directory; at least one real supporting difficulty is required. Remove changes based on invalid/sporadic evidence before enabling. The external skills repository is not committed by this operation. Each run records which skill version it loaded; missing skills do not block a run.

## Monitor, logs, and watchdog

`GET /` returns the HTML monitor wall; `GET /wall` returns its JSON data. `GET /settings` is the settings HTML. These are human-facing views, not substitutes for task_result. The wall appends activity and exposes backend selection; settings overrides are stored in `.data/presets.json`, selection in `.data/backend-prefer.json`. Repository `presets.json` remains the default, and existing local overrides can take precedence over updated defaults.

Logs: `.data/daemon.log` records startup (including parent PID), shutdown, and exceptions; `.data/watchdog.log` records watchdog activity. The watchdog checks about once a minute. Install from a normal user terminal, not an agent host:

- Windows: `pwsh -File tools/install-watchdog.ps1` (`-Remove` to uninstall).
- macOS: `sh tools/install-watchdog.sh`; the LaunchAgent template is `tools/watchdog.plist`.
- Linux: `sh tools/install-watchdog-linux.sh` installs the user-level watchdog.

Do not start competing daemons on the same port. Reboot ends the daemon; login/watchdog startup restores it.

## Complete CLI reference

```text
node bin/specialist-subagents.mjs [--port number] <command> [options]
start [--non-interactive] [--reset-onboarding]
status
stop
seats [state]
pool
wait <seat|run> [--timeout seconds]
refine <role>
mcp [--profile full|core]
demo
--help | -h
```

wait defaults to six hours (maximum 24); exits 0 when done, 1 after abnormal completion, 2 on usage errors, 3 on timeout. pool is a nonblocking snapshot and reports `pool: unknown` when unreachable. refine uses normal service eligibility rules. demo creates an isolated daemon and temporary ledger, does not touch the live service, and performs real backend work.

Environment: `SPECIALIST_SUBAGENTS_PORT` (43130), `SPECIALIST_SUBAGENTS_TOKEN`, `SPECIALIST_SUBAGENTS_LANG` (en; zh for Chinese), `SPECIALIST_SUBAGENTS_CALLER_TITLE`, and `SPECIALIST_TOOL_PROFILE` (full or core). Runtime configuration uses `SPECIALIST_SUBAGENTS_RUNTIME` or repository `.runtime.json`; malformed JSON is an explicit error.

`npm test` runs the test suite. `node tools/prd-check.mjs` separately evaluates PRD requirements and end-to-end scenarios; eight host/ledger/knowledge-store checks require local evidence and a clean clone therefore exits 1. Neither binary discovery nor a passing component test proves a real backend can execute work.
