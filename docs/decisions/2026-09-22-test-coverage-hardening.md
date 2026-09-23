# Test-Coverage Hardening (S7)

> **STATUS: IMPLEMENTED on `feat/s7-test-hardening` (2026-09-22).** All eight steps in
> section 5 are committed and `npm test` passes (239 tests, 11 files). `npm run verify`
> passes against this repository's own checkout. Owner decisions in section 3 are settled,
> each as the recommended option, except 3.1 (folded a real fix in, not just tests).

## 1. Context

S6 (`docs/decisions/2026-09-22-schema-v3-structural-guard.md`) closed the schema/structural
side of `docs/04-remediation-plan.md`. S7 was the last open slice: wire the tests and
regression-guard contracts that the plan called for but never landed - `NEW-PRIVACY-TESTGAP`
(zero fs-access instrumentation for the "never open `.env`" guarantee), the
redaction↔detection drift risk, an explicit `schemaVersion` recheck, missing npm scripts, and
end-to-end real-bundle validation.

Scoping this slice surfaced a real bug, not just a test gap: `collect-planning.mjs`'s
`repositoryConfig()` forced every declared authority-document path through `safePath()`
(path-escape checks only), with no filename/extension denylist. A repository's own
`.repo-intelligence.json` declaring `{"authorityDocuments": {".env": "..."}}` caused a real
`readFileSync` on a real `.env` file. The user decided to fold this fix into full S7 rather
than fast-tracking it as its own earlier PR (see owner decision 3.1).

## 2. Design

**2.1 Shared private-file module.** `lib/private-files.mjs` exports `isEnvironmentFile`
(moved unchanged from `lib/collect-files.mjs`, which imports it back) and a new
`isPrivateEnvironmentFile` - the same broad dotenv match, minus the one deliberate exception
(`.env.example`, a template file `collect-config.mjs` already reads via its own separate,
hardcoded allowlist).

**2.2 The real fix, in three places.** `lib/collect-planning.mjs`'s `repositoryConfig()`
filters both `authorityDocuments` and `requiredAuthorityDocuments` through
`isPrivateEnvironmentFile`, pushing a warning (not silence, not an observation) when a
declared path is refused - the repository's own configuration asked for something the tool
won't honor, which is "the repository's own configuration was not fully honored" under S3's
§2.4 table. Its directory scan silently skips a private-looking filename it happens to
encounter, matching every other silent skip in that walker. The same class of gap, reached by
extension matching instead of config declaration, existed in `lib/collect-product.mjs`'s
source scan (`SOURCE_EXTENSIONS` matches `.ts`/`.js`/etc regardless of the rest of the
filename, so `src/.env.ts` would have been scanned) and `lib/collect-delivery.mjs`'s workflow
listing (`.github/workflows/.env.yml` would have been read) - both fixed the same way, silently.
`lib/collect-config.mjs` was checked and found **already safe**: its
`shouldSkipEnvironmentScan` already calls `isExcludedRepositoryPath`, which already calls
`isEnvironmentFile` - confirmed by writing the equivalent sentinel test first and finding it
passed even with the other two fixes reverted.

**2.3 Filesystem-access instrumentation.** `privacy-boundary.test.mjs` uses a module-level
`vi.mock("node:fs")` (via `vi.hoisted`) wrapping only `readFileSync`, everything else passed
through to the real implementation - not an injected reader, because an injected seam can
always be bypassed by a future direct import and still pass. A fixture plants a private file
at every real gap above, plus a real `.env.example` as a positive control: it SHOULD be read,
proving the mock actually intercepts rather than silently no-op'ing (the same lesson as S3
step 7's own rollup-test fixture). Runs against both a non-Git and a Git-initialized fixture,
both `includeDiff` values. A closing static check confirms every `lib/*.mjs`/`export.mjs` fs
import is exactly `"node:fs"`, so the suite's coverage claim can't go silently stale.

**2.4 Sanitizer drift.** `lib/sanitize.mjs` exports `HIGH_CONFIDENCE_PATTERN_IDS` (derived
from the patterns' own `.id` fields). `sanitize.test.mjs` gained a coverage test (the fixture
map's keys must exactly match the exported ids), a per-id test (each fixture is flagged under
its own id and actually redacted), a pairwise round-trip across every fixture pair and four
separators, and an idempotence check.

**2.5 Export-layer walker tests.** `export.mjs` now exports `validateEvidence` (a thin
wrapper over the existing `validateArtifact`), matching `sanitizeEvidence`'s existing direct-
export treatment. New tests exercise both walkers directly against nested structures, as both
object keys and values, without going through the full `writeArtifacts` path.

**2.6 End-to-end.** `end-to-end.test.mjs` builds one realistic, fully-configured Git fixture
(package.json with scripts, `.env.example` plus a static server-side env reference, a valid
CI workflow, authority docs, a product-signal config with a matching source file, two commits
across two branches) and runs it through the real CLI (`run()`, including the git-ignore
guard). Asserts, for both `includeDiff` values: `schemaVersion === 3`, `assertBundleShape` and
`validateEvidence` both pass, every collector is `complete` with no warnings, `diff.omitted`
is correct for the flag, and `summary.md` reads `None.` under both Warnings and Observations.

**2.7 npm scripts.** Added `test:<name>` scripts for every previously-unwired test file
(`observations`, `git-worktree-probe`, `private-files`, `privacy-boundary`, `end-to-end`, and
this step's own `package-scripts`), plus `"verify": "vitest run && node export.mjs --root .
--overwrite"`. New `package-scripts.test.mjs` asserts every root `*.test.mjs` (including
itself) has a matching script naming that exact file.

## 3. Owner decisions

**3.1 Is the `.env` fix in scope? → Yes, folded into full S7** (per the user's decision),
as steps 1-3, so step 4's fs-instrumentation test doesn't have to skip a known real read.

**3.2 What happens when a repo's own config names a private path? → A warning**, not
silence and not an observation - see §2.2.

**3.3 How to instrument the fs boundary? → Module-level `vi.mock("node:fs")`**, not an
injected reader threaded through four collectors - see §2.3. Scope: `readFileSync` only;
`lstatSync`/`statSync` on a private file is by design (the files collector lists it and flags
it, never reads content); git subprocess reads are a separate boundary, out of scope here.

**3.4 How far does the drift test go? → One small new export**, `HIGH_CONFIDENCE_PATTERN_IDS`
- see §2.4. The six path/env detector ids are hand-listed in the existing metadata-tier
superset describe block in `sanitize.test.mjs`, not re-derived here.

**3.5 End-to-end validation scope? → A local vitest test plus a `verify` npm script.** CI
itself is a separate follow-on task (`INTEL-9`) - runner matrix, Windows support, and
required-check status are infra decisions, not test-hardening work, and the tests are the
actual value; CI just runs them once it exists.

**3.6 The `schemaVersion === 2` recheck → confirmed via `SCHEMA_VERSION` (now 3) and the
end-to-end test's direct assertion**, both stronger than the originally-scoped literal
check. Held only because S6 landed first.

**3.7 The sliceboard task record → not edited.** `NEW-TASK-COMPLETE-UNTRACKED` closed as
moot in this repository's own ledger instead - see `docs/03-current-state.md`.

## 4. Scope

**In:** the shared `.env`-detection module and its adoption everywhere a real gap existed
(planning, product, delivery), fs-access instrumentation, the sanitizer/export-walker drift
tests, the end-to-end real bundle test, missing npm scripts, and this docs pass.

**Out:** CI itself (`INTEL-9`); `NEW-PLANNING-REQUIRED-DISCOVERY` (`INTEL-8`, a different bug
in the same file, scheduled after S7 since it touches the same declared-document reading path
this slice already hardened); `compareText` consolidation (stays a Low); the `tmp/`
gitignore advice-text fix (`INTEL-10`).

## 5. Implementation (eight commits on `feat/s7-test-hardening`)

1. `b0b46cc` - shared `lib/private-files.mjs`, no behavior change yet.
2. `b0c11a7` - the real planning-collector fix.
3. `6a04cf2` - the other three walkers: two real fixes (product, delivery), one confirmed
   already safe (configuration).
4. `3def414` - filesystem-access instrumentation, `privacy-boundary.test.mjs`.
5. `c114991` - sanitizer redaction↔detection drift guard.
6. `e3a856f` - export-layer walker tests (`sanitizeEvidence`/`validateEvidence`).
7. `c8019be` - end-to-end real-bundle test.
8. `19e06d5` - npm scripts for every test file, plus `verify`.

## 6. Acceptance check

- `npm test`: 11 files, 239 tests, all passing.
- `npm run verify` passes against this repository's own checkout.
- Every real fix in this slice was verified to actually matter: reverting the planning,
  product, or delivery fix individually turns the corresponding sentinel test in
  `privacy-boundary.test.mjs` red (confirmed directly); disabling the fs mock's own call
  recording turns its positive control red (confirmed directly); a temporarily-added
  eleventh sanitizer pattern with no fixture turns the drift-coverage test red immediately
  (confirmed directly, then removed).

## 7. Risks

Mocking a Node builtin under vitest needs the positive control to be trusted - if
interception silently stopped working, this suite would pass without proving anything; the
static "every fs import is `node:fs`" check and the positive control together are the
mitigation. The private-file predicate may over-match rare legitimate filenames (`.envrc`,
etc.) - acceptable, since the failure mode is under-collection, never a leak.
