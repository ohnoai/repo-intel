# Schema v3 and the Structural Guard (S6)

> **STATUS: IMPLEMENTED on `feat/s6-schema-v3` (2026-09-22).** All six steps in section 5 are
> committed and `npm test` passes (202 tests). The section 6 acceptance check has been confirmed
> against `sliceboard` and this repository itself, both `--include-diff` values. Owner decisions
> in section 3 are settled, each as the recommended option.

## 1. Context

Two contracts from `docs/04-remediation-plan.md` were still open once S3 merged (`c8351c7`):
C1's "diff key always present" requirement, and C7's fail-closed structural guard. Both were
blocked on S3 for the same reason - `export.mjs` deleted `metadata.diff` outright when
`includeDiff` was false (`RI-07(b)`), which is a shape change, and a structural guard written
before that shape settled would have had to special-case it.

`docs/decisions/2026-08-07-evidence-labels.md` already anticipated this slice in detail and
explicitly parked two things on it: the `diff` label choice when `omitted: true` (§6.2, §11 item
1, §10.4 V1-3 - "should be settled as part of S6's diff handling rather than inherited unexamined
from this draft"), and the five-rule structural label checker (§10.6, deferred by §10.4 V1-3).
`schemaVersion` was already at 2 (claimed by evidence-labels), so per §10.5's rule ("if S6 has
already consumed 2, this is 3") this bump is to 3, not 2.

**Execution model note.** This slice was designed and implemented directly by Claude/Opus, one
small reviewed step at a time (each step its own commit, tests green before moving on), rather
than through the OpenCode/Zen crew used for evidence-labels and S3. See `PASSOFF.md`'s retirement
header for that decision.

## 2. Design

**2.1 Schema version.** `export.mjs` exports `SCHEMA_VERSION = 3` as the single source of truth;
`composeEvidence` reads it instead of a literal.

**2.2 The diff key.** `lib/collect-git.mjs`'s `initialMetadata()` now includes `diff.omitted:
true`. The collector flips it to `false` immediately before it actually attempts a diff -
regardless of whether that attempt then succeeds, is rejected, or finds no base - so "never
attempted" (includeDiff false, or no repository at all) and "attempted and failed" (a rejected or
missing base) are now distinguishable in the data itself, not just in prose. `export.mjs`'s
`withoutDiff()` is deleted; the diff key is always present in every bundle from now on.

**2.3 The diff label.** Kept §6.2's existing choice: when `baseRef === null`, or the base
resolved to HEAD, or the diff was omitted, the whole `diff` subtree is labeled `unresolved` -
except `omitted` itself, which is always `observed_fact` (it is a direct read of the collector's
own control flow, never a guess). The git collector's `unavailable` early return is a deliberate
exception to this (§3.4): it never reaches `attachGitEvidenceLabels`, so `diff.omitted` there
inherits the blanket top-level `unresolved` default with no per-field reasoning, matching how
every other unavailable envelope already works.

**2.4 The structural guard.** `export.mjs` exports `assertBundleShape(bundle)`
(`export.mjs:220`), called first thing in `writeArtifacts` - before rendering the summary, before
sanitizing, before the write-gate validator, and before `ensureWritableTarget`'s `rmSync`, so
`--overwrite` can never delete existing artifacts in exchange for writing nothing back. It
checks, in order: exact top-level bundle keys; `schemaVersion` equals the current
`SCHEMA_VERSION`; a valid `status` enum; exact collector-name keys; for each collector, exact
envelope keys (`status, records, warnings, observations, metadata`), a valid status enum,
well-formed `warnings`/`observations` arrays, and an object `metadata` carrying `evidenceLabels`;
two named metadata keys real consumers depend on (`git.metadata.diff.omitted` is a boolean,
`planning.metadata.externalContext` is an object); aggregate warning/observation counts against
the sum of every collector's own; and the permanent `policy.rawDiffsIncluded === false`
invariant. It throws on the first violation, one at a time, and never echoes an unexpected key's
own *name* (only its count) - it runs ahead of sanitizing, so an unexpected key could be
repository data.

**2.5 The five-rule label guard.** `assertEvidenceLabelStructure` (`export.mjs:333`), called at
the end of `assertBundleShape`, recurses the whole bundle and enforces
`2026-08-07-evidence-labels.md` §10.6 wherever it finds an `evidenceLabels` key: exactly
`{default, fields}`; `default` is one of the four tokens; every `fields` value is one of the four
tokens; every `fields` key names a key present on the same object; no `fields` key is
`evidenceLabels` itself. Unlike an unexpected bundle key, `fields` keys are static strings
written in collector source, never data read off disk, so they are safe to name directly in a
failure message.

## 3. Owner decisions

**3.1 Where does `omitted` live? -> In the collector (`lib/collect-git.mjs`).** Evidence labels
belong to collectors; `withoutDiff` was a leftover from before the `includeDiff===false` early
return existed. Cost: a slightly larger diff than an export.mjs-only fix, in exchange for not
permanently splitting ownership of the diff subtree's shape across two files.

**3.2 Label for the diff subtree when omitted -> keep §6.2's existing choice**, with the git
`unavailable` envelope recorded as a deliberate §3.4 exception (see 2.3 above).

**3.3 How deep does the guard go? -> Envelope-level key sets, identical across all six
collectors today, plus two named metadata keys** (`git.metadata.diff`'s shape,
`planning.metadata.externalContext` being an object) - **not** an exact per-collector metadata
key set. The unavailable and normal envelopes' metadata key sets differ per collector (confirmed
directly - e.g. planning's unavailable metadata has 4 keys, normal has 5, missing
`authorityPaths`), so an exact set would be a second breaking change for no consumer benefit, and
those unavailable envelopes aren't reachable through the CLI anyway (`repositoryRootPath` rejects
any non-directory root before a collector ever returns unavailable). This asymmetry is a new Low
ledger row (`docs/03-current-state.md`), not fixed here.

**3.4 Where does the guard run? -> First thing in `writeArtifacts`, on the raw bundle** - see 2.4.

**3.5 Include the deferred §10.6 five-rule label guard? -> Yes.** Live-probed against real
`composeEvidence` output for both this repository and `sliceboard`, both `includeDiff` values -
zero violations, confirming the existing per-collector evidence-label implementations were
already consistent with these rules before this guard existed to enforce it.

**3.6 When to bump the version? -> Step 1, alone**, so every later step in this slice landed
under a correctly-labeled v3 bundle even under a partial revert.

## 4. Scope

**In:** version bump to 3, `omitted` always present on the diff, the structural guard
(envelope shapes, the two named metadata keys, the aggregate-count check, and the five label
rules), tests for all of it, and this docs pass.

**Out:** normalizing the unavailable-metadata key-set asymmetry (new Low row, not a task);
`NEW-GIT-BASE-MESSAGE` (touches the same file, different concern, deliberately not run in
parallel with this slice); a full per-field label registry (non-goal, `D9`); S7's test-coverage
hardening.

## 5. Implementation (six commits on `feat/s6-schema-v3`)

1. `c07c517` - bump `schemaVersion` to 3 (`export.mjs`, `export.test.mjs`).
2. `5802f9b` - `diff.omitted` in the git collector, plus its evidence label
   (`lib/collect-git.mjs`, `collectors.test.mjs`).
3. `11c018a` - delete `withoutDiff`; the diff key is never deleted again (`export.mjs`,
   `export.test.mjs`).
4. `e61a738` - `assertBundleShape`, written and tested as a pure function, not yet wired in
   (`export.mjs`, `export.test.mjs`).
5. `354544f` - wire the guard into `writeArtifacts`; fix the one test it breaks
   (`export.mjs`, `export.test.mjs`).
6. `3f23e92` - the five-rule evidence-label guard, folded into `assertBundleShape`
   (`export.mjs`, `export.test.mjs`).

## 6. Acceptance check

- `npm test`: 7 files, 202 tests, all passing.
- `assertBundleShape` (including the five-rule label guard) accepted real `composeEvidence`
  output from both `sliceboard` and this repository, with `--include-diff` both on and off - zero
  violations, confirmed 2026-09-22.
- Running against a non-git directory still writes successfully (the git-unavailable path passes
  the guard, confirmed by a dedicated test).

## 7. Risks

Unknown external bundle consumers relying on `diff`'s absence when `includeDiff` is false will
break - mitigated by the version bump to 3. The guard could reject a legitimate shape no test
covers - mitigated by the acceptance runs above covering non-git, both `includeDiff` values, and
two real repositories.
