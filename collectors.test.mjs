import {
  afterEach,
  describe,
  expect,
  it,
} from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import { collectRepositoryFiles } from "./lib/collect-files.mjs";
import { collectGitInventory } from "./lib/collect-git.mjs";
import { runCommand } from "./lib/run-command.mjs";
import { normalizeRepositoryPath } from "./lib/sanitize.mjs";

const fixtureDirectories = [];
const gitAvailable = runCommand("git", ["--version"], {
  cwd: process.cwd(),
}).ok;
const gitDescribe = gitAvailable ? describe : describe.skip;
const gitIt = gitAvailable ? it : it.skip;

afterEach(() => {
  while (fixtureDirectories.length) {
    rmSync(fixtureDirectories.pop(), { recursive: true, force: true });
  }
});

function createFixture() {
  const directory = mkdtempSync(join(tmpdir(), "sliceboard-intelligence-"));
  const root = join(directory, "repo");
  mkdirSync(root);
  fixtureDirectories.push(directory);
  return { directory, root };
}

function writeFixtureFile(root, path, content) {
  const filePath = join(root, ...path.split("/"));
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
}

function runGit(root, args) {
  const result = runCommand("git", args, { cwd: root });

  if (!result.ok) {
    throw new Error(`Fixture Git command failed: ${args[0]}`);
  }

  return result.stdout.trim();
}

function initializeRepository(root) {
  const fixtureEmail = ["fixture", "collector", "@", "example", ".test"].join("");

  runGit(root, ["init", "--initial-branch=main"]);
  runGit(root, ["config", "user.name", "Fixture Collector"]);
  runGit(root, ["config", "user.email", fixtureEmail]);
  runGit(root, ["add", "--all"]);
  runGit(root, ["commit", "-m", "initial inventory"]);

  return {
    branch: runGit(root, ["branch", "--show-current"]),
    email: fixtureEmail,
  };
}

function codePointSort(values) {
  return [...values].sort((left, right) => {
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
  });
}

function commandResult(stdout = "", ok = true) {
  return {
    ok,
    status: ok ? 0 : 1,
    stdout,
    stderr: "",
    error: ok ? null : { code: "EXIT_NON_ZERO", message: "Fixture command failed." },
  };
}

function syntheticGitRunner(
  root,
  {
    stagedNameStatus = "",
    unstagedNameStatus = "",
    diffNameStatus = "",
    diffNumstat = "",
    worktreeStatus = "",
  } = {},
) {
  const head = "a".repeat(40);

  return (_command, args) => {
    if (args[0] === "rev-parse" && args.includes("--is-inside-work-tree")) {
      return commandResult("true\n");
    }
    if (args[0] === "rev-parse" && args.includes("--show-toplevel")) {
      return commandResult(`${root}\n`);
    }
    if (args[0] === "rev-parse" && args.includes("--verify")) {
      return commandResult(`${head}\n`);
    }
    if (args[0] === "rev-parse") return commandResult("", false);
    if (args[0] === "branch") return commandResult("main\n");
    if (args[0] === "remote") return commandResult("");
    if (args[0] === "config") return commandResult("", false);
    if (args[0] === "diff" && args.includes("--cached")) {
      return commandResult(stagedNameStatus);
    }
    if (args[0] === "diff" && args.includes("--numstat")) {
      return commandResult(diffNumstat);
    }
    if (args[0] === "diff" && args.includes("--end-of-options")) {
      return commandResult(diffNameStatus);
    }
    if (args[0] === "diff") return commandResult(unstagedNameStatus);
    if (args[0] === "ls-files") return commandResult("");
    if (args[0] === "status") return commandResult(worktreeStatus);
    if (args[0] === "for-each-ref") return commandResult("main\t*\n");
    if (args[0] === "worktree") {
      return commandResult(
        `worktree ${root}\nHEAD ${head}\nbranch refs/heads/main\n\n`,
      );
    }
    if (args[0] === "log") return commandResult(`${head}\tfixture\n`);

    return commandResult("", false);
  };
}

describe("repository file inventory", () => {
  it("normalizes Windows-style paths to forward slashes", () => {
    expect(
      normalizeRepositoryPath(String.raw`src\fixtures\collector.test.mjs`),
    ).toBe("src/fixtures/collector.test.mjs");
  });

  gitIt("excludes configured generated and local directories", () => {
    const { root } = createFixture();
    const excludedDirectories = [
      "node_modules",
      "dist",
      "build",
      "coverage",
      ".vercel",
      ".review-staging",
      ".project-intelligence",
      ".vscode",
      "tmp",
      ".claude",
    ];

    writeFixtureFile(root, "src/kept.ts", "export const kept = true;\n");
    writeFixtureFile(root, "src/build/kept.ts", "export const nestedBuild = true;\n");
    writeFixtureFile(root, "src/dist/kept.ts", "export const nestedDist = true;\n");
    writeFixtureFile(root, "src/tmp/kept.ts", "export const nestedTmp = true;\n");
    writeFixtureFile(root, "src/coverage/kept.ts", "export const nestedCoverage = true;\n");
    for (const directory of excludedDirectories) {
      writeFixtureFile(root, `${directory}/ignored.txt`, "ignored\n");
    }
    initializeRepository(root);

    const result = collectRepositoryFiles({ root });
    const paths = result.records.map((record) => record.path);

    expect(result.status).toBe("complete");
    expect(paths).toContain("src/kept.ts");
    expect(paths).toContain("src/build/kept.ts");
    expect(paths).toContain("src/dist/kept.ts");
    expect(paths).toContain("src/tmp/kept.ts");
    expect(paths).toContain("src/coverage/kept.ts");
    expect(paths.some((path) => path.startsWith(".git/"))).toBe(false);
    for (const directory of excludedDirectories) {
      expect(paths.some((path) => path.startsWith(`${directory}/`))).toBe(false);
    }
  });

  gitIt("keeps binary assets as metadata without content", () => {
    const { root } = createFixture();

    writeFixtureFile(root, "assets/logo.png", Buffer.from([137, 80, 78, 71, 0, 1]));
    initializeRepository(root);

    const result = collectRepositoryFiles({ root });
    const asset = result.records.find((record) => record.path === "assets/logo.png");

    expect(asset).toMatchObject({
      path: "assets/logo.png",
      extension: ".png",
      classification: "asset",
      tracked: true,
      isBinary: true,
      contentInspectionSkipped: true,
      skipReason: "binary-asset",
    });
    expect(asset).not.toHaveProperty("content");
    expect(asset.evidenceLabels).toEqual({
      default: "observed_fact",
      fields: {
        classification: "mechanical_inference",
        isBinary: "mechanical_inference",
        skipReason: "mechanical_inference",
      },
    });
  });

  gitIt("returns deterministically sorted file records", () => {
    const { root } = createFixture();

    writeFixtureFile(root, "zeta.txt", "zeta\n");
    writeFixtureFile(root, "alpha.txt", "alpha\n");
    writeFixtureFile(root, "nested/beta.txt", "beta\n");
    initializeRepository(root);

    const first = collectRepositoryFiles({ root });
    const second = collectRepositoryFiles({ root });
    const paths = first.records.map((record) => record.path);

    expect(first).toEqual(second);
    expect(paths).toEqual(codePointSort(paths));
  });

  gitIt("redacts sensitive repository-relative file paths", () => {
    const { root } = createFixture();
    const email = ["fixture", "path", "@", "example", ".test"].join("");
    const token = ["ghp_", "ABCDEFGHIJKLMNOP", "QRSTUVWX"].join("");

    writeFixtureFile(root, `private/${email}`, "email path\n");
    writeFixtureFile(root, `private/${token}`, "token path\n");
    initializeRepository(root);

    const result = collectRepositoryFiles({ root });
    const paths = result.records.map((record) => record.path);

    expect(paths).toContain("private/[REDACTED:email]");
    expect(paths).toContain("private/[REDACTED:github-token]");
    expect(JSON.stringify(result)).not.toContain(email);
    expect(JSON.stringify(result)).not.toContain(token);
  });

  it("uses a sanitized filesystem fallback when Git is unavailable", () => {
    const { root } = createFixture();
    writeFixtureFile(root, "src/fallback.ts", "export const fallback = true;\n");
    writeFixtureFile(root, ".env", "PRIVATE_VALUE=ignored\n");
    writeFixtureFile(root, ".env.fixture", "PRIVATE_VALUE=ignored\n");
    writeFixtureFile(root, ".claude/settings.local.json", "{}\n");
    writeFixtureFile(root, "cache.tsbuildinfo", "{}\n");
    writeFixtureFile(root, ".github/workflows/keep.yml", "name: keep\n");

    const result = collectRepositoryFiles({
      root,
      gitCommand: "sliceboard-fixture-git-not-found",
    });
    const serialized = JSON.stringify(result);

    expect(result.status).toBe("partial");
    expect(result.metadata.discovery).toBe("filesystem");
    expect(result.records).toContainEqual(
      expect.objectContaining({ path: "src/fallback.ts", tracked: null }),
    );
    expect(result.records).toContainEqual(
      expect.objectContaining({ path: ".github/workflows/keep.yml" }),
    );
    expect(result.records.map((record) => record.path)).not.toContain(".env");
    expect(result.records.map((record) => record.path)).not.toContain(".env.fixture");
    expect(result.records.map((record) => record.path)).not.toContain(
      ".claude/settings.local.json",
    );
    expect(result.records.map((record) => record.path)).not.toContain(
      "cache.tsbuildinfo",
    );
    expect(serialized).not.toContain(normalizeRepositoryPath(root));

    const fallback = result.records.find((record) => record.path === "src/fallback.ts");
    expect(fallback.evidenceLabels).toEqual({
      default: "observed_fact",
      fields: {
        classification: "mechanical_inference",
        isBinary: "mechanical_inference",
        skipReason: "mechanical_inference",
        tracked: "unresolved",
      },
    });
    expect(result.metadata.evidenceLabels).toEqual({
      default: "observed_fact",
      fields: { tracking: "unresolved" },
    });
  });

  it("labels a symbolic-link record's unresolved classification and isBinary", () => {
    const { root } = createFixture();
    writeFixtureFile(root, "target.txt", "target\n");

    try {
      symlinkSync(join(root, "target.txt"), join(root, "link.txt"), "file");
    } catch {
      return;
    }

    const result = collectRepositoryFiles({
      root,
      gitCommand: "sliceboard-fixture-git-not-found",
    });
    const link = result.records.find((record) => record.path === "link.txt");

    expect(link).toBeDefined();
    expect(link.classification).toBe("unknown");
    expect(link.isBinary).toBeNull();
    expect(link.skipReason).toBe("symbolic-link");
    expect(link.evidenceLabels).toEqual({
      default: "observed_fact",
      fields: {
        classification: "unresolved",
        isBinary: "unresolved",
        tracked: "unresolved",
      },
    });
  });

  it("labels the unavailable envelope's metadata as unresolved", () => {
    const missingRoot = join(
      tmpdir(),
      `sliceboard-intelligence-missing-${Date.now()}`,
    );

    const result = collectRepositoryFiles({ root: missingRoot });

    expect(result.status).toBe("unavailable");
    expect(result.records).toEqual([]);
    expect(result.metadata.evidenceLabels).toEqual({
      default: "unresolved",
      fields: {},
    });
  });
});

gitDescribe("Git inventory", () => {
  it("reports the current branch and HEAD commit", () => {
    const { root } = createFixture();
    writeFixtureFile(root, "src/board.ts", "export const board = true;\n");
    const { branch } = initializeRepository(root);

    const result = collectGitInventory({ root });

    expect(result.status).toBe("complete");
    expect(result.metadata.repository).toEqual({
      isGitRepository: true,
      isRepositoryRoot: true,
    });
    expect(result.metadata.currentBranch).toBe(branch);
    expect(result.metadata.headCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(result.records).toContainEqual(
      expect.objectContaining({ subject: "initial inventory" }),
    );
  });

  it("distinguishes staged, unstaged, and untracked changes without raw patches", () => {
    const { root } = createFixture();
    writeFixtureFile(root, "staged.txt", "initial staged\n");
    writeFixtureFile(root, "unstaged.txt", "initial unstaged\n");
    initializeRepository(root);

    writeFixtureFile(root, "staged.txt", "staged replacement\n");
    runGit(root, ["add", "staged.txt"]);
    const patchMarker = ["patch", "-content", "-must", "-not", "-appear"].join("");
    writeFixtureFile(root, "unstaged.txt", `${patchMarker}\n`);
    writeFixtureFile(root, "untracked.txt", "untracked\n");

    const result = collectGitInventory({ root });
    const serialized = JSON.stringify(result);

    expect(result.status).toBe("complete");
    expect(result.metadata.clean).toBe(false);
    expect(result.metadata.dirty).toBe(true);
    expect(result.metadata.stagedChanges).toContainEqual(
      expect.objectContaining({ path: "staged.txt" }),
    );
    expect(result.metadata.unstagedChanges).toContainEqual(
      expect.objectContaining({ path: "unstaged.txt" }),
    );
    expect(result.metadata.untrackedFiles).toContain("untracked.txt");
    expect(result.metadata.diff).not.toHaveProperty("patch");
    expect(serialized).not.toContain(patchMarker);
  });

  it("keeps Git dirty-state accurate when excluded paths are omitted", () => {
    const { root } = createFixture();
    writeFixtureFile(root, "src/clean.ts", "export const clean = true;\n");
    initializeRepository(root);
    writeFixtureFile(root, ".vscode/local.json", "{}\n");

    const result = collectGitInventory({ root });

    expect(result.metadata.clean).toBe(false);
    expect(result.metadata.dirty).toBe(true);
    expect(result.metadata.untrackedFiles).not.toContain(".vscode/local.json");
  });

  it("sanitizes remote credentials and commit email addresses", () => {
    const { root } = createFixture();
    writeFixtureFile(root, "src/remote.ts", "export const remote = true;\n");
    const { email } = initializeRepository(root);

    const remoteUsername = ["fixture", "user"].join("-");
    const remotePassword = ["not", "-a", "-credential"].join("");
    const remoteQuery = ["access", "_token=fixture", "-value"].join("");
    const remoteUrl = `https://${remoteUsername}:${remotePassword}@example.invalid/owner/repo.git?${remoteQuery}#fragment`;
    runGit(root, ["remote", "add", "origin", remoteUrl]);

    const result = collectGitInventory({ root });
    const serialized = JSON.stringify(result);

    expect(result.metadata.defaultRemote).toEqual({
      name: "origin",
      url: "https://example.invalid/owner/repo.git",
    });
    expect(serialized).not.toContain(remoteUsername);
    expect(serialized).not.toContain(remotePassword);
    expect(serialized).not.toContain(remoteQuery);
    expect(serialized).not.toContain(email);
  });

  it("redacts email addresses in commit subjects", () => {
    const { root } = createFixture();
    const subjectEmail = ["commit", "subject", "@", "example", ".test"].join("");
    writeFixtureFile(root, "src/subject.ts", "export const subject = true;\n");
    initializeRepository(root);
    writeFixtureFile(root, "src/subject.ts", "export const subject = false;\n");
    runGit(root, ["add", "src/subject.ts"]);
    runGit(root, ["commit", "-m", `contact ${subjectEmail}`]);

    const result = collectGitInventory({ root });
    const serialized = JSON.stringify(result);

    expect(result.records).toContainEqual(
      expect.objectContaining({ subject: "contact [REDACTED:email]" }),
    );
    expect(serialized).not.toContain(subjectEmail);
  });

  it("redacts, rather than silently passing through, local paths in commit subjects (S1)", () => {
    const { root } = createFixture();
    writeFixtureFile(root, "src/config.ts", "export const config = true;\n");
    initializeRepository(root);
    writeFixtureFile(root, "src/config.ts", "export const config = false;\n");
    runGit(root, ["add", "src/config.ts"]);
    runGit(root, ["commit", "-m", "fix /etc/hosts lookup on CI runner"]);

    const result = collectGitInventory({ root });

    expect(result.records).toContainEqual(
      expect.objectContaining({ subject: "fix [REDACTED:local-path] lookup on CI runner" }),
    );
    expect(JSON.stringify(result)).not.toContain("/etc/hosts");
  });

  it("parses rename records in changed-file and numstat summaries", () => {
    const { root } = createFixture();
    writeFixtureFile(root, "before.txt", "same content\n");
    initializeRepository(root);
    runGit(root, ["mv", "before.txt", "after.txt"]);
    runGit(root, ["commit", "-am", "rename file"]);

    const result = collectGitInventory({ root, baseRef: "HEAD~1" });

    expect(result.metadata.diff.changedFiles).toContainEqual({
      status: "R100",
      previousPath: "before.txt",
      path: "after.txt",
    });
    expect(result.metadata.diff.numstat).toContainEqual({
      previousPath: "before.txt",
      path: "after.txt",
      additions: 0,
      deletions: 0,
    });
  });

  it("defaults the diff base to merge-base(HEAD, main), not the branch's own upstream (RI-GIT-BASE)", () => {
    const { root } = createFixture();
    writeFixtureFile(root, "src/trunk.ts", "export const trunk = true;\n");
    initializeRepository(root);
    const mainSha = runGit(root, ["rev-parse", "HEAD"]);

    runGit(root, ["checkout", "-b", "feature"]);
    writeFixtureFile(root, "src/feature.ts", "export const feature = true;\n");
    runGit(root, ["add", "src/feature.ts"]);
    runGit(root, ["commit", "-m", "add feature file"]);

    // No --base and no configured upstream: the old default (tracking-branch-or-HEAD)
    // collapsed to a literal "HEAD" here, diffing the branch against itself and
    // reporting zero changed files even though "feature" has a real, unmerged commit
    // against "main". The new default (merge-base(HEAD, main) first) must catch it.
    const result = collectGitInventory({ root });

    expect(result.metadata.diff.baseRef).toBe(mainSha);
    expect(result.metadata.diff.changedFiles).toContainEqual(
      expect.objectContaining({ path: "src/feature.ts" }),
    );
  });

  it("warns, but does not fail, when the diff base resolves to HEAD", () => {
    const { root } = createFixture();
    writeFixtureFile(root, "src/only.ts", "export const only = true;\n");
    // Initialize with a non-"main" default branch so merge-base(HEAD, main) has
    // nothing to resolve, and no upstream is configured either.
    runGit(root, ["init"]);
    runGit(root, ["checkout", "-b", "trunk-only"]);
    runGit(root, ["config", "user.name", "Fixture Collector"]);
    runGit(root, ["config", "user.email", ["fixture", "head", "@", "example", ".test"].join("")]);
    runGit(root, ["add", "--all"]);
    runGit(root, ["commit", "-m", "solo commit"]);

    const result = collectGitInventory({ root });

    expect(result.metadata.diff.baseRef).toBe("HEAD");
    expect(result.status).toBe("partial");
    expect(result.warnings).toContain(
      "The diff base resolved to HEAD (no local main and no upstream branch); an empty diff summary is expected, not a failure.",
    );
    expect(result.metadata.diff.changedFiles).toEqual([]);
  });

  it("still honors an explicit --base ref over the merge-base default", () => {
    const { root } = createFixture();
    writeFixtureFile(root, "src/trunk.ts", "export const trunk = true;\n");
    initializeRepository(root);

    runGit(root, ["checkout", "-b", "feature"]);
    writeFixtureFile(root, "src/feature.ts", "export const feature = true;\n");
    runGit(root, ["add", "src/feature.ts"]);
    runGit(root, ["commit", "-m", "add feature file"]);

    const result = collectGitInventory({ root, baseRef: "HEAD" });

    expect(result.metadata.diff.baseRef).toBe("HEAD");
    expect(result.metadata.diff.changedFiles).toEqual([]);
  });

  it("skips diff collection entirely when the caller does not want it", () => {
    const { root } = createFixture();
    writeFixtureFile(root, "src/trunk.ts", "export const trunk = true;\n");
    initializeRepository(root);

    runGit(root, ["checkout", "-b", "feature"]);
    writeFixtureFile(root, "src/feature.ts", "export const feature = true;\n");
    runGit(root, ["add", "src/feature.ts"]);
    runGit(root, ["commit", "-m", "add feature file"]);

    const invocations = [];
    const recordingRunner = (command, args, options) => {
      invocations.push(args);
      return runCommand(command, args, options);
    };

    const result = collectGitInventory({
      root,
      includeDiff: false,
      runner: recordingRunner,
    });

    expect(invocations.some((args) => args[0] === "merge-base")).toBe(false);
    expect(invocations.some((args) => args.includes("--numstat"))).toBe(false);
    expect(result.metadata.diff).toEqual({
      baseRef: null,
      changedFiles: [],
      numstat: [],
    });
    // Non-diff collection is unaffected.
    expect(result.metadata.currentBranch).toBe("feature");
    expect(result.status).toBe("complete");
  });

  it("rejects option-like base refs before invoking Git", () => {
    const { root } = createFixture();
    writeFixtureFile(root, "src/base.ts", "export const base = true;\n");
    initializeRepository(root);

    const result = collectGitInventory({ root, baseRef: "--not-a-ref" });

    expect(result.status).toBe("partial");
    expect(result.metadata.diff.baseRef).toBeNull();
    expect(result.warnings).toContain("The configured diff base was rejected.");
  });

  it("uses aliases instead of absolute worktree paths", () => {
    const { directory, root } = createFixture();
    writeFixtureFile(root, "src/worktree.ts", "export const worktree = true;\n");
    initializeRepository(root);

    const linkedWorktree = join(directory, "linked-worktree");
    runGit(root, ["worktree", "add", "-b", "fixture-worktree", linkedWorktree]);

    const result = collectGitInventory({ root });
    const serialized = JSON.stringify(result);

    expect(result.metadata.worktrees).toContainEqual(
      expect.objectContaining({ alias: "repo-root" }),
    );
    expect(result.metadata.worktrees).toContainEqual(
      expect.objectContaining({ alias: "worktree:linked-worktree" }),
    );
    expect(serialized).not.toContain(normalizeRepositoryPath(root));
    expect(serialized).not.toContain(normalizeRepositoryPath(linkedWorktree));
  });
});

describe("Git collector failure handling", () => {
  it("marks truncated name-status output as partial", () => {
    const { root } = createFixture();
    const result = collectGitInventory({
      root,
      runner: syntheticGitRunner(root, {
        stagedNameStatus: "M\0truncated.txt",
      }),
    });

    expect(result.status).toBe("partial");
    expect(result.warnings).toContain(
      "Staged changes included malformed name-status records.",
    );
  });

  it("stores non-numeric numstat values as null without NaN", () => {
    const { root } = createFixture();
    const result = collectGitInventory({
      root,
      runner: syntheticGitRunner(root, {
        diffNameStatus: "M\0changed.txt\0",
        diffNumstat: "not-a-number\t2\tchanged.txt\0",
      }),
    });
    const record = result.metadata.diff.numstat[0];

    expect(result.status).toBe("partial");
    expect(result.warnings).toContain(
      "Numstat diff summary included malformed records.",
    );
    expect(record).toMatchObject({
      path: "changed.txt",
      additions: null,
      deletions: 2,
    });
    expect(Number.isNaN(record.additions)).toBe(false);
  });

  it("returns unavailable output without local paths when Git is missing", () => {
    const { root } = createFixture();
    writeFixtureFile(root, "src/no-git.ts", "export const unavailable = true;\n");

    const result = collectGitInventory({
      root,
      gitCommand: "sliceboard-fixture-git-not-found",
    });
    const serialized = JSON.stringify(result);

    expect(result.status).toBe("unavailable");
    expect(result.warnings).toContain(
      "Git is unavailable; Git inventory could not be collected.",
    );
    expect(serialized).not.toContain(normalizeRepositoryPath(root));
  });

  gitIt("returns unavailable output for a directory outside a Git repository", () => {
    const { root } = createFixture();
    writeFixtureFile(root, "src/not-a-repository.ts", "export const plain = true;\n");

    const result = collectGitInventory({ root });
    const serialized = JSON.stringify(result);

    expect(result.status).toBe("unavailable");
    expect(result.metadata.repository.isGitRepository).toBe(false);
    expect(serialized).not.toContain(normalizeRepositoryPath(root));
  });
});
