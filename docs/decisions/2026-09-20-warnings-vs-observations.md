# Warnings vs. Observations and Aggregate Status (S3)

> **STATUS: PROPOSED, owner decisions settled (2026-09-20). Design only, no code written.**
> Section 3 records the three owner decisions; each took the recommendation. This stays a
> proposal until the work ships and the acceptance check in section 6 passes.

## 1. Context

Every collector derives its status from one rule: `warnings.length ? "partial" : "complete"`
(`collect-config.mjs:923`, `collect-delivery.mjs:572`, `collect-files.mjs:535`,
`collect-planning.mjs:267`, `collect-product.mjs:210`; git uses a `partial` flag set by `warn()`).
So anything pushed into `warnings` demotes the collector, whether or not the tool lost anything.

**Observed on 2026-09-20**, running `repo-intel --overwrite` against `sliceboard` (clean working
tree): `configuration` reported `partial` with 5 warnings, all of the form "An environment
variable access could not be resolved statically: <path>:<line>" (`api/_lib/resendMarketing.ts:34`,
`api/_lib/stripeServer.ts:49`, `api/contact.ts:199`, and two lines in
`scripts/publish-to-writefreely.mjs`). The collector read every file it was pointed at. It found
code that reads an environment variable by a computed name, which no static reader can resolve.
That is a fact about the repository, not a failure of collection, yet it marks the collector
degraded. This is `RI-STATUS` in `docs/03-current-state.md`, and it is the reason S3 exists.

Prior decisions this builds on, none of which is reopened here:

- `docs/04-remediation-plan.md` D3 and contracts C1/C2: add `observations[]`; only true
  degradation yields `partial`; a healthy repository is `complete`.
- `docs/decisions/2026-08-07-evidence-labels.md` R4, section 4 and section 10.1: `warnings` and
  (post-S3) `observations` are control channels describing the collection run. They carry no
  `evidenceLabels`, and moving an event between channels changes no label.

## 2. Proposed design

**2.1 The rule.** An event is a *warning* if the tool failed to see something it was supposed to
see: a file it could not read, a parse that failed, a command that errored, a scan cut short by a
limit. It demotes status. An event is an *observation* if it describes the repository or the run
and the tool lost nothing by it. Observations never change status.

**2.2 Shape.** Each collector envelope gains `observations: {id, message}[]`, next to `warnings`.
`id` is a stable kebab-case string assigned in the collector (for example
`env-access-not-statically-resolvable`). `message` passes through the same sanitizer as warnings.
Lists are de-duplicated on the exact `(id, message)` pair and sorted by `id`, then `message`,
using code-unit comparison (`compareText`), by `buildObservations` in `lib/observations.mjs`.
The planning and product collectors already finalize `warnings` the same way
(`[...new Set(warnings)].sort(compareText)`); the other four do not sort them today. The
bundle gains
`aggregate: { warnings: {collector, message}[], observations: {collector, id, message}[] }` and a
top-level `status`.

**2.3 Status.** Per-collector status keeps its current rule, applied to the (now smaller)
`warnings` array, so moving events out is what fixes `RI-STATUS`. Bundle status follows C2:
`unavailable` if every collector is unavailable, else `partial` if any collector is partial or
unavailable, else `complete`. Flat, with no per-section status.

**2.4 Classification.** Every current warning site was reviewed (a grep of `warnings.push` and
`warn(` across `lib/collect-*.mjs` on 2026-09-20). Four move to observations; all others stay
warnings.

| Collector | Event | Today | Proposed | Why |
|---|---|---|---|---|
| configuration | Environment variable access could not be resolved statically | warning | **observation** `env-access-not-statically-resolvable` | Repository fact; the source was fully read (the motivating case). |
| configuration | Client-prefixed variable evidence also appears in server code | warning | **observation** `client-prefixed-var-in-server-code` | A finding about the code, not a collection failure. Plan C1 already names this id. |
| git | Diff base resolved to HEAD; an empty diff is expected | warning | **observation** `diff-base-resolved-to-head` | The message itself says "not a failure"; plan C4 says the same. |
| planning | Expected repository authority document was absent | warning | **observation** `required-authority-document-absent` | The repository declared a requirement and did not meet it. See open decision 3.2. |
| all | File outside root, symlink, not a file, over read limit, unreadable | warning | stays | Something the tool could not read. |
| all | Malformed JSON, TOML, or YAML | warning | stays | A parse failed, so data is missing. |
| git | Any "could not be collected / determined / listed" and malformed-record warning | warning | stays | A command failed or returned unusable output. |
| git | Configured diff base rejected or unavailable | warning | stays | The requested diff was not produced. |
| planning, product | Collection bounded, depth limit, oversized source, unreadable source | warning | stays | Coverage was cut short (see open decision 3.3). |
| product, planning | Config could not be parsed; invalid id, severity, or pattern | warning | stays | The repository's own configuration was not fully honored. |

Collectors with no events to move (files, delivery, product) still emit `observations: []`, so
the envelope has one shape.

**2.5 Summary.** `summary.md` keeps its status table, adds an Observations section after
Warnings, and lists observations grouped by collector with counts. `Warnings: None.` becomes
true on a healthy repository, which it is not today.

## 3. Owner decisions

Settled 2026-09-20. The owner replied "go with your recommendations" to all three, so each
below is the recommended option and the alternative is recorded as the road not taken.

**3.1 Version bump. DECIDED: no bump in S3.** S3 is additive (new keys), so it can leave `schemaVersion` at 2 and let S6
make the single bump to 3 along with the structural guard and the always-present `diff` key,
which are the only breaking changes. *Recommendation: no bump in S3.* The alternative is to bump
to 3 in S3 and let S6 build on it, which is cleaner per pull request but spends a version number
on an additive change.

**3.2 Missing required document. DECIDED: observation.** Moving "expected authority document absent" to an observation
means a repository that misses a required `AGENTS.md` still reports `complete`. *Recommendation:
observation*, because the tool collected everything it could, and the summary still shows it.
The alternative is to keep it a warning, on the reading that a missing required document is
important enough to demote status.

**3.3 Coverage limits. DECIDED: they stay warnings.** "Bounded" and "oversized" warnings mean the tool did not look at
everything, so *recommendation: they stay warnings.* The alternative is to treat any hard limit
as an observation, which would hide real gaps behind a `complete` status.

## 4. Scope

In: `observations[]` on all six envelopes, the four reclassifications above, `aggregate`,
top-level `status`, summary rendering, and tests.

Out, deliberately: the always-present `diff` key and the fail-closed structural guard (S6), test
hardening (S7), any change to evidence labels (section 10.1 of the evidence-labels record settled
that), new collectors, and any network access.

## 5. Work breakdown

One pull request. Steps in order, each small enough to review alone:

1. Shared helper for building and de-duplicating an observation list, plus its unit tests.
2. `configuration`: two events moved, with tests that a repository whose only findings are
   observations is `complete`.
3. `git`: one event moved (`diff-base-resolved-to-head`). This collector does not use the
   `warnings.length` rule the others use, so the move is not just a matter of taking the
   message out of `warnings`:
   - Its status comes from a `partial` flag that its `warn()` helper sets. The observation
     must not go through `warn()`. Give it its own accumulator, finalize that with
     `buildObservations`, and leave the `partial` flag alone. The message text stays exactly
     as it is today.
   - Status is derived at two return sites (`status: partial ? "partial" : "complete"`): the
     early return for `includeDiff` false, and the final return. Both carry `observations`.
     The `unavailable` early return carries `observations: []`.
   - The event can only happen when `includeDiff` is true, because the `includeDiff` false
     early return runs before the diff base is resolved. That path always has no observations.
   - The test needs `includeDiff` true in a repository with no local `main` and no upstream
     branch. It asserts `status: "complete"`, the one observation with its id, and that the
     message is not in `warnings`. It must fail if the event is put back through `warn()`.
4. `planning`: one event moved (`required-authority-document-absent`). This is the simple
   case: status here is `warnings.length ? "partial" : "complete"`, so taking the message out
   of `warnings` is what makes the collector `complete`. Notes:
   - Only the push of "Expected repository authority document was absent: <path>." moves.
     Its text stays exactly as it is today. Every other planning warning (outside root,
     symlink, over the read limit, unreadable, config could not be parsed, collection
     bounded) stays a warning.
   - Leave the existing `warnings` finalisation (`[...new Set(warnings)].sort(compareText)`)
     alone. Observations go through `buildObservations`, not through that line.
   - Two return sites: the `unavailable` early return (the directory does not exist) carries
     `observations: []`, and the final return carries `buildObservations(observations)`.
   - The existing test "returns partial evidence for absent or unreadable optional planning
     input..." in `planning-product.test.mjs` asserts `partial` and that the warning is
     present. The absent-document event is its only warning, so rewrite it to expect
     `complete`, empty `warnings`, and the one observation with its id. Keep its assertions
     that no document body or email leaks into the output.
   - After that rewrite, no planning test would show that a real warning still gives
     `partial`. Add one: a malformed `.repo-intelligence.json` gives `partial`, a "could not
     be parsed" warning, and `observations: []`.
   - Add the section 6 acceptance case as a test: a required document that is truly missing
     gives `complete`, empty `warnings`, and exactly one observation. Add a second test that
     a duplicated entry in `requiredAuthorityDocuments` yields one observation (the old
     `Set` de-duplicated it; `buildObservations` does now). Add an assertion on the existing
     unavailable-directory test that `observations` is `[]`.
   - Known quirk, do not fix in this step: a required document that exists on disk but is
     not also listed under `authorityDocuments`, or found through a default authority path,
     a roadmap path, or a planning directory, is reported as absent, because the check
     compares against the discovered-paths list, not the disk. Reproduced 2026-09-20 with
     `requiredAuthorityDocuments: ["CUSTOM.md"]` and `CUSTOM.md` present. The fixture for
     the acceptance test must use a document that is really missing, so the test does not
     depend on this quirk.
5. `files`, `delivery`, `product`: add the empty `observations` array.
6. `export.mjs`: `aggregate`, top-level `status`, summary rendering.
7. A test asserting every collector emits `observations` as an array and the aggregate counts
   match the per-collector counts. This is the backstop for the plan's open risk: a missed
   collector desyncs the rollup. It also asserts that every observation has a non-empty
   string `id` and `message`, so a collector that forgets an id fails a test instead of
   emitting an entry with no id (which JSON output would drop without complaint).
   The test must not stop at a healthy repository: it also asserts `observations` is an array
   on the git collector's `unavailable` envelope (a directory that is not a Git worktree) and
   on its `includeDiff: false` envelope. Step 3 added the key on those return paths and no
   other test looks at it there, and the step 6 aggregate loops over every collector, so a
   missing key on either path would crash the export for a non-git directory.

## 6. Acceptance check

- `npm test` passes, with new tests covering each moved event and the rollup.
- Re-running `repo-intel --overwrite` in `sliceboard` shows `configuration` as `complete`, its 5
  dynamic-environment events under Observations, and the bundle status `complete`. This is a
  prediction from the current output (all 5 configuration warnings were of that one kind), to be
  confirmed by the run, not assumed.
- A repository with a declared-but-missing required document shows `planning` as `complete` with
  one observation (if 3.2 is accepted as recommended).

## 7. Risks

- A collector that forgets `observations` breaks the rollup. Covered by step 7 above.
- Consumers that read `warnings` to find the env-variable or missing-document events will stop
  finding them there. No consumer of the bundle is known inside this repository; external
  consumers, if any, are not known.
- Reclassification is a judgment call per event. The table in 2.4 is the reviewable record of
  those calls.
- A known false positive got quieter. The planning collector reports a required document as
  absent when it exists on disk but is not also declared under `authorityDocuments` or found
  through a default path, a roadmap path, or a planning directory (reproduced 2026-09-20).
  Before S3 that demoted the collector to `partial`. After S3 the collector reads `complete`
  and the false claim appears only under Observations. Step 4 keeps the message and the
  behavior on purpose, because S3 moves events between channels and does not change what
  counts as found. Decision 3.2 covered a document that is truly missing, not this case.
  Tracked as `NEW-PLANNING-REQUIRED-DISCOVERY` in `docs/03-current-state.md`.
