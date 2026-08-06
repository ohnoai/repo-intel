# 03 · Current state (repo-verified)

Every item here was re-verified against the actual repository on 2026-07-22 (runtime probes, `git`,
direct file reads) by the swarm's reconciler and again by an independent verifier. Line numbers were
accurate at time of writing; verify against current code before relying on them.

**2026-07-26 update:** slices S4 and S1 were implemented and committed by Joey following the first
working session (see `04-remediation-plan.md`). A second working session in the same day then
implemented S2 and S5, reflected in the defect ledger below as "implemented, uncommitted" - the
implementing agent had no git access in its sandbox (the worktree's `.git` pointer resolves to a
Windows path outside the sandbox), so these changes are working-tree edits only - not committed, not
yet independently re-verified by a fresh swarm pass the way the rest of this document was. Treat the
"implemented, uncommitted" rows as a strong claim from the same session that wrote the code and ran
its tests (96→101 focused intelligence tests, the full 391-test app suite, lint, and typecheck all
green against those changes), not as an independently reconciled fact the way the rest of this file
is. Re-verify after commit.

**2026-08-05 update (PR #55 review pass):** three fixes landed on
`feat/repository-intelligence-exporter` after review - object-key sanitization
(`RI-KEY-SANITIZE`), skipping diff collection when the caller does not want it (`RI-07` part a), and
listing collector warnings in `summary.md` rather than only counting them. Unlike the S2/S5 rows
below, these *were* run: `npm run typecheck`, `npm run lint` (0 errors, 6 pre-existing warnings),
the 105 focused intelligence tests, `npm run build`, and `npm audit --audit-level=high` (0
vulnerabilities) all pass against a clean clone of the branch. One app test,
`src/lib/shareLink.test.ts > returns a local UI mock when the API is unreachable in DEV`, fails
identically on the unmodified branch head and passes in CI, so it is environment-dependent and
unrelated - but it is a real local-verification gap worth chasing separately. Two ledger rows
(`RI-CI-SMOKE`, and the `RI-04` note about decision D1) were opened rather than fixed.

**2026-08-06 note (repo-intel):** this document is carried over from `ohnoai/sliceboard` as of the
extraction and was not re-run against the new repository layout. Treat every claim above as dated to
sliceboard prior to extraction; see `docs/README.md`'s relocation note and reverify with `npm test`
here before relying on current pass/fail counts.

## What the exporter actually is

- A deterministic, local, read-only **6-collector Node CLI** at `scripts/intelligence/export.mjs`
 (collectors: files, git, configuration, delivery, planning, product).
- Writes **`evidence-bundle.json` + `summary.md`** into `tmp/repository-intelligence/`. There is no
 `.project-intelligence/` dir, `manifest.json`, `README`, `evidence.json`, or GitHub enrichment.
- CLI flags: `--root --output --overwrite --include-diff --base --help`. `schemaVersion: 1` is a literal on
 the bundle only; there is no dedicated schema/validate/write module - logic is inlined in
 `export.mjs` + `sanitize.mjs`.
- A final validation boundary **does** run in production (`writeArtifacts → validateArtifact →
 assertSanitizedText`, before any write) - but it is **hollow** for the metadata tier (see RI-VALIDATOR).
- **105 focused tests pass** as of 2026-08-05 (sanitize 33, collectors 23, configuration 22,
 export 19, planning-product 8), verified by running them. The "77" in earlier revisions of this
 file was the 2026-07-22 snapshot; 101 was the 2026-07-26 snapshot.

## File inventory (git state as of baseline `60d7e9c`)

As of the S0 baseline commit, the exporter files are all committed. Before that commit they were
untracked/modified - which is why there was previously no honest rollback point.

- `scripts/intelligence/export.mjs` - CLI orchestrator (`parseArguments`, `composeEvidence`,
 `renderSummary`, sanitize + validate + `writeArtifacts`, exit-code guard).
- `scripts/intelligence/lib/collect-{files,git,config,delivery,planning,product}.mjs` - the six collectors.
- `scripts/intelligence/lib/run-command.mjs` - `spawnSync` wrapper + error classification.
- `scripts/intelligence/lib/sanitize.mjs` - redactor + validator (includes the metadata-tier redactors).
- Tests: `sanitize.test.mjs`, `collectors.test.mjs`, `configuration.test.mjs`,
 `planning-product.test.mjs`, `export.test.mjs`.
- `collect-planning` includes a **hardcoded google-drive external-context stub** that always reports
 `unavailable / accessed:false`; `renderSummary` structurally depends on it.

(In `ohnoai/repo-intel`, this inventory is flattened: `export.mjs` at the repository root,
`lib/collect-*.mjs`, `lib/run-command.mjs`, `lib/sanitize.mjs`, and the five `*.test.mjs` files also
at the repository root, per the 2026-08-06 extraction decision record.)

## Verified defect ledger

Sourced from the swarm; severities and IDs carried into the remediation plan. "Confirmed" = an agent
independently reproduced it against the repo.

| ID | Sev | Status | One-line |
|---|---|---|---|
| RI-GIT-BASE | 🔴 Crit | **implemented, uncommitted (S2)** | `collect-git.mjs`'s default base-ref resolution is now `merge-base(HEAD, main)` → `@{upstream}` → `HEAD` (was: `@{upstream}` → `HEAD`, i.e. a branch's own upstream, which is always caught up with itself). Resolving to literal `HEAD` now emits a warning ("expected, not a failure") instead of silently reporting `complete` with zero changed files. A new `--base <ref>` CLI flag threads an explicit override through `composeEvidence` into the collector. Regression-tested with a fixture that reproduces the exact original symptom (feature branch with a real unmerged file against `main`, no upstream configured) and confirms the new default now finds it. |
| RI-VALIDATOR | 🟠 High | **implemented, uncommitted (S1)** | The final write-gate now runs `assertSanitizedMetadata` (`export.mjs`'s `validateArtifact`), a constrained-superset detector independent of the redactor's own allowlist. It fatals on unredacted local paths (drive-letter, UNC, `file://`, POSIX root-based and generic-shape) and PowerShell `$env:`/`SetEnvironmentVariable` residue. Covered by a new `export.test.mjs` case (`sanitizer` override leaking `/usr/local/secret-build` → throws) and 17 new `sanitize.test.mjs` cases. |
| RI-PATH-ALLOWLIST | 🟠 High | **implemented, uncommitted (S1)** | `LOCAL_ROOT_SEGMENTS` in `sanitize.mjs` now includes `usr`, `srv`, `data`; UNC paths, `file://` URIs, and PowerShell `$env:`/`SetEnvironmentVariable` are redacted via shared detector functions also used by the validator (redactor⊇validator by construction, not by a separately-maintained parity test). A generic non-allowlisted-root heuristic (3+ segments, or 2 segments with a file-extension tail) catches paths outside any fixed list; tuned against SliceBoard's own `/api/stripe-webhook` and `/s/:id` routes as an explicit negative corpus so those never fatal. **Maintenance note (2026-08-05):** that corpus is the *current* route set. The 3+-segment rule means a future route like `/api/slices/export` will be redacted to `[REDACTED:local-path]` in collected metadata. The failure mode is over-redaction, never leakage, so it is safe by default - but if the app grows deeper route shapes, expect noise in the bundle and re-tune `isSuspiciousPosixPath` against an updated negative corpus rather than loosening the validator. |
| RI-GIT-ISREPO | 🟠 High | confirmed | Any transient git failure (non-zero exit, timeout, permission/lock) collapses to `isGitRepository:false` - misreporting a real repo as not-a-repo. **Not in scope for S1/S4; still open.** |
| NEW-PRIVACY-TESTGAP | 🟠 High | confirmed | The "never open `.env`" guarantee has **zero** filesystem-access test instrumentation (tests only check output). Code honors it, but nothing guards it. **S7, still open.** |
| RI-STATUS | 🟡 Med | needs-decision | Healthy repo reports `partial` because dynamic-env observations share the `warnings` channel that drives status. **S3, still open.** |
| RI-WORKFLOW-FLATTEN | 🟡 Med | **implemented, uncommitted (S5)** | Workflow env/secret names in `collect-delivery.mjs` are now typed `{name, provenance: [...]}` records (`env-declaration \| env-context \| secret-reference \| shell`), merged via a shared `mergeTypedRecords` helper so a name reached through more than one source keeps every provenance instead of collapsing to one (verified: `DEPLOY_REGION` in the existing fixture correctly shows both `env-declaration` and `shell`). Bare `$NAME`/`${NAME}` shell captures are now tagged `shell` provenance and exclude common CI/OS builtins (`GITHUB_*`, `RUNNER_*`, `ACTIONS_*`, `CI`, `HOME`, `PATH`) so they no longer pollute the set as if they were app-relevant. This is a breaking shape change (flat string arrays → typed objects) fixed in the same slice: two existing `configuration.test.mjs` assertions were updated, one new test added for the builtin-exclusion behavior. |
| RI-06 (`--output`) | 🟡 Med | **documented, uncommitted (S4)** | Behavior unchanged (`--output` still rejects every value except the one resolving to the default) but `--help` now says so explicitly, so the surface isn't silently misleading. Removing the flag was considered and rejected - `export.test.mjs`'s CLI-integration test passes it explicitly, and removing it would be a behavior change outside this slice's scope. |
| RI-07 (diff key) | 🟡 Med | **partially fixed (2026-08-05)** | Two separable problems were filed under one ID. **(a) Wasted and misleading work - fixed.** `collectGitInventory` now accepts `includeDiff` and returns before resolving a base ref or shelling out to `git diff`. Previously the diff ran unconditionally and `composeEvidence` deleted the result afterwards, so a default export spent four extra Git invocations on output it discarded, and a base-ref warning about a diff nobody asked for could downgrade an otherwise healthy run to `partial`. **(b) Unstable output shape - still open.** `composeEvidence` still *deletes* the `diff` key rather than stubbing it. Fixing (b) is a schema change, not a bugfix: `export.test.mjs` asserts the key's absence by default. Carry (b) into S3/S6. |
| RI-KEY-SANITIZE | 🟡 Med | **fixed (2026-08-05)** | `recursivelySanitize` and `validateArtifact` in `export.mjs` processed object *values* only, never keys, so a data-derived key would have bypassed both the redactor and the write gate. Not exploitable as written - every collector emits arrays of fixed-key records, so nothing off disk reaches a key position today - but it was a silent trapdoor for any future collector that keys a map by a filename or an environment-variable name. Both functions now sanitize and validate keys; sanitization happens before the sort so ordering is over the emitted key. Covered by two new `export.test.mjs` cases (a redacted key survives the round trip; a leaked key fatals the write). |
| RI-CI-SMOKE | 🟡 Med | open | Nothing in CI ever *executes* the exporter. `npm run verify` runs 105 focused unit tests against injected runners and temp-directory fixtures, but no job runs `node scripts/intelligence/export.mjs` against a real checkout, so integration-level breakage (a bad import path, a collector that throws only on this repo's actual shape) would ship green. A single non-blocking workflow step running the CLI with `--overwrite` against the checkout would close it. Not scoped to this branch. |
| RI-04 (`tmp/`) | 🟡 Med | **fixed, uncommitted (S4)** - ⚠️ D1 intent not achieved | `.gitignore` now has `tmp/repository-intelligence/` (only that subdirectory, never all of `tmp/`, per decision D1). **However, decision D1 is not actually in force:** `.gitignore` already carried a bare `tmp/` line from before this work, two lines above the new entry. The narrow rule is therefore redundant, and the broad ignore D1 explicitly rejected is still what Git applies. Removing the bare `tmp/` line affects the whole repository, not just the exporter, so it was deliberately left alone here - decide it separately rather than assuming D1 holds. |
| NEW-TASK-COMPLETE-UNTRACKED | 🟡 Med | confirmed | The task record reads `status: complete` while the implementation was untracked. **S7, still open** - deliberately not touched this session to keep the S1/S4 diff narrow. |
| Lows | ⚪ Low | confirmed | doc-discoverability, npm-script gap, product `metadata.product` hardcode, YAML tab / quoted-`#` heuristics, determinism test never git-inits. Untouched. |

**Also implemented in S1 (not separately ledgered above):** `collect-git.mjs`'s `safeGitValue` (branch/HEAD/worktree free text) and commit-subject sanitization were upgraded from `sanitizeText` to `sanitizeMetadataText`, so a benign commit message like `fix /etc/hosts lookup` is now redacted to `fix [REDACTED:local-path] lookup` instead of passing through unredacted (it was never a *secret*-pattern match, so the old `sanitizeText` pass left it untouched). Covered by a new `collectors.test.mjs` case.

## Assumptions the swarm refuted (do not re-litigate)

- ❌ "Final validation exists only in tests." **False** - it runs in production; it is just hollow.
- ❌ Env classification uses SECRET/TOKEN keyword rules. **False** - `VITE_`/`import.meta.env` →
 public/client, `api/`-only → server-only, else unknown. No keyword rule exists.
- ❌ The prior tip was a usable rollback baseline. **False** - it lacked `export.mjs` and four
 collectors (they were untracked). This is why slice S0 (baseline commit) exists.
- ❌ "Validator should exactly match the redactor" is safe. **False and dangerous** - a validator
 built to equal the redactor inherits its blind spots. See contract C3 in the plan.
