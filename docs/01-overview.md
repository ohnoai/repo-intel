# 01 · Overview

## What it is

The **Repository Intelligence Exporter** is a local, read-only, zero-dependency Node CLI
(`scripts/intelligence/export.mjs`) that walks the SliceBoard repository and emits a **sanitized,
portable evidence bundle** describing the project: its files, git state, configuration, delivery/CI
surfaces, planning documents, and product/runtime signals. The bundle can then be handed to any model
(ChatGPT, Claude, a local model) for grounded architecture analysis **without that model having to
rediscover the repo from scratch** every time.

Design principles:

- **Deterministic & offline.** Node standard library + `node:test` only. No paid APIs, no network, no
 model calls.
- **Read-only.** It must not mutate application behavior or repository state.
- **Privacy-first.** It must never read real `.env` values, never export secrets, tokens, local
 absolute paths, or private user data. Environment variables are reported **by name only**.
- **Evidence, not judgment.** Findings are labeled (`observed_fact | documented_intent |
 mechanical_inference | unresolved`). A detector matching a file means that file is a **relevant
 surface**, never that it is defective.

## What it produces (today)

Running the CLI writes **two artifacts** - `evidence-bundle.json` and `summary.md` - into
`tmp/repository-intelligence/`. The bundle carries a top-level `schemaVersion` and one section per
collector. (The original spec envisioned a richer `.project-intelligence/` layout with
`manifest.json`, a README, and `evidence.json`; the code took a leaner path. See §History for why,
and the remediation plan for the frozen V1 decision.)

The six collectors:

| Collector | Emits |
|---|---|
| files | repository file inventory (via `git ls-files` + fs fallback), classification, `.env*` flagged but never read |
| git | branch/head/worktree/commit metadata + a diff summary (name-status/numstat, never raw patch) |
| configuration | environment-variable **names** + visibility classification (never values) |
| delivery | CI workflows, deployment config, workflow env/secret **names** |
| planning | authority/decision/task doc metadata + a (currently stubbed) external-context slot |
| product | product signals + risk-surface detection via bounded source scans (paths only) |

## Relationship to the PR staging gate (PR #29)

The exporter is a **sibling** to the merged PR #29 "PR staging gate" (`scripts/review-preflight.mjs`),
not a replacement:

- **PR staging gate** examines *one branch / change set* and produces branch-readiness evidence.
- **Repository Intelligence Exporter** maps the *broader project and development system*.

The two are deliberately **independent** - neither depends on the other's generated output. A future
read-only dashboard may consume artifacts from both, but that dashboard remains a *view over generated
evidence*, never the source of truth. Both the dashboard and any GitHub/`gh` enrichment are **phase-two**.

## V1 scope (FROZEN - owner-confirmed 2026-07-22)

V1 is exactly the current shape: the six local collectors above, two artifacts, offline and
deterministic. The work remaining is **stabilization and hardening**, not expansion. See
[`04-remediation-plan.md`](04-remediation-plan.md) for non-goals in full. In short, V1 will **not**
add: GitHub enrichment or any network access, a dashboard/UI, AST-based parsing, full
YAML/TOML/JSONC language parsers, raw diffs, multi-repo or historical analysis, or the spec's
`.project-intelligence/` / manifest layout. Those are explicitly deferred.
