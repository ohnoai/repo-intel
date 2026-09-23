# 04 · Remediation plan

The plan to take the exporter from "works, but with a hollow privacy gate and a critical git-base
bug" to "trustworthy V1." Produced by the swarm, hardened by a three-lens adversary panel, and
verified against the repo (verdict: GO-WITH-FIXES, all fixes folded in). Scope is **frozen** at the
current 6-collector shape.

## Owner decisions

The proposer recommended a default for each; ⭐ marks the real judgment calls.

| # | Decision | Resolution |
|---|---|---|
| ⭐ D8 | V1 scope: freeze vs realign to spec | **FREEZE (owner-confirmed).** Spec realignment (`.project-intelligence/`, manifest, `gh` enrichment) → phase-two. |
| ⭐ S0 | Commit the uncommitted work as a baseline? | **YES - done** (`60d7e9c`). Without it, "revertable slices" was fiction. |
| D1 | `tmp/` hazard | Add only `tmp/repository-intelligence/` to `.gitignore` (never all of `tmp/`). |
| D2 | Git base policy | Add `--base`; default precedence explicit → merge-base(HEAD, main) → `@{upstream}` → HEAD; **warn** (not fail) when it resolves to HEAD. |
| D3 | Status vs observations | Add `observations[]`; only true degradation → `partial`. Healthy repo → `complete`. |
| D4 | Validator scope | Cover the metadata tier - as a **constrained superset**, not exact parity (see C3). |
| D5 | Schema version | Bump `schemaVersion`. Originally scoped 1 → 2, but evidence-labels claimed 2 first (`docs/decisions/2026-08-07-evidence-labels.md` §10.5); **S6 actually bumped 2 → 3** (`docs/decisions/2026-09-22-schema-v3-structural-guard.md`). |
| D6 | Workflow provenance | Type each name; drop/segregate `$VAR` + GitHub builtins. |
| D7 | Validation boundary | One fatal pass on sanitized strings **plus** metadata redaction at the final pass (defense-in-depth). |
| D9 | Field registry | Light structural guard now; full per-field registry is a non-goal. |

## 4. Target architecture (contracts)

V1 stays a deterministic, offline, read-only 6-collector CLI. No new collectors, no network, no UI.
The work hardens the shared contracts; the load-bearing one (C3) is re-architected per the adversary
panel and verifier.

**C1 · result-schema (v3). ✅ IMPLEMENTED (S6, 2026-09-22).** Every collector returns `{ status,
records[], warnings[], observations[], metadata }`. Bundle adds `aggregate: { warnings[],
observations[] }` and a top-level `status`. **Observations shape pinned end-to-end:** collectors
emit `observations: {id, message}[]` (id assigned at the collector, e.g.
`client-prefixed-var-in-server-code`); the aggregate wraps each as `{collector, id, message}`. The
git `diff` key is **always present** - when diff is off, emits
`{baseRef:null, changedFiles:[], numstat:[], omitted:true}` rather than deleting it. See
`docs/decisions/2026-09-22-schema-v3-structural-guard.md`.

**C2 · status-semantics.** `status` reflects **collector degradation only**. `unavailable` = early
guard, couldn't run. `partial` = ran but degraded (missing tool, unreadable/oversized file, malformed
parse). `complete` = ran, zero warnings. Observations never demote status. Bundle status =
`unavailable` if all unavailable; else `partial` if any partial/unavailable; else `complete`. Flat
(no subsection status) in V1.

**C3 · sanitizer↔validator coverage - constrained SUPERSET, not parity.** *(The re-architecture the
privacy lens forced and the verifier tightened. This is the difference between a real guarantee and a
rigged one.)*
- The fatal validator's path detector is a **strict superset** of the redactor: it flags
 absolute-path shapes - drive letter, UNC leading `\\`, `file://`, and **POSIX absolute paths whose
 first segment is a filesystem root (or that have ≥2 real-path-like segments)** - so a redactor
 *miss* becomes a fatal error, not a silent pass. Validation is **never gated on the redactor's
 allowlist.**
- **Deliberately NOT "any leading slash"** - that would fatal on SliceBoard's own route strings like
 `/api/stripe-webhook` and `/s/:id`. Those exact routes go in the **negative** test corpus.
- **Redactor-must-match-validator invariant:** in the same slice, broaden the redactor
 (`sanitizeMetadataText`) to redact *exactly* the set the validator flags (`/usr /srv /data`, UNC,
 `$env:`, the constrained POSIX shape). Enforce with a **property test**: every validator-flagged
 fixture is empty after `sanitizeMetadataText`. Otherwise sanitized output still containing `/usr/…`
 makes the validator **self-fatal on its own pipeline's output.**
- New metadata detectors **must exclude the `[REDACTED:*]` sentinels**, or the validator throws on its
 own correct output and the tool stops producing artifacts.
- **PowerShell `$env:NAME=value`** (and `[Environment]::SetEnvironmentVariable(...)`) added to both
 redactor and validator - this repo runs on Windows and `$env:` currently leaks.
- **local-remote is dropped from flat-string validation** (no field context; `sanitizeRemoteUrl` is a
 transformer with no enumerable pattern). It is enforced by collector-side typing. "Parity" is
 redefined as detectable-**residue**-category coverage (secret, email, local-path, cred-flag,
 env-value), explicitly excluding transform-style redactions.

**C4 · git-base-policy.** Precedence: explicit `--base` → `merge-base(HEAD, main)` → `@{upstream}` →
`HEAD`. Option-like refs stay rejected; end-of-options markers stay. When the base resolves to `HEAD`,
emit a warning (an empty diff is legitimate, not a failure). Thread `baseRef` + `includeDiff` from
`run()` through `composeEvidence` into `collectGitInventory`.

**C5 · workflow-provenance.** Replace flat name sets with typed `{name, provenance}` where provenance
∈ `env-declaration | env-context | secret-reference | expression`. Drop bare `$VAR` shell capture as a
name source (or tag `shell` and exclude `GITHUB_*/RUNNER_*/CI/HOME/PATH`).

**C6 · final-validation-boundary (defense-in-depth).** One fatal validation pass on fully-sanitized
strings before any destructive write - **plus** the final sanitize pass upgraded to apply
metadata-tier redaction (`recursivelySanitize → sanitizeMetadataText`), not just `sanitizeText`. The
idempotency objection is unfounded (`[REDACTED:local-path]` is not re-matchable). This restores a
second line of defense so a single validator gap is not a direct leak.

**C7 · field-registry. ✅ IMPLEMENTED (S6, 2026-09-22).** Light fail-closed structural guard: assert
`schemaVersion` and the exact set of required collector/metadata keys before write; reject unknown
top-level shape. Not a full per-field
registry (non-goal).

## 5. Implementation slices (ordered, individually revertable)

Baseline is **S0's commit** (`60d7e9c`); **each subsequent slice is its own commit**. Never
`git add -A`; stage intended files explicitly; `.vscode/` and `tmp/` untouched.

- **S0 · Commit the working tree as the baseline. ✅ DONE** (`60d7e9c`). The only honest rollback
 point; every "revertable" claim depends on it.
- **S4 · Resolve `tmp/` hazard + `--output`. ✅ IMPLEMENTED, COMMITTED (2026-07-26).** Gitignored
 `tmp/repository-intelligence/` (not blanket `tmp/`); documented (not removed) the constrained
 `--output` flag in `--help`. *Depended on S0.*
- **S1 · Privacy boundary (re-architected). ✅ IMPLEMENTED, COMMITTED (2026-07-26).**
 Constrained-superset validator (C3) + redactor⊇validator by shared detector functions (not a
 separately-maintained parity test - `findUnsanitizedLocalPaths` backs both the redaction and the
 fatal check) + sentinel exclusion (verified: `[REDACTED:*]` output never re-triggers) + PowerShell
 `$env:` / `SetEnvironmentVariable` (redactor + validator + defense-in-depth final pass, C6) +
 **upgraded git free-text fields** (`collect-git.mjs` commit subjects, `safeGitValue`
 branch/head/worktree) to `sanitizeMetadataText` so a benign `fix /etc/hosts` commit is **redacted,
 not fatal**. Closure corpus has **positive AND negative** cases per class, including UNC,
 non-allowlist roots (`/usr /srv /data` plus a generic 3+-segment / extension-tail heuristic),
 `$env:`, and SliceBoard's own `/api/stripe-webhook` + `/s/:id` routes as negatives. 17 new
 `sanitize.test.mjs` cases, 1 new `collectors.test.mjs` case, 1 new `export.test.mjs` case; full
 focused suite 77→96, full app suite still 100% green, lint clean, typecheck clean (one pre-existing,
 unrelated `SliceBoardApp.tsx` error/warning untouched). *Depended on S0.*
 - **Implementation note:** built and verified in a sandbox with no git access to this worktree (its
 `.git` pointer resolves to a Windows path outside the sandbox), so this landed as working-tree-only
 progress from a single session before being committed separately. See `03-current-state.md`'s
 2026-07-26 update for that original context; confirmed present and committed on `main` as of the
 2026-09-22 docs pass.
- **S2 · Git-base policy. ✅ IMPLEMENTED, COMMITTED (2026-07-26, second session).**
 `--base` + merge-base(HEAD, main) → `@{upstream}` → `HEAD` precedence + HEAD-resolution warning
 (C4), threaded through `composeEvidence`/`run()`. Regression-tested against the exact original
 symptom (see `03-current-state.md`). *Depended on S0.*
- **S3 · Warnings vs observations + aggregate status. ✅ IMPLEMENTED (2026-09-22).** (C1/C2). Merged
 to `main` via PR #6 (`c8351c7`); reclassified the S2 HEAD-resolution warning as an
 `observations[]` entry (`diff-base-resolved-to-head`), fixing RI-STATUS. *Depended on S1.*
- **S5 · Workflow provenance typing. ✅ IMPLEMENTED, COMMITTED (2026-07-26, second session).**
 Typed `{name, provenance}` records (C5), shell-reference CI-builtin exclusion, and a shared
 merge helper so multi-source names keep every provenance. Breaking shape change; the tests it broke
 were fixed in the same slice (see `03-current-state.md`). *Depended on S0.*
- **S6 · Schema v3 + structural guard. ✅ IMPLEMENTED (2026-09-22).** (C1/C7). `schemaVersion`
 bumped 2 → 3 (evidence-labels claimed 2 first, per D5 above); the git diff key is always present
 with an `omitted` flag; `assertBundleShape` (envelope shapes, named metadata keys, aggregate
 counts, and the evidence-labels record's deferred five-rule label guard) runs fail-closed in
 `writeArtifacts` before any write. See `docs/decisions/2026-09-22-schema-v3-structural-guard.md`.
 *Depended on S2, S3, S5.*
- **S7 · Wire focused tests + regression-guard contracts. ✅ IMPLEMENTED (2026-09-22).**
 fs-access instrumentation for the `.env` boundary (closes NEW-PRIVACY-TESTGAP, and fixed a
 real gap found while scoping it - the planning collector could be configured to read a real
 `.env`, plus smaller versions of the same bug in the product and delivery collectors), the
 sanitizer redaction↔detection drift guard, export-layer walker tests, npm scripts for every
 test file, and an end-to-end real-bundle test. The task record's status was closed as moot
 rather than edited (sliceboard's own convention retires that file). See
 `docs/decisions/2026-09-22-test-coverage-hardening.md`. *Depended on S6.*

**Recommended path:** S0 → S4 → S1 → S2 → S5 → S3 → S6 → S7. **All slices done.**

**Next up:** the three follow-on tasks created alongside this plan (`INTEL-8` planning
required-document discovery, `INTEL-9` CI, `INTEL-10` the `tmp/` gitignore advice text) -
each already scoped to build on what S6/S7 shipped.

## 6. Explicit non-goals (V1)

- No GitHub CLI enrichment or any network access - offline, deterministic, read-only.
- No dashboard/UI. No AST parsing (regex + incompleteness warnings). No full YAML/TOML/JSONC parsers.
- No raw diffs / patch content - only sanitized name-status / numstat summaries.
- No live Supabase/Stripe calls; **no change to PR #29 behavior.**
- No multi-repo, no historical/trend analysis, no binary content inspection.
- No full per-field type registry (light structural guard only).
- No `.project-intelligence/` / manifest / README realignment (phase-two).
- No `git add -A`; `.vscode/` and user files under `tmp/` untouched beyond gitignoring the exporter's
 own subdir.

## 7. Open risks

- Pattern-based sanitizer cannot catch unknown/novel secret shapes - coverage guarantees the *known*
 set is validated, not completeness.
- The constrained superset path detector still needs tuning against a real corpus during S1 (balance
 between catching leaks and not over-flagging benign prose or routes). Mitigated by redact-not-fatal
 on collector free-text and the negative corpus.
- The `merge-base` default assumes a local `main` ref exists; clones without it fall back to
 upstream/HEAD, which may surprise users expecting branch-vs-main.
- ~~Schema v2 + always-present diff key **intentionally** breaks existing export tests - they must
 be updated in the same slice to avoid a red baseline.~~ **Resolved (S6, 2026-09-22):** the two
 tests this broke were updated in the same commits that broke them (`export.test.mjs`); `npm test`
 stayed green throughout.
- Adding `observations[]` touches all six collector envelopes; a missed collector desyncs the rollup - 
 the S6 structural guard is the backstop.
