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

  it("returns partial evidence for absent or unreadable optional planning input without document bodies", () => {
    const root = fixture();
    write(root, ".repo-intelligence.json", JSON.stringify({
      requiredAuthorityDocuments: ["SLICE_BOARD_AUTHORITY.md", "PASSOFF.md"],
    }));
    write(root, "docs/decisions/broken.md", "# Broken\ncontact secret@example.test\n");
    const result = collectPlanning({ root });
    expect(result.status).toBe("partial");
    expect(result.warnings.some((warning) => warning.includes("authority document was absent"))).toBe(true);
    expect(JSON.stringify(result)).not.toContain("secret@example.test");
    expect(JSON.stringify(result)).not.toContain("contact secret");
    expect(result.records[0]).not.toHaveProperty("content");
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
    expect(result.metadata.product).toBeNull();
    expect(result.metadata.signals).toEqual([]);
    expect(result.metadata.riskSurfaces).toEqual([]);
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
    for (let index = 0; index < 161; index += 1) write(root, `src/source-${String(index).padStart(3, "0")}.ts`, "export const value = true;\n");

    const result = collectProduct({ root });

    expect(result.status).toBe("partial");
    expect(result.records[0].inspectedSourceFiles).toBe(160);
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
  });
});
