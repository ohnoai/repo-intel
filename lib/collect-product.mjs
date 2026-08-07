import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { normalizeAndSanitizeRepositoryPath, normalizeRepositoryPath, sanitizeMetadataText } from "./sanitize.mjs";

const MAX_SOURCE_BYTES = 384 * 1024;
const MAX_SOURCE_FILES = 160;
const MAX_SOURCE_DEPTH = 5;
const SOURCE_EXTENSIONS = /\.(?:cjs|css|js|jsx|mjs|ts|tsx|vue)$/i;
const EXCLUDED = new Set([".git", "node_modules", "dist", "build", "coverage", ".vscode", "tmp", ".project-intelligence"]);
const SOURCE_COLLECTION_WARNING = "Product source collection was bounded.";
const SOURCE_DEPTH_WARNING = "Product source collection omitted files beyond its traversal depth limit.";
const OVERSIZED_SOURCE_WARNING = "Product source collection omitted oversized source files.";

const CONFIG_FILENAME = ".repo-intelligence.json";
const MAX_NAME_LENGTH = 80;
const MAX_ID_LENGTH = 80;
const MAX_PATTERN_LENGTH = 200;
const ID_PATTERN = /^[a-z][a-z0-9-]*$/;
const SEVERITIES = new Set(["low", "medium", "high"]);

function compareText(left, right) { return left < right ? -1 : left > right ? 1 : 0; }
function safePath(path) { return normalizeAndSanitizeRepositoryPath(normalizeRepositoryPath(path)); }

function configuredId(rawId) {
  if (typeof rawId !== "string") return null;
  const id = sanitizeMetadataText(rawId).trim().slice(0, MAX_ID_LENGTH);
  return ID_PATTERN.test(id) ? id : null;
}

function configuredPattern(rawPattern, warnings, context) {
  if (typeof rawPattern !== "string" || !rawPattern || rawPattern.length > MAX_PATTERN_LENGTH) {
    warnings.push(`Product ${context} declared an invalid pattern.`);
    return null;
  }
  try {
    return new RegExp(rawPattern, "i");
  } catch {
    warnings.push(`Product ${context} pattern could not be compiled.`);
    return null;
  }
}

// Repository-declared product signals and risk surfaces. With no config present (or no
// "product" section in it) this returns name: null and empty signals/risks, so pointing
// --root at an unconfigured repository produces honest empty output instead of another
// project's detection noise. A real product's own signal/risk patterns belong in that
// repository's own .repo-intelligence.json, the same way collect-planning.mjs reads
// authorityDocuments/planningDirectories from it.
function productConfig(root, warnings) {
  const empty = { name: null, signals: [], riskSurfaces: [] };

  const configPath = join(root, CONFIG_FILENAME);
  if (!existsSync(configPath)) return empty;

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    warnings.push(`Repository intelligence config could not be parsed: ${CONFIG_FILENAME}.`);
    return empty;
  }

  const product = parsed?.product;
  if (!product || typeof product !== "object") return empty;

  const name = typeof product.name === "string"
    ? sanitizeMetadataText(product.name).trim().slice(0, MAX_NAME_LENGTH) || null
    : null;

  const signals = [];
  if (Array.isArray(product.signals)) {
    for (const entry of product.signals) {
      const id = configuredId(entry?.id);
      if (!id) {
        warnings.push("Product signal declared an invalid id.");
        continue;
      }
      const pattern = configuredPattern(entry?.pattern, warnings, `signal "${id}"`);
      if (pattern) signals.push([id, pattern]);
    }
  }

  const riskSurfaces = [];
  if (Array.isArray(product.riskSurfaces)) {
    for (const entry of product.riskSurfaces) {
      const id = configuredId(entry?.id);
      if (!id) {
        warnings.push("Product risk surface declared an invalid id.");
        continue;
      }
      const severity = typeof entry?.severity === "string" ? entry.severity.toLowerCase() : "";
      if (!SEVERITIES.has(severity)) {
        warnings.push(`Product risk surface "${id}" declared an invalid severity.`);
        continue;
      }
      const pattern = configuredPattern(entry?.pattern, warnings, `risk surface "${id}"`);
      if (pattern) riskSurfaces.push([id, severity, pattern]);
    }
  }

  return { name, signals, riskSurfaces };
}

function sourcePaths(root) {
  const paths = [];
  let depthTruncated = false;
  function visit(directory, depth = 0) {
    if (depth > 0 && lstatSync(join(directory, ".git"), { throwIfNoEntry: false })) return false;
    if (depth > MAX_SOURCE_DEPTH) {
      depthTruncated = true;
      return false;
    }
    let entries;
    try { entries = readdirSync(directory, { withFileTypes: true }); } catch { return false; }
    for (const entry of entries.sort((a, b) => compareText(a.name, b.name))) {
      if (EXCLUDED.has(entry.name)) continue;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory() && visit(absolute, depth + 1)) return true;
      if (entry.isFile() && SOURCE_EXTENSIONS.test(entry.name)) {
        if (paths.length >= MAX_SOURCE_FILES) return true;
        paths.push(absolute);
      }
    }
    return false;
  }
  return { paths: paths.sort(compareText), truncated: visit(root), depthTruncated };
}

function evidenceFor(path, warnings) {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile()) return "";
    if (stat.size > MAX_SOURCE_BYTES) {
      warnings.push(OVERSIZED_SOURCE_WARNING);
      return "";
    }
    return readFileSync(path, "utf8");
  } catch {
    warnings.push("A product source file could not be inspected.");
    return "";
  }
}

export function collectProduct({ root = process.cwd() } = {}) {
  const repositoryRoot = resolve(root);
  const warnings = [];
  try { if (!statSync(repositoryRoot).isDirectory()) throw new Error("not a directory"); }
  catch {
    return { status: "unavailable", records: [], warnings: ["The requested repository directory is unavailable."], metadata: { product: null, signals: [], riskSurfaces: [] } };
  }

  const config = productConfig(repositoryRoot, warnings);
  const SIGNALS = config.signals;
  const RISKS = config.riskSurfaces;

  const signalPaths = new Map(SIGNALS.map(([id]) => [id, new Set()]));
  const riskPaths = new Map(RISKS.map(([id]) => [id, new Set()]));
  let inspected = 0;
  const sourceCollection = sourcePaths(repositoryRoot);
  if (sourceCollection.truncated) warnings.push(SOURCE_COLLECTION_WARNING);
  if (sourceCollection.depthTruncated) warnings.push(SOURCE_DEPTH_WARNING);
  for (const absolutePath of sourceCollection.paths) {
    const text = evidenceFor(absolutePath, warnings);
    if (!text) continue;
    inspected += 1;
    const relativePath = safePath(absolutePath.slice(repositoryRoot.length + 1));
    for (const [id, pattern] of SIGNALS) if (pattern.test(text)) signalPaths.get(id).add(relativePath);
    for (const [id, , pattern] of RISKS) if (pattern.test(text)) riskPaths.get(id).add(relativePath);
  }

  const signals = [...signalPaths].filter(([, paths]) => paths.size).map(([id, paths]) => ({ id, evidencePaths: [...paths].sort(compareText) })).sort((a, b) => compareText(a.id, b.id));
  const riskSurfaces = RISKS.map(([id, severity]) => ({ id, severity, detected: riskPaths.get(id).size > 0, evidencePaths: [...riskPaths.get(id)].sort(compareText) })).filter((risk) => risk.detected);
  // A product name is only reported once its own configured signals actually fired against
  // this repository -- otherwise metadata.product would claim identity from config alone,
  // even against a repository that shares nothing but a directory with the one it was written for.
  const product = config.name && signals.length ? config.name : null;
  return {
    status: warnings.length ? "partial" : "complete",
    records: [{ type: "product-surface", product, inspectedSourceFiles: inspected }],
    warnings: [...new Set(warnings)].sort(compareText),
    metadata: { product, signals, riskSurfaces },
  };
}
