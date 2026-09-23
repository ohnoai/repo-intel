import { afterEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";

import {
  SCHEMA_VERSION,
  buildAggregate,
  bundleStatus,
  composeEvidence,
  parseArguments,
  renderSummary,
  resolveOutputDirectory,
  run,
  writeArtifacts,
} from "./export.mjs";

const fixtures = [];
afterEach(() => { while (fixtures.length) rmSync(fixtures.pop(), { recursive: true, force: true }); });

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "sliceboard-export-"));
  const root = join(directory, "repo");
  mkdirSync(root);
  fixtures.push(directory);
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture", scripts: {} }));
  writeFileSync(join(root, "SLICE_BOARD_AUTHORITY.md"), "# Authority\n");
  writeFileSync(join(root, "PASSOFF.md"), "# Handoff\n");
  return { directory, root };
}

describe("repository intelligence export", () => {
  it("resolves the default output inside the repository", () => {
    const { root } = fixture();
    expect(resolveOutputDirectory(root)).toBe(join(root, "tmp", "repository-intelligence"));
  });

  it("rejects output paths outside the repository", () => {
    const { root, directory } = fixture();
    expect(() => resolveOutputDirectory(root, join(directory, "outside"))).toThrow(/inside the repository/);
  });

  it("rejects the repository root as an output target", () => {
    const { root } = fixture();
    expect(() => resolveOutputDirectory(root, ".")).toThrow(/dedicated exporter artifact directory/);
  });

  it("rejects source directories as output targets", () => {
    const { root } = fixture();
    mkdirSync(join(root, "src"));
    expect(() => resolveOutputDirectory(root, "src")).toThrow(/dedicated exporter artifact directory/);
  });

  it("rejects arbitrary existing repository directories as output targets", () => {
    const { root } = fixture();
    mkdirSync(join(root, "reports"));
    expect(() => resolveOutputDirectory(root, "reports")).toThrow(/dedicated exporter artifact directory/);
  });

  it("refuses an existing target unless overwrite is explicit, then safely overwrites the dedicated artifact directory", () => {
    const { root } = fixture();
    const output = resolveOutputDirectory(root);
    mkdirSync(output, { recursive: true });
    writeFileSync(join(output, "evidence-bundle.json"), "old");
    expect(() => writeArtifacts({ root, outputDirectory: output, bundle: composeEvidence({ root }) })).toThrow(/--overwrite/);
    expect(writeArtifacts({ root, outputDirectory: output, bundle: composeEvidence({ root }), overwrite: true })).toEqual([
      join(output, "evidence-bundle.json"),
      join(output, "summary.md"),
    ]);
    expect(readFileSync(join(output, "evidence-bundle.json"), "utf8")).not.toBe("old");
  });

  it("rejects direct writer use outside the repository root", () => {
    const { root, directory } = fixture();
    expect(() => writeArtifacts({
      root,
      outputDirectory: join(directory, "outside"),
      bundle: composeEvidence({ root }),
    })).toThrow(/inside the repository/);
  });

  it("rejects direct writer use for non-dedicated repository directories", () => {
    const { root } = fixture();
    const output = join(root, "reports");
    mkdirSync(output);
    expect(() => writeArtifacts({
      root,
      outputDirectory: output,
      bundle: composeEvidence({ root }),
    })).toThrow(/dedicated exporter artifact directory/);
  });

  it("rejects symlink escapes", () => {
    const { root, directory } = fixture();
    const outside = join(directory, "outside");
    mkdirSync(outside);
    const link = join(root, "tmp-link");
    try {
      symlinkSync(outside, link, "junction");
    } catch (error) {
      if (["EACCES", "EINVAL", "ENOTSUP", "EPERM"].includes(error?.code)) return;
      throw error;
    }
    expect(() => writeArtifacts({
      root,
      outputDirectory: join(link, "artifacts"),
      bundle: composeEvidence({ root }),
    })).toThrow(/symlink|containment/i);
  });

  it("fails before writing when final sanitization validation fails", () => {
    const { root } = fixture();
    const output = resolveOutputDirectory(root);
    expect(() => writeArtifacts({
      outputDirectory: output,
      root,
      bundle: composeEvidence({ root }),
      sanitizer: () => "leaked@example.test",
    })).toThrow(/Sanitization validation failed/);
  });

  it("fails before writing when a local-path leak slips past redaction (RI-VALIDATOR)", () => {
    const { root } = fixture();
    const output = resolveOutputDirectory(root);
    expect(() => writeArtifacts({
      outputDirectory: output,
      root,
      bundle: composeEvidence({ root }),
      sanitizer: () => "leaked build path: /usr/local/secret-build",
    })).toThrow(/Sanitization validation failed/);
  });

  it("produces deterministic artifacts and excludes diff by default", () => {
    const { root } = fixture();
    const first = composeEvidence({ root });
    const second = composeEvidence({ root });
    expect(first).toEqual(second);
    expect(first.collectors.git.metadata).not.toHaveProperty("diff");
    expect(JSON.stringify(first)).not.toContain("patch");
  });

  it("includes only the collector's diff summary when explicitly requested", () => {
    const { root } = fixture();
    const bundle = composeEvidence({ root, includeDiff: true });
    expect(bundle.collectors.git.metadata.diff).toEqual(expect.objectContaining({ changedFiles: [], numstat: [] }));
    expect(bundle.policy.rawDiffsIncluded).toBe(false);
  });

  it("sets schemaVersion to the current SCHEMA_VERSION (3)", () => {
    const { root } = fixture();
    expect(SCHEMA_VERSION).toBe(3);
    expect(composeEvidence({ root }).schemaVersion).toBe(SCHEMA_VERSION);
  });

  it("threads an explicit --base ref from parseArguments through composeEvidence into the Git collector (S2)", () => {
    const { root } = fixture();
    execFileSync("git", ["init", "--initial-branch=main"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Fixture Export"], { cwd: root });
    execFileSync("git", ["config", "user.email", ["fixture", "export", "@", "example", ".test"].join("")], { cwd: root });
    execFileSync("git", ["add", "--all"], { cwd: root });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: root });

    const options = parseArguments(["--root", root, "--include-diff", "--base", "HEAD"]);
    expect(options.baseRef).toBe("HEAD");

    const bundle = composeEvidence({ root, includeDiff: true, baseRef: options.baseRef });
    expect(bundle.collectors.git.metadata.diff.baseRef).toBe("HEAD");
  });

  it("sanitizes and validates object keys, not just values", () => {
    const { root } = fixture();
    const output = resolveOutputDirectory(root);
    const email = ["keyed", "record", "@", "example", ".test"].join("");

    // No collector keys an object by collected data today, so this drives the guard
    // through the writer directly: a data-derived key must be redacted on the way out.
    const written = writeArtifacts({
      root,
      outputDirectory: output,
      bundle: { ...composeEvidence({ root }), byContact: { [email]: { count: 1 } } },
    });
    const bundle = JSON.parse(readFileSync(written[0], "utf8"));

    expect(Object.keys(bundle.byContact)).toEqual(["[REDACTED:email]"]);
    expect(readFileSync(written[0], "utf8")).not.toContain(email);
  });

  it("fails before writing when a leaked key slips past redaction", () => {
    const { root } = fixture();
    const output = resolveOutputDirectory(root);

    expect(() => writeArtifacts({
      outputDirectory: output,
      root,
      bundle: composeEvidence({ root }),
      sanitizer: () => ({ "/usr/local/secret-build": true }),
    })).toThrow(/Sanitization validation failed/);
  });

  it("lists collector warnings in the summary, not just their count", () => {
    const { root } = fixture();
    const output = resolveOutputDirectory(root);

    // The fixture is not a Git repository, so the Git collector is guaranteed to warn.
    writeArtifacts({ root, outputDirectory: output, bundle: composeEvidence({ root }) });
    const summary = readFileSync(join(output, "summary.md"), "utf8");

    expect(summary).toContain("## Warnings");
    expect(summary).toMatch(/^- `git`: .+$/m);
  });

  it("keeps artifact output isolated from the workspace tmp directory", () => {
    const { root } = fixture();
    const output = join(root, "tmp", "repository-intelligence");
    writeArtifacts({ root, outputDirectory: output, bundle: composeEvidence({ root }) });
    expect(readFileSync(join(output, "summary.md"), "utf8")).toContain("Google Drive context");
  });

  it("runs the CLI integration with explicit overwrite in an isolated repository", () => {
    const { root } = fixture();
    const output = join(root, "tmp", "repository-intelligence");
    mkdirSync(output, { recursive: true });
    writeFileSync(join(output, "evidence-bundle.json"), "stale");

    const paths = run(["--root", root, "--output", "tmp/repository-intelligence", "--overwrite"]);

    expect(paths).toEqual([
      join(output, "evidence-bundle.json"),
      join(output, "summary.md"),
    ]);
    expect(JSON.parse(readFileSync(join(output, "evidence-bundle.json"), "utf8"))).toEqual(
      expect.objectContaining({
        policy: expect.objectContaining({
          rawDiffsIncluded: false,
          diffSummaryIncluded: false,
        }),
      }),
    );
    expect(readFileSync(join(output, "summary.md"), "utf8")).toContain("Raw diffs included: false.");
  });
});

describe("git-ignore guard on the output directory", () => {
  // A Git repository whose global excludes can't leak in from the machine running the tests.
  function gitFixture() {
    const { directory, root } = fixture();
    execFileSync("git", ["init", "--initial-branch=main"], { cwd: root });
    execFileSync("git", ["config", "core.excludesFile", join(directory, "no-global-excludes")], { cwd: root });
    return { directory, root };
  }

  it("refuses to write, and writes nothing, when the output directory is not git-ignored", () => {
    const { root } = gitFixture();

    expect(() => run(["--root", root])).toThrow(/not git-ignored.*--allow-unignored/s);
    expect(existsSync(join(root, "tmp"))).toBe(false);
  });

  it("writes when the repository's .gitignore covers the output directory", () => {
    const { root } = gitFixture();
    writeFileSync(join(root, ".gitignore"), "tmp/\n");

    const paths = run(["--root", root]);

    expect(paths).toHaveLength(2);
    expect(existsSync(join(root, "tmp", "repository-intelligence", "evidence-bundle.json"))).toBe(true);
  });

  it("refuses when an ignore rule covers the bundle but not the summary", () => {
    const { root } = gitFixture();
    writeFileSync(join(root, ".gitignore"), "*.json\n");

    expect(() => run(["--root", root])).toThrow(/summary\.md is not git-ignored/);
    expect(existsSync(join(root, "tmp"))).toBe(false);
  });

  it("writes anyway with --allow-unignored", () => {
    const { root } = gitFixture();

    const paths = run(["--root", root, "--allow-unignored"]);

    expect(paths).toHaveLength(2);
  });

  it("fails closed when Git cannot read a directory that has a .git entry", () => {
    const { root } = fixture();
    // Dangling gitdir: fails identically inside or outside another repository.
    writeFileSync(join(root, ".git"), "gitdir: ./no-such-gitdir\n");

    expect(() => run(["--root", root])).toThrow(/could not tell whether this directory is inside a Git repository/);
    expect(existsSync(join(root, "tmp"))).toBe(false);
    expect(run(["--root", root, "--allow-unignored"])).toHaveLength(2);
  });

  it("does not apply to a directory that is not a Git repository", () => {
    const { root } = fixture();

    expect(run(["--root", root])).toHaveLength(2);
  });
});

// S3 step 6: aggregate, top-level status, and Observations summary rendering.
// See docs/decisions/2026-09-20-warnings-vs-observations.md section 5 step 6.

describe("buildAggregate", () => {
  it("walks collectors in name order and preserves each collector's own emission order without re-sorting", () => {
    const collectors = {
      zulu: {
        warnings: ["z-second", "z-first"],
        observations: [
          { id: "z-obs-2", message: "b" },
          { id: "z-obs-1", message: "a" },
        ],
      },
      alpha: {
        warnings: ["a-only"],
        observations: [{ id: "a-obs", message: "m" }],
      },
    };

    expect(buildAggregate(collectors)).toEqual({
      warnings: [
        { collector: "alpha", message: "a-only" },
        { collector: "zulu", message: "z-second" },
        { collector: "zulu", message: "z-first" },
      ],
      observations: [
        { collector: "alpha", id: "a-obs", message: "m" },
        { collector: "zulu", id: "z-obs-2", message: "b" },
        { collector: "zulu", id: "z-obs-1", message: "a" },
      ],
    });
  });

  it("returns empty lists when no collector has warnings or observations", () => {
    const collectors = {
      one: { warnings: [], observations: [] },
      two: { warnings: [], observations: [] },
    };
    expect(buildAggregate(collectors)).toEqual({ warnings: [], observations: [] });
  });

  it("emits exactly {collector, id, message} for observations, so the real collector name wins over any stray field on the entry", () => {
    const collectors = {
      example: {
        warnings: [],
        observations: [{ id: "obs-id", message: "obs message", collector: "wrong", extra: true }],
      },
    };
    expect(buildAggregate(collectors)).toEqual({
      warnings: [],
      observations: [{ collector: "example", id: "obs-id", message: "obs message" }],
    });
  });
});

describe("bundleStatus", () => {
  it("is complete when every collector is complete", () => {
    expect(bundleStatus({ a: { status: "complete" }, b: { status: "complete" } })).toBe("complete");
  });

  it("is partial when any collector is partial", () => {
    expect(bundleStatus({ a: { status: "complete" }, b: { status: "partial" } })).toBe("partial");
  });

  it("is partial, not unavailable, when one collector is unavailable among otherwise-healthy collectors", () => {
    expect(bundleStatus({
      a: { status: "complete" },
      b: { status: "unavailable" },
      c: { status: "complete" },
    })).toBe("partial");
  });

  it("is unavailable only when every collector is unavailable", () => {
    expect(bundleStatus({ a: { status: "unavailable" }, b: { status: "unavailable" } })).toBe("unavailable");
  });
});

describe("bundle-wide status and aggregate wiring in composeEvidence", () => {
  it("sets the top-level status from the real collectors, landing on the mixed partial case", () => {
    const { root } = fixture();
    const bundle = composeEvidence({ root });

    // The fixture is not a Git repository (git collector "unavailable") and file
    // discovery falls back to the filesystem (a "files" warning, so "partial"). Neither
    // "every collector unavailable" nor "every collector complete" holds, so this
    // exercises the mixed branch of the 2.3 rule against real collector output, not
    // hand-built data.
    expect(bundle.status).toBe("partial");
    expect(bundle.status).toBe(bundleStatus(bundle.collectors));
  });

  it("populates the top-level aggregate from the real collectors' warnings and observations", () => {
    const { root } = fixture();
    const bundle = composeEvidence({ root });

    expect(bundle.aggregate.observations).toEqual([]);
    expect(bundle.aggregate.warnings.map((warning) => warning.collector)).toEqual(["files", "git"]);
    expect(
      bundle.aggregate.warnings.every(
        (warning) => typeof warning.message === "string" && warning.message.length > 0,
      ),
    ).toBe(true);
  });

  it("keeps every collector's observations array in sync with the aggregate rollup (S3 step 7)", () => {
    const { root } = fixture();
    // A real, resolvable observation from a real collector: without this, `every` below
    // would pass vacuously over an empty array and assert nothing
    // (docs/decisions/2026-09-20-warnings-vs-observations.md section 5 step 7).
    mkdirSync(join(root, "api"), { recursive: true });
    writeFileSync(join(root, "api", "dynamic-env.ts"), "const dynamic = process.env[pickName()];\n");
    // git init the fixture so the git collector is not "unavailable" for this test.
    execFileSync("git", ["init", "--initial-branch=main"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Fixture Export"], { cwd: root });
    execFileSync("git", ["config", "user.email", ["fixture", "export", "@", "example", ".test"].join("")], { cwd: root });
    execFileSync("git", ["add", "--all"], { cwd: root });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: root });

    const bundle = composeEvidence({ root });
    const collectorEntries = Object.entries(bundle.collectors);

    // Backstop for the plan's open risk: a collector that forgets `observations` desyncs
    // the rollup.
    expect(collectorEntries.every(([, collector]) => Array.isArray(collector.observations))).toBe(true);

    const allObservations = collectorEntries.flatMap(([, collector]) => collector.observations);
    expect(allObservations.length).toBeGreaterThan(0);
    // A collector that forgets an id would emit an entry JSON output drops without
    // complaint, so this fails loudly instead.
    expect(
      allObservations.every(
        (observation) =>
          typeof observation.id === "string" &&
          observation.id.length > 0 &&
          typeof observation.message === "string" &&
          observation.message.length > 0,
      ),
    ).toBe(true);

    // Checks the wiring in composeEvidence and buildAggregate together: every real
    // collector's own lists actually reach the aggregate, not just buildAggregate in
    // isolation against hand-built collectors.
    const observationsSum = collectorEntries.reduce((sum, [, collector]) => sum + collector.observations.length, 0);
    const warningsSum = collectorEntries.reduce((sum, [, collector]) => sum + collector.warnings.length, 0);
    expect(observationsSum).toBe(bundle.aggregate.observations.length);
    expect(warningsSum).toBe(bundle.aggregate.warnings.length);
  });
});

function sectionBetween(text, startHeading, endHeading) {
  const start = text.indexOf(startHeading);
  const end = text.indexOf(endHeading, start);
  return text.slice(start + startHeading.length, end);
}

function minimalCollector(overrides = {}) {
  return { status: "complete", records: [], warnings: [], observations: [], ...overrides };
}

function minimalBundle(collectorOverrides = {}) {
  const collectors = {
    files: minimalCollector(),
    git: minimalCollector(),
    configuration: minimalCollector(),
    delivery: minimalCollector(),
    planning: minimalCollector({
      metadata: { externalContext: { status: "unavailable", accessed: false } },
    }),
    product: minimalCollector(),
    ...collectorOverrides,
  };
  return { collectors, policy: { diffSummaryIncluded: false } };
}

describe("Observations section in the rendered summary", () => {
  it("places '## Observations' after '## Warnings' and before '## External context'", () => {
    const summary = renderSummary(minimalBundle());
    const warningsIndex = summary.indexOf("## Warnings");
    const observationsIndex = summary.indexOf("## Observations");
    const externalContextIndex = summary.indexOf("## External context");

    expect(warningsIndex).toBeGreaterThan(-1);
    expect(observationsIndex).toBeGreaterThan(warningsIndex);
    expect(externalContextIndex).toBeGreaterThan(observationsIndex);
  });

  it("renders 'None.' under Observations when no collector has any", () => {
    const summary = renderSummary(minimalBundle());
    const observationsSection = sectionBetween(summary, "## Observations", "## External context");
    expect(observationsSection.trim()).toBe("None.");
  });

  it("lists an observation under a '### <collector> (<count>)' heading, as `id`: message", () => {
    const bundle = minimalBundle({
      configuration: minimalCollector({
        observations: [{
          id: "env-access-not-statically-resolvable",
          message: "An environment variable access could not be resolved statically: api/foo.ts:12.",
        }],
      }),
    });
    const summary = renderSummary(bundle);
    const observationsSection = sectionBetween(summary, "## Observations", "## External context");

    expect(observationsSection).toContain("### configuration (1)");
    expect(observationsSection).toMatch(
      /^- `env-access-not-statically-resolvable`: An environment variable access could not be resolved statically: api\/foo\.ts:12\.$/m,
    );
    // Only collectors that actually have observations are listed.
    expect(observationsSection).not.toContain("### files");
    expect(observationsSection).not.toContain("### git");
  });

  it("keeps a warning out of the Observations section and an observation out of the Warnings section", () => {
    const bundle = minimalBundle({
      git: minimalCollector({ status: "partial", warnings: ["The requested directory is not a Git worktree."] }),
      configuration: minimalCollector({
        observations: [{
          id: "env-access-not-statically-resolvable",
          message: "An environment variable access could not be resolved statically: api/foo.ts:12.",
        }],
      }),
    });
    const summary = renderSummary(bundle);
    const warningsSection = sectionBetween(summary, "## Warnings", "## Observations");
    const observationsSection = sectionBetween(summary, "## Observations", "## External context");

    expect(warningsSection).toContain("The requested directory is not a Git worktree.");
    expect(warningsSection).not.toContain("env-access-not-statically-resolvable");

    expect(observationsSection).toContain("env-access-not-statically-resolvable");
    expect(observationsSection).not.toContain("The requested directory is not a Git worktree.");
  });

  it("groups observations by collector in name order, one heading per collector", () => {
    const bundle = minimalBundle({
      planning: minimalCollector({
        observations: [{
          id: "required-authority-document-absent",
          message: "Expected repository authority document was absent: AGENTS.md.",
        }],
        metadata: { externalContext: { status: "unavailable", accessed: false } },
      }),
      configuration: minimalCollector({
        observations: [
          { id: "client-prefixed-var-in-server-code", message: "message one" },
          { id: "env-access-not-statically-resolvable", message: "message two" },
        ],
      }),
    });
    const summary = renderSummary(bundle);
    const observationsSection = sectionBetween(summary, "## Observations", "## External context");

    const configurationIndex = observationsSection.indexOf("### configuration (2)");
    const planningIndex = observationsSection.indexOf("### planning (1)");

    expect(configurationIndex).toBeGreaterThan(-1);
    expect(planningIndex).toBeGreaterThan(-1);
    expect(configurationIndex).toBeLessThan(planningIndex);
  });
});
