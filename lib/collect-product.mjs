import { lstatSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { normalizeAndSanitizeRepositoryPath, normalizeRepositoryPath } from "./sanitize.mjs";

// NOTE: this collector is still SliceBoard-tuned (see README "Known limitation").
// Pointed at another repository it degrades gracefully - metadata.product comes back
// null and no signals fire - but it will not detect anything meaningful about a
// non-SliceBoard codebase yet. Generalizing this (configurable signal/risk patterns,
// the same way collect-planning.mjs became configurable via .repo-intelligence.json)
// is open work, not yet started.

const MAX_SOURCE_BYTES = 384 * 1024;
const MAX_SOURCE_FILES = 160;
const MAX_SOURCE_DEPTH = 5;
const SOURCE_EXTENSIONS = /\.(?:cjs|css|js|jsx|mjs|ts|tsx|vue)$/i;
const EXCLUDED = new Set([".git", "node_modules", "dist", "build", "coverage", ".vscode", "tmp", ".project-intelligence"]);
const SOURCE_COLLECTION_WARNING = "Product source collection was bounded.";
const SOURCE_DEPTH_WARNING = "Product source collection omitted files beyond its traversal depth limit.";
const OVERSIZED_SOURCE_WARNING = "Product source collection omitted oversized source files.";

function compareText(left, right) { return left < right ? -1 : left > right ? 1 : 0; }
function safePath(path) { return normalizeAndSanitizeRepositoryPath(normalizeRepositoryPath(path)); }

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

const SIGNALS = [
  ["budget-allocation", /fixed.?pot|unassigned|applyAmountToSlice|applySlicePatch|totalFor/i],
  ["pizza-visualization", /PizzaWindowChart|pizza-chart-wrap|pizza.?texture|sliceBoardThemes/i],
  ["local-first-persistence", /sliceboard-state|localStorage|persistence/i],
  ["multi-pie", /MAX_PIES|activePieId|addPie|multi.?pie/i],
  ["onboarding", /OnboardingWizard|FirstRunIntro|onboardingComplete/i],
  ["cloud-sync", /cloudSync|board_states|reconcileCloud|Supabase|supabase/i],
  ["billing-entitlements", /Stripe|stripe|entitlement|isPro|promo_code/i],
  ["theme-system", /data-theme|theme|rotten|boring|toon/i],
];

const RISKS = [
  ["budget-invariant", "high", /fixed.?pot|applyAmountToSlice|applySlicePatch|totalFor/i],
  ["cloud-concurrency", "high", /revision|reconcileCloud|saveCurrentPayloadToCloud|board_states/i],
  ["entitlement-boundary", "high", /isPro|isPieLocked|user_entitlements|board_states/i],
  ["sensitive-data-boundary", "high", /localStorage|sliceboard-state|board_states|payload|backup|environment|process\.env|import\.meta\.env/i],
  ["responsive-surface", "medium", /mobile|viewport|breakpoint|overflow|aspect-ratio/i],
  ["visual-asset-authority", "medium", /WebP|webp|pizza|SVG|canvas|texture/i],
];

export function collectProduct({ root = process.cwd() } = {}) {
  const repositoryRoot = resolve(root);
  const warnings = [];
  try { if (!statSync(repositoryRoot).isDirectory()) throw new Error("not a directory"); }
  catch {
    return { status: "unavailable", records: [], warnings: ["The requested repository directory is unavailable."], metadata: { product: null, signals: [], riskSurfaces: [] } };
  }

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
  return {
    status: warnings.length ? "partial" : "complete",
    records: [{ type: "product-surface", product: signals.some((signal) => signal.id === "budget-allocation" || signal.id === "pizza-visualization") ? "SliceBoard" : null, inspectedSourceFiles: inspected }],
    warnings: [...new Set(warnings)].sort(compareText),
    metadata: { product: "SliceBoard", signals, riskSurfaces },
  };
}
