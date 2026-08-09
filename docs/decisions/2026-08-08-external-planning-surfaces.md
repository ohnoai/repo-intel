# External Planning Surfaces (OBSERVATION)

> **STATUS: OBSERVATION ONLY. NOT A DECISION RECORD, AND NOT A DESIGN.**
> No code was written or changed for this. It records a problem that is about to
> exist, and one shape a solution might take. It is deliberately short because the
> thought is short; padding it into a spec would misrepresent how settled it is.
> It becomes a design document only if and when someone decides the problem is
> worth solving, and a decision record only after that design ships and verifies.

## 1. Context

On 2026-08-08 the decision was made to run a self-hosted Vikunja instance as the
primary task system, and to adopt `veans` — Vikunja's agent CLI — for repository
work. `veans init` writes a committed `.veans.yml` at a repo root and moves that
repo's execution tracking into a Vikunja project with five fixed Kanban buckets.

The working split, still unproven and to be tested on SliceBoard first:

- **`plans/` stays in the repository.** Approval records. Durable intent, human-
  approved before implementation, read as prose.
- **`tasks/` moves to Vikunja.** Execution state, which is better in a database
  that can be watched moving than in a markdown file read after the fact.

## 2. The observation

repo-intel exists to get repository context **into** an agent without pasting.
`veans` exists to get an agent's work **out** somewhere durable. Same instinct,
opposite directions. At some point they should know about each other.

## 3. Why this is a problem and not just a nice idea

`lib/collect-planning.mjs` falls back to these planning directories when a repo
declares nothing: `docs/decisions`, `docs/tasks`, `docs/roadmap`, `docs/plans`,
`tasks`, `plans`.

If execution state migrates out of `tasks/` and into a Vikunja project, those
directories thin out. The collector will faithfully report fewer documents, its
`status` will stay `"complete"`, and nothing in the bundle will indicate that a
whole planning surface moved somewhere the collector cannot see.

This is the same failure class the evidence-labels work exists to prevent: an
artifact asserting more completeness than it has earned. But it is **not** fixable
by a label. Per R4 of `2026-08-07-evidence-labels.md`, absence produces no value,
so no field label can carry it. There is currently no way for a bundle to say
*"this repository's execution tracking is real, and it is somewhere I did not
look."*

## 4. The obvious solution is wrong

The obvious move — have the planning collector query the Vikunja API and pull the
project's tasks — breaks three properties stated in the first line of the README:
**deterministic, offline, read-only**. A network read is none of the first two.
Bundle output would vary by when it ran and whether the server was reachable.

Recording this explicitly so nobody spends an afternoon building it before
noticing. Any integration that makes a live call is incompatible with what this
tool is, not merely unimplemented.

## 5. A shape that would not break anything

`.veans.yml` is committed, sits at the repo root, and contains no secrets — server
URL, project id, project identifier, view id, the five bucket ids, and the bot's
username and user id. The token lives in the OS keychain, never in the file.

Reading that file is offline, deterministic, and read-only. It would let a bundle
carry a **pointer** rather than content:

> this repository's execution tracking lives at project 42 on `<server>`, under
> identifier `PROJ`, and it is not represented in this bundle

That is honest, costs one small collector, adds no network dependency, and
converts a silent gap into a stated one. It does not attempt to represent the
tasks themselves, which is the part that cannot be done without breaking the
tool's founding properties.

Whether that belongs in `collect-planning.mjs` or in a separate collector is
undecided and deliberately not argued here.

## 6. Trigger condition

Revisit when **both** are true:

1. `veans` has been running on at least one repository long enough to confirm the
   `plans/` versus `tasks/` split above actually holds in practice, rather than
   being a prediction made on the day of the decision.
2. A bundle has been generated from a repo where planning genuinely spans both
   surfaces, and the gap has been observed rather than anticipated.

Not before. If the split turns out differently in practice — if plans migrate too,
or if `tasks/` survives alongside Vikunja — the problem changes shape and this
note should be rewritten rather than implemented.

## 7. Weakest points

1. **The `plans` / `tasks` split is a prediction, not an observation.** It was
   reasoned out on 2026-08-08 with zero days of `veans` usage behind it. Everything
   in §3 depends on it being roughly right.
2. **This may never be worth building.** A single line in a repo's `AGENTS.md`
   saying "execution tracking is in Vikunja, see `.veans.yml`" would be read by the
   planning collector as an authority document today, at zero implementation cost.
   That is a worse answer, but it may be a sufficient one.
3. **It presumes `veans` sticks.** veans describes itself as experimental. If it is
   dropped, `.veans.yml` disappears and this note is moot.

## 8. Addendum (2026-08-09): the human/agent-facing half is now solved, separately

This note is about the **collector** — repo-intel silently under-reporting when a
repo's tasks live in Vikunja instead of `docs/tasks/`. That gap is still open; the
trigger condition in §6 hasn't fired.

A related but distinct gap has been closed, independently of this document:
SliceBoard's `AGENTS.md` now states, in its own words, how an agent reconciles
`veans prime`'s "use veans instead of TodoWrite" instruction against the repo's own
`docs/tasks/` convention — the two looked contradictory to at least one outside
audit before this landed. The resolution is the same split predicted in §1
(`veans`/Vikunja = live execution state, `docs/tasks/` = durable record), stated as
a self-contained paragraph in AGENTS.md itself, not a pointer to any personal config:

> **State in Vikunja, record in the repo.** A Vikunja card answers "what is being
> worked on right now". A task file answers "what happened, and why". If you
> somehow only manage one, make it the task file — that is the half that persists.

**When repo-intel gets set up on another repository that also has a `.veans.yml`**,
this is the template to reuse: adapt SliceBoard's `AGENTS.md` "Task records" section
(the two-system framing, the claim/review/never-close-yourself workflow, the
bare-number-vs-database-id trap, the pulled-out "state in Vikunja, record in the
repo" line) rather than re-deriving it. This does not touch §6's trigger condition —
the collector still cannot see Vikunja-tracked work, and still shouldn't query it
live (§4) — it only means a human/agent working in such a repo won't hit the
ambiguity that prompted this addendum.
