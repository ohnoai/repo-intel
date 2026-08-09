<p align="center">
 <img src="docs/assets/banner-1280x640.png" alt="repo-intel" width="100%" />
</p>

# repo-intel

> **Status: early / WIP (v0.1).** Usable, not frozen - CLI flags, collectors, and evidence shape may change. Treat as experimental.

Deterministic, offline, read-only repository intelligence exporter. Walks a repository and emits
a sanitized, portable evidence bundle - files, git state, configuration, delivery/CI surfaces,
planning documents, and product signals - that can ground architecture analysis in an LLM
conversation without pasting the repo in by hand.

**Extracted from SliceBoard on 2026-08-06.** This tool was built and originally lived inside
`ohnoai/sliceboard`, tied to one project's repository. It's general-purpose - `--root` drives all
file and configuration resolution, and the planning collector degrades cleanly to generic defaults
against any repository - so it now has its own home. Point `--root` at any repository instead of
copying the tool into each one. See
[`docs/decisions/2026-08-06-repository-intelligence-exporter-extraction.md`](docs/decisions/2026-08-06-repository-intelligence-exporter-extraction.md)
for the extraction record and [`docs/README.md`](docs/README.md) for the full history and design
knowledge base.

## Usage

```
node export.mjs --root /path/to/some/repository
```

Writes two artifacts to `<root>/tmp/repository-intelligence/`: `evidence-bundle.json` (the full
sanitized evidence) and `summary.md` (a per-collector status table plus warnings).

```
Usage: node export.mjs [options]

Options:
 --root <path> Repository root (default: current directory)
 --output <path> Must resolve to the dedicated exporter artifact directory,
 tmp/repository-intelligence under --root (default: tmp/repository-intelligence).
 Any other value is rejected; this flag exists to make that
 directory explicit on the command line, not to relocate output.
 --overwrite Explicitly replace existing evidence artifacts
 --include-diff Include sanitized Git diff summary metadata (never raw patches)
 --base <ref> Explicit diff base (default precedence: merge-base(HEAD, main)
 -> the branch's own upstream -> HEAD, with a warning rather than
 a failure when it resolves to HEAD)
 --help Show this help
```

## Configuration

No configuration is required - with none present, the planning collector falls back to generic
defaults (`AGENTS.md`, `README.md`, `docs/code-map.md` as authority documents; `docs/decisions`,
`docs/tasks`, `docs/roadmap`, `docs/plans`, `tasks`, `plans` as planning directories) and produces
clean output against any repository.

To declare a repository's own authority documents, drop a `.repo-intelligence.json` at its root - 
see [`.repo-intelligence.json.example`](.repo-intelligence.json.example):

```json
{
 "authorityDocuments": {
 "AGENTS.md": "agent-guidance",
 "README.md": "repository-overview"
 },
 "requiredAuthorityDocuments": ["AGENTS.md"]
}
```

Every declared path is forced through the same path sanitizer the collectors use internally, so a
config file cannot point collection outside its own repository.

The same file also drives the product collector, via a `product` key - with none present,
`metadata.product` comes back `null` and no signals or risk surfaces fire:

```json
{
 "product": {
 "name": "ExampleProduct",
 "signals": [
 { "id": "example-feature", "pattern": "ExampleFeatureComponent|EXAMPLE_FEATURE_FLAG" }
 ],
 "riskSurfaces": [
 { "id": "example-risk", "severity": "medium", "pattern": "dangerouslySetInnerHTML|eval\\(" }
 ]
 }
}
```

Each signal/risk-surface `id` must be lowercase kebab-case, `pattern` a regular expression source
(case-insensitive, bounded length), and `severity` one of `low`/`medium`/`high`; malformed entries
are dropped with a warning rather than failing collection. `metadata.product` is only populated once
at least one configured signal actually fires against the repository being scanned.

## Collectors

| Collector | Emits |
| --- | --- |
| files | repository file inventory (via `git ls-files` + fs fallback), classification, `.env*` flagged but never read |
| git | branch/head/worktree/commit metadata + an optional diff summary (name-status/numstat, never raw patch) |
| configuration | environment-variable **names** + visibility classification (never values) |
| delivery | CI workflows, deployment config, workflow env/secret **names** |
| planning | authority/decision/task document metadata, repository-agnostic via `.repo-intelligence.json` |
| product | product signals + risk-surface detection via bounded source scans (paths only) |

`lib/collect-product.mjs` is repository-agnostic, the same way the planning collector is: signal
and risk-surface patterns come from a repository's own `.repo-intelligence.json` (see
Configuration above). With no config present, `metadata.product` comes back `null` and no signals
fire - pointing `--root` at an unconfigured repository produces honest empty output instead of
another project's detection noise. SliceBoard's own signals/risks now live in its own
`.repo-intelligence.json`, not in this collector.

## Evidence Labels

Every value in the bundle is tagged with an `evidenceLabels` field indicating the trustworthiness of
what that value asserts: `observed_fact` (read directly from durable artifacts), `documented_intent`
(explicit statements in authority documents), `mechanical_inference` (derived from patterns), or
`unresolved` (unable to classify). See
[`docs/decisions/2026-08-07-evidence-labels.md`](docs/decisions/2026-08-07-evidence-labels.md) for
the complete mapping per collector and the design rationale.

## Privacy

The exporter never reads `.env` values, never exports binary content or raw diffs, and redacts
credentials, tokens, emails, and local absolute paths before anything is written. A final
validation pass - independent of the redactor's own allowlist - is fatal on any residual sensitive
content, so a redaction gap fails the write rather than silently shipping. Full design rationale in
[`docs/02-history-and-decisions.md`](docs/02-history-and-decisions.md).

## Status

Not a finished v1. **126 focused tests pass** as of 2026-08-09 (sanitize 33, collectors 28,
configuration 28, export 20, planning-product 17), verified with `npx vitest run` in this repository.
Slices S3 (warnings/observations split), S6 (schema v3 - evidence-labels claimed v2 first), and S7
(test-coverage hardening) are still open - see [`docs/04-remediation-plan.md`](docs/04-remediation-plan.md).

## Development

```
npm install
npm test # full suite
npm run test:sanitize # sanitize.test.mjs only
npm run test:collectors # collectors.test.mjs only
npm run test:configuration # configuration.test.mjs only
npm run test:export # export.test.mjs only
npm run test:planning-product # planning-product.test.mjs only
npm run export -- --root . # run the exporter against this repo itself
```
