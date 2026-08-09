import { afterEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";

import {
  composeEvidence,
  parseArguments,
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

  it("sets schemaVersion to 2", () => {
    const { root } = fixture();
    expect(composeEvidence({ root }).schemaVersion).toBe(2);
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
