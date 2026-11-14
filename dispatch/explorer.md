# Using explorer (caller guide)

The service contract is `roles/explorer.md`. This guide governs dispatching. Shared rules: `dispatch_guide` without `role`.

## When to dispatch

- You need local repository facts: contracts, call chains, configuration keys, change boundaries, or evidence locations.

## Required brief

- `cwd`: the directory to investigate. Only its contents are readable.
- The factual question, in one sentence.
- Evidence format: `path:line` plus a concise conclusion.

## After delivery

- The report is material to assess. Have tester independently verify important conclusions, or open the one or two cited locations yourself. Do not reread the entire batch of files.
- Return gaps in a follow-up in the same cwd.
- Record durable facts with `memory_write {role: "explorer", kind: "fact", body: "…"}`.

## Do not

- Ask explorer to edit files.
