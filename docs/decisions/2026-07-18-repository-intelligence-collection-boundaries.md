# Repository Intelligence Collection Boundaries

## Context

The Repository Intelligence Exporter needs useful local repository evidence without
reading environment values, exporting binary content, leaking local paths, or relying
on a working Git executable.

Independent adversarial review identified boundary gaps in path redaction, local remote
handling, malformed Git output, fallback discovery, and Git command ambient state.

The next collection slices need configuration, delivery, planning, and product evidence
while retaining the same privacy boundary for environment variables and deployment
configuration. The completed exporter also needs a safe local delivery path for those
records.

## Decision

The exporter is deterministic, local, and read-only. The first collection slice and the
later collectors share these boundaries.

- File inventory uses Git's NUL-delimited tracked and untracked listings when Git is
  available. It falls back to a constrained filesystem walk otherwise.
- File records contain metadata only. The collector never reads file bytes; it classifies
  known binary assets and environment files by path, and never traverses excluded
  local/build directories.
- Exported repository-relative paths are normalized and then passed through text
  sanitization. The original relative path stays internal solely for metadata lookup.
- Filesystem fallback excludes environment files, TypeScript build-info files, `.claude`,
  and hidden local entries except an explicit safe repository-config allowlist.
- Git inventory uses only summary commands. It records changed-file and numstat
  evidence, never patch content.
- Git worktrees use repository-relative aliases, and remote URLs are sanitized before
  being included in collector output.
- Git commands use a bounded timeout, ignore ambient Git directory/index/external-diff
  overrides, disable system Git configuration, reject option-like base refs, and use
  end-of-options markers before supported ref arguments.
- Malformed NUL-delimited name-status and numstat records mark inventory partial with
  generic warnings; invalid numstat counts are represented as `null`.
- Configuration collection reads only a bounded recognized-file allowlist and exports
  selected metadata. Package locks, workflows, and arbitrary configuration bodies are
  never exported wholesale.
- `.env.example` may provide variable names, declaration locations, and sanitized
  comments. Comments are capped at 240 characters and discarded when they resemble
  assignments, credential values, or opaque tokens. Private `.env*` files are never
  inspected, and environment assignment values are never emitted.
- Shared metadata sanitization removes local Windows/POSIX paths, shell environment
  assignments, and recognized credential-option values before package-script metadata
  is emitted. It preserves HTTPS URLs rather than treating URL paths as local paths.
- Source scans collect mechanically recognized dot-property and literal-bracket
  environment access. Dynamic or whole-environment access produces a generic
  incompleteness warning. Collector and test sources are excluded so fixtures do not
  become repository evidence. Client/server placement contradictions are evidence
  warnings, not security conclusions.
- Workflow and TOML collection uses conservative dependency-free parsing. Missing or
  malformed optional input yields partial structured output rather than a collector
  failure. TOML array tables are recognized, malformed headers clear the current
  section, and workflow environment names are accepted only from indentation-bounded
  `env:` mappings.
- Planning collection reads bounded repository authority, decision, task, and roadmap
  metadata without exporting document bodies. Product collection uses bounded source
  inspection to emit SliceBoard signals and risk-surface paths, not source contents.
- Nested Git boundaries are excluded from configuration and product collection.
- Configuration and delivery filesystem access is guarded to the repository root and
  excludes local/generated directories. Sanitizer remediation is applied before export,
  and final artifact validation is fatal if sensitive text remains.
- The export CLI writes `evidence-bundle.json` and `summary.md`. Its default output is
  `tmp/repository-intelligence/`, which must remain contained to the repository. It
  refuses to overwrite an existing output directory unless `--overwrite` is explicit.
- Raw diffs are excluded by default. `--include-diff` may add only the sanitized Git
  diff summary metadata; raw patch content is never exported.
- Repository authority files (`SLICE_BOARD_AUTHORITY.md`, `PASSOFF.md`, `AGENTS.md`,
  and the repository documentation map as applicable) are implementation constraints.
  Google Drive keeper notes are unavailable optional external context only, represented
  as unavailable metadata, and are never a dependency.

## Validation record

- The real workspace bundle was generated and independently inspected at
  `tmp/repository-intelligence/`.
- Validated artifact scope: configuration partial (11 records, 3 warnings, 20
  environment-variable names), delivery 6, files 293, Git 20, planning 19, and
  product 1.
- Focused intelligence tests passed: 77 total (sanitize 16, collectors 18,
  configuration 21, planning/product 8, export 14). The full suite passed with 81
  files and 661 tests. Lint passed with 12 pre-existing warnings; typecheck, build,
  and `git diff --check` passed.
- Output is metadata-only; raw diffs are excluded by default. Google Drive was
  unavailable and was not accessed.

## Consequences

Git absence produces partial file output with unknown tracked state and unavailable
Git output rather than a collector crash. The CLI assembles these collector results
into a sanitized bundle and uses the tracking branch or `HEAD` for comparison unless a
base is explicitly supplied. The required `contentInspectionSkipped` output field
remains even though the metadata-only file collector always skips byte inspection.
User-owned `.vscode/` and `tmp/` entries remain untouched and must not be staged
incidentally.

The exporter implementation and real-workspace validation are complete for this
bounded slice. The result does not claim broader completeness: parsing remains
bounded, dynamic environment access remains incomplete, and pattern-based sanitizer
coverage can miss unknown credential flags or other unrecognized sensitive forms.

These collectors deliberately do not parse arbitrary shell, JavaScript, YAML, or TOML
syntax. Alias-based, dynamically computed, and complex inline environment references
may be absent; unknown credential flags may also require future sanitizer coverage.
