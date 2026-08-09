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
  sanitizeCommandMetadata,
  sanitizeMetadataText,
} from "./sanitize.mjs";

const MAX_DELIVERY_FILE_BYTES = 1024 * 1024;

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
    normalizedPath === ".." ||
    normalizedPath.startsWith("../") ||
    isAbsolutePath(normalizedPath)
  ) {
    return null;
  }

  const path = normalizeAndSanitizeRepositoryPath(normalizedPath);

  if (
    !path ||
    path === "." ||
    path === ".." ||
    path.startsWith("../") ||
    isAbsolutePath(path)
  ) {
    return null;
  }

  return path;
}

function readTextFile(root, localPath, warnings) {
  const filePath = resolve(root, ...localPath.split("/"));

  try {
    const repositoryRoot = realpathSync(root);
    const relativePath = relative(repositoryRoot, filePath);
    if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
      warnings.push("A recognized delivery path was outside the repository root.");
      return null;
    }
    let currentPath = repositoryRoot;
    for (const segment of relativePath.split(/[\\/]/).filter(Boolean)) {
      currentPath = join(currentPath, segment);
      if (lstatSync(currentPath).isSymbolicLink()) {
        warnings.push("A recognized delivery path used a symbolic link.");
        return null;
      }
    }
    const resolvedFilePath = realpathSync(filePath);
    const resolvedRelativePath = relative(repositoryRoot, resolvedFilePath);
    if (resolvedRelativePath.startsWith("..") || isAbsolute(resolvedRelativePath)) {
      warnings.push("A recognized delivery path was outside the repository root.");
      return null;
    }
    const stat = statSync(filePath);
    if (!stat.isFile()) {
      warnings.push("A recognized delivery path was not a file.");
      return null;
    }
    if (stat.size > MAX_DELIVERY_FILE_BYTES) {
      warnings.push("A delivery file exceeded the metadata read limit.");
      return null;
    }
    return readFileSync(resolvedFilePath, "utf8");
  } catch {
    warnings.push("A recognized delivery file could not be read.");
    return null;
  }
}

function parseJson(text, path, warnings) {
  try {
    return JSON.parse(text);
  } catch {
    warnings.push(`Malformed JSON delivery configuration: ${path}.`);
    return null;
  }
}

function extractNpmScripts(text) {
  const scripts = new Set();

  for (const match of text.matchAll(/\bnpm\s+run\s+([A-Za-z0-9:_-]+)/g)) {
    scripts.add(sanitizeMetadataText(match[1]));
  }

  return [...scripts].sort(compareText);
}

function yamlScalarList(value) {
  const trimmed = value.trim().replace(/\s+#.*$/, "");
  const list = trimmed.startsWith("[") && trimmed.endsWith("]")
    ? trimmed.slice(1, -1).split(",")
    : [trimmed];

  return list
    .map((item) => item.trim().replace(/^['"]|['"]$/g, ""))
    .filter(Boolean)
    .map(sanitizeMetadataText)
    .filter(Boolean)
    .sort(compareText);
}

function workflowTriggers(lines) {
  const onIndex = lines.findIndex((line) => /^on:\s*/.test(line));
  if (onIndex < 0) return [];

  const inlineValue = lines[onIndex].replace(/^on:\s*/, "").trim();
  if (inlineValue) return yamlScalarList(inlineValue);

  const triggers = new Set();
  for (let index = onIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line && !/^\s/.test(line)) break;
    const match = line.match(/^ {2}([A-Za-z_][A-Za-z0-9_-]*):/);
    if (match) triggers.add(sanitizeMetadataText(match[1]));
  }

  return [...triggers].sort(compareText);
}

// C5: GitHub-provided builtins that show up constantly in bare `$NAME`/`${NAME}` shell
// references but are never one of this app's own secrets or configuration knobs.
const CI_BUILTIN_ENVIRONMENT_PREFIX_PATTERN = /^(?:GITHUB_|RUNNER_|ACTIONS_)/;
const CI_BUILTIN_ENVIRONMENT_NAMES = new Set(["CI", "HOME", "PATH"]);

function isCiBuiltinEnvironmentName(name) {
  return CI_BUILTIN_ENVIRONMENT_PREFIX_PATTERN.test(name) || CI_BUILTIN_ENVIRONMENT_NAMES.has(name);
}

function addTypedEntry(entries, name, provenance) {
  const sanitizedName = sanitizeMetadataText(name);
  if (!sanitizedName) return;
  const provenances = entries.get(sanitizedName) ?? new Set();
  provenances.add(provenance);
  entries.set(sanitizedName, provenances);
}

function typedRecordsFromEntries(entries) {
  return [...entries.entries()]
    .map(([name, provenances]) => ({ name, provenance: [...provenances].sort(compareText) }))
    .sort((left, right) => compareText(left.name, right.name));
}

// C5: merges typed {name, provenance} record lists, unioning provenance per name - so a
// name that legitimately appears via more than one source (e.g. declared in an `env:`
// block *and* referenced via bare `$NAME` in a run step) keeps every provenance it
// actually has, instead of one list silently winning.
function mergeTypedRecords(...recordLists) {
  const merged = new Map();
  for (const records of recordLists) {
    for (const record of records) {
      const provenances = merged.get(record.name) ?? new Set();
      for (const provenance of record.provenance) provenances.add(provenance);
      merged.set(record.name, provenances);
    }
  }
  return typedRecordsFromEntries(merged);
}

function workflowEnvironmentNames(text) {
  const environmentEntries = new Map();
  const secretEntries = new Map();

  for (const match of text.matchAll(/\bsecrets\.([A-Z][A-Z0-9_]*)\b/g)) {
    addTypedEntry(secretEntries, match[1], "secret-reference");
  }
  for (const match of text.matchAll(/\benv\.([A-Z][A-Z0-9_]*)\b/g)) {
    addTypedEntry(environmentEntries, match[1], "env-context");
  }
  for (const match of text.matchAll(/\$(?:\{)?([A-Z][A-Z0-9_]*)\b/g)) {
    if (isCiBuiltinEnvironmentName(match[1])) continue;
    addTypedEntry(environmentEntries, match[1], "shell");
  }

  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const environmentBlock = lines[index].match(/^([ ]*)env:\s*(?:#.*)?$/);
    if (!environmentBlock) continue;

    const environmentIndent = environmentBlock[1].length;
    let variableIndent = null;
    for (let childIndex = index + 1; childIndex < lines.length; childIndex += 1) {
      const child = lines[childIndex];
      if (!child.trim() || /^\s*#/.test(child)) continue;

      const indentation = child.match(/^ */)[0].length;
      if (indentation <= environmentIndent) break;

      const declaration = child.match(/^ *([A-Za-z_][A-Za-z0-9_]*)\s*:/);
      if (!declaration) continue;
      if (variableIndent === null) variableIndent = indentation;
      if (indentation === variableIndent) {
        addTypedEntry(environmentEntries, declaration[1], "env-declaration");
      }
    }
  }

  return {
    environmentVariables: typedRecordsFromEntries(environmentEntries),
    secretNames: typedRecordsFromEntries(secretEntries),
  };
}

function workflowJobs(lines) {
  const jobsIndex = lines.findIndex((line) => /^jobs:\s*$/.test(line));
  if (jobsIndex < 0) return [];

  const starts = [];
  for (let index = jobsIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line && !/^\s/.test(line)) break;
    const match = line.match(/^ {2}([A-Za-z0-9_-]+):\s*(?:#.*)?$/);
    if (match) starts.push({ index, id: sanitizeMetadataText(match[1]) });
  }

  return starts
    .map((start, index) => {
      const end = starts[index + 1]?.index ?? lines.length;
      const text = lines.slice(start.index, end).join("\n");
      const runners = new Set();

      for (const match of text.matchAll(/^\s*runs-on:\s*(.+?)\s*$/gm)) {
        for (const runner of yamlScalarList(match[1])) runners.add(runner);
      }

      const names = workflowEnvironmentNames(text);
      return {
        id: start.id,
        runners: [...runners].sort(compareText),
        npmScripts: extractNpmScripts(text),
        environmentVariables: names.environmentVariables,
        secretNames: names.secretNames,
      };
    })
    .sort((left, right) => compareText(left.id, right.id));
}

function workflowRecord(path, text, warnings) {
  const lines = text.split(/\r?\n/);
  const nameMatch = lines.find((line) => /^name:\s*/.test(line));
  const workflowName = nameMatch
    ? sanitizeMetadataText(nameMatch.replace(/^name:\s*/, "").trim())
    : null;
  const triggers = workflowTriggers(lines);
  const jobs = workflowJobs(lines);
  const malformed =
    !lines.some((line) => /^on:\s*/.test(line)) ||
    !lines.some((line) => /^jobs:\s*$/.test(line)) ||
    lines.some((line) => line.includes("\t"));

  if (malformed) warnings.push(`Malformed YAML-like workflow metadata: ${path}.`);

  const npmScripts = new Set();
  for (const job of jobs) {
    for (const script of job.npmScripts) npmScripts.add(script);
  }

  const workflowNames = workflowEnvironmentNames(text);
  const environmentVariables = mergeTypedRecords(
    ...jobs.map((job) => job.environmentVariables),
    workflowNames.environmentVariables,
  );
  const secretNames = mergeTypedRecords(
    ...jobs.map((job) => job.secretNames),
    workflowNames.secretNames,
  );

  return {
    path,
    type: "github-workflow",
    format: "yaml",
    name: workflowName,
    triggers,
    jobs,
    npmScripts: [...npmScripts].sort(compareText),
    environmentVariables,
    secretNames,
    malformed,
  };
}

function tomlOverview(text) {
  const sections = new Set();
  const environmentVariables = new Set();
  let malformed = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const section = line.match(/^\[([A-Za-z0-9_.-]+)\]$/);
    const arraySection = line.match(/^\[\[([A-Za-z0-9_.-]+)\]\]$/);
    if (section || arraySection) {
      sections.add(sanitizeMetadataText((section ?? arraySection)[1]));
      continue;
    }
    if (line.startsWith("[")) {
      malformed = true;
      continue;
    }
    if (/^[A-Za-z0-9_.-]+\s*=/.test(line)) {
      for (const match of line.matchAll(/\benv\(([A-Z][A-Z0-9_]*)\)/g)) {
        environmentVariables.add(sanitizeMetadataText(match[1]));
      }
      continue;
    }
    if (line.includes("=")) malformed = true;
  }

  return {
    sections: [...sections].sort(compareText),
    environmentVariables: [...environmentVariables].sort(compareText),
    malformed,
  };
}

function tomlDeliveryRecord(path, type, text, warnings) {
  const overview = tomlOverview(text);
  if (overview.malformed) warnings.push(`Malformed TOML-like delivery configuration: ${path}.`);

  return {
    path,
    type,
    format: "toml",
    settings: { sections: overview.sections },
    environmentVariables: overview.environmentVariables,
    malformed: overview.malformed,
  };
}

function vercelRecord(path, text, warnings) {
  const parsed = parseJson(text, path, warnings);
  if (!parsed) {
    return { path, type: "vercel", format: "json", malformed: true };
  }

  return {
    path,
    type: "vercel",
    format: "json",
    settings: {
      redirectCount: Array.isArray(parsed.redirects) ? parsed.redirects.length : 0,
      rewriteCount: Array.isArray(parsed.rewrites) ? parsed.rewrites.length : 0,
      headerCount: Array.isArray(parsed.headers) ? parsed.headers.length : 0,
    },
  };
}

function deliveryScripts(path, text, warnings) {
  const parsed = parseJson(text, path, warnings);
  if (!parsed) return { record: { path, type: "package", format: "json", malformed: true }, scripts: [] };

  const scripts = Object.entries(parsed.scripts ?? {})
    .filter(([, command]) => typeof command === "string")
    .map(([name, command]) => {
      const sanitizedName = sanitizeMetadataText(name);
      const kind = /(?:deploy|netlify|supabase|vercel)/i.test(sanitizedName)
        ? "deployment"
        : /(?:build|preview|start|verify|typecheck)/i.test(sanitizedName)
          ? "build"
          : "other";
      return {
        name: sanitizedName,
        command: sanitizeCommandMetadata(command),
        kind,
        evidenceLabels: deliveryScriptEvidenceLabels(),
      };
    })
    .filter((script) => script.kind !== "other")
    .sort((left, right) => compareText(left.name, right.name));

  return {
    record: {
      path,
      type: "package",
      format: "json",
      settings: {
        name: typeof parsed.name === "string" ? sanitizeMetadataText(parsed.name) : null,
        packageManager:
          typeof parsed.packageManager === "string"
            ? sanitizeMetadataText(parsed.packageManager)
            : null,
      },
      deliveryScripts: scripts,
    },
    scripts,
  };
}

function sortedFields(fields) {
  const sorted = {};
  for (const key of Object.keys(fields).sort(compareText)) {
    sorted[key] = fields[key];
  }
  return sorted;
}

// deliveryScripts[]/deploymentScripts[] elements: `name`/`command` are authored (R1),
// `kind` is regex-over-script-name output (R2). Per docs/decisions/2026-08-07-evidence-labels.md
// 6.4.
function deliveryScriptEvidenceLabels() {
  return {
    default: "documented_intent",
    fields: sortedFields({ kind: "mechanical_inference" }),
  };
}

// Attaches the evidenceLabels block described in docs/decisions/2026-08-07-evidence-labels.md
// 6.4 to a single delivery record. A malformed record short-circuits everything else -
// nothing was reliably extracted, so every field falls back to the `unresolved` default.
function deliveryRecordEvidenceLabels(record) {
  if (record.malformed === true) {
    return {
      default: "unresolved",
      fields: sortedFields({
        malformed: "observed_fact",
        path: "observed_fact",
        type: "mechanical_inference",
        format: "mechanical_inference",
      }),
    };
  }

  // package.json: settings are authored declarations (R1); no `malformed` key exists on
  // the success shape.
  if (record.type === "package") {
    return {
      default: "documented_intent",
      fields: sortedFields({
        path: "observed_fact",
        type: "mechanical_inference",
        format: "mechanical_inference",
      }),
    };
  }

  // vercel.json: a full JSON parse of declared config (R2), so `settings.*Count` faithfully
  // represents the file under R1.
  if (record.type === "vercel") {
    return {
      default: "documented_intent",
      fields: sortedFields({
        path: "observed_fact",
        type: "mechanical_inference",
        format: "mechanical_inference",
      }),
    };
  }

  // github-workflow, netlify.toml, supabase/config.toml: nothing here came from a real
  // YAML/TOML parser (R2) - the *default* is inference and observed fact is the exception,
  // per the inverted example in 7.4.
  return {
    default: "mechanical_inference",
    fields: sortedFields({
      path: "observed_fact",
      malformed: "observed_fact",
    }),
  };
}

function workflowPaths(root) {
  const directory = join(root, ".github", "workflows");
  let entries;

  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }

  return entries
    .filter((entry) => /\.(?:yaml|yml)$/.test(entry.name))
    .map((entry) => safeRepositoryPath(`.github/workflows/${entry.name}`))
    .filter(Boolean)
    .sort(compareText);
}

export function collectDelivery({ root = process.cwd() } = {}) {
  const repositoryRoot = resolve(root);
  const warnings = [];

  try {
    if (!statSync(repositoryRoot).isDirectory()) throw new Error("Not a directory.");
  } catch {
    return {
      status: "unavailable",
      records: [],
      warnings: ["The requested repository directory is unavailable."],
      metadata: {
        deploymentScripts: [],
        workflowCount: 0,
        evidenceLabels: { default: "unresolved", fields: {} },
      },
    };
  }

  const records = [];
  const deploymentScripts = [];

  for (const path of workflowPaths(repositoryRoot)) {
    const text = readTextFile(repositoryRoot, path, warnings);
    if (text !== null) records.push(workflowRecord(path, text, warnings));
  }

  const packagePath = "package.json";
  if (existsSync(join(repositoryRoot, packagePath))) {
    const text = readTextFile(repositoryRoot, packagePath, warnings);
    if (text !== null) {
      const packageDelivery = deliveryScripts(packagePath, text, warnings);
      records.push(packageDelivery.record);
      deploymentScripts.push(...packageDelivery.scripts);
    }
  }

  const optionalConfigs = [
    { path: "netlify.toml", type: "netlify" },
    { path: "vercel.json", type: "vercel" },
    { path: "supabase/config.toml", type: "supabase" },
  ];
  for (const config of optionalConfigs) {
    if (!existsSync(join(repositoryRoot, ...config.path.split("/")))) continue;

    const text = readTextFile(repositoryRoot, config.path, warnings);
    if (text === null) continue;
    records.push(
      config.type === "vercel"
        ? vercelRecord(config.path, text, warnings)
        : tomlDeliveryRecord(config.path, config.type, text, warnings),
    );
  }

  const workflows = records.filter((record) => record.type === "github-workflow");
  const workflowEnvironmentVariables = mergeTypedRecords(
    ...workflows.map((workflow) => workflow.environmentVariables),
  );
  const workflowSecretNames = mergeTypedRecords(
    ...workflows.map((workflow) => workflow.secretNames),
  );

  return {
    status: warnings.length ? "partial" : "complete",
    records: records
      .sort((left, right) => compareText(left.path, right.path))
      .map((record) => ({ ...record, evidenceLabels: deliveryRecordEvidenceLabels(record) })),
    warnings,
    metadata: {
      deploymentScripts: deploymentScripts
        .sort((left, right) => compareText(left.name, right.name)),
      workflowCount: workflows.length,
      workflowEnvironmentVariables,
      workflowSecretNames,
      evidenceLabels: {
        default: "mechanical_inference",
        fields: sortedFields({ workflowCount: "observed_fact" }),
      },
    },
  };
}
