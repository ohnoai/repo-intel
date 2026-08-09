import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

import {
  normalizeAndSanitizeRepositoryPath,
  normalizeRepositoryPath,
  sanitizeMetadataText,
} from "./sanitize.mjs";

const MAX_DOCUMENT_BYTES = 512 * 1024;
const MAX_DOCUMENTS = 120;
const MAX_HEADINGS = 40;
const MAX_STATUS_LENGTH = 80;

const CONFIG_FILENAME = ".repo-intelligence.json";

// Generic defaults only. Anything repository-specific (SliceBoard's authority file,
// its handoff map) belongs in that repository's own .repo-intelligence.json, so this
// collector can be pointed at any repo with --root and produce clean output instead of
// warning about documents that were never supposed to exist there.
const DEFAULT_AUTHORITY_DOCUMENTS = new Map([
  ["AGENTS.md", "agent-guidance"],
  ["README.md", "repository-overview"],
  ["docs/code-map.md", "repository-reference"],
]);

// Both task conventions in use across these repositories: SliceBoard keeps tasks under
// docs/tasks/, the others use a bare tasks/ directory. Scanning both by default means
// neither layout is invisible.
const DEFAULT_PLANNING_DIRECTORIES = [
  "docs/decisions",
  "docs/tasks",
  "docs/roadmap",
  "docs/plans",
  "tasks",
  "plans",
];

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function safePath(input) {
  const normalized = normalizeRepositoryPath(input);
  if (
    !normalized ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:\//.test(normalized)
  ) return null;
  return normalizeAndSanitizeRepositoryPath(normalized);
}

function readRepositoryText(root, path, warnings) {
  const repositoryRoot = resolve(root);
  const filePath = resolve(repositoryRoot, ...path.split("/"));
  try {
    const realRoot = realpathSync(repositoryRoot);
    const realFile = realpathSync(filePath);
    const relativeFile = relative(realRoot, realFile);
    if (relativeFile.startsWith("..") || isAbsolute(relativeFile)) {
      warnings.push(`Planning document was outside the repository root: ${path}.`);
      return null;
    }
    let current = realRoot;
    for (const segment of relativeFile.split(/[\\/]/).filter(Boolean)) {
      current = join(current, segment);
      if (lstatSync(current).isSymbolicLink()) {
        warnings.push(`Planning document used a symbolic link: ${path}.`);
        return null;
      }
    }
    const stat = statSync(realFile);
    if (!stat.isFile()) return null;
    if (stat.size > MAX_DOCUMENT_BYTES) {
      warnings.push(`Planning document exceeded the metadata read limit: ${path}.`);
      return null;
    }
    return readFileSync(realFile, "utf8");
  } catch {
    warnings.push(`Planning document could not be read: ${path}.`);
    return null;
  }
}

function titleFrom(text, path) {
  const heading = text.match(/^#\s+(.+)$/m);
  const fromHeading = Boolean(heading?.[1]?.trim());
  const title = sanitizeMetadataText(heading?.[1]?.trim() || path.split("/").at(-1));
  return { title, fromHeading };
}

function sortedFields(fields) {
  const sorted = {};
  for (const key of Object.keys(fields).sort(compareText)) {
    sorted[key] = fields[key];
  }
  return sorted;
}

function headingsFrom(text) {
  return [...text.matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gm)]
    .slice(0, MAX_HEADINGS)
    .map((match) => sanitizeMetadataText(match[1].trim()))
    .filter(Boolean);
}

function frontMatterValue(text, key) {
  const match = text.match(new RegExp(`^${key}:\\s*(.+)$`, "im"));
  if (!match) return null;
  const value = match[1].trim().replace(/^['"]|['"]$/g, "");
  return sanitizeMetadataText(value).slice(0, MAX_STATUS_LENGTH) || null;
}

// Attaches the evidenceLabels block described in docs/decisions/2026-08-07-evidence-labels.md
// §6.5. kindDeclared distinguishes a path found in an actual parsed .repo-intelligence.json's
// own authorityDocuments object (documented_intent) from everything else, including the three
// hardcoded defaults and the path-based guesses (mechanical_inference) -- see §6.5's resolved
// ambiguity: the hardcoded defaults are the tool's own filename convention, not a human
// declaring a role for this repository.
function documentRecord(path, text, classification, kindDeclared) {
  const lower = path.toLowerCase();
  const kind = classification ||
    (lower.includes("/decisions/") ? "decision" :
      lower.includes("/tasks/") ? "task" : "roadmap");
  const { title, fromHeading } = titleFrom(text, path);
  const status = frontMatterValue(text, "status");
  const owner = frontMatterValue(text, "owner");

  const fields = {};
  fields.path = "observed_fact";
  fields.lineCount = "observed_fact";
  fields.byteSize = "observed_fact";
  if (!fromHeading) fields.title = "mechanical_inference";
  if (status === null) fields.status = "unresolved";
  if (owner === null) fields.owner = "unresolved";
  if (!kindDeclared) fields.kind = "mechanical_inference";

  return {
    path: safePath(path),
    kind,
    title,
    headings: headingsFrom(text),
    lineCount: text.split(/\r?\n/).length,
    byteSize: Buffer.byteLength(text, "utf8"),
    status,
    owner,
    evidenceLabels: { default: "documented_intent", fields: sortedFields(fields) },
  };
}

// Repository-declared overrides. Every value is forced back through safePath, so a
// config file cannot point the collector outside its own repository even if it tries.
function repositoryConfig(root, warnings) {
  const authorityDocuments = new Map(DEFAULT_AUTHORITY_DOCUMENTS);
  // Populated only from an actual parsed .repo-intelligence.json's own authorityDocuments
  // object -- never pre-seeded with the hardcoded defaults above. This is what lets
  // documentRecord() tell "a human declared this document's role" apart from "the tool's
  // own filename convention picked a default", per §6.5's resolved ambiguity.
  const declaredAuthorityDocuments = new Set();
  let planningDirectories = [...DEFAULT_PLANNING_DIRECTORIES];
  const requiredAuthorityDocuments = [];

  const configPath = join(root, CONFIG_FILENAME);
  if (!existsSync(configPath)) {
    return { authorityDocuments, declaredAuthorityDocuments, planningDirectories, requiredAuthorityDocuments };
  }

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    warnings.push(`Repository intelligence config could not be parsed: ${CONFIG_FILENAME}.`);
    return { authorityDocuments, declaredAuthorityDocuments, planningDirectories, requiredAuthorityDocuments };
  }

  if (parsed?.authorityDocuments && typeof parsed.authorityDocuments === "object") {
    for (const [rawPath, rawRole] of Object.entries(parsed.authorityDocuments)) {
      const path = safePath(rawPath);
      if (path && typeof rawRole === "string") {
        authorityDocuments.set(path, sanitizeMetadataText(rawRole).slice(0, MAX_STATUS_LENGTH));
        declaredAuthorityDocuments.add(path);
      }
    }
  }

  if (Array.isArray(parsed?.planningDirectories)) {
    const declared = parsed.planningDirectories.map(safePath).filter(Boolean);
    if (declared.length) planningDirectories = declared;
  }

  if (Array.isArray(parsed?.requiredAuthorityDocuments)) {
    for (const rawPath of parsed.requiredAuthorityDocuments) {
      const path = safePath(rawPath);
      if (path) requiredAuthorityDocuments.push(path);
    }
  }

  return { authorityDocuments, declaredAuthorityDocuments, planningDirectories, requiredAuthorityDocuments };
}

function discoveredPlanningPaths(root, config) {
  const paths = new Set(config.authorityDocuments.keys());
  const directories = config.planningDirectories;
  const roadmapFiles = ["ROADMAP.md", "docs/roadmap.md", "docs/ROADMAP.md"];
  for (const path of roadmapFiles) paths.add(path);

  function visit(directory) {
    const absoluteDirectory = join(root, ...directory.split("/"));
    let entries;
    try { entries = readdirSync(absoluteDirectory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries.sort((a, b) => compareText(a.name, b.name))) {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && /\.(?:md|mdx|rst|txt)$/i.test(entry.name)) paths.add(path);
    }
  }
  for (const directory of directories) visit(directory);
  return [...paths].filter((path) => existsSync(join(root, ...path.split("/")))).sort(compareText);
}

export function collectPlanning({ root = process.cwd() } = {}) {
  const repositoryRoot = resolve(root);
  const warnings = [];
  try { if (!statSync(repositoryRoot).isDirectory()) throw new Error("not a directory"); }
  catch {
    return {
      status: "unavailable",
      records: [],
      warnings: ["The requested repository directory is unavailable."],
      metadata: {
        documentCount: 0,
        authorityDocumentCount: 0,
        externalContext: { source: "google-drive-keeper-note", status: "unavailable", required: false, accessed: false },
        evidenceLabels: { default: "unresolved", fields: {} },
      },
    };
  }

  const config = repositoryConfig(repositoryRoot, warnings);
  const planningPaths = discoveredPlanningPaths(repositoryRoot, config);
  const records = [];
  for (const path of planningPaths.slice(0, MAX_DOCUMENTS)) {
    const text = readRepositoryText(repositoryRoot, path, warnings);
    if (text === null) continue;
    records.push(documentRecord(path, text, config.authorityDocuments.get(path), config.declaredAuthorityDocuments.has(path)));
  }
  // Only documents the repository itself declared as required can be reported missing.
  // With no config file nothing is required, so pointing --root at an unfamiliar repo
  // produces evidence rather than complaints about another project's conventions.
  for (const path of config.requiredAuthorityDocuments) {
    if (!planningPaths.includes(path)) warnings.push(`Expected repository authority document was absent: ${path}.`);
  }
  if (planningPaths.length > MAX_DOCUMENTS) warnings.push("Planning document collection was bounded.");

  const authorityRecords = records.filter((record) => config.authorityDocuments.has(record.path));
  return {
    status: warnings.length ? "partial" : "complete",
    records: records.sort((a, b) => compareText(a.path, b.path)),
    warnings: [...new Set(warnings)].sort(compareText),
    metadata: {
      documentCount: records.length,
      authorityDocumentCount: authorityRecords.length,
      authorityPaths: authorityRecords.map((record) => record.path).sort(compareText),
      externalContext: {
        source: "google-drive-keeper-note",
        status: "unavailable",
        required: false,
        accessed: false,
        representation: "unavailable external context",
        evidenceLabels: {
          default: "observed_fact",
          fields: sortedFields({ status: "unresolved", representation: "unresolved" }),
        },
      },
      evidenceLabels: {
        default: "documented_intent",
        fields: sortedFields({ documentCount: "observed_fact" }),
      },
    },
  };
}
