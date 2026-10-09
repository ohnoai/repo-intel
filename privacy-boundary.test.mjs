import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

// The whole point of this file: prove the "never read a private file's content" guarantee
// holds at the actual fs boundary, not just "the output happens not to contain it" (which a
// leak elsewhere in the pipeline -- a new collector, a refactor that widens a scan -- could
// silently defeat). See docs/decisions/2026-09-22-schema-v3-structural-guard.md's successor
// S7 design record, owner decision 3.3: module-level vi.mock, not an injected reader, because
// an injected seam can always be bypassed by a future direct import and still pass.
const { readCalls } = vi.hoisted(() => ({ readCalls: [] }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    readFileSync: (path, ...args) => {
      readCalls.push(String(path));
      return actual.readFileSync(path, ...args);
    },
  };
});

const { composeEvidence } = await import("./export.mjs");

const fixtures = [];
afterEach(() => {
  readCalls.length = 0;
  while (fixtures.length) rmSync(fixtures.pop(), { recursive: true, force: true });
});

function write(root, path, content) {
  const file = join(root, ...path.split("/"));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

const PRIVATE_SENTINEL = ["fixture", "-privacy-boundary", "-secret"].join("");
const POSITIVE_CONTROL_VALUE = "your-public-value";

// Plants a private file everywhere a collector looks (one per real gap fixed in this slice,
// plus the files collector's own pre-existing denylist) and one real .env.example -- the
// positive control -- which SHOULD be read, proving the mock actually intercepts rather than
// silently no-op'ing (the same lesson as S3 step 7's rollup-test fixture).
function plantPrivateFiles(root) {
  write(root, ".env", `ROOT_SECRET=${PRIVATE_SENTINEL}\n`);
  write(root, "api/.env.local", `API_SECRET=${PRIVATE_SENTINEL}\n`);
  write(root, "src/.env.ts", `export const SHOULD_NEVER_FIRE = "${PRIVATE_SENTINEL}";\n`);
  write(root, ".github/workflows/.env.yml", `name: x\non: push\njobs:\n  x:\n    env:\n      LEAKED: ${PRIVATE_SENTINEL}\n`);
  write(root, "docs/decisions/.env.md", `SHOULD_NEVER_BE_READ=${PRIVATE_SENTINEL}\n`);
  write(root, ".repo-intelligence.json", JSON.stringify({
    authorityDocuments: { ".env": "environment-secrets" },
    requiredAuthorityDocuments: [".env"],
    product: { name: "Fixture", signals: [{ id: "sentinel-signal", pattern: "SHOULD_NEVER_FIRE" }] },
  }));
  write(root, ".env.example", `PUBLIC_SETTING=${POSITIVE_CONTROL_VALUE}\n`);
}

function privatePlantedPaths() {
  return [
    ".env",
    "api/.env.local",
    "src/.env.ts",
    ".github/workflows/.env.yml",
    "docs/decisions/.env.md",
  ];
}

function assertNoPrivateLeak(bundle) {
  const serialized = JSON.stringify(bundle);
  expect(serialized).not.toContain(PRIVATE_SENTINEL);

  // The files collector legitimately lists every file by name, including a private one --
  // ".env* flagged but never read" is the documented contract (README.md), so ".env"
  // appearing as a *filename* there is correct, not a leak. The other collectors' records
  // represent something they read and parsed; a private path should never reach any of them.
  for (const [name, collector] of Object.entries(bundle.collectors)) {
    if (name === "files") continue;
    for (const record of collector.records) {
      if (typeof record.path !== "string") continue;
      for (const plantedPath of privatePlantedPaths()) {
        expect(record.path.endsWith(plantedPath)).toBe(false);
      }
    }
  }

  // The positive control: proves the mock actually intercepted real reads, so the absence
  // of the private paths above is not because readFileSync silently never ran at all.
  expect(readCalls.some((path) => path.replace(/\\/g, "/").endsWith(".env.example"))).toBe(true);
}

describe("privacy boundary: never reads a private file's content (S7)", () => {
  it("holds for a non-Git fixture", () => {
    const directory = mkdtempSync(join(tmpdir(), "privacy-boundary-"));
    const root = join(directory, "repo");
    mkdirSync(root);
    fixtures.push(directory);
    plantPrivateFiles(root);

    const bundle = composeEvidence({ root });
    assertNoPrivateLeak(bundle);
  });

  it("holds for a Git fixture, includeDiff:false", () => {
    const directory = mkdtempSync(join(tmpdir(), "privacy-boundary-"));
    const root = join(directory, "repo");
    mkdirSync(root);
    fixtures.push(directory);
    plantPrivateFiles(root);
    execFileSync("git", ["init", "-q", "--initial-branch=main"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Fixture Privacy"], { cwd: root });
    execFileSync("git", ["config", "user.email", ["fixture", "privacy", "@", "example", ".test"].join("")], { cwd: root });
    execFileSync("git", ["add", "--all"], { cwd: root });
    execFileSync("git", ["commit", "-q", "-m", "initial"], { cwd: root });

    const bundle = composeEvidence({ root, includeDiff: false });
    assertNoPrivateLeak(bundle);
  });

  it("holds for a Git fixture, includeDiff:true", () => {
    const directory = mkdtempSync(join(tmpdir(), "privacy-boundary-"));
    const root = join(directory, "repo");
    mkdirSync(root);
    fixtures.push(directory);
    plantPrivateFiles(root);
    execFileSync("git", ["init", "-q", "--initial-branch=main"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Fixture Privacy"], { cwd: root });
    execFileSync("git", ["config", "user.email", ["fixture", "privacy", "@", "example", ".test"].join("")], { cwd: root });
    execFileSync("git", ["add", "--all"], { cwd: root });
    execFileSync("git", ["commit", "-q", "-m", "initial"], { cwd: root });

    const bundle = composeEvidence({ root, includeDiff: true });
    assertNoPrivateLeak(bundle);
  });

  // Static check: the mock above only wraps "node:fs". If any lib/*.mjs or export.mjs
  // itself ever imports "fs" (bare) or "node:fs/promises" for reading file content, this
  // suite's coverage claim would be silently false -- the read would bypass the mock
  // entirely and neither the positive control nor a real leak would show up here.
  // readFileSync/readdirSync here are the mock's own pass-through implementations
  // (readdirSync is never wrapped; readFileSync still returns real content), so this
  // reads the real repository source normally.
  it("every source file's fs import is exactly node:fs (so this suite's coverage claim is honest)", () => {
    const sourceFiles = [
      "export.mjs",
      ...readdirSync(join(process.cwd(), "lib"))
        .filter((name) => name.endsWith(".mjs"))
        .map((name) => `lib/${name}`),
    ];

    for (const file of sourceFiles) {
      const text = readFileSync(join(process.cwd(), file), "utf8");
      const importSpecifiers = [...text.matchAll(/from\s+["']([^"']*fs[^"']*)["']/gi)]
        .map((match) => match[1])
        .filter((specifier) => specifier === "fs" || specifier.startsWith("fs/") || specifier.includes("node:fs"));
      for (const specifier of importSpecifiers) {
        expect(specifier).toBe("node:fs");
      }
    }
  });
});
