import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * True when `start` or any ancestor directory has a `.git` entry (a directory, or the
 * file that worktrees and submodules use). Purely a filesystem check, so it doesn't
 * depend on Git being runnable or on the language Git prints its messages in.
 */
export function hasGitMarkerInAncestry(start) {
  let directory = resolve(start);
  for (;;) {
    if (existsSync(join(directory, ".git"))) return true;
    const parent = dirname(directory);
    if (parent === directory) return false;
    directory = parent;
  }
}

/**
 * Classifies the result of `git rev-parse --is-inside-work-tree` run in `root`.
 *
 * - "inside":           Git answered "true".
 * - "outside-worktree": Git ran fine and answered something other than "true"
 *                       (for example inside a .git directory or a bare repository).
 * - "git-missing":      Git could not be started at all (ENOENT).
 * - "not-a-repo":       Git exited non-zero and no `.git` entry exists here or above.
 * - "unknown":          Git failed (non-zero exit, timeout, spawn error) but the directory
 *                       looks like part of a repository, or the failure was not a plain
 *                       non-zero exit. A lock, timeout, or permission error lands here
 *                       instead of being mistaken for "not a repository".
 */
export function classifyGitWorkTreeProbe(result, root) {
  if (result?.ok) {
    return String(result.stdout ?? "").trim() === "true" ? "inside" : "outside-worktree";
  }

  const code = result?.error?.code;
  if (code === "ENOENT") return "git-missing";
  if (code !== "EXIT_NON_ZERO") return "unknown";
  return hasGitMarkerInAncestry(root) ? "unknown" : "not-a-repo";
}
