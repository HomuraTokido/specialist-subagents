# Using tester (caller guide)

The service contract is `roles/tester.md`. Shared rules: `dispatch_guide` without `role`.

## When to dispatch

- An observable claim needs independent verification: a fix, implementation, or integration.
- Independence is part of the deliverable; an author's own checks do not count as a second verification.

## Required brief

- `cwd`: absolute project directory.
- The claim: environment, input, and expected observation.
- Exact command or entry point and the smallest check that can falsify it.
- For output files, specify a directory inside cwd. The seat's file tools cannot read outside cwd; external artifacts can only be read through shell.

## After delivery

- Evidence includes commands, exit codes, key output, failure attribution, and skipped checks. Distinguish static, unit, integration, and real-machine evidence.
- Acceptance belongs to the lead; tester supplies evidence.
- Save reusable observed facts with `memory_write {role: "tester", kind: "lesson", body: "…"}`.

## Do not

- Ask tester to edit the product while testing; implementation belongs to coder.
