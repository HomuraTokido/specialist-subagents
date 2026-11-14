# Using librarian (caller guide)

The service contract is `roles/librarian.md`. Shared rules: `dispatch_guide` without `role`.

## When to dispatch

- Write verified findings to Hwiki, organize notes, or list stale notes.

## Required brief

- `cwd`: Hwiki repository root.
- Conclusions, sources, and verification dates.
- Target note path or title, or permission to locate it.
- If a new source differs from an old note, say "the new claim is …", rather than "correct it to …" or "it no longer matches the official source". Old notes record verification at that time; the new claim shows the source has changed.

## After delivery

- The service makes a local Hwiki commit after each run. The lead checks that the commit contains the intended changes.

## Do not

- Ask for facts about the user: those belong in private user memory, not Hwiki's AI area.
