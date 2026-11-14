# Using leader (caller guide)

The service contract is `roles/leader.md`. Shared rules: `dispatch_guide` without `role`.

## When to dispatch

- You want to act as the client for an entire requirement, delegating decomposition, implementation decisions, member dispatch, and acceptance. The upstream host passes the requirement; leader chooses an available Claude Code, Codex, or Antigravity backend (R-6).
- For a small job with one acceptance sentence, dispatch the member directly. Another lead adds cost.

## Required brief

- `cwd`: absolute project directory, passed to dispatched members.
- The requirement, a one-sentence acceptance criterion, allowed paths, and prohibited paths.
- Do not prescribe decomposition or member assignment; that is leader's work.

## After delivery

- The first sentence states the outcome; the report lists dispatched runs and seat IDs. Inspect cited results or retrieve original reports using `task_result`.
- Leader runs longer because it waits for members: its timeout is 240 minutes (`roles.json timeout_minutes`).

## Do not

- Fix the implementation approach in the brief; dispatch coder directly if it is already fixed.
- Dispatch several leaders at once. Their member runs share the service's concurrency limit of 10.
