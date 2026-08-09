# PASSOFF.md

Implementation map for whoever (human or agent) picks up the evidence-labels
rollout next. Status lives in [PR #1](https://github.com/ohnoai/repo-intel/pull/1)
— that checklist is the source of truth for what's done; this file explains the
*workflow* so a fresh session isn't reverse-engineering it from commit messages.

## What this is

v1 of evidence-label tagging (`observed_fact` / `documented_intent` /
`mechanical_inference` / `unresolved`) across repo-intel's six collectors, per
[`docs/decisions/2026-08-07-evidence-labels.md`](docs/decisions/2026-08-07-evidence-labels.md)
(read that first — it's the actual spec, this file is just the process around it).

## The crew, and why it's shaped this way

`opencode.json` at the repo root defines four OpenCode roles: `architect`,
`implementer`, `verifier`, `docs`. All four are `mode: "primary"` — manually
selected and driven by a human, not auto-delegating subagents. That was a
deliberate fix partway through this work, not the original design: subagent mode
would let one role silently hand off to the next with no human (or Claude) actually
looking at what happened in between. The value this whole process has actually
delivered — catching a wrong "S3/S6 dependency" claim in the design doc, catching
two real test-coverage gaps on the git collector, catching a diff-scope mixup
caused by an uncommitted checkpoint — came specifically from something pausing
between steps. Automating that away would remove the reason any of this works.

## The loop, per collector

1. **You** switch to `implementer` in OpenCode, paste the prompt for one collector
   (scoped to exactly that collector's file + its test file — never "do the rest
   too"), run it, bring the result back to **Claude**.
2. **Claude** reads the actual diff directly (not just the implementer's summary —
   summaries have been wrong or incomplete more than once) and reports findings.
3. If clean, **you** switch to `verifier` (a different model family on purpose —
   `glm-5.2`, not a Claude model — so it isn't grading its own kind of mistake),
   paste a prompt scoped to the exact files that changed, bring that back too.
4. Claude reconciles both reviews. Any real gap gets a small, targeted follow-up
   prompt back to `implementer` — not a redo of the whole collector.
5. Once both reviews are clean, **Claude commits it** as its own commit on
   `feat/evidence-labels`, and checks the box in PR #1.
6. Repeat for the next collector.

`docs` role runs once, last, after all six are checked off — flips the spec from
`DRAFT` to final, bumps `schemaVersion` by exactly one, updates the root README
and `docs/README.md`. Don't run it early; the checklist in PR #1 tracks exactly
what it needs to do.

## Prompt templates

Each collector's `implementer` prompt follows the same shape: read the spec doc,
apply exactly section 6.N to exactly one named file plus its test file, apply any
v1 simplification from section 10.4 that touches that collector, preserve existing
assertions, run the collector's specific test file, report the result. Past
prompts for `files`, `git`, and `config` are in this conversation's history if you
need the exact wording as a template for `delivery`, `planning`, `product`.

`verifier`'s prompt is the same shape every time: read the spec, `git diff` against
the exact files that changed (not a directory glob — that caused a real diff-scope
confusion once), run the full suite, check shape-match / sanitization / determinism
/ silent assertion changes, report and stop without editing.

## Things that bit us, worth not re-learning

- **Windows line-ending noise looks like lost work and isn't.** `core.autocrlf`
  will periodically make a pile of untouched files show as "modified" with zero
  actual diff content. Check `git diff -- <file> | wc -l` before assuming
  something real changed — if it's empty, `git checkout -- <file>` is safe.
- **Conversation memory of "what's done" can be wrong.** This session went through
  at least one context compaction; real committed work (the config collector, an
  unrelated planning-collector observation) existed that wasn't in active
  turn-by-turn memory. Always check `git log` and `git status` directly before
  trusting a recap, including this one.
- **`verifier`'s diff command must name exact files, not a directory.** `git diff
  -- lib/` will pick up unrelated uncommitted work sitting in that directory and
  misattribute it. Scope it to the two files that actually changed this round.
- **MCP servers spawned via a `.cmd`/shell wrapper leave zombies on restart.**
  `Kill()` on the wrapper process doesn't always cascade to the real child. Worth
  a periodic `Get-CimInstance Win32_Process` sweep if things feel sluggish.

## Where things live

- Spec: `docs/decisions/2026-08-07-evidence-labels.md`
- Crew config: `opencode.json`
- Status: [PR #1](https://github.com/ohnoai/repo-intel/pull/1)
- Related, not part of this work: `docs/decisions/2026-08-08-external-planning-surfaces.md`
  (a still-open observation about the planning collector and externally-tracked
  Vikunja/`veans` work — worth reading before starting the `planning` collector's
  evidence-label pass, since it may bear on that collector's mapping)
