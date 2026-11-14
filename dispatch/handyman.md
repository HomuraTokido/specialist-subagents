# Using handyman (caller guide)

The service contract is `roles/handyman.md`. Shared rules: `dispatch_guide` without `role`.

## When to dispatch

- Eliminate specialist roles first: explorer for repository facts, web_researcher for external research, coder for approved implementation, tester for independent verification, librarian for Hwiki. Use handyman only when none applies.
- One-off small work: read a batch and report conclusions, run a command sequence, or make a small change. Dispatch only when it saves the lead's tokens.

## Required brief (do not dispatch with gaps)

- `cwd`: absolute working directory. Without cwd the seat works once in an empty service-owned directory and cannot reach project files; use this deliberately for isolation.
- The result and a one-sentence completion criterion.
- Allowed read/write paths and prohibited paths. Handyman deletes nothing: specify the destination directory for anything to move.

## After delivery

- Delivery states actions, changed paths, and unfinished work; it is not acceptance. The lead inspects important results or asks tester.
- For an unfamiliar visitor's website trial, omit cwd and provide only the URL. Reproduce each reported issue before relaying it to the user.
