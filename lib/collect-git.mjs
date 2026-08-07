import { resolve } from "node:path";

import { isExcludedRepositoryPath } from "./collect-files.mjs";
import {
  normalizeRepositoryPath,
  sanitizeMetadataText,
  sanitizeRemoteUrl,
  sanitizeText,
} from "./sanitize.mjs";
import { runCommand } from "./run-command.mjs";

const DEFAULT_RECENT_COMMIT_LIMIT = 20;
const MAX_RECENT_COMMIT_LIMIT = 100;

function compareText(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function isAbsolutePath(path) {
  return path.startsWith("/") || /^[A-Za-z]:\//.test(path);
}

function safeRepositoryPath(input) {
  if (input === undefined || input === null) return null;

  const normalizedPath = normalizeRepositoryPath(input);

  if (
    !normalizedPath ||
    normalizedPath === "." ||
    isAbsolutePath(normalizedPath) ||
    normalizedPath === ".." ||
    normalizedPath.startsWith("../")
  ) {
    return null;
  }

  const path = normalizeRepositoryPath(sanitizeText(normalizedPath).text);

  if (
    !path ||
    path === "." ||
    isAbsolutePath(path) ||
    path === ".." ||
    path.startsWith("../")
  ) {
    return null;
  }

  return path;
}

function safeGitValue(input) {
  // Metadata-tier: a benign free-text value like a branch name or worktree path that
  // happens to contain "fix /etc/hosts" is redacted, not discarded outright. The
  // isAbsolutePath guard below still nulls out the rare case where the *entire* value
  // is itself an unredacted absolute path shape.
  const value = sanitizeMetadataText(input).trim();
  return value && !isAbsolutePath(normalizeRepositoryPath(value)) ? value : null;
}

function comparablePath(path) {
  const normalized = normalizeRepositoryPath(resolve(path)).replace(/\/$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function parseNullDelimitedPaths(raw) {
  return raw
    .split("\0")
    .filter(Boolean)
    .map(safeRepositoryPath)
    .filter((path) => path && !isExcludedRepositoryPath(path))
    .sort(compareText);
}

function parseNameStatus(raw) {
  const text = String(raw ?? "");
  const values = text.split("\0");
  const limit = text ? values.length - (text.endsWith("\0") ? 1 : 0) : 0;
  const records = [];
  let malformed = text && !text.endsWith("\0") ? 1 : 0;

  for (let index = 0; index < limit; ) {
    const status = values[index++];
    if (!/^[ACDMRTUXB][0-9]*$/.test(status)) {
      malformed += 1;
      continue;
    }

    const renamed = status.startsWith("R") || status.startsWith("C");
    if (renamed && index >= limit) {
      malformed += 1;
      break;
    }

    const rawPreviousPath = renamed ? values[index++] : null;
    if (index >= limit) {
      malformed += 1;
      break;
    }

    const rawPath = values[index++];
    const previousPath = renamed ? safeRepositoryPath(rawPreviousPath) : null;
    const path = safeRepositoryPath(rawPath);

    if (!path || (renamed && !previousPath)) {
      malformed += 1;
      continue;
    }

    if (isExcludedRepositoryPath(path)) continue;

    records.push({
      status,
      path,
      previousPath: previousPath && !isExcludedRepositoryPath(previousPath) ? previousPath : null,
    });
  }

  return {
    records: records.sort((left, right) => {
      const pathOrder = compareText(left.path, right.path);
      return pathOrder || compareText(left.previousPath ?? "", right.previousPath ?? "");
    }),
    malformed,
  };
}

function parseNumstat(raw) {
  const text = String(raw ?? "");
  const values = text.split("\0");
  const limit = text ? values.length - (text.endsWith("\0") ? 1 : 0) : 0;
  const records = [];
  let malformed = text && !text.endsWith("\0") ? 1 : 0;

  for (let index = 0; index < limit; ) {
    const header = values[index++];
    if (!header) {
      malformed += 1;
      continue;
    }

    const firstSeparator = header.indexOf("\t");
    const secondSeparator = header.indexOf("\t", firstSeparator + 1);
    if (firstSeparator < 0 || secondSeparator < 0) {
      malformed += 1;
      continue;
    }

    const additions = header.slice(0, firstSeparator);
    const deletions = header.slice(firstSeparator + 1, secondSeparator);
    const firstPath = header.slice(secondSeparator + 1);
    if (!firstPath && index + 1 >= limit) {
      malformed += 1;
      break;
    }

    const rawPreviousPath = firstPath ? null : values[index++];
    const rawPath = firstPath || values[index++];
    const previousPath = firstPath ? null : safeRepositoryPath(rawPreviousPath);
    const path = safeRepositoryPath(rawPath);

    if (!path || (!firstPath && !previousPath)) {
      malformed += 1;
      continue;
    }

    const additionCount = numstatCount(additions);
    const deletionCount = numstatCount(deletions);
    if (!additionCount.valid || !deletionCount.valid) malformed += 1;

    if (isExcludedRepositoryPath(path)) continue;

    records.push({
      path,
      previousPath: previousPath && !isExcludedRepositoryPath(previousPath) ? previousPath : null,
      additions: additionCount.value,
      deletions: deletionCount.value,
    });
  }

  return {
    records: records.sort((left, right) => {
      const pathOrder = compareText(left.path, right.path);
      return pathOrder || compareText(left.previousPath ?? "", right.previousPath ?? "");
    }),
    malformed,
  };
}

function numstatCount(value) {
  if (value === "-") return { value: null, valid: true };
  if (!/^\d+$/.test(value)) return { value: null, valid: false };

  const number = Number(value);
  return {
    value: Number.isFinite(number) && Number.isSafeInteger(number) ? number : null,
    valid: Number.isFinite(number) && Number.isSafeInteger(number),
  };
}

function parseBranches(raw) {
  return raw
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [rawName, marker] = line.split("\t");
      const name = safeGitValue(rawName);
      return name ? { name, current: marker === "*" } : null;
    })
    .filter(Boolean)
    .sort((left, right) => compareText(left.name, right.name));
}

function worktreeAlias(worktreePath, repositoryRoot) {
  const normalized = normalizeRepositoryPath(worktreePath).replace(/\/+$/, "");

  if (comparablePath(worktreePath) === comparablePath(repositoryRoot)) {
    return "repo-root";
  }

  const directoryName = normalized.split("/").filter(Boolean).at(-1) ?? "worktree";
  const safeDirectoryName = sanitizeText(directoryName).text || "worktree";
  return `worktree:${safeDirectoryName}`;
}

function parseWorktrees(raw, repositoryRoot) {
  const worktrees = [];

  for (const block of raw.split(/\r?\n\r?\n/)) {
    if (!block.trim()) continue;

    let worktreePath = null;
    let branch = null;
    let head = null;
    let detached = false;
    let bare = false;

    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("worktree ")) {
        worktreePath = line.slice("worktree ".length);
      } else if (line.startsWith("branch ")) {
        branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
      } else if (line.startsWith("HEAD ")) {
        head = line.slice("HEAD ".length);
      } else if (line === "detached") {
        detached = true;
      } else if (line === "bare") {
        bare = true;
      }
    }

    if (!worktreePath) continue;

    worktrees.push({
      alias: worktreeAlias(worktreePath, repositoryRoot),
      branch: safeGitValue(branch),
      head: safeGitValue(head),
      detached,
      bare,
    });
  }

  worktrees.sort((left, right) => compareText(left.alias, right.alias));

  const aliases = new Map();
  return worktrees.map((worktree) => {
    const count = (aliases.get(worktree.alias) ?? 0) + 1;
    aliases.set(worktree.alias, count);

    return count === 1
      ? worktree
      : { ...worktree, alias: `${worktree.alias}-${count}` };
  });
}

function parseRecentCommits(raw) {
  return raw
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const separator = line.indexOf("\t");
      if (separator < 0) return null;

      const sha = safeGitValue(line.slice(0, separator));
      if (!sha) return null;

      return {
        sha,
        subject: sanitizeMetadataText(line.slice(separator + 1)),
      };
    })
    .filter(Boolean);
}

function recentCommitLimit(value) {
  if (!Number.isInteger(value)) return DEFAULT_RECENT_COMMIT_LIMIT;
  return Math.min(Math.max(value, 1), MAX_RECENT_COMMIT_LIMIT);
}

function executeGit(runner, gitCommand, args, root) {
  try {
    return runner(gitCommand, args, { cwd: root });
  } catch {
    return {
      ok: false,
      status: null,
      stdout: "",
      stderr: "",
      error: { code: "COMMAND_ERROR", message: "Command execution failed." },
    };
  }
}

function sortedFields(fields) {
  const sorted = {};
  for (const key of Object.keys(fields).sort(compareText)) {
    sorted[key] = fields[key];
  }
  return sorted;
}

function commitRecordEvidenceLabels() {
  return { default: "observed_fact", fields: { subject: "documented_intent" } };
}

function repositoryEvidenceLabels({ isRepositoryRoot }) {
  const fields = {};
  if (isRepositoryRoot === null) fields.isRepositoryRoot = "unresolved";
  return { default: "observed_fact", fields: sortedFields(fields) };
}

function defaultRemoteEvidenceLabels({ name, url }) {
  const fields = {};

  // V1-1 (docs/decisions/2026-08-07-evidence-labels.md §10.4): the target mapping in §6.2
  // splits this field into observed_fact (git config named the remote explicitly) versus
  // mechanical_inference (the "origin"/first-remote fallback fired). v1 does not carry the
  // index of which precedence branch matched, so it rounds toward the more skeptical label
  // unconditionally: mechanical_inference whenever a name is present, unresolved when none
  // could be determined at all.
  fields.name = name === null ? "unresolved" : "mechanical_inference";
  if (url === null) fields.url = "unresolved";

  return { default: "observed_fact", fields: sortedFields(fields) };
}

function worktreeEvidenceLabels({ branch, head }) {
  const fields = { alias: "mechanical_inference" };
  if (branch === null) fields.branch = "unresolved";
  if (head === null) fields.head = "unresolved";
  return { default: "observed_fact", fields: sortedFields(fields) };
}

function numstatRecordEvidenceLabels({ additions, deletions }) {
  const fields = {};
  if (additions === null) fields.additions = "unresolved";
  if (deletions === null) fields.deletions = "unresolved";
  if (Object.keys(fields).length === 0) return null;
  return { default: "observed_fact", fields: sortedFields(fields) };
}

// Attaches every evidenceLabels block described in docs/decisions/2026-08-07-evidence-labels.md
// §6.2 for a `complete`/`partial` envelope. Called once, right before a non-`unavailable`
// return, so every field it inspects (repository.isRepositoryRoot, defaultRemote, worktrees,
// diff, the top-level nulls) has already reached its final value.
function attachGitEvidenceLabels(metadata, { baseResolvedToHead = false } = {}) {
  const repositoryLabels = repositoryEvidenceLabels(metadata.repository);
  const repository =
    Object.keys(repositoryLabels.fields).length > 0
      ? { ...metadata.repository, evidenceLabels: repositoryLabels }
      : metadata.repository;

  const defaultRemote = {
    ...metadata.defaultRemote,
    evidenceLabels: defaultRemoteEvidenceLabels(metadata.defaultRemote),
  };

  const worktrees = metadata.worktrees.map((worktree) => ({
    ...worktree,
    evidenceLabels: worktreeEvidenceLabels(worktree),
  }));

  const numstat = metadata.diff.numstat.map((entry) => {
    const labels = numstatRecordEvidenceLabels(entry);
    return labels ? { ...entry, evidenceLabels: labels } : entry;
  });

  // A null baseRef (rejected, or never attempted because includeDiff was false) and a
  // baseRef that resolved to HEAD are both cases where nothing under `diff` asserts anything
  // meaningful about the repository (§6.2's `diff.baseRef` row; example §7.2). Rather than
  // overriding baseRef/changedFiles/numstat individually, blanket the whole subtree with one
  // nested `unresolved` default, per §3.3.
  const diffUnresolved = metadata.diff.baseRef === null || baseResolvedToHead;
  const diff = diffUnresolved
    ? { ...metadata.diff, numstat, evidenceLabels: { default: "unresolved", fields: {} } }
    : { ...metadata.diff, numstat };

  const metadataFields = {};
  if (metadata.currentBranch === null) metadataFields.currentBranch = "unresolved";
  if (metadata.headCommit === null) metadataFields.headCommit = "unresolved";
  if (metadata.trackingBranch === null) metadataFields.trackingBranch = "unresolved";
  if (metadata.ahead === null) metadataFields.ahead = "unresolved";
  if (metadata.behind === null) metadataFields.behind = "unresolved";
  // [CORRECTION] clean/dirty are a direct read of `git status --porcelain` being empty, not
  // a guess — observed_fact, matching the default, unless the status command itself failed.
  if (metadata.clean === null) metadataFields.clean = "unresolved";
  if (metadata.dirty === null) metadataFields.dirty = "unresolved";

  return {
    ...metadata,
    repository,
    defaultRemote,
    worktrees,
    diff,
    evidenceLabels: { default: "observed_fact", fields: sortedFields(metadataFields) },
  };
}

function initialMetadata() {
  return {
    repository: {
      isGitRepository: null,
      isRepositoryRoot: null,
    },
    currentBranch: null,
    headCommit: null,
    defaultRemote: {
      name: null,
      url: null,
    },
    trackingBranch: null,
    ahead: null,
    behind: null,
    clean: null,
    dirty: null,
    stagedChanges: [],
    unstagedChanges: [],
    untrackedFiles: [],
    localBranches: [],
    worktrees: [],
    diff: {
      baseRef: null,
      changedFiles: [],
      numstat: [],
    },
  };
}

export function collectGitInventory(
  {
    root = process.cwd(),
    baseRef,
    includeDiff = true,
    gitCommand = "git",
    recentCommitLimit: requestedRecentCommitLimit = DEFAULT_RECENT_COMMIT_LIMIT,
    runner = runCommand,
  } = {},
) {
  const repositoryRoot = resolve(root);
  const metadata = initialMetadata();
  const warnings = [];
  let partial = false;

  function warn(message) {
    partial = true;
    warnings.push(message);
  }

  const insideWorkTree = executeGit(
    runner,
    gitCommand,
    ["rev-parse", "--is-inside-work-tree"],
    repositoryRoot,
  );

  if (!insideWorkTree?.ok || insideWorkTree.stdout.trim() !== "true") {
    const unavailable = insideWorkTree?.error?.code === "ENOENT";
    metadata.repository.isGitRepository = unavailable ? null : false;
    metadata.repository.isRepositoryRoot = unavailable ? null : false;
    metadata.evidenceLabels = { default: "unresolved", fields: {} };

    return {
      status: "unavailable",
      records: [],
      warnings: [
        unavailable
          ? "Git is unavailable; Git inventory could not be collected."
          : "The requested directory is not a Git worktree.",
      ],
      metadata,
    };
  }

  metadata.repository.isGitRepository = true;

  const topLevel = executeGit(
    runner,
    gitCommand,
    ["rev-parse", "--show-toplevel"],
    repositoryRoot,
  );
  const topLevelPath = topLevel?.ok ? topLevel.stdout.trim() : "";

  if (topLevelPath) {
    metadata.repository.isRepositoryRoot =
      comparablePath(repositoryRoot) === comparablePath(topLevelPath);
  } else {
    warn("Repository-root status could not be determined.");
  }

  const currentBranch = executeGit(
    runner,
    gitCommand,
    ["branch", "--show-current"],
    repositoryRoot,
  );
  if (currentBranch?.ok) {
    metadata.currentBranch = safeGitValue(currentBranch.stdout);
  } else {
    warn("Current branch could not be determined.");
  }

  const head = executeGit(runner, gitCommand, ["rev-parse", "HEAD"], repositoryRoot);
  if (head?.ok) {
    metadata.headCommit = safeGitValue(head.stdout);
  } else {
    warn("HEAD commit is unavailable.");
  }

  const remotes = executeGit(runner, gitCommand, ["remote"], repositoryRoot);
  const remoteNames = remotes?.ok
    ? remotes.stdout.split(/\r?\n/).filter(Boolean).sort(compareText)
    : [];
  if (!remotes?.ok) warn("Configured remotes could not be listed.");

  const pushDefault = executeGit(
    runner,
    gitCommand,
    ["config", "--get", "remote.pushDefault"],
    repositoryRoot,
  );
  const branchRemote = metadata.currentBranch
    ? executeGit(
        runner,
        gitCommand,
        ["config", "--get", `branch.${metadata.currentBranch}.remote`],
        repositoryRoot,
      )
    : null;
  const selectedRemote = [
    pushDefault?.ok ? pushDefault.stdout.trim() : "",
    branchRemote?.ok ? branchRemote.stdout.trim() : "",
    remoteNames.includes("origin") ? "origin" : "",
    remoteNames[0] ?? "",
  ].find(Boolean);

  if (selectedRemote) {
    metadata.defaultRemote.name = safeGitValue(selectedRemote);
    const remoteUrl = executeGit(
      runner,
      gitCommand,
      ["remote", "get-url", selectedRemote],
      repositoryRoot,
    );

    if (remoteUrl?.ok) {
      metadata.defaultRemote.url = sanitizeRemoteUrl(remoteUrl.stdout);
    } else {
      warn("The configured default remote URL is unavailable.");
    }
  }

  const trackingBranch = executeGit(
    runner,
    gitCommand,
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
    repositoryRoot,
  );
  const rawTrackingBranch = trackingBranch?.ok ? trackingBranch.stdout.trim() : "";

  if (rawTrackingBranch) {
    metadata.trackingBranch = safeGitValue(rawTrackingBranch);
    const aheadBehind = executeGit(
      runner,
      gitCommand,
      [
        "rev-list",
        "--left-right",
        "--count",
        "--end-of-options",
        `HEAD...${rawTrackingBranch}`,
      ],
      repositoryRoot,
    );
    const counts = aheadBehind?.stdout.trim().match(/^(\d+)\s+(\d+)$/);

    if (aheadBehind?.ok && counts) {
      metadata.ahead = Number(counts[1]);
      metadata.behind = Number(counts[2]);
    } else {
      warn("Ahead/behind counts are unavailable.");
    }
  }

  const staged = executeGit(
    runner,
    gitCommand,
    ["diff", "--cached", "--name-status", "-z", "--find-renames"],
    repositoryRoot,
  );
  const unstaged = executeGit(
    runner,
    gitCommand,
    ["diff", "--name-status", "-z", "--find-renames"],
    repositoryRoot,
  );
  const untracked = executeGit(
    runner,
    gitCommand,
    ["ls-files", "--others", "--exclude-standard", "-z"],
    repositoryRoot,
  );
  const worktreeStatus = executeGit(
    runner,
    gitCommand,
    ["status", "--porcelain=v1", "-z"],
    repositoryRoot,
  );

  const stagedChanges = staged?.ok
    ? parseNameStatus(staged.stdout)
    : { records: [], malformed: 0 };
  const unstagedChanges = unstaged?.ok
    ? parseNameStatus(unstaged.stdout)
    : { records: [], malformed: 0 };
  const rawUntracked = untracked?.ok ? parseNullDelimitedPaths(untracked.stdout) : [];

  if (!staged?.ok) warn("Staged changes could not be collected.");
  if (!unstaged?.ok) warn("Unstaged changes could not be collected.");
  if (!untracked?.ok) warn("Untracked files could not be collected.");
  if (!worktreeStatus?.ok) warn("Working tree status could not be collected.");
  if (stagedChanges.malformed) {
    warn("Staged changes included malformed name-status records.");
  }
  if (unstagedChanges.malformed) {
    warn("Unstaged changes included malformed name-status records.");
  }

  metadata.stagedChanges = stagedChanges.records;
  metadata.unstagedChanges = unstagedChanges.records;
  metadata.untrackedFiles = rawUntracked;

  if (worktreeStatus?.ok) {
    metadata.clean = worktreeStatus.stdout.length === 0;
    metadata.dirty = !metadata.clean;
  }

  const branches = executeGit(
    runner,
    gitCommand,
    ["for-each-ref", "--format=%(refname:short)%09%(HEAD)", "refs/heads"],
    repositoryRoot,
  );
  if (branches?.ok) {
    metadata.localBranches = parseBranches(branches.stdout);
  } else {
    warn("Local branches could not be collected.");
  }

  const worktrees = executeGit(
    runner,
    gitCommand,
    ["worktree", "list", "--porcelain"],
    repositoryRoot,
  );
  if (worktrees?.ok) {
    metadata.worktrees = parseWorktrees(
      worktrees.stdout,
      topLevelPath || repositoryRoot,
    );
  } else {
    warn("Worktrees could not be collected.");
  }

  const commits = executeGit(
    runner,
    gitCommand,
    [
      "log",
      `--format=%H%x09%s`,
      "-n",
      String(recentCommitLimit(requestedRecentCommitLimit)),
    ],
    repositoryRoot,
  );
  const records = (commits?.ok ? parseRecentCommits(commits.stdout) : []).map((record) => ({
    ...record,
    evidenceLabels: commitRecordEvidenceLabels(),
  }));
  if (!commits?.ok) warn("Recent commits could not be collected.");

  // When the caller is not going to keep the diff summary, do not resolve a base ref or
  // shell out to `git diff` at all. Previously the work ran unconditionally and the
  // caller deleted the result afterwards, which meant a default export could spend four
  // extra Git invocations on output it discarded and could be downgraded to `partial`
  // by a base-ref warning about a diff nobody asked for.
  if (!includeDiff) {
    return {
      status: partial ? "partial" : "complete",
      records,
      warnings,
      metadata: attachGitEvidenceLabels(metadata),
    };
  }

  const explicitBaseRef = typeof baseRef === "string" && baseRef.trim() ? baseRef.trim() : null;
  const baseRejected = explicitBaseRef ? explicitBaseRef.startsWith("-") : false;

  // C4 precedence: explicit --base -> merge-base(HEAD, main) -> @{upstream} -> HEAD.
  // The old default (tracking-branch-or-HEAD) was RI-GIT-BASE: a branch's own upstream
  // is by definition already caught up with itself, so the diff against it is always
  // empty even when the branch has real, unmerged changes against trunk. merge-base
  // against a local `main` is attempted first so the default diff reflects divergence
  // from trunk, not from the branch's own remote-tracking ref.
  let rawBaseRef = explicitBaseRef;
  let baseResolvedToHead = false;

  if (!baseRejected && !rawBaseRef) {
    const mergeBase = executeGit(
      runner,
      gitCommand,
      ["merge-base", "--end-of-options", "HEAD", "main"],
      repositoryRoot,
    );
    const mergeBaseSha = mergeBase?.ok ? mergeBase.stdout.trim() : "";

    if (mergeBaseSha) {
      rawBaseRef = mergeBaseSha;
    } else if (rawTrackingBranch) {
      rawBaseRef = rawTrackingBranch;
    } else {
      rawBaseRef = "HEAD";
      baseResolvedToHead = true;
    }
  }

  if (!baseRejected && rawBaseRef === "HEAD") baseResolvedToHead = true;

  metadata.diff.baseRef = baseRejected ? null : safeGitValue(rawBaseRef);

  if (baseRejected) {
    warn("The configured diff base was rejected.");
  } else {
    if (baseResolvedToHead) {
      warn(
        "The diff base resolved to HEAD (no local main and no upstream branch); an empty diff summary is expected, not a failure.",
      );
    }
    const baseExists = executeGit(
      runner,
      gitCommand,
      ["rev-parse", "--verify", "--end-of-options", `${rawBaseRef}^{commit}`],
      repositoryRoot,
    );

    if (!baseExists?.ok) {
      warn("The configured diff base is unavailable; no diff summary was collected.");
    } else {
      const diffRange = `${rawBaseRef}...HEAD`;
      const changedFiles = executeGit(
        runner,
        gitCommand,
        [
          "diff",
          "--name-status",
          "-z",
          "--find-renames",
          "--end-of-options",
          diffRange,
        ],
        repositoryRoot,
      );
      const numstat = executeGit(
        runner,
        gitCommand,
        [
          "diff",
          "--numstat",
          "-z",
          "--find-renames",
          "--end-of-options",
          diffRange,
        ],
        repositoryRoot,
      );

      if (changedFiles?.ok) {
        const diffChanges = parseNameStatus(changedFiles.stdout);
        metadata.diff.changedFiles = diffChanges.records;
        if (diffChanges.malformed) {
          warn("Changed-file diff summary included malformed name-status records.");
        }
      } else {
        warn("Changed-file diff summary could not be collected.");
      }

      if (numstat?.ok) {
        const diffNumstat = parseNumstat(numstat.stdout);
        metadata.diff.numstat = diffNumstat.records;
        if (diffNumstat.malformed) {
          warn("Numstat diff summary included malformed records.");
        }
      } else {
        warn("Numstat diff summary could not be collected.");
      }
    }
  }

  return {
    status: partial ? "partial" : "complete",
    records,
    warnings,
    metadata: attachGitEvidenceLabels(metadata, { baseResolvedToHead }),
  };
}
