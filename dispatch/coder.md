# Using coder (caller guide)

The service contract is `roles/coder.md`. This guide governs dispatching. See the lead manual (`dispatch_guide` without `role`) for shared rules.

## When to dispatch

- The objective, allowed changes, and acceptance criteria are settled; implementation remains.
- Product semantics, architecture, and interface tradeoffs remain the lead's decisions.

## Required brief (do not dispatch with gaps)

- `cwd`: absolute project path. All referenced documents and code must be inside it; the seat cannot read outside cwd.
- Target behavior after the change.
- Paths allowed for writing and paths that must remain untouched.
- An observable acceptance target: who can verify it and how.

The lead fixes the implementation approach; coder follows it. Specify files, changes at each location, and tradeoffs. Coder performs nearly mechanical implementation, without investigating or designing for the lead. First obtain an explorer change map (locations, paths, line numbers, call chain) when the code is not yet understood. The lead chooses the approach from that map, then dispatches coder.

- Before dispatch, match every statement about existing behavior ("X commits automatically", "Y refreshes the index") to the explorer report's exact evidence and line numbers. Omit unsupported claims or investigate first.

## After delivery

- Coder delivers unverified implementation claims and runs neither tests nor builds. Dispatch tester or have the lead run the narrowest relevant check.
- Return gaps to coder in the same cwd, stating the previous conclusion and required follow-up.
- Coder does not commit or push; the lead handles commits after acceptance.

## Do not

- Ask coder to write or edit skill bodies.
