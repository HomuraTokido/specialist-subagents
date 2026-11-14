# Using web_researcher (caller guide)

The service contract is `roles/web_researcher.md`. Shared rules: `dispatch_guide` without `role`.

## When to dispatch

- You need mutable external facts: web pages, versions, prices, release dates, or third-party behavior.

## Required brief

- The single question to answer.
- The criterion for sufficient evidence.
- Time or version boundaries.

First check `memory_read {role: "web_researcher"}` for existing stable facts; do not dispatch when they already answer the question.

## After delivery

- Search snippets are not evidence. Conclusions must cite original pages the researcher actually opened; inspect the links.
- Save stable facts with `memory_write {role: "web_researcher", kind: "fact", body: "conclusion + source + date"}`. Dispatch librarian for Hwiki writes.

## Do not

- Ask the researcher to edit files.
