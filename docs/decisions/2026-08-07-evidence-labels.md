# Evidence Labels (DRAFT)

> **STATUS: DRAFT — DESIGN ONLY. NOT A DECISION RECORD YET.**
> No collector code was changed to produce this document. This becomes a real decision
> record only once the design below is implemented, the full suite passes, and an
> independent verifier confirms the per-collector mapping against actual output. Until
> then it is a proposal, and the per-collector mappings in §7 are claims about what the
> code does today that a reader should re-check against the line numbers cited.

## 1. Context

Six collectors share one envelope:

```
{ status: "complete" | "partial" | "unavailable", records: [], warnings: [], metadata: {} }
```

`status` is collector-level. It answers "did this collector run cleanly?" It does not
answer "how much should I trust this particular value?" A `status: "complete"` files
collector emits `path` (read off disk) and `classification` (guessed from the file
extension) side by side, indistinguishably. A `status: "complete"` delivery collector
emits workflow triggers that were extracted by an indentation-sensitive line scanner, not
a YAML parser, and nothing in the output says so.

The founding spec required four evidence labels. They were never implemented. This
document specifies the one shared shape for attaching them, corrects the working
hypothesis where the code contradicts it, and gives a before/after example per collector.

The label vocabulary is **already fixed in this repository's own documentation**
(`docs/01-overview.md:19-21`):

```
observed_fact | documented_intent | mechanical_inference | unresolved
```

Use those four tokens exactly — snake_case, and `unresolved`, not
`unknown_unresolved`/`unknown`. That doc predates this design and is the closest thing to
a written record of the founding spec's own naming; inventing a second spelling now would
mean the repo describes the feature with tokens the feature does not emit.

## 2. The load-bearing interpretive rules

These four rules decide most of the per-collector mapping. They are stated first because
disagreeing with a rule here is a much cheaper conversation than disagreeing with sixty
individual field assignments.

**R1 — A label describes the trustworthiness of what a value *asserts*, not the
reliability of the *read*.**
Every value in the bundle was read reliably; saying so is not informative. A commit
subject, a `package.json` dependency range, and a decision document's heading were all
faithfully read off disk — and all three are unverified human claims about the software.
They are `documented_intent`. Without R1, `observed_fact` swallows everything that came
off a disk and `documented_intent` never applies to anything, which is how the label set
degenerates into a no-op.

**R2 — Whole-file structural parse vs. needle extraction.**
When a collector parses a file in its actual format and reads a value out of the resulting
structure (`JSON.parse` on `package.json`, the JSONC strip-then-parse on `tsconfig.json`,
dotenv line declarations), the value faithfully represents what the file says: label it by
content under R1. When a collector runs a regex or a line scanner across a language it
does not parse (JS/TS source, YAML workflows, TOML config), the finding is the tool's
pattern-matching output and may be wrong — a match inside a comment or a string literal
counts the same as a real one. That is `mechanical_inference`, always, regardless of how
confident the pattern looks. This repo's own non-goals commit to never adding real
YAML/TOML/AST parsers (`docs/04-remediation-plan.md:143`), so this rule is permanent, not
a temporary concession.

**R3 — A classification field whose value is the tool's own "unknown" sentinel is
`unresolved`, not `mechanical_inference`.**
`classification: "source"` means a rule fired. `classification: "unknown"` means every rule
declined. Those are different epistemic states and the same label for both destroys the
distinction. This makes some labels **value-dependent**: the label is computed per record,
not stamped statically per field. That is intentional and it is where most of the design's
implementation cost lives.

**R4 — Labels describe the values that are present. Absence and incompleteness stay in
`status` / `warnings` / (post-S3) `observations`.**
A required authority document that does not exist, a dynamic `process.env[expr]` access
that could not be resolved, a source scan truncated at `MAX_SOURCE_FILES`, a name-status
record dropped as malformed — none of these produce a value, so none of them can carry a
field label. They are already represented by `status: "partial"` plus a warning. Adding a
placeholder record per omitted item would be unbounded and would break the collector's
bounding limits, which is precisely what those limits exist to prevent. §9 lists these
gaps explicitly rather than papering over them, because three of the four hypotheses in
the original ask land here.

A fifth situation — a value that is determinate but *not applicable*, such as `numstat`
`additions: null` for a binary file — has no fifth label available. It is folded into
`unresolved`, on the reading that the founding spec's "genuinely ambiguous" covers "no
determinate value for this field." Recorded here as an interpretation, not a discovery.

## 3. The field

### 3.1 Name and shape

One reserved key, `evidenceLabels`, on any object that contains labeled values:

```json
"evidenceLabels": {
  "default": "observed_fact",
  "fields": {
    "classification": "mechanical_inference",
    "isBinary": "mechanical_inference"
  }
}
```

- `default` — one of the four tokens. Applies to every sibling key of the block that is
  not named in `fields`, and transitively to everything nested beneath those siblings.
- `fields` — an object mapping a sibling key name to one of the four tokens. Overrides
  `default` for that key and everything nested beneath it. Always present; `{}` when there
  are no overrides.

Both keys are always emitted. An optional `fields` would weaken the C7 structural guard
(`docs/04-remediation-plan.md:83-85`), which asserts an exact required key set, and would
force every consumer to branch. The cost is one extra token per block.

The name is `evidenceLabels`, not `evidence`. `collect-product.mjs` already emits
`evidencePaths`, and the whole artifact is an "evidence bundle" — the bare word is too
overloaded to also mean "the label block."

### 3.2 Where it lives

`evidenceLabels` appears on:

- each element of `records[]`
- the `metadata` object
- any object nested inside those two **where the label differs from what it would
  inherit**

It does **not** appear on the collector envelope itself. `status`, `records`, `warnings`
(and post-S3 `observations`) are control channels describing the collection run, not
evidence about the repository, and labeling them would be a category error. The envelope's
key set is therefore unchanged — this design adds no top-level key to the existing
contract, which is the strongest available answer to "do not invent a parallel output
structure."

It also does not appear on the bundle's `policy` block or `schemaVersion`.

### 3.3 Label resolution

To resolve the label for any leaf value:

1. Walk from the leaf outward to the root of its collector's `records[i]` or `metadata`.
2. At each enclosing object, if that object has an `evidenceLabels` block and the block's
   `fields` names the key by which you descended, that token is the answer.
3. Otherwise, if that object has an `evidenceLabels` block, its `default` is the answer.
4. Otherwise continue outward.

An array inherits its parent's resolved label. An array *element* may override by carrying
its own `evidenceLabels`, but should only do so when its label actually differs from the
inherited one — see §6.

This is fully self-describing. A consumer needs no external schema and no knowledge of
which fields exist: `default` is defined over the sibling keys actually present in the
same object, minus `evidenceLabels` itself.

### 3.4 Nulls

A field present with a placeholder value that stands in for something the collector could
not determine — `null`, or `[]`/`0` in an `unavailable` envelope — is `unresolved`. This
gives one uniform, trivially implementable rule for the early-return path that all six
collectors share:

> In an `unavailable` envelope, `metadata.evidenceLabels` is
> `{ "default": "unresolved", "fields": {} }` and `records` is empty.

Six collectors, one line each, no per-field reasoning.

## 4. What this is not

**Not a replacement for S3's `observations[]`.** They are orthogonal.
`observations[]` records non-degrading events that happened during collection.
`evidenceLabels` annotates values that were emitted. Neither subsumes the other; a value
can be `mechanical_inference` with zero observations, and an observation can exist about a
value that was never emitted at all.

**Not a confidence score.** There is no ordering, no numeric weight, and no arithmetic
over the four tokens. A consumer that wants "how much do I trust this" must decide that
itself from the label plus the collector's `status`.

**Not a fix for any ledger defect.** It exposes two of them more clearly (see §9) and
fixes none.

## 5. Invariants preserved

**Determinism.** Labels are pure functions of values the collectors already compute
deterministically. `evidenceLabels.fields` keys must be emitted in sorted order at the
collector, not only at `export.mjs`'s `recursivelySanitize` (which already sorts keys after
sanitization, `export.mjs:97-101`) — otherwise unit tests that assert directly on collector
output become order-dependent even though the written artifact would not be.

**Sanitization.** Nothing bypasses `lib/sanitize.mjs`:

- All four tokens are literal ASCII identifiers with no `/`, no `:`, no `=`, and no
  secret-, email-, or path-shaped substring. They survive `sanitizeMetadataText` unchanged
  and pass `assertSanitizedMetadata` — verify against `SECRET_ASSIGNMENT_PATTERN`
  (`sanitize.mjs:86`), `POSIX_PATH_TOKEN_PATTERN` (`sanitize.mjs:130`), and
  `POWERSHELL_ENV_ASSIGNMENT_PATTERN` (`sanitize.mjs:134`); none match.
- **Invariant: `fields` keys are only ever literal field names from the collector's own
  record shape.** Never a filename, never an environment-variable name, never any value
  read off disk. `recursivelySanitize` and `validateArtifact` do sanitize and validate keys
  since the RI-KEY-SANITIZE fix, so a violation would not leak — but it would make that fix
  load-bearing for the first time, and it would make `fields` unbounded. Keep the
  invariant.
- Labels are attached to values that have already been through the collectors' existing
  sanitizers. The label is metadata about the sanitized value; it does not reopen the
  value.

**Bounding.** The existing limits (`MAX_SOURCE_BYTES` 384KB, `MAX_SOURCE_FILES` 160,
`MAX_SOURCE_DEPTH` 5, `MAX_DOCUMENTS` 120, `MAX_HEADINGS` 40, `MAX_CONFIGURATION_BYTES` and
`MAX_DELIVERY_FILE_BYTES` 1MB) are **input-side** limits on what gets read. This design
does not touch any of them and does not add a new read. It does grow **output** size, and
that should be stated honestly rather than hand-waved:

- Per labeled object: `+2` keys plus one entry per override.
- The files collector is the worst case — 8-key records, unbounded record count (there is
  no `MAX_FILES`), and 2–3 overrides typical. Expect roughly **+25–35% bundle size for the
  files section**.
- Mitigation is structural, not a new limit: use `default` aggressively and add an override
  or a nested block **only where the label actually differs from the inherited one**. Do
  not emit a fully-expanded per-field map "for clarity." The resolution algorithm in §3.3
  already makes the compact form unambiguous.
- Explicitly rejected: a label entry per omitted file, per dropped malformed record, or per
  truncated scan. That would be unbounded by construction. See R4.

## 6. Per-collector mapping

Corrections to the working hypothesis are marked **[CORRECTION]**. "value-dependent" means
the label is computed per record from the value, per R3.

### 6.1 files (`lib/collect-files.mjs`)

| Field | Label | Note |
|---|---|---|
| `records[].path` | `observed_fact` | hypothesis correct |
| `records[].extension` | `observed_fact` | |
| `records[].byteSize` | `observed_fact` | `lstat().size` |
| `records[].classification` | `mechanical_inference` / `unresolved` | **[CORRECTION]** value-dependent per R3. `classificationFor` (`:236-247`) is pure path/extension matching → inference; the literal `"unknown"` fallthrough at `:246`, and the hardcoded `"unknown"` on the symlink record at `:402`, are `unresolved`. |
| `records[].tracked` | `observed_fact` / `unresolved` | `true`/`false` from `git ls-files` → observed; `null` in filesystem-fallback (`:376`) → `unresolved`. Hypothesis correct. |
| `records[].isBinary` | `mechanical_inference` / `unresolved` | **[CORRECTION — most significant here]** `inspectionForFile` (`:249-288`) **never reads file content**. `isBinary: true` is inferred from the extension allowlist; `isBinary: false` is inferred from path classification; `null` is `unresolved`. Despite the name, this field is never an observed fact about bytes. Hypothesis did not cover it. |
| `records[].contentInspectionSkipped` | `observed_fact` | Always `true`. A self-report of what the collector did — directly known, not interpreted. |
| `records[].skipReason` | `mechanical_inference` / `observed_fact` | Emitted by the same pattern-matching function as `isBinary`. Exception: `"symbolic-link"` (`:405`) comes from `lstat` → `observed_fact`. |
| `metadata.discovery` | `observed_fact` / `unresolved` | `"git"`/`"filesystem"` → observed; `"unavailable"` → `unresolved`. |
| `metadata.tracking` | `observed_fact` / `unresolved` | same |
| `metadata.recordCount` | `observed_fact` | Count over an observed set. General rule: **a count inherits the label of the set it summarizes.** |

### 6.2 git (`lib/collect-git.mjs`)

| Field | Label | Note |
|---|---|---|
| `records[].sha` | `observed_fact` | |
| `records[].subject` | `documented_intent` | **[CORRECTION]** Per R1. A commit subject is an unverified authorial claim about what a change does. The *bytes* are observed; the *assertion* is not. |
| `metadata.repository.isGitRepository` / `.isRepositoryRoot` | `observed_fact` / `unresolved` | `null` (the ENOENT branch, `:375-377`) → `unresolved`. **Note:** the RI-GIT-ISREPO defect means a *transient* git failure emits `false`, which this scheme would mislabel `observed_fact`. Labeling does not fix it; it makes the lie legible. |
| `metadata.currentBranch`, `.headCommit`, `.trackingBranch` | `observed_fact` / `unresolved` | `null` after the corresponding `warn()` → `unresolved`. |
| `metadata.ahead` / `.behind` | `observed_fact` / `unresolved` | Hypothesis correct. `null` when the count regex fails (`:492-499`) → `unresolved`. |
| `metadata.clean` / `.dirty` | `observed_fact` / `unresolved` | **[CORRECTION]** Hypothesis said mechanical inference. `:551` is `worktreeStatus.stdout.length === 0` — a direct read of `git status --porcelain` being empty. No pattern-matching, no classification. Observed. Both stay `null` when the command fails → `unresolved`. |
| `metadata.defaultRemote.name` | `observed_fact` / `mechanical_inference` | **[CORRECTION — partial]** Hypothesis said uniformly mechanical inference. The precedence at `:447-452` has four branches: `remote.pushDefault` and `branch.<b>.remote` are **git config state read directly** → `observed_fact`; falling back to `"origin"` or to `remoteNames[0]` is the collector *choosing* → `mechanical_inference`. Value-dependent. **Implementation note:** the collector currently discards which branch fired (`.find(Boolean)` over an ordered array); it must retain the index to label this correctly. |
| `metadata.defaultRemote.url` | `observed_fact` / `unresolved` | Git's own recorded state about where a remote lives; not a claim about the code. `null` after the warn at `:466` → `unresolved`. |
| `metadata.stagedChanges[]`, `.unstagedChanges[]`, `.untrackedFiles[]` | `observed_fact` | Malformed entries are dropped, not emitted — see R4 and §9. |
| `metadata.localBranches[]` | `observed_fact` | |
| `metadata.worktrees[].branch`, `.head`, `.detached`, `.bare` | `observed_fact` | |
| `metadata.worktrees[].alias` | `mechanical_inference` | **[CORRECTION]** Not in the hypothesis. `worktreeAlias` (`:217-227`) constructs `"repo-root"` or `"worktree:<dirname>"` and then de-duplicates with a `-2` suffix (`:268-276`). This identifier exists nowhere on disk; the tool made it up. |
| `metadata.diff.baseRef` | `observed_fact` / `unresolved` | Explicit `--base`, a resolved `merge-base`, or `@{upstream}` → `observed_fact`. `baseResolvedToHead === true` (`:637`, `:641`) → `unresolved`. `null` when the base was rejected (`:643`) → `unresolved`. Hypothesis correct. This is also the S3 case where a warning currently demotes an otherwise healthy repo to `partial`; the label makes "expected, not a failure" machine-readable. |
| `metadata.diff.changedFiles[]` | `observed_fact` | |
| `metadata.diff.numstat[].path`, `.previousPath` | `observed_fact` | |
| `metadata.diff.numstat[].additions`, `.deletions` | `observed_fact` / `unresolved` | **[REFINEMENT]** Hypothesis said "diff numbers are observed fact" — true for integers. `null` from a `-` count (binary file, `numstatCount` `:194`) is not applicable rather than failed, and folds into `unresolved` per §2. |
| `metadata.diff` when `omitted: true` | `unresolved` (subtree), `omitted` itself `observed_fact` | Post-S6, when `includeDiff` is false the key is stubbed rather than deleted. **This is the weakest assignment in the whole spec** — the diff was not attempted, which is neither "failed" nor "ambiguous." See §11. |

### 6.3 configuration (`lib/collect-config.mjs`)

| Field | Label | Note |
|---|---|---|
| `records[].path` | `observed_fact` | |
| `records[].type`, `.format` | `mechanical_inference` | **[CORRECTION]** Not in the hypothesis. Both are assigned by `configurationType` / `configurationFormat` (`:113-137`) from the filename and extension. Nothing in the file declares them. |
| `records[].settings.*` (package) | `documented_intent` | `name`, `private`, `version`, `license`, `packageManager`, `engines` — authored declarations. |
| `records[].scripts[]` | `documented_intent` | A declared command; nobody ran it. |
| `records[].dependencies`, `.developmentDependencies` | `documented_intent` | **[CORRECTION]** Hypothesis said "raw values from files are observed fact." Per R1 these are *claims about what the code needs*, unverified against `node_modules` (never read) or against actual imports. |
| `records[].toolchain` | `mechanical_inference` | **[CORRECTION]** Not in the hypothesis. Produced by filtering dependencies against a hardcoded five-name set (`:274-280`). The tool decided what "toolchain" means. |
| `records[].summary.*` (package-lock) | `documented_intent` | Including `packageCount` — a count over declared entries, inheriting the set's label. |
| `records[].settings.compilerOptions`, `.references`, `.entryPoints` (tsconfig) | `documented_intent` | Per R2 the JSONC strip-then-parse (`:179-233`) is a whole-file structural parse, so values faithfully represent the file. `entryPoints` globs are declared, never resolved against the filesystem. |
| `records[].settings.usesDefineConfig`, `.flatConfig` | `mechanical_inference` | Regexes over unparsed source (`:394-395`). |
| `records[].references` (script configs) | `mechanical_inference` | `extractImports` (`:374-384`) is a regex, not an AST. Per R2. |
| `records[].settings.sections`, `.keys`, `.environmentVariables` (TOML) | `mechanical_inference` | `parseTomlOverview` (`:401-446`) is a line scanner, not a TOML parser. Per R2. |
| `records[].settings.*Count` (vercel) | `documented_intent` | Counts over declared config, full JSON parse. |
| `records[].malformed` | `observed_fact` | When `true`, the record's *parsed content* fields are `unresolved`. |
| `metadata.environmentVariables[].name` | `observed_fact` | The identifier literally appears in the repository. |
| `metadata.environmentVariables[].descriptions[]` | `documented_intent` | Hypothesis correct — `.env.example` comments via `sanitizeEnvironmentComment`. |
| `metadata.environmentVariables[].declarations[]` | `observed_fact` | Per R2: dotenv is a trivial, fully-supported line format and the line genuinely declares the variable. |
| `metadata.environmentVariables[].references[]` | `mechanical_inference` | **[CORRECTION]** Per R2. `scanEnvironmentReferences` (`:562-598`) regexes JS/TS source; a match inside a comment or a string counts identically to a real access. `path` and `line` do not escape this — the *finding* is inferred, so the whole element is. |
| `metadata.environmentVariables[].classification` | `mechanical_inference` / `unresolved` | Hypothesis correct, plus R3: the literal `"unknown"` (`:679`) is `unresolved`. |
| `metadata.environmentVariables[].accessStyles[]` | `mechanical_inference` | Derived from `references`. |
| `metadata.packageScripts`, `.dependencies`, `.developmentDependencies` | `documented_intent` | Mirrors the package record. |
| `metadata.toolchain` | `mechanical_inference` | Mirrors the package record. |

### 6.4 delivery (`lib/collect-delivery.mjs`)

| Field | Label | Note |
|---|---|---|
| `records[].path` | `observed_fact` | |
| `records[].type`, `.format` | `mechanical_inference` | Assigned from path convention / extension, as in configuration. |
| `records[].name` (workflow) | `mechanical_inference` | **[CORRECTION]** See below. |
| `records[].triggers` | `mechanical_inference` | **[CORRECTION — most significant in this collector]** Hypothesis said workflow triggers and runners are observed fact. They are not. `workflowTriggers` (`:133-149`) and `workflowJobs` (`:234-266`) are **indentation-sensitive line scanners**, and a real YAML parser is a permanent non-goal. A trigger this collector fails to report may be a scanner limitation rather than an absent trigger, and the label is the only place that can say so. |
| `records[].jobs[].id`, `.runners`, `.npmScripts` | `mechanical_inference` | Same scanner. Per R2. |
| `records[].jobs[].environmentVariables[]`, `.secretNames[]` (incl. `provenance`) | `mechanical_inference` | `workflowEnvironmentNames` (`:190-232`) is regex + indentation heuristics. |
| `records[].npmScripts`, `.environmentVariables`, `.secretNames` (workflow rollup) | `mechanical_inference` | |
| `records[].malformed` | `observed_fact` | When `true` (`:276-281`), set the record's `evidenceLabels.default` to `unresolved` and override `path`/`malformed` → `observed_fact`, `type`/`format` → `mechanical_inference`. Hypothesis correct. |
| `records[].settings.name`, `.packageManager` (package) | `documented_intent` | Full JSON parse of declared values. |
| `records[].deliveryScripts[].name`, `.command` | `documented_intent` | |
| `records[].deliveryScripts[].kind` | `mechanical_inference` | Hypothesis correct — regex over the *script name* (`:387-391`). Note `"other"` is filtered out entirely (`:398`), so no `unresolved` value ever appears in this field. |
| `records[].settings.sections`, `.environmentVariables` (netlify/supabase TOML) | `mechanical_inference` | Line scanner. Per R2. |
| `records[].settings.*Count` (vercel) | `documented_intent` | Full JSON parse. |
| `metadata.deploymentScripts[]` | as the record | |
| `metadata.workflowCount` | `observed_fact` | Count of files found by reading `.github/workflows/`. |
| `metadata.workflowEnvironmentVariables`, `.workflowSecretNames` | `mechanical_inference` | |

### 6.5 planning (`lib/collect-planning.mjs`)

| Field | Label | Note |
|---|---|---|
| `records[].path` | `observed_fact` | Hypothesis correct — the document's existence is observed. |
| `records[].lineCount`, `.byteSize` | `observed_fact` | |
| `records[].headings[]` | `documented_intent` | **[CORRECTION]** The hypothesis says "a document's existence/headings are observed fact" and then, in its next clause, "its own content IS documented intent by nature." Headings *are* content. Their *presence* is observed; their *text* is an authored claim. Per R1 they are `documented_intent`. |
| `records[].title` | `documented_intent` / `mechanical_inference` | Value-dependent. `titleFrom` (`:95-98`) uses the first `#` heading when present → `documented_intent`; when absent it falls back to the **filename** → `mechanical_inference`, since no human wrote that string as a title. |
| `records[].status`, `.owner` | `documented_intent` | Front-matter claims. Hypothesis correct. |
| `records[].kind` | `documented_intent` / `mechanical_inference` | Hypothesis correct and worth restating precisely. `documentRecord` (`:114-118`) takes `classification` from `config.authorityDocuments` when the repository declared a role in `.repo-intelligence.json` → `documented_intent`; otherwise it guesses from `/decisions/` or `/tasks/` in the path → `mechanical_inference`. **Latent defect the labeling exposes:** the terminal else-branch calls *everything* else `"roadmap"` (`:118`), so a `docs/plans/` document is silently labeled a roadmap with no way to express `unresolved`. Adding an `"unknown"` kind is a prerequisite for honest labeling here, and is a separate change from this spec. |
| `metadata.documentCount` | `observed_fact` | |
| `metadata.authorityDocumentCount`, `.authorityPaths` | `documented_intent` | The paths exist (observed), but the assertion *these are the authority documents* comes from `.repo-intelligence.json`. The claim, not the existence, is what the field carries. |
| `metadata.externalContext.source`, `.required`, `.accessed` | `observed_fact` | Facts about the tool's own policy — the hardcoded stub at `:233-239` always reports `accessed: false`, and that is true. |
| `metadata.externalContext.status`, `.representation` | `unresolved` | A permanently-unresolved slot: `"unavailable"` / `"unavailable external context"` by construction. |

### 6.6 product (`lib/collect-product.mjs`)

| Field | Label | Note |
|---|---|---|
| `records[0].type` | `observed_fact` | A constant schema discriminator; it truthfully reports the record's own kind. |
| `records[0].product` | `documented_intent` / `mechanical_inference` / `unresolved` | Value-dependent, three ways. Non-null → `documented_intent` (a human's declared product identity in `.repo-intelligence.json`, gated on a signal actually firing at `:177`). `null` with a configured name but no signal hits → `mechanical_inference` (the tool inferred non-identity — a determinate negative). `null` with no config at all → `unresolved`. |
| `records[0].inspectedSourceFiles` | `observed_fact` | Count of files actually read (`:166`). |
| `metadata.signals[].id` | `documented_intent` | Hypothesis correct — a human declaring "this pattern means X". Note the pattern itself is never emitted, so the id is the only surface the intent has. |
| `metadata.signals[].evidencePaths[]` | `mechanical_inference` | Hypothesis correct — regex hits over source text (`:168`). |
| `metadata.riskSurfaces[].id` | `documented_intent` | |
| `metadata.riskSurfaces[].severity` | `documented_intent` | **[ADDITION]** Not in the hypothesis and worth calling out: severity is a human's unverified judgment carried straight through from config (`:92-96`). It is never derived from anything in the repository. |
| `metadata.riskSurfaces[].detected`, `.evidencePaths[]` | `mechanical_inference` | |
| `metadata.product` | as `records[0].product` | Same value since the 2026-08-07 addendum; must carry the same label. |

**Note on truncation.** When `SOURCE_COLLECTION_WARNING` / depth / oversized warnings fire,
`evidencePaths` is incomplete but every path in it is a real hit. The label stays
`mechanical_inference`; incompleteness is a `status` / `warnings` concern per R4. Do not
downgrade a set's label because the set is short.

## 7. Before / after, one per collector

Every example is a real shape from the code paths cited above. Only `evidenceLabels` is
added; no existing key changes name, type, or value.

### 7.1 files — a tracked source file (git discovery)

**Before**

```json
{
  "path": "lib/collect-files.mjs",
  "extension": ".mjs",
  "byteSize": 12873,
  "classification": "source",
  "tracked": true,
  "isBinary": false,
  "contentInspectionSkipped": true,
  "skipReason": "classified-by-path"
}
```

**After**

```json
{
  "path": "lib/collect-files.mjs",
  "extension": ".mjs",
  "byteSize": 12873,
  "classification": "source",
  "tracked": true,
  "isBinary": false,
  "contentInspectionSkipped": true,
  "skipReason": "classified-by-path",
  "evidenceLabels": {
    "default": "observed_fact",
    "fields": {
      "classification": "mechanical_inference",
      "isBinary": "mechanical_inference",
      "skipReason": "mechanical_inference"
    }
  }
}
```

### 7.1b files — the same collector in filesystem-fallback mode

Included because the fallback is where three of the four labels appear at once.

**Before**

```json
{
  "records": [
    {
      "path": "docs/assets/logo.svg",
      "extension": ".svg",
      "byteSize": 2044,
      "classification": "asset",
      "tracked": null,
      "isBinary": false,
      "contentInspectionSkipped": true,
      "skipReason": "classified-by-path"
    }
  ],
  "metadata": { "discovery": "filesystem", "tracking": "unavailable", "recordCount": 1 }
}
```

**After**

```json
{
  "records": [
    {
      "path": "docs/assets/logo.svg",
      "extension": ".svg",
      "byteSize": 2044,
      "classification": "asset",
      "tracked": null,
      "isBinary": false,
      "contentInspectionSkipped": true,
      "skipReason": "classified-by-path",
      "evidenceLabels": {
        "default": "observed_fact",
        "fields": {
          "classification": "mechanical_inference",
          "isBinary": "mechanical_inference",
          "skipReason": "mechanical_inference",
          "tracked": "unresolved"
        }
      }
    }
  ],
  "metadata": {
    "discovery": "filesystem",
    "tracking": "unavailable",
    "recordCount": 1,
    "evidenceLabels": {
      "default": "observed_fact",
      "fields": { "tracking": "unresolved" }
    }
  }
}
```

`discovery: "filesystem"` stays `observed_fact` — the collector really did take that path.
`tracking: "unavailable"` is a placeholder for something it could not determine, so per
§3.4 it is `unresolved`.

### 7.2 git — metadata on a feature branch with no local `main` and no upstream

**Before**

```json
{
  "records": [
    { "sha": "9f1c0a2e5b7d4c8a1f3e6b9d2c5a8f0e4b7d1c3a", "subject": "Harden the write gate" }
  ],
  "metadata": {
    "currentBranch": "feat/evidence-labels",
    "headCommit": "9f1c0a2e5b7d4c8a1f3e6b9d2c5a8f0e4b7d1c3a",
    "defaultRemote": { "name": "origin", "url": "https://github.com/ohnoai/repo-intel.git" },
    "trackingBranch": null,
    "ahead": null,
    "behind": null,
    "clean": false,
    "dirty": true,
    "worktrees": [
      { "alias": "repo-root", "branch": "feat/evidence-labels", "head": "9f1c0a2e", "detached": false, "bare": false }
    ],
    "diff": { "baseRef": "HEAD", "changedFiles": [], "numstat": [] }
  }
}
```

**After**

```json
{
  "records": [
    {
      "sha": "9f1c0a2e5b7d4c8a1f3e6b9d2c5a8f0e4b7d1c3a",
      "subject": "Harden the write gate",
      "evidenceLabels": {
        "default": "observed_fact",
        "fields": { "subject": "documented_intent" }
      }
    }
  ],
  "metadata": {
    "currentBranch": "feat/evidence-labels",
    "headCommit": "9f1c0a2e5b7d4c8a1f3e6b9d2c5a8f0e4b7d1c3a",
    "defaultRemote": {
      "name": "origin",
      "url": "https://github.com/ohnoai/repo-intel.git",
      "evidenceLabels": {
        "default": "observed_fact",
        "fields": { "name": "mechanical_inference" }
      }
    },
    "trackingBranch": null,
    "ahead": null,
    "behind": null,
    "clean": false,
    "dirty": true,
    "worktrees": [
      {
        "alias": "repo-root",
        "branch": "feat/evidence-labels",
        "head": "9f1c0a2e",
        "detached": false,
        "bare": false,
        "evidenceLabels": {
          "default": "observed_fact",
          "fields": { "alias": "mechanical_inference" }
        }
      }
    ],
    "diff": {
      "baseRef": "HEAD",
      "changedFiles": [],
      "numstat": [],
      "evidenceLabels": { "default": "unresolved", "fields": {} }
    },
    "evidenceLabels": {
      "default": "observed_fact",
      "fields": {
        "ahead": "unresolved",
        "behind": "unresolved",
        "trackingBranch": "unresolved"
      }
    }
  }
}
```

Three things this example pins down. `defaultRemote.name` is `mechanical_inference`
**here** because no `remote.pushDefault` or `branch.*.remote` was configured — the
collector fell back to the literal `"origin"` branch of the precedence; had git config
declared it, the same field would be `observed_fact`. `clean`/`dirty` inherit
`observed_fact` from `default` — this is the hypothesis correction, visible as the *absence*
of an override. The `diff` subtree resolved to `HEAD`, so its whole subtree is `unresolved`
via one nested block rather than three overrides.

### 7.3 configuration — an environment variable with all four labels in one object

**Before**

```json
{
  "name": "VITE_SUPABASE_URL",
  "classification": "public/client",
  "descriptions": ["Public Supabase project URL used by the browser client"],
  "declarations": [{ "path": ".env.example", "line": 4 }],
  "references": [
    { "path": "src/lib/supabase.ts", "line": 3, "accessStyle": "import.meta.env.NAME" }
  ],
  "accessStyles": ["import.meta.env.NAME"]
}
```

**After**

```json
{
  "name": "VITE_SUPABASE_URL",
  "classification": "public/client",
  "descriptions": ["Public Supabase project URL used by the browser client"],
  "declarations": [{ "path": ".env.example", "line": 4 }],
  "references": [
    { "path": "src/lib/supabase.ts", "line": 3, "accessStyle": "import.meta.env.NAME" }
  ],
  "accessStyles": ["import.meta.env.NAME"],
  "evidenceLabels": {
    "default": "observed_fact",
    "fields": {
      "accessStyles": "mechanical_inference",
      "classification": "mechanical_inference",
      "descriptions": "documented_intent",
      "references": "mechanical_inference"
    }
  }
}
```

`name` and `declarations` inherit `observed_fact`; the override on `references` covers its
nested `path`/`line`/`accessStyle` transitively, which is the point of §3.3 — a regex
finding does not become observed just because it carries a line number. Had
`classification` been the literal `"unknown"`, that one override would read `"unresolved"`
instead, per R3.

### 7.4 delivery — a GitHub workflow record

**Before**

```json
{
  "path": ".github/workflows/ci.yml",
  "type": "github-workflow",
  "format": "yaml",
  "name": "CI",
  "triggers": ["pull_request", "push"],
  "jobs": [
    {
      "id": "verify",
      "runners": ["ubuntu-latest"],
      "npmScripts": ["verify"],
      "environmentVariables": [{ "name": "DEPLOY_REGION", "provenance": ["env-declaration", "shell"] }],
      "secretNames": []
    }
  ],
  "npmScripts": ["verify"],
  "environmentVariables": [{ "name": "DEPLOY_REGION", "provenance": ["env-declaration", "shell"] }],
  "secretNames": [],
  "malformed": false
}
```

**After**

```json
{
  "path": ".github/workflows/ci.yml",
  "type": "github-workflow",
  "format": "yaml",
  "name": "CI",
  "triggers": ["pull_request", "push"],
  "jobs": [
    {
      "id": "verify",
      "runners": ["ubuntu-latest"],
      "npmScripts": ["verify"],
      "environmentVariables": [{ "name": "DEPLOY_REGION", "provenance": ["env-declaration", "shell"] }],
      "secretNames": []
    }
  ],
  "npmScripts": ["verify"],
  "environmentVariables": [{ "name": "DEPLOY_REGION", "provenance": ["env-declaration", "shell"] }],
  "secretNames": [],
  "malformed": false,
  "evidenceLabels": {
    "default": "mechanical_inference",
    "fields": {
      "malformed": "observed_fact",
      "path": "observed_fact"
    }
  }
}
```

This is the inverted case: for a workflow record the *default* is inference and observed
fact is the exception, because nothing here came from a YAML parser. When `malformed` is
`true`, `default` flips to `"unresolved"` and `type`/`format` join `fields` as
`mechanical_inference` — the file's shape is still knowable from its path even when its
contents were not scannable.

### 7.5 planning — a decision document

**Before**

```json
{
  "path": "docs/decisions/2026-08-06-repository-intelligence-exporter-extraction.md",
  "kind": "decision",
  "title": "Repository Intelligence Exporter Extraction",
  "headings": ["Repository Intelligence Exporter Extraction", "Context", "Decision", "Consequences"],
  "lineCount": 92,
  "byteSize": 5218,
  "status": null,
  "owner": null
}
```

**After**

```json
{
  "path": "docs/decisions/2026-08-06-repository-intelligence-exporter-extraction.md",
  "kind": "decision",
  "title": "Repository Intelligence Exporter Extraction",
  "headings": ["Repository Intelligence Exporter Extraction", "Context", "Decision", "Consequences"],
  "lineCount": 92,
  "byteSize": 5218,
  "status": null,
  "owner": null,
  "evidenceLabels": {
    "default": "documented_intent",
    "fields": {
      "byteSize": "observed_fact",
      "kind": "mechanical_inference",
      "lineCount": "observed_fact",
      "owner": "unresolved",
      "path": "observed_fact",
      "status": "unresolved"
    }
  }
}
```

A planning document is the one record type whose *default* is `documented_intent` — it is
mostly authored content, with a few observed facts about the file itself bolted on. `kind`
is `mechanical_inference` because it was guessed from `/decisions/` in the path; had this
repository declared the file's role in `.repo-intelligence.json`, `kind` would drop out of
`fields` and inherit `documented_intent`. `status` and `owner` are `null` because this
document has no front matter — placeholders for undetermined values, so `unresolved` per
§3.4, not `documented_intent`.

### 7.6 product — signals and risk surfaces

**Before**

```json
{
  "product": "SliceBoard",
  "signals": [
    { "id": "budget-allocation", "evidencePaths": ["src/lib/budget.ts", "src/state/slices.ts"] }
  ],
  "riskSurfaces": [
    { "id": "raw-html-injection", "severity": "high", "detected": true, "evidencePaths": ["src/components/Preview.tsx"] }
  ]
}
```

**After**

```json
{
  "product": "SliceBoard",
  "signals": [
    {
      "id": "budget-allocation",
      "evidencePaths": ["src/lib/budget.ts", "src/state/slices.ts"],
      "evidenceLabels": {
        "default": "documented_intent",
        "fields": { "evidencePaths": "mechanical_inference" }
      }
    }
  ],
  "riskSurfaces": [
    {
      "id": "raw-html-injection",
      "severity": "high",
      "detected": true,
      "evidencePaths": ["src/components/Preview.tsx"],
      "evidenceLabels": {
        "default": "documented_intent",
        "fields": {
          "detected": "mechanical_inference",
          "evidencePaths": "mechanical_inference"
        }
      }
    }
  ],
  "evidenceLabels": {
    "default": "documented_intent",
    "fields": {}
  }
}
```

This is the cleanest demonstration of why per-field labels are necessary rather than
per-record ones. Inside a single risk-surface object, `id` and `severity` are a human's
unverified declaration and `detected`/`evidencePaths` are regex output. A per-record label
would have to pick one and lie about the other.

## 8. Where the hypothesis was right, wrong, or unrepresentable

| Hypothesis | Verdict |
|---|---|
| files: paths/tracked observed, classification inference, fallback `tracked: null` unresolved | **Correct**, and incomplete — `isBinary` is never observed (it is extension-derived), and `classification: "unknown"` is `unresolved`, not inference. |
| git: branch/HEAD/diff numbers observed | **Correct**, minus `numstat` `null` for binary files. |
| git: clean/dirty are mechanical inference | **Wrong.** `git status --porcelain` emptiness is a direct read. `observed_fact`. |
| git: default-remote parsing is mechanical inference | **Half wrong.** Inference only in the `origin`/first-remote fallback; git-config-declared remotes are observed. |
| git: diff base resolving to HEAD with a warning is unresolved | **Correct.** |
| config: raw values from files are observed fact | **Wrong.** Per R1 declared values (`dependencies`, `name`, `scripts`, `compilerOptions`) are `documented_intent`. Observed fact in this collector is limited to paths, declaration sites, and the identifiers themselves. |
| config: `.env.example` comments are documented intent | **Correct.** |
| config: public/client vs server-only is mechanical inference | **Correct**, plus `"unknown"` → `unresolved`. |
| config: "could not be resolved statically" is unresolved | **Right in spirit, unrepresentable.** See §9. |
| delivery: workflow triggers/runners are observed fact | **Wrong, and this is the biggest correction.** Everything a workflow record contains comes from a line scanner, not a YAML parser. All `mechanical_inference`. |
| delivery: script kind is mechanical inference | **Correct.** |
| delivery: malformed YAML/TOML is unresolved | **Correct.** |
| planning: existence/headings are observed fact | **Half wrong.** Existence yes; heading *text* is content, therefore `documented_intent`. |
| planning: document content is documented intent by nature | **Correct** — and it is what makes the headings clause above wrong. |
| planning: kind from path rather than config is mechanical inference | **Correct**, and it surfaces a latent defect (`"roadmap"` as a silent catch-all). |
| planning: an absent required authority doc is unresolved | **Right in spirit, unrepresentable today.** See §9. |
| product: the signal/risk definition is documented intent | **Correct**, and `severity` belongs in that set too. |
| product: whether the pattern matches is mechanical inference | **Correct.** |
| product: a dropped invalid config entry is unresolved | **Right in spirit, unrepresentable.** See §9. |

## 9. What this design deliberately does not cover

Four of the hypothesis items describe evidence that **never becomes a value**, so no field
label can carry them (R4). They are listed here rather than quietly dropped, because a
reader could otherwise reasonably expect them to be labeled:

1. **`config`: a dynamic `process.env[expr]` access** (`collect-config.mjs:594`). Warned
   about; no record emitted. Emitting a placeholder record per unresolved access would be
   unbounded — the count is a function of arbitrary source, with no limit in place.
   **Recommendation: leave in `warnings`/`observations`.**
2. **`product`: a dropped invalid signal/risk config entry** (`collect-product.mjs:76`,
   `:88`, `:94`). Same shape, but *bounded* by the config file's own array length. Still
   recommend `warnings`/`observations`, on the grounds that a config the tool refused to
   load is a fact about the config, not evidence about the repository.
3. **`git`: name-status / numstat records dropped as malformed.** Counted internally
   (`parseNameStatus` returns `malformed`), surfaced only as a warning. A per-dropped-record
   entry would be unbounded.
4. **`planning`: a required authority document that is absent** (`collect-planning.mjs:220`).
   This one *is* cheaply bounded — by `config.requiredAuthorityDocuments.length`, a
   finite declared list. A record of the form
   `{ path, kind, present: false, evidenceLabels: { default: "unresolved", fields: { path: "observed_fact" } } }`
   would represent it honestly. **Flagged as optional and out of scope for this spec**: it
   adds a record variant to `records[]`, which is a shape change beyond labeling and needs
   its own schema decision.

Also out of scope: set-level completeness. A truncated scan, a bounded document list, or a
short `evidencePaths` array does not change any label. Labels describe values; completeness
is `status`.

## 10. Implementation plan (v1)

### 10.1 Correction: the S3/S6 dependency was overstated

An earlier revision of this section said this work belonged with or after **S6**, was
transitively blocked on **S3**, and that landing it sooner would be "actively harmful."
**That was wrong and is retracted.** The claim does not hold at the mechanism level.

- **S3 (warnings vs. observations).** Label values are computed from the values the
  collectors already emit — a path, a `null`, a classification string. No label reads the
  `warnings` array. S3 changes which channel an event is *reported* in; it changes no
  label. The rework test settles it: if v1 ships now and S3 lands later, **zero labels
  change and no test assertion on a label value moves.** Two sentences of prose in §9 need
  "warnings" to read "warnings/observations." That is the entire coupling.
- **S6 (schema v2 + structural guard).** Its only real contact point is the always-present
  `diff` key. Today `export.mjs:130-133` deletes that key outright when `includeDiff` is
  false, so there is nothing to label: the last row of §6.2 and item 1 of §11 are simply
  **not applicable until S6 lands**, and become applicable additively when it does. The
  schemaVersion bump is one line and does not require the rest of the slice (see §10.5).

Neither slice is a prerequisite. The original claim was reasoning by association — labels
concern trustworthiness, S3 concerns trustworthiness — not by tracing what the code reads.

There is also a mild interaction in the *opposite* direction worth recording: labels make
the RI-STATUS confusion less acute in the interim, because a reader who sees
`status: "partial"` can see from the labels that only `diff.baseRef` is `unresolved` while
everything else in that collector is `observed_fact`. That does not fix RI-STATUS — the
status word is still misleading — but it argues for shipping labels sooner, not later.

### 10.2 Relationship between §6 and this section

**§6 is the target mapping. This section is the shipping route.** v1 deviates from §6 in
exactly three places, named in §10.4. Every other row of §6 ships as written. A reader
should treat §6 as the destination and §10.4 as the current, deliberate shortfall against
it — not as a contradiction.

### 10.3 The simplification rule

> **When simplifying a label for v1, round toward the more skeptical label.**
>
> A simplification may move a label toward less claimed certainty about the repository —
> toward `mechanical_inference` from `observed_fact`, or toward `unresolved` from any
> label. It may **never** move a label toward `observed_fact`.

The asymmetry is the whole point of the feature. Over-claiming — stamping `observed_fact`
on something the tool guessed — is precisely the failure evidence labels exist to prevent,
and a consumer has no way to detect it. Under-claiming costs a reader precision they can
recover by looking at the underlying value. **Skepticism is recoverable; false confidence
is not.**

This rule is what licenses the cuts in §10.4, and it is the standard any future pass
restoring precision must meet. Each cut below therefore records three things: the direction
it rounds, what is lost, and **what "more precise" would concretely look like if someone
wants it back** — so a later revisit is a decision, not an archaeology exercise.

### 10.4 The three v1 simplifications

**V1-1 · `git` `metadata.defaultRemote.name` is always `mechanical_inference`.**

§6.2 splits this field: `observed_fact` when `remote.pushDefault` or `branch.<b>.remote`
declared the remote, `mechanical_inference` only on the `"origin"` / first-remote fallback.
v1 does not split it and labels the field `mechanical_inference` unconditionally.

- *Direction:* skeptical — some genuinely observed facts are under-claimed as inference.
  Compliant with §10.3.
- *What is lost:* a reader cannot distinguish a configured default remote from a guessed
  one. Low impact: `defaultRemote.url` sits alongside it and is `observed_fact` either way.
- *Why cut:* `collect-git.mjs:447-452` builds an ordered precedence array and calls
  `.find(Boolean)`, which returns the value and discards which branch matched. Recovering
  it means changing control flow in the git collector during a schema change. Cut for churn
  isolation, not difficulty.
- *What "more precise" looks like:* replace the `.find` with a `findIndex`, carry the index
  to the labeler, and label indices 0–1 `observed_fact` and 2–3 `mechanical_inference`.
  Roughly five lines in one function, plus one fixture per branch.

**V1-2 · `product` identity collapses from three cases to two.**

Stated exactly. For both `records[0].product` and `metadata.product` (the same value since
the 2026-08-07 addendum, and they must always carry the same label):

- `config.name` is set **and** at least one configured signal fired → **`documented_intent`**.
- **Every other outcome** — which is exactly every outcome where `product` resolves to
  `null`, whether that is *a configured name whose signals did not fire* or *no `product`
  config at all* → **`unresolved`**.

Dropped from §6.6: the `mechanical_inference` case for "configured name, no signal hit,"
which §6.6 read as the tool having determined a negative.

- *Direction:* skeptical. Compliant with §10.3.
- *Why cut — and this one is a semantic argument, not a cost argument:* neither collapsed
  case is a claim worth standing behind. From a consumer's position both mean "this bundle
  does not identify a product." Calling the second an *inferred negative* implies the config
  was correct for this repository and the repository genuinely is not that product — which
  the collector cannot distinguish from a stale config, or from `--root` being pointed at
  the wrong repository entirely. `unresolved` is the honest reading of both.
- *What "more precise" looks like:* the distinction is already sitting at
  `collect-product.mjs:177` (`config.name` truthy, `signals.length` zero) at zero
  control-flow cost. **This cut was made on the argument above, not for implementation
  effort — so restoring it requires rebutting that argument, not writing code.** It is
  simultaneously the cut most likely to be wrong and the cheapest to reverse.

**V1-3 · The fail-closed label checker is deferred.**

The five structural assertions in §10.6 are the target. v1 ships without them and relies on
the per-collector tests in §10.7 instead.

- *Direction:* not applicable — this defers a **guard**, not a label. No label value
  changes, so §10.3 does not govern it.
- *What is lost:* a mistyped token, or a `fields` key naming a field that does not exist,
  would ship silently instead of failing the write. Bounded by the fact that labels are
  static strings in collector source, never data read off disk (§5).
- *What "more precise" looks like:* it is the narrow slice of C7 — roughly thirty lines in
  `export.mjs`'s `validateArtifact`. Take it when S6 lands, or sooner; it does not require
  the rest of S6 (the "reject unknown top-level shape" and always-present-`diff` parts).

### 10.5 schemaVersion

**Bump by one, unconditionally**, on whichever path is chosen — v1 as scoped here, or the
full §6 mapping later. The output shape changes either way, and a reader diffing two
bundles must be able to see that the shape moved without inspecting it. This is one line
plus the one test that asserts the current value; it does not pull in any other part of S6.
If S6 has already consumed `2`, this is `3`.

Note that v1 and the eventual full mapping are **not** separate schema versions: v1 changes
label *values* on a shape that is already correct, so restoring V1-1 or V1-2 later is a
value change within the same schema, not another bump.

### 10.6 Deferred structural guard (target shape, not v1)

Fail-closed, before any write:

- Every object containing `evidenceLabels` has exactly the keys `default` and `fields`
  within it.
- `default` is one of the four tokens.
- Every value in `fields` is one of the four tokens.
- Every key in `fields` names a key actually present on the same object.
- No key in `fields` is `evidenceLabels`.

### 10.7 Test obligations (v1)

- Per collector: a fixture asserting the exact `evidenceLabels` block on at least one
  record and on `metadata`, including one value-dependent case (the `"unknown"`
  classification, the `null` `tracked`, the `malformed` workflow, the HEAD-resolved diff
  base, or the two-way `product` outcome).
- Shared: the `unavailable` early return of all six collectors emits
  `metadata.evidenceLabels = { default: "unresolved", fields: {} }`.
- Shared: a round-trip through `sanitizeEvidence` + `validateArtifact` leaves all four
  tokens and all `fields` keys unchanged and does not throw.
- **Pinning the simplifications:** one test each asserting V1-1 (`defaultRemote.name` is
  `mechanical_inference` even when `remote.pushDefault` is configured) and V1-2 (`product`
  is `unresolved` both with an unmatched configured name and with no config). These exist so
  that restoring precision later is a deliberate, reviewed change rather than a silent one,
  and so a reader of a failing test is pointed at §10.4 rather than guessing.

**Not required:** a per-field label registry. That is the same non-goal as D9 — the guard is
structural, not per-field.
## 11. Weakest points, stated on purpose

1. **`diff` with `omitted: true` labeled `unresolved` — inert until S6 lands.** This weak
   point does not apply to v1 and a v1 reader should not treat it as a live concern. Per
   §10.1's retraction, `export.mjs:130-133` deletes the `diff` key outright when
   `includeDiff` is false, so `diff.omitted` does not exist in v1 output and there is
   nothing to mislabel. **Trigger condition: revisit this note when S6 actually ships the
   always-present `diff` key, while S6's diff handling is still being decided — not
   before, and not as a standalone fix.** The concern itself, preserved verbatim for that
   moment: "not attempted" is not the same as "attempted and failed," and the four labels
   cannot express the difference. The alternative — omitting `evidenceLabels` from an
   omitted subtree entirely — trades a slightly wrong label for a hole in the structural
   guard. §6.2 currently chooses the wrong label; that choice is open to reversal and
   should be settled as part of S6's diff handling rather than inherited unexamined from
   this draft.
2. **`observed_fact` on a `false` `isGitRepository` produced by a transient git failure**
   (RI-GIT-ISREPO). The label will faithfully report the collector's wrong answer. Fixing
   the defect is the fix; the label is not a substitute.
3. **`planning.kind` has no `"unknown"` value**, so the catch-all `"roadmap"` branch cannot
   be labeled `unresolved` and will be labeled `mechanical_inference` — technically true,
   but it dignifies a guess.
4. **Output size.** +25–35% on the files section is a real cost for a tool whose artifacts
   are meant to be pasted into a model context. If that proves unacceptable in practice, the
   lever is fewer overrides via better `default` choices, not dropping the feature.
5. **R1 is a judgment call.** Reading `package.json` `dependencies` as `documented_intent`
   rather than `observed_fact` is defensible but not the only defensible reading. It is the
   single assumption most likely to be re-litigated, and most of §6.3 moves with it.

