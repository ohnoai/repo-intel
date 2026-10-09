import { extname } from "node:path";

// Repository-relative paths only (forward slashes, as produced by
// normalizeRepositoryPath elsewhere) -- these are not filesystem-path helpers.
// Exported so lib/collect-files.mjs (which already imports isEnvironmentFile from here)
// can share these instead of keeping its own copy.
export function filenameFor(path) {
  return path.split("/").at(-1)?.toLowerCase() ?? "";
}

export function extensionFor(path) {
  return extname(path.split("/").at(-1) ?? "").toLowerCase();
}

// Broad "looks like a dotenv file" predicate. Moved from lib/collect-files.mjs
// unchanged: it deliberately also matches .env.example (used there only to skip binary
// content-inspection and to classify a record, never to decide whether to read a file),
// so it is not the right check for "is it safe to open this file's contents" -- see
// isPrivateEnvironmentFile below for that.
export function isEnvironmentFile(path) {
  const filename = filenameFor(path);
  return (
    filename === ".env" ||
    filename.startsWith(".env") ||
    extensionFor(path) === ".env"
  );
}

// The one deliberate, hand-reviewed exception: a template/example file meant to be read
// and shipped in the repository, containing placeholder values rather than secrets.
// collect-config.mjs already reads it by its own explicit, separate allowlist; this
// module's job is only to make sure nothing *else* newly starts reading it under the
// broader isEnvironmentFile match.
const KNOWN_SAFE_ENVIRONMENT_FILENAMES = new Set([".env.example"]);

// Precise "never read this file's contents" predicate, for anywhere a path comes from
// data the repository itself controls (a configured authority-document path, a scanned
// source file) rather than from this tool's own fixed list of files it already knows are
// safe to read. Unlike isEnvironmentFile, this explicitly excludes the one known-safe
// dotenv variant, so it must never be used for classification/display purposes where
// over-matching .env.example would be the existing (harmless) behavior.
export function isPrivateEnvironmentFile(path) {
  if (KNOWN_SAFE_ENVIRONMENT_FILENAMES.has(filenameFor(path))) return false;
  return isEnvironmentFile(path);
}
