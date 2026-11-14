# Lead manual: using specialist-subagents

`doc/PRD.md` is authoritative for service requirements and `node tools/prd-check.mjs` determines implementation status. This manual governs callers.

This is the dispatching lead's (main's) manual. The MCP handshake sends the entire manual as instructions, including when the host defers tool loading. Retrieve it again with `dispatch_guide` without `role` if missing or truncated. Request a role's caller guide with `role`. Role contracts live in `roles/<role>.md`. Only the lead edits this manual and skill bodies; specialists deliver proposed locations and evidence.

## The lead's responsibilities

The lead sets objectives, makes decisions, dispatches, and accepts results. Once the user authorizes a task, decide whether to dispatch by total cost without waiting for a separate delegation request. Keep product semantics, architecture, interface tradeoffs, priorities, release, final acceptance, and skill bodies with the lead.

## Whether to dispatch (in order; do it yourself if any gate fails)

1. Two hard vetoes: do not delegate work requiring repeated back-and-forth; do not dispatch parallel writes to the same files.
2. Compare tokens multiplied by model prices (R / H). R is the lead's own reading, writing, and output cost; H is its handoff cost (brief, report, acceptance rereads), amplified by rework probability p. Prices differ substantially between lead and member models. With clear boundaries and no repeated checking, dispatch even when total token counts are similar. Do it yourself only when handoff and rework make delegation more expensive at actual prices.
3. If acceptance cannot be stated in one sentence, split further or do it yourself.

## Which role

| Work | Role |
| --- | --- |
| Repository facts: contracts, call chains, change boundaries | `explorer` |
| Mutable external facts: pages, versions, prices, dates | `web_researcher` |
| Implementation within approved scope | `coder` |
| Independent verification of a claim | `tester` |
| Hwiki writing and organization | `librarian` |
| Other one-off work | `handyman` |

Use the matching specialist; do not invent roles. The service dispatches `refiner` automatically; the lead does not.

## Writing a brief

- State objective, allowed read/write paths, prohibited actions, and a one-sentence acceptance criterion. Leave execution details to the specialist. Reconsider delegation if explaining nearly completes the work.
- Coder is the exception: fix the implementation approach, files, changes, and tradeoffs. Have explorer map investigative or judgment-dependent parts first; the lead chooses the approach and dispatches coder (2026-10-10, the user; see `dispatch/coder.md`).
- web_researcher identifies experts by domain: supply `domain` (for example knowledge topics `openai` or `agent-infra`), never cwd. The service supplies its directory. First inspect `seat_list` and reuse existing domain names; each new name starts a new expert.
- Supply absolute `cwd` for other roles. Built-in read/edit/write tools are restricted to cwd, so copy external reference material inside it or include it in the brief. Roles with bash, including Antigravity headless execution, depend on backend sandbox and contract enforcement: an allowlist alone does not block shell writes. Librarian (`commit_after_run`) automatically stages and locally commits **all uncommitted changes inside cwd**; never use a directory with unfinished manual changes. When the target repository explicitly enables `git config --local claude.allowPush true`, the service also pulls and pushes before and after organization.
- Each run gets one deliverable with one acceptance sentence. Split multiple criteria, versions, and sizes, or retain only those needed now.
- Specify the output directory inside cwd when files are required, including read-only assignments.
- Describe differences between test and production environments (missing same-domain sites, server-generated error pages), or filter those findings during acceptance.
- Cite source paths and line numbers for the specialist to read. Do not paste whole source blocks: they cost more and become stale. Task bodies enter the spawn command; the service switches oversized tasks to files and explicitly refuses only if that cannot help.

## After dispatch

- Do not watch the worker. With host completion notifications, continue other work or end the turn, then read `task_result` when notified; no extra wait is needed. Otherwise use background CLI `wait` or `task_wait`. Claude Code can run the `next` wait command through background Bash (`run_in_background`); its exit wakes the host. Use task_wait only without background commands. Never poll seat_show, seat_list, or task_result to wait.
- One owner per job. Do not investigate the same facts in parallel or reread the whole cited batch for reassurance. Return gaps to the same role in the same cwd (same domain for web_researcher), continuing its session.
- Use `seat_start seat` to name an expert. Use `seat_rename` for names that describe expertise; choose by name in seat_list.
- Stop a run through `seat_close`. The service stops runs exceeding their role timeout (60 minutes by default).

## Acceptance

- Deliveries are material to verify, not decisions. Coder's claims need tester or lead verification. Web summaries need opened original pages. Reproduce test findings, remove false positives, then relay them to the user.
- Record `seat_verdict` after checking: `accepted` as delivered, `revised` after changes, or `rejected`; explain the latter two.
- Review skill candidates through `candidates` and `candidate_decide`. Mark caller-caused difficulties invalid. Propose the lesson to the user and update this manual only after approval.
