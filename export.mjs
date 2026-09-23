import { lstatSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { collectRepositoryFiles } from "./lib/collect-files.mjs";
import { collectGitInventory } from "./lib/collect-git.mjs";
import { collectConfiguration } from "./lib/collect-config.mjs";
import { collectDelivery } from "./lib/collect-delivery.mjs";
import { collectPlanning } from "./lib/collect-planning.mjs";
import { collectProduct } from "./lib/collect-product.mjs";
import { classifyGitWorkTreeProbe } from "./lib/git-worktree-probe.mjs";
import { runCommand } from "./lib/run-command.mjs";
import {
  assertSanitizedMetadata,
  sanitizeMetadataText,
} from "./lib/sanitize.mjs";

const DEFAULT_OUTPUT = "tmp/repository-intelligence";
const BUNDLE_FILENAME = "evidence-bundle.json";
const SUMMARY_FILENAME = "summary.md";

// v2 was claimed by the evidence-labels rollout (docs/decisions/2026-08-07-evidence-labels.md
// section 10.5); this is the S6 bump (docs/decisions/2026-09-20-warnings-vs-observations.md's
// successor design record), not the first bump off v1.
export const SCHEMA_VERSION = 3;

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

/**
 * Flattens every collector's own `warnings` and `observations` into two bundle-wide
 * lists. Collectors are walked in `compareText` order of their names (the order the
 * summary already uses); within a collector, entries are appended in the order that
 * collector emitted them. Nothing is re-sorted, so the aggregate is exactly the
 * per-collector lists concatenated -- several collectors do not sort their own
 * `warnings` today, and a global re-sort here would change output that nothing asked
 * to change. See docs/decisions/2026-09-20-warnings-vs-observations.md section 5 step 6.
 */
export function buildAggregate(collectors) {
  const names = Object.keys(collectors).sort(compareText);
  const warnings = [];
  const observations = [];

  for (const name of names) {
    const collector = collectors[name];
    for (const message of collector.warnings) {
      warnings.push({ collector: name, message });
    }
    for (const observation of collector.observations) {
      observations.push({ collector: name, id: observation.id, message: observation.message });
    }
  }

  return { warnings, observations };
}

/**
 * Bundle-wide status, per section 2.3: `unavailable` only if every collector is
 * `unavailable`; otherwise `partial` if any collector is `partial` or `unavailable`;
 * otherwise `complete`. One `unavailable` collector among otherwise-healthy ones is
 * `partial`, not `unavailable` -- the bundle as a whole still collected something.
 */
export function bundleStatus(collectors) {
  const statuses = Object.values(collectors).map((collector) => collector.status);
  if (statuses.every((status) => status === "unavailable")) return "unavailable";
  if (statuses.some((status) => status === "partial" || status === "unavailable")) return "partial";
  return "complete";
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
    schemaVersion: SCHEMA_VERSION,
    status: bundleStatus(collectors),
    collectors,
    aggregate: buildAggregate(collectors),
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

  // Grouped by collector, unlike the flat Warnings list above: an observation carries
  // its own id, and grouping under a "### <collector>" heading keeps that id's owner
  // unambiguous without repeating the collector name on every line. The bullet form
  // ("- `<id>`: <message>") differs from the warnings form ("- `<collector>`: <message>")
  // on purpose, so a test can tell a warning line from an observation line by shape alone.
  const observationGroups = Object.keys(collectors)
    .sort(compareText)
    .map((name) => ({ name, observations: collectors[name].observations }))
    .filter((group) => group.observations.length > 0);

  lines.push("", "## Observations", "");
  if (observationGroups.length) {
    observationGroups.forEach((group, index) => {
      if (index > 0) lines.push("");
      lines.push(`### ${group.name} (${group.observations.length})`, "");
      lines.push(...group.observations.map((observation) => `- \`${observation.id}\`: ${observation.message}`));
    });
  } else {
    lines.push("None.");
  }

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
    allowUnignored: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") options.help = true;
    else if (argument === "--overwrite") options.overwrite = true;
    else if (argument === "--include-diff") options.includeDiff = true;
    else if (argument === "--allow-unignored") options.allowUnignored = true;
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

export const HELP = `Usage: repo-intel [options]

Options:
  --root <path>       Repository root (default: current directory)
  --output <path>     Must resolve to the dedicated exporter artifact directory,
                       ${DEFAULT_OUTPUT} under --root (default: ${DEFAULT_OUTPUT}).
                       Any other value is rejected; this flag exists to make that
                       directory explicit on the command line, not to relocate output.
  --overwrite         Explicitly replace existing evidence artifacts
  --include-diff      Include sanitized Git diff summary metadata (never raw patches)
  --allow-unignored   Write even if the output directory is not git-ignored in the target
                       repository (default: refuse, so the bundle can't be committed by accident)
  --base <ref>        Explicit diff base (default precedence: merge-base(HEAD, main)
                       -> the branch's own upstream -> HEAD, noted as an observation
                       rather than a failure when it resolves to HEAD)
  --help              Show this help
`;

function assertOutputGitIgnored(root, outputDirectory) {
  const rootPath = repositoryRootPath(root);
  const workTree = classifyGitWorkTreeProbe(
    runCommand("git", ["rev-parse", "--is-inside-work-tree"], { cwd: rootPath }),
    rootPath,
  );
  // Genuinely not a Git working tree (or Git isn't installed): nothing here can be
  // committed by accident. A failure Git didn't explain is not that, so it fails closed.
  if (workTree === "not-a-repo" || workTree === "git-missing" || workTree === "outside-worktree") return;
  if (workTree === "unknown") {
    throw new Error(
      "Refusing to write: could not tell whether this directory is inside a Git repository " +
        "(git failed or timed out when asked). " +
        "Re-run, fix the repository state, or pass --allow-unignored to write anyway.",
    );
  }

  // Both files this run writes must be ignored: a rule that covers the bundle but not
  // the summary (for example `*.json`) would still leave summary.md committable.
  const shown = relative(rootPath, resolve(outputDirectory)).split("\\").join("/");
  for (const filename of [BUNDLE_FILENAME, SUMMARY_FILENAME]) {
    const ignored = runCommand(
      "git",
      ["check-ignore", "-q", "--", resolve(outputDirectory, filename)],
      { cwd: rootPath },
    );
    if (ignored.status === 0) continue;
    if (ignored.status === 1) {
      throw new Error(
        `Refusing to write: ${shown}/${filename} is not git-ignored in this repository, so the exported evidence could be committed by accident. ` +
          `Add "tmp/" to .gitignore and re-run, or pass --allow-unignored to write anyway.`,
      );
    }
    throw new Error(
      `Refusing to write: could not confirm that ${shown}/${filename} is git-ignored (git check-ignore did not give a clear answer). ` +
        `Fix the repository state, or pass --allow-unignored to write anyway.`,
    );
  }
}

export function run(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (options.help) {
    console.log(HELP);
    return [];
  }
  const root = repositoryRootPath(options.root);
  const outputDirectory = resolveOutputDirectory(root, options.output);
  if (!options.allowUnignored) assertOutputGitIgnored(root, outputDirectory);
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
