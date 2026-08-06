import { lstatSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { collectRepositoryFiles } from "./lib/collect-files.mjs";
import { collectGitInventory } from "./lib/collect-git.mjs";
import { collectConfiguration } from "./lib/collect-config.mjs";
import { collectDelivery } from "./lib/collect-delivery.mjs";
import { collectPlanning } from "./lib/collect-planning.mjs";
import { collectProduct } from "./lib/collect-product.mjs";
import {
  assertSanitizedMetadata,
  sanitizeMetadataText,
} from "./lib/sanitize.mjs";

const DEFAULT_OUTPUT = "tmp/repository-intelligence";
const BUNDLE_FILENAME = "evidence-bundle.json";
const SUMMARY_FILENAME = "summary.md";

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function repositoryContained(root, target) {
  const rootPath = resolve(root);
  const targetPath = resolve(target);
  const relativePath = relative(rootPath, targetPath);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function repositoryRootPath(root) {
  if (!root) throw new Error("A repository root is required to write artifacts.");
  try {
    const rootPath = realpathSync(root);
    if (!lstatSync(rootPath).isDirectory()) throw new Error("not a directory");
    return rootPath;
  } catch {
    throw new Error("Repository root must exist and be resolvable.");
  }
}

function assertSafeTarget(root, target) {
  const rootPath = repositoryRootPath(root);
  const targetPath = resolve(target);
  if (!repositoryContained(rootPath, targetPath)) {
    throw new Error("Output path must be inside the repository root.");
  }

  let current = targetPath;
  while (true) {
    try {
      if (lstatSync(current).isSymbolicLink()) {
        throw new Error("Output path contains a symlink; refusing an uncertain containment boundary.");
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    if (current === rootPath) break;
    const parent = resolve(current, "..");
    if (parent === current || !repositoryContained(rootPath, parent)) {
      throw new Error("Output path must be inside the repository root.");
    }
    current = parent;
  }
  return { rootPath, targetPath };
}

function dedicatedOutputDirectory(rootPath) {
  return resolve(rootPath, DEFAULT_OUTPUT);
}

function assertDedicatedOutputDirectory(root, target) {
  const { rootPath, targetPath } = assertSafeTarget(root, target);
  if (targetPath !== dedicatedOutputDirectory(rootPath)) {
    throw new Error(`Output directory must be the dedicated exporter artifact directory: ${dedicatedOutputDirectory(rootPath)}`);
  }
  return { rootPath, targetPath };
}

export function resolveOutputDirectory(root, requestedOutput = DEFAULT_OUTPUT) {
  const output = requestedOutput || DEFAULT_OUTPUT;
  const rootPath = repositoryRootPath(root);
  const outputDirectory = resolve(rootPath, output);
  return assertDedicatedOutputDirectory(rootPath, outputDirectory).targetPath;
}

function recursivelySanitize(value) {
  if (typeof value === "string") return sanitizeMetadataText(value);
  if (Array.isArray(value)) return value.map(recursivelySanitize);
  if (value && typeof value === "object") {
    // Keys are sanitized as well as values, and sorted *after* sanitization so the
    // ordering is over the key actually emitted rather than its pre-redaction form.
    // No collector keys an object by collected data today (every collection is an
    // array of fixed-key records), so this changes nothing about current output; it
    // closes the bypass for a future collector that keys a map by a filename, an
    // environment-variable name, or any other value that came off disk.
    return Object.fromEntries(
      Object.entries(value)
        .map(([key, item]) => [sanitizeMetadataText(key), recursivelySanitize(item)])
        .sort(([left], [right]) => compareText(left, right)),
    );
  }
  return value;
}

export function sanitizeEvidence(value) {
  return recursivelySanitize(value);
}

function validateArtifact(value) {
  if (typeof value === "string") {
    assertSanitizedMetadata(value);
    return value;
  }
  if (Array.isArray(value)) {
    value.forEach(validateArtifact);
    return value;
  }
  if (value && typeof value === "object") {
    // Validate keys as well as values: the write gate must not have a blind spot that
    // the redactor covers. Mirrors the key handling in `recursivelySanitize`.
    Object.entries(value).forEach(([key, item]) => {
      assertSanitizedMetadata(key);
      validateArtifact(item);
    });
  }
  return value;
}

function withoutDiff(inventory) {
  const metadata = { ...inventory.metadata };
  delete metadata.diff;
  return { ...inventory, metadata };
}

export function composeEvidence({ root = process.cwd(), includeDiff = false, baseRef } = {}) {
  const repositoryRoot = resolve(root);
  const collectors = {
    files: collectRepositoryFiles({ root: repositoryRoot }),
    git: collectGitInventory({ root: repositoryRoot, baseRef, includeDiff }),
    configuration: collectConfiguration({ root: repositoryRoot }),
    delivery: collectDelivery({ root: repositoryRoot }),
    planning: collectPlanning({ root: repositoryRoot }),
    product: collectProduct({ root: repositoryRoot }),
  };

  if (!includeDiff) collectors.git = withoutDiff(collectors.git);

  return {
    schemaVersion: 1,
    collectors,
    policy: {
      rawDiffsIncluded: false,
      diffSummaryIncluded: includeDiff,
      externalGoogleDriveAccessed: false,
    },
  };
}

export function renderSummary(bundle) {
  const collectors = bundle.collectors;
  const lines = [
    "# Repository intelligence summary",
    "",
    "Deterministic metadata-only evidence export. Source contents, credentials, and raw diffs are not included.",
    "",
    "## Collector status",
    "",
    "| Collector | Status | Records | Warnings |",
    "| --- | --- | ---: | ---: |",
  ];

  for (const name of Object.keys(collectors).sort(compareText)) {
    const result = collectors[name];
    lines.push(`| ${name} | ${result.status} | ${result.records.length} | ${result.warnings.length} |`);
  }

  // The status table above reports warning *counts*; without the warnings themselves a
  // reader has to open evidence-bundle.json to find out what "partial" actually meant.
  const warnings = Object.keys(collectors)
    .sort(compareText)
    .flatMap((name) =>
      collectors[name].warnings.map((warning) => `- \`${name}\`: ${warning}`),
    );

  lines.push("", "## Warnings", "");
  lines.push(...(warnings.length ? warnings : ["None."]));

  const planningContext = collectors.planning.metadata.externalContext;
  lines.push(
    "",
    "## External context",
    "",
    `Google Drive context: ${planningContext.status}; accessed: ${planningContext.accessed}.`,
    "",
    "## Policy",
    "",
    `Diff summary included: ${bundle.policy.diffSummaryIncluded}.`,
    "Raw diffs included: false.",
  );
  return lines.join("\n") + "\n";
}

function ensureWritableTarget(root, outputDirectory, overwrite) {
  assertDedicatedOutputDirectory(root, outputDirectory);
  let targetStat;
  try {
    targetStat = lstatSync(outputDirectory);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (!overwrite) {
    throw new Error(`Output directory already exists; pass --overwrite to replace it: ${outputDirectory}`);
  }
  if (!targetStat.isDirectory() || targetStat.isSymbolicLink()) {
    throw new Error("Existing output target must be a directory for overwrite.");
  }
  rmSync(outputDirectory, { recursive: true, force: true });
}

export function writeArtifacts({
  root,
  outputDirectory,
  bundle,
  overwrite = false,
  sanitizer = sanitizeEvidence,
} = {}) {
  if (!outputDirectory) throw new Error("An output directory is required.");
  assertDedicatedOutputDirectory(root, outputDirectory);
  const artifacts = [
    { path: resolve(outputDirectory, BUNDLE_FILENAME), value: sanitizer(bundle) },
    { path: resolve(outputDirectory, SUMMARY_FILENAME), value: sanitizer(renderSummary(bundle)) },
  ];
  artifacts.forEach((artifact) => {
    assertSafeTarget(root, artifact.path);
    validateArtifact(artifact.value);
  });

  ensureWritableTarget(root, outputDirectory, overwrite);
  mkdirSync(outputDirectory, { recursive: true });
  assertSafeTarget(root, outputDirectory);

  for (const artifact of artifacts) {
    assertSafeTarget(root, artifact.path);
    validateArtifact(artifact.value);
    const serialized = typeof artifact.value === "string"
      ? artifact.value
      : JSON.stringify(artifact.value, null, 2) + "\n";
    writeFileSync(artifact.path, serialized, "utf8");
  }
  return artifacts.map((artifact) => artifact.path);
}

export function parseArguments(argv) {
  const options = {
    root: process.cwd(),
    output: DEFAULT_OUTPUT,
    overwrite: false,
    includeDiff: false,
    baseRef: undefined,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") options.help = true;
    else if (argument === "--overwrite") options.overwrite = true;
    else if (argument === "--include-diff") options.includeDiff = true;
    else if (argument === "--base") {
      const value = argv[++index];
      if (!value) throw new Error(`${argument} requires a value.`);
      options.baseRef = value;
    } else if (argument === "--root" || argument === "--output") {
      const value = argv[++index];
      if (!value) throw new Error(`${argument} requires a value.`);
      options[argument.slice(2)] = value;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return options;
}

export const HELP = `Usage: node export.mjs [options]

Options:
  --root <path>       Repository root (default: current directory)
  --output <path>     Must resolve to the dedicated exporter artifact directory,
                       ${DEFAULT_OUTPUT} under --root (default: ${DEFAULT_OUTPUT}).
                       Any other value is rejected; this flag exists to make that
                       directory explicit on the command line, not to relocate output.
  --overwrite         Explicitly replace existing evidence artifacts
  --include-diff      Include sanitized Git diff summary metadata (never raw patches)
  --base <ref>        Explicit diff base (default precedence: merge-base(HEAD, main)
                       -> the branch's own upstream -> HEAD, with a warning rather than
                       a failure when it resolves to HEAD)
  --help              Show this help
`;

export function run(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (options.help) {
    console.log(HELP);
    return [];
  }
  const root = repositoryRootPath(options.root);
  const outputDirectory = resolveOutputDirectory(root, options.output);
  const bundle = composeEvidence({ root, includeDiff: options.includeDiff, baseRef: options.baseRef });
  const paths = writeArtifacts({ root, outputDirectory, bundle, overwrite: options.overwrite });
  console.log(`Wrote ${paths.length} repository intelligence artifacts to ${options.output}.`);
  return paths;
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  try {
    run();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
