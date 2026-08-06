# Repository Intelligence Exporter Extraction

## Context

The Repository Intelligence Exporter (`scripts/intelligence/` in `ohnoai/sliceboard`) is
deliberately repository-agnostic: `--root` drives all file and configuration resolution, and
`lib/collect-planning.mjs`'s `.repo-intelligence.json` handling degrades cleanly to generic
defaults when no repository-specific config is present. Only `lib/collect-product.mjs` is
SliceBoard-tuned, and it degrades gracefully (returns no signals) against other repositories.

With a second project (`roster`, not yet on GitHub) starting up, the exporter was a candidate for
reuse. Running it out of sliceboard's own `scripts/` directory against a different `--root` would
have worked mechanically, but tied a general-purpose tool to one product's repository — anyone
using it against another project would be reading source, tests, and documentation that lived
inside, and appeared scoped to, SliceBoard.

## Decision

Extract the exporter — `export.mjs`, the six `lib/collect-*.mjs` collectors, `lib/run-command.mjs`,
`lib/sanitize.mjs`, and the full five-file Vitest suite — out of `ohnoai/sliceboard` into a new,
standalone repository, `ohnoai/repo-intel`, both on GitHub and as a local folder. The tool now has
one home; any project points `--root` at itself and runs it from there, rather than the tool being
copied into or embedded in any one project's repository.

Structure was flattened on extraction: `scripts/intelligence/export.mjs` becomes `export.mjs` at
the repository root, and `scripts/intelligence/lib/` becomes `lib/`. All relative imports between
these files were already relative to that layout and required no changes. The `#!/usr/bin/env node`
shebang stays removed, per
[`2026-08-05-repository-intelligence-exporter-branch-reconciliation.md`](2026-08-05-repository-intelligence-exporter-branch-reconciliation.md).

Code, tests, and the full `docs/repository-intelligence/` knowledge base (now this repository's
`docs/` directory) moved together, since the knowledge base documents the code's actual history and
known gaps, and neither is useful without the other. The two prior decision records
([`2026-07-18-…`](2026-07-18-repository-intelligence-collection-boundaries.md),
[`2026-08-05-…`](2026-08-05-repository-intelligence-exporter-branch-reconciliation.md)) were
**copied** here, not moved — SliceBoard's own documentation convention treats decision records as
permanent history, so the originals stay in `ohnoai/sliceboard` where the decisions were actually
made, alongside the original task record, which also stays behind.

`lib/collect-product.mjs` was carried over unchanged and is still SliceBoard-tuned (hardcoded
`product: "SliceBoard"`, signal patterns for `PizzaWindowChart`, `MAX_PIES`, `fixed-pot`, Stripe,
etc.). It is the one non-generic collector of the six. Generalizing it — the same way
`collect-planning.mjs` became repository-agnostic via `.repo-intelligence.json` — is open work, not
started. Documented as a known limitation in this repository's `README.md`.

The known-incomplete state of the tool (slices S3, S6, S7 still open, per `04-remediation-plan.md`
in this repository) was extracted as-is. Extraction does not fix, and was never intended to fix,
the tool's remaining gaps.

Sliceboard's own copy (`scripts/intelligence/`, `docs/repository-intelligence/`, and the four
`test:intelligence:*` package.json scripts) is to be removed following this extraction, once
verified that nothing in `ci.yml`, `scripts/review-preflight.mjs`, or `opencode.json` depends on it,
and that `docs/code-map.md` is updated to point here instead.

## Consequences

`ohnoai/repo-intel` is now the single source for the exporter; running it against any repository —
SliceBoard included — means pointing `--root` at that repository from wherever `repo-intel` is
checked out, not copying files into the target repository.

Once sliceboard's copy is removed (see Context), anyone looking for this history in sliceboard from
that point forward should expect to find only a decision record pointing here, not the
implementation itself.

The extraction is a pure move-and-flatten: no collector logic, sanitization behavior, or test
assertion was changed from what shipped in sliceboard. The 105 focused tests that passed there as of
2026-08-05 are expected to pass unchanged here, but this was **not independently re-run** as part of
the extraction itself (files were transferred via the GitHub API, not a live `npm test` run in this
repository) — verify with `npm test` here before relying on a current pass count.
