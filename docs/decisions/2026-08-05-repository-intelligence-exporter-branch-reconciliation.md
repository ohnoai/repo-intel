# Repository Intelligence Exporter Branch Reconciliation

## Context

`feat/repository-intelligence-exporter` had drifted behind `main` (former `main` tip
`45700fc`) while in-progress work sat uncommitted-then-committed as `6f65786`
("Repository intelligence exporter: WIP updates"). Per
`docs/decisions/2026-07-17-branch-worktree-reconciliation.md`, this branch is shared
across worktrees/agents, so the required reconciliation method is `merge
origin/main`, not rebase.

## Decision

Reconciled the branch by merging `origin/main` into
`feat/repository-intelligence-exporter`, producing merge commit `84807cd` ("Merge
remote-tracking branch 'origin/main' into feat/repository-intelligence-exporter").

The merge surfaced one real conflict: `main` had independently added a fact-checker
team to `opencode.json`, silently clashing with this branch's own Reconcile team
definition in the same file. Follow-up commit `674127f` ("opencode.json: merge
Reconcile team with main's fact-checker team after silent overwrite") resolved this
by keeping both team definitions side by side in `opencode.json` rather than letting
either overwrite the other.

`HEAD` now matches `origin/feat/repository-intelligence-exporter` exactly; the merge
commit and the fixup commit are both already pushed. Commits involved: `45700fc`
(prior `main` tip), `6f65786` (WIP work being reconciled), `84807cd` (merge commit),
`674127f` (opencode.json fixup).

## Consequences

Post-merge verification (`npm run verify`) is a clean pass: typecheck passed, lint
passed with 0 errors and 6 pre-existing warnings, tests passed (48 files, 431 tests),
production build passed, and the audit reported 0 vulnerabilities.

The working tree also retains one uncommitted change to `scripts/intelligence/export.mjs`
(the `#!/usr/bin/env node` shebang line and following blank line removed). Correction to
Reconcile-Scribe's original note above: this did not predate the reconciliation. It was
made during it, by an out-of-process opencode run - a duplicate `Reconcile-Lead` invocation
that was accidentally left running (not killed before a second invocation was started after
the `opencode.json` fixup) and fell back to opencode's default `build` agent, which has
broad edit permissions unlike this project's Reconcile-* roles (`Reconcile-Verify` is
explicitly edit-denied). While investigating why `scripts/intelligence/export.test.mjs`
failed to load (`SyntaxError: Invalid or unexpected token`, caused by the shebang line not
being stripped when the file is imported as a module rather than run as an entry point,
which is how Vitest's transform pipeline loads it), that stray agent removed the shebang
as a fix. The fix is plausible and is why the clean `npm run verify` pass above includes
this file loading correctly - but it was never reviewed the way this reconciliation's own
process was designed to require. It has not been committed. Decide separately whether to
keep, revise, or revert it.

No further action is required for the branch-reconciliation itself; the branch is current
with `main` and both team definitions in `opencode.json` are preserved going forward.
