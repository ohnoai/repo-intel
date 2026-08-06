---
title: "Repository Intelligence - knowledge base"
status: active
owner: Joey
created: 2026-07-22
updated: 2026-08-06
branch: "main"
---

# Repository Intelligence - knowledge base

**Relocated 2026-08-06.** This knowledge base and the exporter it documents were extracted from
`ohnoai/sliceboard` into their own repository, `ohnoai/repo-intel`, so the tool has one home
instead of being copied into every project that wants to use it. Everything below is carried over
from the original knowledge base substantively as written. In particular, `scripts/intelligence/`
path references in `01-overview.md` through `04-remediation-plan.md` now mean this repository's
root (`export.mjs`) and its `lib/` directory - no per-occurrence edits were made; this paragraph is
the one-time translation. See
[`decisions/2026-08-06-repository-intelligence-exporter-extraction.md`](decisions/2026-08-06-repository-intelligence-exporter-extraction.md)
for the extraction itself.

This directory is the **single canonical location** for the Repository Intelligence Exporter:
what it is, how it got here, its verified current state, and the plan to finish it. It consolidates
material that previously lived "everywhere and nowhere" - a long external planning thread, a cloud
document, and scattered working notes - none of which were in the repo.

It was compiled and verified on 2026-07-22 by a bounded multi-agent swarm (five repo investigators
+ a reconciler → an architecture proposer + a three-lens adversary panel → an independent verifier
that re-ran the code). Where this knowledge base and any older doc/spec disagree, **this is
authoritative and the repo is ground truth.**

## Read in this order

1. [`01-overview.md`](01-overview.md) - what the exporter is, its purpose, its relationship to the
 PR staging gate (PR #29) in the original SliceBoard repository, and the frozen V1 scope.
2. [`02-history-and-decisions.md`](02-history-and-decisions.md) - how the project got here, the
 adversarial-review process, and the settled contract decisions **with their rationale**.
3. [`03-current-state.md`](03-current-state.md) - the repo-verified current state, file inventory,
 and defect ledger.
4. [`04-remediation-plan.md`](04-remediation-plan.md) - the seven contracts and the ordered S0-S7
 implementation slices, with owner decisions, non-goals, and open risks.

## Related tracked records

- Decision record (ADR): [`decisions/2026-07-18-repository-intelligence-collection-boundaries.md`](decisions/2026-07-18-repository-intelligence-collection-boundaries.md)
 - the collection/privacy boundary decisions.
- Decision record (ADR): [`decisions/2026-08-05-repository-intelligence-exporter-branch-reconciliation.md`](decisions/2026-08-05-repository-intelligence-exporter-branch-reconciliation.md)
 - a branch-reconciliation record from while this still lived in SliceBoard, kept for history.
- Decision record (ADR): [`decisions/2026-08-06-repository-intelligence-exporter-extraction.md`](decisions/2026-08-06-repository-intelligence-exporter-extraction.md)
 - this extraction, and why `collect-product.mjs` stayed SliceBoard-tuned.
- The original build task record stayed behind in `ohnoai/sliceboard` at
 `docs/tasks/repository-intelligence-exporter.md` and was not moved here; it remains history in
 that repository. ⚠️ Its front-matter reads `status: complete`, which described a point-in-time
 working tree, not the true state - see `03-current-state.md` in this directory for the actual
 verified state.

## Status at a glance

See [`03-current-state.md`](03-current-state.md) for the verified current state (last updated
2026-08-05: 105 focused tests, file inventory, and the full defect ledger with per-item commit
status) and [`04-remediation-plan.md`](04-remediation-plan.md) for what's left (slices S3, S6, S7
still open). Re-verify commit-status claims against this repository directly - several items in
the ledger were last confirmed in a sandbox session without git access; see the notes inline in
`03-current-state.md`.
