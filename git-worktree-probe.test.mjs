import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { classifyGitWorkTreeProbe, hasGitMarkerInAncestry } from "./lib/git-worktree-probe.mjs";

const directories = [];
afterEach(() => { while (directories.length) rmSync(directories.pop(), { recursive: true, force: true }); });

function directory() {
  const path = mkdtempSync(join(tmpdir(), "repo-intel-probe-"));
  directories.push(path);
  return path;
}

function failure(code) {
  return { ok: false, status: code === "EXIT_NON_ZERO" ? 128 : null, stdout: "", stderr: "", error: { code, message: "x" } };
}

describe("classifyGitWorkTreeProbe", () => {
  it("answers inside when Git printed true", () => {
    expect(classifyGitWorkTreeProbe({ ok: true, stdout: "true\n" }, directory())).toBe("inside");
  });

  it("answers outside-worktree when Git ran fine but did not print true", () => {
    expect(classifyGitWorkTreeProbe({ ok: true, stdout: "false\n" }, directory())).toBe("outside-worktree");
  });

  it("does not throw when a successful result has no stdout", () => {
    expect(classifyGitWorkTreeProbe({ ok: true }, directory())).toBe("outside-worktree");
  });

  it("answers git-missing for ENOENT, even when a .git entry exists", () => {
    const root = directory();
    mkdirSync(join(root, ".git"));
    expect(classifyGitWorkTreeProbe(failure("ENOENT"), root)).toBe("git-missing");
  });

  it("answers not-a-repo for a plain non-zero exit with no .git entry anywhere above", () => {
    expect(classifyGitWorkTreeProbe(failure("EXIT_NON_ZERO"), directory())).toBe("not-a-repo");
  });

  it("answers unknown for a non-zero exit when a .git entry exists here", () => {
    const root = directory();
    mkdirSync(join(root, ".git"));
    expect(classifyGitWorkTreeProbe(failure("EXIT_NON_ZERO"), root)).toBe("unknown");
  });

  it("answers unknown for a non-zero exit when a .git entry exists in an ancestor", () => {
    const parent = directory();
    mkdirSync(join(parent, ".git"));
    const child = join(parent, "a", "b");
    mkdirSync(child, { recursive: true });
    expect(classifyGitWorkTreeProbe(failure("EXIT_NON_ZERO"), child)).toBe("unknown");
  });

  it("answers unknown for a timeout or spawn error regardless of ancestry", () => {
    const root = directory();
    expect(classifyGitWorkTreeProbe(failure("ETIMEDOUT"), root)).toBe("unknown");
    expect(classifyGitWorkTreeProbe(failure("COMMAND_ERROR"), root)).toBe("unknown");
  });

  it("answers unknown when there is no result at all", () => {
    expect(classifyGitWorkTreeProbe(undefined, directory())).toBe("unknown");
  });
});

describe("hasGitMarkerInAncestry", () => {
  it("is false for a temp directory with no .git entry above it", () => {
    expect(hasGitMarkerInAncestry(directory())).toBe(false);
  });

  it("is true when the directory itself has a .git entry", () => {
    const root = directory();
    mkdirSync(join(root, ".git"));
    expect(hasGitMarkerInAncestry(root)).toBe(true);
  });
});
