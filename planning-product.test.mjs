import { afterEach, describe, expect, it } from "vitest";
import { dirname, join } from "node:path";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

import { collectPlanning } from "./lib/collect-planning.mjs";
import { collectProduct } from "./lib/collect-product.mjs";

const fixtures = [];
afterEach(() => { while (fixtures.length) rmSync(fixtures.pop(), { recursive: true, force: true }); });

function fixture() { const directory = mkdtempSync(join(tmpdir(), "sliceboard-planning-product-")); const root = join(directory, "repo"); mkdirSync(root); fixtures.push(directory); return root; }
function write(root, path, content) { const file = join(root, ...path.split("/")); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, content); }
function writeProductConfig(root, product) { write(root, ".repo-intelligence.json", JSON.stringify({ product })); }

describe("planning collector", () => {
  it("classifies authority, decisions, tasks, and roadmap metadata deterministically", () => {
    const root = fixture();
    write(root, ".repo-intelligence.json", JSON.stringify({
      authorityDocuments: { "SLICE_BOARD_AUTHORITY.md": "repository-authority", "PASSOFF.md": "implementation-handoff" },
      requiredAuthorityDocuments: ["SLICE_BOARD_AUTHORITY.md", "PASSOFF.md"],
    }));
    write(root, "SLICE_BOARD_AUTHORITY.md", "# Authority\n## Product identity\n## Budget model\n");
    write(root, "PASSOFF.md", "# Handoff\nstatus: active\n");
    write(root, "docs/decisions/2026-choice.md", "# Decision\n## Decision\n");
    write(root, "docs/tasks/roadmap-task.md", "---\nstatus: active\nowner: private@example.test\n---\n# Task\n");
    write(root, "docs/roadmap.md", "# Roadmap\n## Next\n");
    const first = collectPlanning({ root });
    const second = collectPlanning({ root });
    expect(first).toEqual(second);
    expect(first.records).toContainEqual(expect.objectContaining({ path: "SLICE_BOARD_AUTHORITY.md", kind: "repository-authority" }));
    expect(first.records).toContainEqual(expect.objectContaining({ path: "docs/decisions/2026-choice.md", kind: "decision" }));
    expect(first.records).toContainEqual(expect.objectContaining({ path: "docs/tasks/roadmap-task.md", kind: "task", owner: "[REDACTED:email]" }));
    expect(first.metadata.externalContext).toMatchObject({ status: "unavailable", required: false, accessed: false });

    const decisionRecord = first.records.find((record) => record.path === "docs/decisions/2026-choice.md");
    expect(decisionRecord.evidenceLabels).toEqual({
      default: "documented_intent",
      fields: { kind: "mechanical_inference", path: "observed_fact", lineCount: "observed_fact", byteSize: "observed_fact", status: "unresolved", owner: "unresolved" },
    });

    const declaredAuthorityRecord = first.records.find((record) => record.path === "SLICE_BOARD_AUTHORITY.md");
    expect(declaredAuthorityRecord.evidenceLabels).toEqual({
      default: "documented_intent",
      fields: { path: "observed_fact", lineCount: "observed_fact", byteSize: "observed_fact", status: "unresolved", owner: "unresolved" },
    });

    const taskRecord = first.records.find((record) => record.path === "docs/tasks/roadmap-task.md");
    expect(taskRecord.evidenceLabels).toEqual({
      default: "documented_intent",
      fields: { kind: "mechanical_inference", path: "observed_fact", lineCount: "observed_fact", byteSize: "observed_fact" },
    });

    expect(first.metadata.evidenceLabels).toEqual({
      default: "documented_intent",
      fields: { documentCount: "observed_fact" },
    });
    expect(first.metadata.externalContext.evidenceLabels).toEqual({
      default: "observed_fact",
      fields: { representation: "unresolved", status: "unresolved" },
    });
  });

  it("returns complete evidence with observations for absent required authority documents, without document bodies", () => {
    const root = fixture();
    write(root, ".repo-intelligence.json", JSON.stringify({
      requiredAuthorityDocuments: ["SLICE_BOARD_AUTHORITY.md", "PASSOFF.md"],
    }));
    write(root, "docs/decisions/broken.md", "# Broken\ncontact secret@example.test\n");
    const result = collectPlanning({ root });
    // S3: a declared-but-missing authority document is a fact about the repository, not
    // a collection failure -- the tool read everything it could -- so it is an
    // observation and must not demote status (docs/decisions/2026-09-20-warnings-vs-
    // observations.md section 2.4 and section 5 step 4). It must fail if this event is
    // put back through `warnings`.
    expect(result.status).toBe("complete");
    expect(result.warnings).toEqual([]);
    expect(result.observations).toEqual([
      { id: "required-authority-document-absent", message: "Expected repository authority document was absent: PASSOFF.md." },
      { id: "required-authority-document-absent", message: "Expected repository authority document was absent: SLICE_BOARD_AUTHORITY.md." },
    ]);
    expect(JSON.stringify(result)).not.toContain("secret@example.test");
    expect(JSON.stringify(result)).not.toContain("contact secret");
    expect(result.records[0]).not.toHaveProperty("content");
  });

  it("refuses to read a real .env declared as an authority document, with a warning instead of a leak (S7)", () => {
    const root = fixture();
    write(root, ".repo-intelligence.json", JSON.stringify({
      authorityDocuments: { ".env": "environment-secrets" },
      requiredAuthorityDocuments: [".env"],
    }));
    write(root, ".env", "DATABASE_PASSWORD=hunter2\n");
    const result = collectPlanning({ root });

    expect(result.status).toBe("partial");
    expect(result.warnings).toEqual([
      "Repository intelligence config declared a private environment file as an authority document; refusing to read it: .env.",
    ]);
    // Refused, not absent -- the tool did not fail to find it, it declined to open it, so
    // it must not also carry a required-authority-document-absent observation.
    expect(result.observations).toEqual([]);
    expect(result.records).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("hunter2");
    expect(JSON.stringify(result)).not.toContain("DATABASE_PASSWORD");
  });

  it("silently skips a private environment file found by the planning-directory scan, not declared by config (S7)", () => {
    const root = fixture();
    // The scan only looks at .md/.mdx/.rst/.txt names; ".env.md" is the shape that would
    // otherwise pass that filter and also match isPrivateEnvironmentFile's broad check.
    write(root, "docs/decisions/.env.md", "SHOULD_NEVER_BE_READ=hunter2\n");
    write(root, "docs/decisions/2026-real.md", "# Real decision\n");
    const result = collectPlanning({ root });

    expect(result.status).toBe("complete");
    expect(result.warnings).toEqual([]);
    expect(result.records).toContainEqual(expect.objectContaining({ path: "docs/decisions/2026-real.md" }));
    expect(result.records.map((record) => record.path)).not.toContain("docs/decisions/.env.md");
    expect(JSON.stringify(result)).not.toContain("hunter2");
  });

  it("still reports partial for a real collection failure: a malformed .repo-intelligence.json", () => {
    const root = fixture();
    write(root, ".repo-intelligence.json", "{ not valid json");
    const result = collectPlanning({ root });
    expect(result.status).toBe("partial");
    expect(result.warnings).toEqual([
      "Repository intelligence config could not be parsed: .repo-intelligence.json.",
    ]);
    expect(result.observations).toEqual([]);
  });

  it("reports complete with exactly one observation when a required authority document is truly missing (acceptance check, section 6)", () => {
    const root = fixture();
    write(root, ".repo-intelligence.json", JSON.stringify({
      requiredAuthorityDocuments: ["MISSING.md"],
    }));
    const result = collectPlanning({ root });
    expect(result.status).toBe("complete");
    expect(result.warnings).toEqual([]);
    expect(result.observations).toEqual([
      { id: "required-authority-document-absent", message: "Expected repository authority document was absent: MISSING.md." },
    ]);
  });

  it("de-duplicates a required authority document declared twice into one observation", () => {
    const root = fixture();
    // Before S3, [...new Set(warnings)] collapsed this same duplicate into one warning;
    // buildObservations must preserve that collapsing behavior for observations too.
    write(root, ".repo-intelligence.json", JSON.stringify({
      requiredAuthorityDocuments: ["MISSING.md", "MISSING.md"],
    }));
    const result = collectPlanning({ root });
    expect(result.status).toBe("complete");
    expect(result.warnings).toEqual([]);
    expect(result.observations).toEqual([
      { id: "required-authority-document-absent", message: "Expected repository authority document was absent: MISSING.md." },
    ]);
  });

  it("stays quiet in a repository that declares nothing, so --root works anywhere", () => {
    const root = fixture();
    write(root, "AGENTS.md", "# Agents\n");
    write(root, "docs/decisions/2026-choice.md", "# Decision\n");
    const result = collectPlanning({ root });

    expect(result.warnings).toEqual([]);
    expect(result.status).toBe("complete");
    expect(result.records).toContainEqual(
      expect.objectContaining({ path: "AGENTS.md", kind: "agent-guidance" }),
    );

    const agentsRecord = result.records.find((record) => record.path === "AGENTS.md");
    expect(agentsRecord.evidenceLabels.fields.kind).toBe("mechanical_inference");
  });

  it("falls back to the filename for a document with no heading, and labels the title mechanical_inference", () => {
    const root = fixture();
    write(root, "docs/plans/no-heading.md", "Just some prose with no heading line.\n");
    const result = collectPlanning({ root });

    const record = result.records.find((entry) => entry.path === "docs/plans/no-heading.md");
    expect(record.title).toBe("no-heading.md");
    expect(record.evidenceLabels.fields.title).toBe("mechanical_inference");
  });

  it("labels status and owner unresolved when a document has no front matter", () => {
    const root = fixture();
    write(root, "docs/plans/no-front-matter.md", "# No Front Matter\nJust prose.\n");
    const result = collectPlanning({ root });

    const record = result.records.find((entry) => entry.path === "docs/plans/no-front-matter.md");
    expect(record.status).toBeNull();
    expect(record.owner).toBeNull();
    expect(record.evidenceLabels.fields.status).toBe("unresolved");
    expect(record.evidenceLabels.fields.owner).toBe("unresolved");
  });

  it("reports an unresolved evidenceLabels envelope for an unavailable repository", () => {
    const result = collectPlanning({ root: join(tmpdir(), "missing-planning-fixture") });

    expect(result.status).toBe("unavailable");
    expect(result.metadata.evidenceLabels).toEqual({ default: "unresolved", fields: {} });
    expect(result.observations).toEqual([]);
  });

  it("finds tasks in a bare tasks/ directory, not just docs/tasks/", () => {
    const root = fixture();
    write(root, "tasks/github-mcp-bootstrap.md", "---\nstatus: active\n---\n# Task\n");
    write(root, "tasks/completed/2026/done-thing.md", "---\nstatus: complete\n---\n# Task\n");
    const paths = collectPlanning({ root }).records.map((record) => record.path);

    expect(paths).toContain("tasks/github-mcp-bootstrap.md");
    expect(paths).toContain("tasks/completed/2026/done-thing.md");
  });

  it("ignores config entries that try to escape the repository", () => {
    const root = fixture();
    write(root, ".repo-intelligence.json", JSON.stringify({
      authorityDocuments: { "../../../etc/passwd": "escape", "/etc/hosts": "escape" },
      planningDirectories: ["../outside"],
      requiredAuthorityDocuments: ["../../secrets.md"],
    }));
    write(root, "AGENTS.md", "# Agents\n");
    const result = collectPlanning({ root });

    expect(result.warnings).toEqual([]);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("passwd");
    expect(serialized).not.toContain("outside");
    expect(serialized).not.toContain("secrets.md");
  });
});

describe("product collector", () => {
  it("stays quiet in a repository that declares no product config, so --root works anywhere", () => {
    const root = fixture();
    write(root, "src/app.ts", "export const app = true;\n");

    const result = collectProduct({ root });

    expect(result.status).toBe("complete");
    // S3 step 5: product has nothing to move to observations, so every envelope still
    // carries an empty array. Fails if the key is dropped or reverted.
    expect(result.observations).toEqual([]);
    expect(result.metadata.product).toBeNull();
    expect(result.metadata.signals).toEqual([]);
    expect(result.metadata.riskSurfaces).toEqual([]);
    expect(result.records[0].evidenceLabels.fields.product).toBe("unresolved");
    expect(result.metadata.evidenceLabels.fields.product).toBe("unresolved");
  });

  it("detects configured product signals and risk surfaces without exporting source", () => {
    const root = fixture();
    writeProductConfig(root, {
      name: "FixtureBoard",
      signals: [
        { id: "feature-panel", pattern: "FeaturePanel|feature_state" },
        { id: "external-sync", pattern: "reconcileRemote" },
        { id: "premium-tier", pattern: "isPremium|isFeatureLocked" },
      ],
      riskSurfaces: [
        { id: "state-invariant", severity: "high", pattern: "feature_state|applyFeaturePatch" },
        { id: "sync-concurrency", severity: "high", pattern: "reconcileRemote" },
        { id: "premium-boundary", severity: "high", pattern: "isPremium|isFeatureLocked" },
      ],
    });
    write(root, "src/FixtureApp.tsx", "import { FeaturePanel } from './panel'; const state = feature_state; const cloud = reconcileRemote; function applyFeaturePatch() {}\n");
    write(root, "src/entitlements.ts", "export const isPremium = true; export const isFeatureLocked = true;\n");
    const result = collectProduct({ root });
    expect(result.metadata.product).toBe("FixtureBoard");
    expect(result.metadata.signals.map((signal) => signal.id)).toEqual(expect.arrayContaining(["feature-panel", "external-sync", "premium-tier"]));
    expect(result.metadata.riskSurfaces.map((risk) => risk.id)).toEqual(expect.arrayContaining(["state-invariant", "sync-concurrency", "premium-boundary"]));
    expect(result.records[0].product).toBe("FixtureBoard");
    expect(JSON.stringify(result)).not.toContain("function applyFeaturePatch");
    expect(result.records[0].evidenceLabels.fields.product).toBe("documented_intent");
    expect(result.metadata.evidenceLabels).toEqual({ default: "documented_intent", fields: {} });
    expect(result.metadata.signals[0].evidenceLabels).toEqual({
      default: "documented_intent",
      fields: { evidencePaths: "mechanical_inference" },
    });
    expect(result.metadata.riskSurfaces[0].evidenceLabels).toEqual({
      default: "documented_intent",
      fields: { detected: "mechanical_inference", evidencePaths: "mechanical_inference" },
    });
  });

  it("never scans a source-extension file that also looks like a dotenv variant (S7)", () => {
    const root = fixture();
    const sentinelValue = ["fixture", "-product-dotenv", "-secret"].join("");
    writeProductConfig(root, {
      name: "FixtureBoard",
      signals: [{ id: "sentinel-signal", pattern: "SHOULD_NEVER_FIRE" }],
    });
    // ".env.ts" passes SOURCE_EXTENSIONS' .ts match and, before this fix, would have been
    // opened and scanned for signals/risk surfaces like any other source file.
    write(root, "src/.env.ts", `export const SHOULD_NEVER_FIRE = "${sentinelValue}";\n`);
    write(root, "src/app.ts", "export const app = true;\n");

    const result = collectProduct({ root });

    expect(result.metadata.signals.map((signal) => signal.id)).not.toContain("sentinel-signal");
    expect(result.metadata.product).toBeNull();
    expect(JSON.stringify(result)).not.toContain(sentinelValue);
  });

  it("reports product: null when configured signals never fire, even with a configured name", () => {
    const root = fixture();
    writeProductConfig(root, {
      name: "FixtureBoard",
      signals: [{ id: "feature-panel", pattern: "FeaturePanel" }],
    });
    write(root, "src/app.ts", "export const app = true;\n");

    const result = collectProduct({ root });

    expect(result.metadata.product).toBeNull();
    expect(result.records[0].product).toBeNull();
    expect(result.metadata.signals).toEqual([]);
    expect(result.records[0].evidenceLabels.fields.product).toBe("unresolved");
    expect(result.metadata.evidenceLabels.fields.product).toBe("unresolved");
  });

  it("drops signal and risk-surface entries with an invalid id, pattern, or severity", () => {
    const root = fixture();
    writeProductConfig(root, {
      name: "FixtureBoard",
      signals: [
        { id: "Not Kebab Case", pattern: "FeaturePanel" },
        { id: "unclosed-pattern", pattern: "(unclosed" },
        { id: "feature-panel", pattern: "FeaturePanel" },
      ],
      riskSurfaces: [
        { id: "bad-severity", severity: "critical", pattern: "FeaturePanel" },
        { id: "state-invariant", severity: "high", pattern: "FeaturePanel" },
      ],
    });
    write(root, "src/app.ts", "const app = FeaturePanel;\n");

    const result = collectProduct({ root });

    expect(result.metadata.signals.map((signal) => signal.id)).toEqual(["feature-panel"]);
    expect(result.metadata.riskSurfaces.map((risk) => risk.id)).toEqual(["state-invariant"]);
    expect(result.status).toBe("partial");
    expect(result.warnings).toEqual(expect.arrayContaining([
      "Product signal declared an invalid id.",
      'Product signal "unclosed-pattern" pattern could not be compiled.',
      'Product risk surface "bad-severity" declared an invalid severity.',
    ]));
  });

  it("ignores nested Git worktrees when collecting product evidence", () => {
    const root = fixture();
    writeProductConfig(root, { name: "FixtureBoard", signals: [{ id: "local-state", pattern: "fixture-local-state" }] });
    write(root, "src/app.ts", "const app = 'fixture-local-state';\n");
    write(root, "nested-file/.git", "gitdir: ../.git/worktrees/nested-file\n");
    write(root, "nested-file/hidden.ts", "const hidden = 'fixture-local-state';\n");
    mkdirSync(join(root, "nested-directory/.git"), { recursive: true });
    write(root, "nested-directory/hidden.ts", "const hidden = 'fixture-local-state';\n");

    const result = collectProduct({ root });

    expect(result.records[0].inspectedSourceFiles).toBe(1);
    expect(result.metadata.signals.flatMap((signal) => signal.evidencePaths)).toEqual(["src/app.ts"]);
  });

  it("reports partial evidence when the source collection cap truncates candidates", () => {
    const root = fixture();
    for (let index = 0; index < 501; index += 1) write(root, `src/source-${String(index).padStart(3, "0")}.ts`, "export const value = true;\n");

    const result = collectProduct({ root });

    expect(result.status).toBe("partial");
    expect(result.records[0].inspectedSourceFiles).toBe(500);
    expect(result.warnings).toEqual(["Product source collection was bounded."]);
  });

  it("reports partial evidence when traversal depth truncates source candidates", () => {
    const root = fixture();
    writeProductConfig(root, { name: "FixtureBoard", signals: [{ id: "local-state", pattern: "fixture-local-state" }] });
    write(root, "a/b/c/d/e/f/deep.ts", "const deep = 'fixture-local-state';\n");

    const result = collectProduct({ root });

    expect(result.status).toBe("partial");
    expect(result.records[0].inspectedSourceFiles).toBe(0);
    expect(result.warnings).toEqual(["Product source collection omitted files beyond its traversal depth limit."]);
    expect(result.metadata.signals.flatMap((signal) => signal.evidencePaths)).not.toContain("a/b/c/d/e/f/deep.ts");
  });

  it("reports partial evidence when an oversized source file is omitted", () => {
    const root = fixture();
    writeProductConfig(root, { name: "FixtureBoard", signals: [{ id: "local-state", pattern: "fixture-local-state" }] });
    write(root, "src/oversized.ts", `const oversized = 'fixture-local-state';\n${"x".repeat(384 * 1024)}\n`);

    const result = collectProduct({ root });

    expect(result.status).toBe("partial");
    expect(result.records[0].inspectedSourceFiles).toBe(0);
    expect(result.warnings).toEqual(["Product source collection omitted oversized source files."]);
    expect(result.metadata.signals.flatMap((signal) => signal.evidencePaths)).not.toContain("src/oversized.ts");
  });

  it("reports unavailable repositories without touching external context", () => {
    const result = collectProduct({ root: join(tmpdir(), "missing-product-fixture") });
    expect(result.status).toBe("unavailable");
    expect(result.metadata.riskSurfaces).toEqual([]);
    expect(result.metadata.evidenceLabels).toEqual({ default: "unresolved", fields: {} });
    // S3 step 5: the unavailable envelope also carries an empty observations array.
    expect(result.observations).toEqual([]);
  });
});
