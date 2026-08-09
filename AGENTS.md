# AGENTS.md

This file provides guidance to any agent working with code in this repository.

## Project memory

Keep durable decisions in [`docs/decisions/`](docs/decisions/). [`docs/README.md`](docs/README.md)
is the canonical knowledge-base index - read it before adding or restructuring any document.

`.repo-intelligence.json` at the root, if present, declares a repository's own authority
documents, planning directories, and product signals for **repo-intel** (this tool) to read
when someone points `--root` at it. This repository doesn't have one of its own yet - the
planning and product collectors fall back to their generic defaults (`AGENTS.md`, `README.md`,
`docs/code-map.md` as authority documents; no configured product signals) when run against
this repo, the same way they would against any repository that hasn't configured one.

## Task records

**Two systems are in play here. They are not interchangeable and neither replaces
the other.**

**veans / Vikunja - live execution state.** If `veans prime` runs on `SessionStart` and tells
you to use veans instead of `TodoWrite`, that instruction is correct and means exactly what it
says: veans replaces the *ephemeral in-session todo list*, not this repository's records.
Claim a task before you start (`veans claim #N`), move it to **In Review** when you finish, and
**never mark it Done yourself** - a human closes it once the work has actually landed. Config
is `.veans.yml` at the root: committed, no secrets in it, the bot token lives in the OS
keychain. Bot identity is `bot-repo-intel` against `tasks.ohnoai.xyz`. The `SessionStart`/
`PreCompact` hooks that fire `veans prime` automatically (`.claude/settings.json`,
`.opencode/plugin/veans-prime.ts`) are local machine config, not committed - see `.gitignore`.

Note that the task's project-relative identifier is not its database id. The JSON returns
both - `"id"` (a global database id, not project-scoped) and `"identifier"` (this project's
own numbering) - and only `"identifier"` works with `claim`, `show`, and `update`. This
project's identifier prefix is `INTEL`, so task 1 is `INTEL-1`, not a bare `#1` - check the
prefix per-project rather than assuming one.

**`docs/decisions/` - the durable repository record.** This repository doesn't have a
`docs/tasks/` execution-log convention the way some sibling repositories do; durable facts
here are decision records, not per-task working files. If a change genuinely needs its own
working file (spans multiple sessions or agents, needs a paper trail beyond what a Vikunja
card carries), start one in `docs/tasks/` following the same shape as an entry in
`docs/decisions/` - short kebab-case filename, a `status:` line, evidence over intent - rather
than assuming scaffolding (a `README.md`, a `TEMPLATE.md`) that doesn't exist here yet.

> **State in Vikunja, record in the repo.** A Vikunja card answers "what is being worked on
> right now". A decision record (or task file) answers "what happened, and why". If you
> somehow only manage one, make it the repo record - that is the half that persists.

Adapted from `ohnoai/sliceboard`'s `AGENTS.md`, per the reconciliation note in
[`docs/decisions/2026-08-08-external-planning-surfaces.md`](docs/decisions/2026-08-08-external-planning-surfaces.md)
§8 - written for the first repository other than SliceBoard to get a `.veans.yml`.
