import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

import { SCHEMA_VERSION, assertBundleShape, run, validateEvidence } from "./export.mjs";

// One realistic fixture exercising all six collectors together through the real CLI
// (run(), including the git-ignore guard), not composeEvidence directly -- everything
// else in this suite already covers collectors and export.mjs in isolation. This is the
// integration check: a healthy, fully-configured repository should read back as
// unambiguously healthy (schemaVersion 3, every collector complete, no warnings or
// observations) with both --include-diff on and off.
const fixtures = [];
afterEach(() => {
  while (fixtures.length) rmSync(fixtures.pop(), { recursive: true, force: true });
});

function write(root, path, content) {
  const file = join(root, ...path.split("/"));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

function git(root, args) {
  return execFileSync("git", args, { cwd: root }).toString();
}

function buildFixture() {
  const directory = mkdtempSync(join(tmpdir(), "end-to-end-"));
  const root = join(directory, "repo");
  mkdirSync(root);
  fixtures.push(directory);

  write(root, ".gitignore", "tmp/\n");
  write(
    root,
    "package.json",
    JSON.stringify(
      { name: "fixture-board", version: "1.0.0", private: true, scripts: { build: "vite build", test: "vitest run" } },
      null,
      2,
    ),
  );
  write(root, ".env.example", "SERVER_TOKEN=your-server-secret\n");
  write(root, "api/server.ts", "const token = process.env.SERVER_TOKEN;\nexport { token };\n");
  write(
    root,
    ".github/workflows/ci.yml",
    ["name: CI", "on:", "  push:", "    branches: [main]", "jobs:", "  build:", "    runs-on: ubuntu-latest", "    steps:", "      - run: npm run build"].join("\n"),
  );
  write(root, "AGENTS.md", "# Agents\nGuidance for agents working in this fixture.\n");
  write(root, "README.md", "# Fixture Board\nA fixture repository for the end-to-end test.\n");
  write(
    root,
    ".repo-intelligence.json",
    JSON.stringify({
      product: {
        name: "FixtureBoard",
        signals: [{ id: "fixture-feature", pattern: "FixtureFeature" }],
      },
    }),
  );
  write(root, "src/FixtureApp.tsx", "export function FixtureFeature() { return null; }\n");

  git(root, ["init", "-q", "--initial-branch=main"]);
  git(root, ["config", "core.excludesFile", join(directory, "no-global-excludes")]);
  git(root, ["config", "user.name", "Fixture End To End"]);
  git(root, ["config", "user.email", ["fixture", "e2e", "@", "example", ".test"].join("")]);
  git(root, ["add", "--all"]);
  git(root, ["commit", "-q", "-m", "initial: package, config, CI, docs, product source"]);

  git(root, ["checkout", "-q", "-b", "feature"]);
  write(root, "docs/decisions/2026-feature.md", "# Feature decision\n## Rationale\nKeep it simple.\n");
  git(root, ["add", "--all"]);
  git(root, ["commit", "-q", "-m", "add a planning decision record on a second branch"]);

  return root;
}

function assertHealthyBundle(bundle, { expectDiffOmitted }) {
  expect(bundle.schemaVersion).toBe(SCHEMA_VERSION);
  expect(() => assertBundleShape(bundle)).not.toThrow();
  expect(() => validateEvidence(bundle)).not.toThrow();
  expect(bundle.status).toBe("complete");

  for (const [name, collector] of Object.entries(bundle.collectors)) {
    expect(collector.status, `${name} collector status`).toBe("complete");
    expect(collector.warnings, `${name} collector warnings`).toEqual([]);
  }

  expect(bundle.collectors.git.metadata.diff.omitted).toBe(expectDiffOmitted);
  expect(bundle.aggregate.warnings).toEqual([]);
  expect(bundle.aggregate.observations).toEqual([]);
}

describe("end-to-end: a realistic, fully healthy repository (S7)", () => {
  it("reads back as unambiguously healthy without --include-diff", () => {
    const root = buildFixture();
    const output = join(root, "tmp", "repository-intelligence");

    run(["--root", root, "--overwrite"]);

    const bundle = JSON.parse(readFileSync(join(output, "evidence-bundle.json"), "utf8"));
    assertHealthyBundle(bundle, { expectDiffOmitted: true });

    const summary = readFileSync(join(output, "summary.md"), "utf8");
    expect(summary).toMatch(/## Warnings\s*\n+\s*None\./);
    expect(summary).toMatch(/## Observations\s*\n+\s*None\./);
  });

  it("reads back as unambiguously healthy with --include-diff", () => {
    const root = buildFixture();
    const output = join(root, "tmp", "repository-intelligence");

    run(["--root", root, "--overwrite", "--include-diff"]);

    const bundle = JSON.parse(readFileSync(join(output, "evidence-bundle.json"), "utf8"));
    assertHealthyBundle(bundle, { expectDiffOmitted: false });
    expect(bundle.collectors.git.metadata.diff.baseRef).not.toBeNull();

    const summary = readFileSync(join(output, "summary.md"), "utf8");
    expect(summary).toMatch(/## Warnings\s*\n+\s*None\./);
    expect(summary).toMatch(/## Observations\s*\n+\s*None\./);
  });
});
