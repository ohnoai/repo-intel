# Warnings vs. Observations and Aggregate Status (S3)

> **STATUS: PROPOSED. Design only, no code written.** Section 3 holds decisions that belong to
> the repository owner. Nothing here is a decision record until those are answered, the work
> ships, and the acceptance check in section 6 passes.

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
Lists are de-duplicated and sorted, as `warnings` are today. The bundle gains
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

## 3. Open decisions for the owner

**3.1 Version bump.** S3 is additive (new keys), so it can leave `schemaVersion` at 2 and let S6
make the single bump to 3 along with the structural guard and the always-present `diff` key,
which are the only breaking changes. *Recommendation: no bump in S3.* The alternative is to bump
to 3 in S3 and let S6 build on it, which is cleaner per pull request but spends a version number
on an additive change.

**3.2 Missing required document.** Moving "expected authority document absent" to an observation
means a repository that misses a required `AGENTS.md` still reports `complete`. *Recommendation:
observation*, because the tool collected everything it could, and the summary still shows it.
The alternative is to keep it a warning, on the reading that a missing required document is
important enough to demote status.

**3.3 Coverage limits.** "Bounded" and "oversized" warnings mean the tool did not look at
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
3. `git`: one event moved.
4. `planning`: one event moved.
5. `files`, `delivery`, `product`: add the empty `observations` array.
6. `export.mjs`: `aggregate`, top-level `status`, summary rendering.
7. A test asserting every collector emits `observations` as an array and the aggregate counts
   match the per-collector counts. This is the backstop for the plan's open risk: a missed
   collector desyncs the rollup.

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
