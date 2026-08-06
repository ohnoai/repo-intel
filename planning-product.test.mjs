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
  it("detects SliceBoard product signals and risk surfaces without exporting source", () => {
    const root = fixture();
    write(root, "src/SliceBoardApp.tsx", "import { PizzaWindowChart } from './chart'; const key = 'sliceboard-state'; const cloud = board_states; const revision = 1; function applyAmountToSlice() {}\n");
    write(root, "src/entitlements.ts", "export const isPro = true; export const isPieLocked = true;\n");
    const result = collectProduct({ root });
    expect(result.metadata.product).toBe("SliceBoard");
    expect(result.metadata.signals.map((signal) => signal.id)).toEqual(expect.arrayContaining(["budget-allocation", "pizza-visualization", "local-first-persistence", "cloud-sync", "billing-entitlements"]));
    expect(result.metadata.riskSurfaces.map((risk) => risk.id)).toEqual(expect.arrayContaining(["budget-invariant", "cloud-concurrency", "entitlement-boundary", "sensitive-data-boundary"]));
    expect(JSON.stringify(result)).not.toContain("function applyAmountToSlice");
  });

  it("ignores nested Git worktrees when collecting product evidence", () => {
    const root = fixture();
    write(root, "src/app.ts", "const app = 'sliceboard-state';\n");
    write(root, "nested-file/.git", "gitdir: ../.git/worktrees/nested-file\n");
    write(root, "nested-file/hidden.ts", "const hidden = 'board_states';\n");
    mkdirSync(join(root, "nested-directory/.git"), { recursive: true });
    write(root, "nested-directory/hidden.ts", "const hidden = 'Stripe';\n");

    const result = collectProduct({ root });

    expect(result.records[0].inspectedSourceFiles).toBe(1);
    expect(result.metadata.signals.flatMap((signal) => signal.evidencePaths)).not.toEqual(
      expect.arrayContaining(["nested-file/hidden.ts", "nested-directory/hidden.ts"]),
    );
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
    write(root, "a/b/c/d/e/f/deep.ts", "const deep = 'board_states';\n");

    const result = collectProduct({ root });

    expect(result.status).toBe("partial");
    expect(result.records[0].inspectedSourceFiles).toBe(0);
    expect(result.warnings).toEqual(["Product source collection omitted files beyond its traversal depth limit."]);
    expect(result.metadata.signals.flatMap((signal) => signal.evidencePaths)).not.toContain("a/b/c/d/e/f/deep.ts");
  });

  it("reports partial evidence when an oversized source file is omitted", () => {
    const root = fixture();
    write(root, "src/oversized.ts", `const oversized = 'sliceboard-state';\n${"x".repeat(384 * 1024)}\n`);

    const result = collectProduct({ root });

    expect(result.status).toBe("partial");
    expect(result.records[0].inspectedSourceFiles).toBe(0);
    expect(result.warnings).toEqual(["Product source collection omitted oversized source files."]);
    expect(result.metadata.signals.flatMap((signal) => signal.evidencePaths)).not.toContain("src/oversized.ts");
  });

  it("reports unavailable repositories without touching external context", () => {
    const result = collectProduct({ root: join(tmpdir(), "missing-sliceboard-product-fixture") });
    expect(result.status).toBe("unavailable");
    expect(result.metadata.riskSurfaces).toEqual([]);
  });
});
