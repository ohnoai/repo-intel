# 02 · History and decisions

This is the distilled backstory — compiled from a ~626KB external planning thread and a cloud
"knowledge base" document, neither of which lived in the repo. It exists so the *reasoning* behind the
current design is not lost when those external sources disappear.

## Origin

The project began (2026-07-18) from a simple question: could architecture planning be done in a
regular chat model if it were given the repo as evidence? The answer — yes, but only if the repo is
distilled into a portable, sanitized snapshot first — became the exporter itself. Rather than paste
files into a chat every time, generate a **deterministic evidence bundle** once and hand that around.

Implementation proceeded in slices: a **sanitization foundation** first, then **repository + git
collectors** (committed), then **configuration + delivery collectors**, then **planning + product
collectors and the `export.mjs` orchestrator**. The later work outran the documentation — which is
why, before this knowledge base, the code and every planning doc disagreed about what existed.

## The adversarial-review process

A recurring, deliberately combative loop drove quality:

1. One model (Claude Opus) writes a plan or implements a slice.
2. An **independent, different-family adversary** (referred to as "Terra", a GPT‑5.6 configuration)
   attacks it — *assume it is wrong; agreement is the least useful outcome*.
3. Load-bearing claims are **re-verified against the actual repo**, not accepted on authority.
4. Only then is anything banked.

This process repeatedly earned its keep. It is the same shape this session used, with the swarm's
adversary panel and verifier standing in for the external "Terra" loop — the difference being that the
agents here can read the repo directly instead of relying on pasted excerpts.

## The remediation replan saga (why the settled decisions are what they are)

After the early blocking findings were closed, ~11 "non-blocking" items accumulated on the
config/delivery slice. A first resolution plan (v1) was written — and **rejected on independent
review** for three reasons that still shape the design:

- **A speculative redaction regex was defective.** Its look-around alphabet and its consuming
  alphabet differed, producing a punctuation bypass (`secret+abcDEF123456` only partially redacted).
  A second reasoned-from-scratch regex had already shipped with defects. → **Decision: no generic
  shape-classifier regex for secrets; drop-by-default for suspicious comments.**
- **"Redact in place" weakened privacy.** Replacing a token but keeping surrounding prose leaks
  structure (which provider, which environment, rotation state). → **Decision: drop the whole
  suspicious comment, don't redact-in-place.**
- **The proposed leak-probe would have read real `.env` secrets** to build a forbidden-value list —
  violating the exporter's own boundary. → **Decision: tests use synthetic sentinel values only, and
  prove private files are never opened via filesystem-access instrumentation — never by reading them.**

The replacement plans (v2, v3) incorporated those, and a v3 review approved a baseline "after named
amendments." A v3.1 amendment was requested but **never produced** — the external loop stalled there
(the owner also could not reach the paid tooling until later, and the cloud doc drifted stale). **This
session replaced that stalled loop entirely.**

## Settled contract decisions (with rationale)

These are the durable decisions the target architecture is built on. Full specifications are in
[`04-remediation-plan.md`](04-remediation-plan.md#4-target-architecture-contracts).

- **Drop-by-default comment handling; no secret shape-classifier.** Two shape regexes shipped defects;
  a classifier that guesses "is this a secret" both over-redacts real prose and misses punctuated
  tokens. Suspicious comments are omitted whole.
- **Synthetic sentinels only in tests; never read real env values.** The central promise is "no
  secrets/paths leave the machine"; a test that reads real secrets to check them is self-defeating.
- **One versioned collector-result schema** across every collector, including early-return/unavailable
  cases — so the CLI and any consumer see a uniform shape.
- **Typed channels: `warnings` vs `observations`.** Collection *degradation* (unreadable file, missing
  tool, malformed parse) drives `partial`. Repository *observations* (things merely noticed) must
  never demote status — otherwise a perfectly healthy repo reports `partial`.
- **Workflow evidence kept typed and separate:** environment-declaration vs environment-reference vs
  secret-reference vs shell-expansion. Flattening them lets a GitHub *secret* be reported as an
  *environment variable*.
- **An explicit git diff-base contract.** Silently comparing a feature branch against its own upstream
  produces an empty, misleading diff (see RI-GIT-BASE in `03-current-state.md`).
- **One final composed-output validation boundary**, fatal on any finding — per-helper sanitize calls
  are not enough. The validator must actually cover what the redactor removes (this is where the
  current code is weakest; see the plan's contract C3).
- **Fail-closed structural guard.** Unknown/unexpected bundle shape should fail validation, never
  silently pass through.

## What changed this session (2026-07-22)

A bounded swarm re-grounded everything against the repo: five investigators + a reconciler established
the verified current state; a proposer + three adversaries produced and stress-tested a target
architecture; an independent verifier re-ran the validator/redactor live and confirmed the plan is
faithful to the code. The V1 scope was frozen, and the previously-uncommitted implementation was
committed as a baseline (`60d7e9c`). See the remaining files for the results.
