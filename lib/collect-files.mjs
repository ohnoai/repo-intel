import {
  lstatSync,
  readdirSync,
  statSync,
} from "node:fs";
import { extname, join, resolve } from "node:path";

import { normalizeRepositoryPath, sanitizeText } from "./sanitize.mjs";
import { runCommand } from "./run-command.mjs";

const ANY_DEPTH_EXCLUDED_DIRECTORY_NAMES = new Set([".git", "node_modules"]);
const ROOT_EXCLUDED_DIRECTORY_NAMES = new Set([
  "dist",
  "build",
  "coverage",
  ".vercel",
  ".review-staging",
  ".project-intelligence",
  ".vscode",
  "tmp",
  ".claude",
]);
const FALLBACK_HIDDEN_ALLOWLIST = new Set([
  ".github",
  ".gitattributes",
  ".gitignore",
  ".editorconfig",
  ".nvmrc",
  ".prettierignore",
  ".prettierrc",
  ".prettierrc.json",
  ".eslintrc",
  ".eslintrc.cjs",
  ".eslintrc.js",
]);

const BINARY_ASSET_EXTENSIONS = new Set([
  ".avif",
  ".bmp",
  ".cur",
  ".gif",
  ".heic",
  ".ico",
  ".jpeg",
  ".jpg",
  ".mp3",
  ".mp4",
  ".ogg",
  ".otf",
  ".pdf",
  ".png",
  ".ttf",
  ".wav",
  ".webm",
  ".webp",
  ".woff",
  ".woff2",
]);

const BINARY_EXTENSIONS = new Set([
  ".7z",
  ".bin",
  ".class",
  ".dll",
  ".dylib",
  ".exe",
  ".gz",
  ".jar",
  ".so",
  ".tar",
  ".wasm",
  ".zip",
]);

const ASSET_EXTENSIONS = new Set([
  ...BINARY_ASSET_EXTENSIONS,
  ".svg",
]);

const DOCUMENTATION_EXTENSIONS = new Set([
  ".adoc",
  ".md",
  ".mdx",
  ".rst",
  ".txt",
]);

const SOURCE_EXTENSIONS = new Set([
  ".c",
  ".cc",
  ".cpp",
  ".css",
  ".go",
  ".h",
  ".html",
  ".java",
  ".js",
  ".jsx",
  ".mjs",
  ".php",
  ".py",
  ".rb",
  ".rs",
  ".scss",
  ".sh",
  ".sql",
  ".ts",
  ".tsx",
  ".vue",
]);

const TEXT_EXTENSIONS = new Set([
  ".csv",
  ".log",
  ".xml",
  ".yml",
  ".yaml",
]);

const CONFIGURATION_EXTENSIONS = new Set([
  ".ini",
  ".json",
  ".toml",
  ".yaml",
  ".yml",
]);

const CONFIGURATION_FILENAMES = new Set([
  "dockerfile",
  "package-lock.json",
  "package.json",
  "pnpm-lock.yaml",
  "tsconfig.json",
  "vite.config.ts",
  "yarn.lock",
]);

function compareText(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function isAbsoluteRepositoryPath(path) {
  return path.startsWith("/") || /^[A-Za-z]:\//.test(path);
}

function isSafeRelativePath(path) {
  return (
    Boolean(path) &&
    path !== "." &&
    !isAbsoluteRepositoryPath(path) &&
    path !== ".." &&
    !path.startsWith("../")
  );
}

function localRelativePath(input) {
  if (input === undefined || input === null) return null;

  const path = normalizeRepositoryPath(input);
  return isSafeRelativePath(path) ? path : null;
}

function safeRelativePath(input) {
  const localPath = localRelativePath(input);
  if (!localPath) return null;

  const path = normalizeRepositoryPath(sanitizeText(localPath).text);
  return isSafeRelativePath(path) ? path : null;
}

function repositoryPathInfo(input) {
  const localPath = localRelativePath(input);
  if (!localPath) return null;

  const path = safeRelativePath(localPath);

  return path ? { localPath, path } : null;
}

function extensionFor(path) {
  return extname(path.split("/").at(-1) ?? "").toLowerCase();
}

function filenameFor(path) {
  return path.split("/").at(-1)?.toLowerCase() ?? "";
}

function isEnvironmentFile(path) {
  const filename = filenameFor(path);
  return (
    filename === ".env" ||
    filename.startsWith(".env") ||
    extensionFor(path) === ".env"
  );
}

function isGeneratedFile(path) {
  return (
    /(?:^|\/)(?:generated|__generated__)(?:\/|$)/.test(path) ||
    /\.(?:generated|gen|min)\.[^/]+$/i.test(path) ||
    path.endsWith(".map")
  );
}

function isDocumentationFile(path, extension) {
  const filename = filenameFor(path);
  return (
    DOCUMENTATION_EXTENSIONS.has(extension) ||
    ["changelog", "license", "notice", "readme"].includes(filename)
  );
}

function isWorkflowFile(path) {
  return path.startsWith(".github/workflows/");
}

function isTestFile(path) {
  return (
    /(?:^|\/)(?:__tests__|test|tests)(?:\/|$)/.test(path) ||
    /\.(?:spec|test)\.[^/]+$/i.test(path)
  );
}

function isConfigurationFile(path, extension) {
  const filename = filenameFor(path);
  return (
    isEnvironmentFile(path) ||
    filename.startsWith(".") ||
    CONFIGURATION_FILENAMES.has(filename) ||
    CONFIGURATION_EXTENSIONS.has(extension)
  );
}

function classificationFor(path, extension, isBinary) {
  if (isGeneratedFile(path)) return "generated";
  if (isDocumentationFile(path, extension)) return "documentation";
  if (isWorkflowFile(path)) return "workflow";
  if (isTestFile(path)) return "test";
  if (isConfigurationFile(path, extension)) return "configuration";
  if (ASSET_EXTENSIONS.has(extension)) return "asset";
  if (BINARY_EXTENSIONS.has(extension) || isBinary) return "binary";
  if (SOURCE_EXTENSIONS.has(extension)) return "source";
  if (TEXT_EXTENSIONS.has(extension)) return "text";
  return "unknown";
}

function inspectionForFile(path, extension) {
  if (isEnvironmentFile(path)) {
    return {
      isBinary: null,
      contentInspectionSkipped: true,
      skipReason: "environment-file",
    };
  }

  if (BINARY_ASSET_EXTENSIONS.has(extension) || BINARY_EXTENSIONS.has(extension)) {
    return {
      isBinary: true,
      contentInspectionSkipped: true,
      skipReason: "binary-asset",
    };
  }

  if (
    isGeneratedFile(path) ||
    isDocumentationFile(path, extension) ||
    isWorkflowFile(path) ||
    isTestFile(path) ||
    isConfigurationFile(path, extension) ||
    ASSET_EXTENSIONS.has(extension) ||
    SOURCE_EXTENSIONS.has(extension) ||
    TEXT_EXTENSIONS.has(extension)
  ) {
    return {
      isBinary: false,
      contentInspectionSkipped: true,
      skipReason: "classified-by-path",
    };
  }

  return {
    isBinary: null,
    contentInspectionSkipped: true,
    skipReason: "unknown-file-type",
  };
}

function sortedFields(fields) {
  const sorted = {};
  for (const key of Object.keys(fields).sort(compareText)) {
    sorted[key] = fields[key];
  }
  return sorted;
}

function fileRecordEvidenceLabels({ classification, isBinary, skipReason, tracked }) {
  const fields = {};

  fields.classification = classification === "unknown" ? "unresolved" : "mechanical_inference";
  fields.isBinary = isBinary === null ? "unresolved" : "mechanical_inference";

  if (skipReason !== "symbolic-link") {
    fields.skipReason = "mechanical_inference";
  }

  if (tracked === null) {
    fields.tracked = "unresolved";
  }

  return { default: "observed_fact", fields: sortedFields(fields) };
}

function filesMetadataEvidenceLabels({ discovery, tracking }) {
  const fields = {};

  if (discovery === "unavailable") fields.discovery = "unresolved";
  if (tracking === "unavailable") fields.tracking = "unresolved";

  return { default: "observed_fact", fields: sortedFields(fields) };
}

function parseNullDelimitedPaths(raw) {
  return raw
    .split("\0")
    .filter(Boolean)
    .map(repositoryPathInfo)
    .filter((file) => file && !isExcludedRepositoryPath(file.localPath));
}

function discoverGitFiles(root, runner, gitCommand) {
  const options = { cwd: root };
  let trackedResult;
  let untrackedResult;

  try {
    trackedResult = runner(gitCommand, ["ls-files", "-z"], options);
    untrackedResult = runner(
      gitCommand,
      ["ls-files", "--others", "--exclude-standard", "-z"],
      options,
    );
  } catch {
    return null;
  }

  if (!trackedResult?.ok || !untrackedResult?.ok) return null;

  const files = new Map();

  for (const file of parseNullDelimitedPaths(trackedResult.stdout)) {
    files.set(file.localPath, { ...file, tracked: true });
  }

  for (const file of parseNullDelimitedPaths(untrackedResult.stdout)) {
    if (!files.has(file.localPath)) {
      files.set(file.localPath, { ...file, tracked: false });
    }
  }

  return [...files.values()];
}

function isFallbackPrivatePath(path) {
  return normalizeRepositoryPath(path)
    .split("/")
    .some(
      (segment, index) =>
        segment.startsWith(".") &&
        !(index === 0 && FALLBACK_HIDDEN_ALLOWLIST.has(segment)),
    );
}

function discoverFilesystemFiles(root, warnings) {
  const files = [];

  function visit(relativeDirectory) {
    const directory = relativeDirectory ? join(root, relativeDirectory) : root;
    let entries;

    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      warnings.push("A directory could not be read during filesystem discovery.");
      return;
    }

    entries.sort((left, right) => compareText(left.name, right.name));

    for (const entry of entries) {
      const localPath = localRelativePath(
        relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name,
      );

      if (
        !localPath ||
        isExcludedRepositoryPath(localPath) ||
        isFallbackPrivatePath(localPath)
      ) {
        continue;
      }

      const file = repositoryPathInfo(localPath);
      if (!file) continue;

      if (entry.isDirectory()) {
        visit(file.localPath);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        files.push({ ...file, tracked: null });
      }
    }
  }

  visit("");
  return files;
}

function recordForFile(root, discoveredFile, warnings) {
  const filePath = resolve(root, ...discoveredFile.localPath.split("/"));
  let stat;

  try {
    stat = lstatSync(filePath);
  } catch {
    warnings.push("File metadata was unavailable for a discovered path.");
    return null;
  }

  if (stat.isSymbolicLink()) {
    const record = {
      path: discoveredFile.path,
      extension: extensionFor(discoveredFile.localPath),
      byteSize: stat.size,
      classification: "unknown",
      tracked: discoveredFile.tracked,
      isBinary: null,
      contentInspectionSkipped: true,
      skipReason: "symbolic-link",
    };

    return {
      ...record,
      evidenceLabels: fileRecordEvidenceLabels(record),
    };
  }

  if (!stat.isFile()) return null;

  const extension = extensionFor(discoveredFile.localPath);
  const inspection = inspectionForFile(discoveredFile.localPath, extension);

  const record = {
    path: discoveredFile.path,
    extension,
    byteSize: stat.size,
    classification: classificationFor(
      discoveredFile.localPath,
      extension,
      inspection.isBinary,
    ),
    tracked: discoveredFile.tracked,
    isBinary: inspection.isBinary,
    contentInspectionSkipped: inspection.contentInspectionSkipped,
    skipReason: inspection.skipReason,
  };

  return {
    ...record,
    evidenceLabels: fileRecordEvidenceLabels(record),
  };
}

export function isExcludedRepositoryPath(input) {
  const path = normalizeRepositoryPath(input);
  const segments = path.split("/");
  const filename = filenameFor(path);

  return (
    segments.some((segment) => ANY_DEPTH_EXCLUDED_DIRECTORY_NAMES.has(segment)) ||
    ROOT_EXCLUDED_DIRECTORY_NAMES.has(segments[0]) ||
    isEnvironmentFile(path) ||
    filename.endsWith(".tsbuildinfo")
  );
}

export function collectRepositoryFiles(
  { root = process.cwd(), gitCommand = "git", runner = runCommand } = {},
) {
  const repositoryRoot = resolve(root);
  const warnings = [];
  const rootIsDirectory = (() => {
    try {
      return statSync(repositoryRoot).isDirectory();
    } catch {
      return false;
    }
  })();

  if (!rootIsDirectory) {
    return {
      status: "unavailable",
      records: [],
      warnings: ["The requested repository directory is unavailable."],
      metadata: {
        discovery: "unavailable",
        tracking: "unavailable",
        recordCount: 0,
        evidenceLabels: { default: "unresolved", fields: {} },
      },
    };
  }

  const gitFiles = discoverGitFiles(repositoryRoot, runner, gitCommand);
  const discoveredFiles = gitFiles ?? discoverFilesystemFiles(repositoryRoot, warnings);

  if (!gitFiles) {
    warnings.unshift(
      "Git file discovery was unavailable; used filesystem discovery instead.",
    );
  }

  const records = discoveredFiles
    .map((file) => recordForFile(repositoryRoot, file, warnings))
    .filter(Boolean)
    .sort((left, right) => compareText(left.path, right.path));

  const metadata = {
    discovery: gitFiles ? "git" : "filesystem",
    tracking: gitFiles ? "available" : "unavailable",
    recordCount: records.length,
  };

  return {
    status: warnings.length ? "partial" : "complete",
    records,
    warnings,
    metadata: {
      ...metadata,
      evidenceLabels: filesMetadataEvidenceLabels(metadata),
    },
  };
}
