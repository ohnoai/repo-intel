import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { extname, isAbsolute, join, relative, resolve } from "node:path";

import { isExcludedRepositoryPath } from "./collect-files.mjs";
import {
  normalizeAndSanitizeRepositoryPath,
  normalizeRepositoryPath,
  sanitizeCommandMetadata,
  sanitizeEnvironmentComment,
  sanitizeMetadataText,
} from "./sanitize.mjs";

const MAX_CONFIGURATION_BYTES = 1024 * 1024;
const SOURCE_EXTENSIONS = new Set([".cjs", ".cts", ".js", ".jsx", ".mjs", ".mts", ".ts", ".tsx"]);
const SOURCE_DIRECTORIES = ["api", "scripts", "src"];
const ROOT_CONFIGURATION_NAMES = new Set([
  ".env.example",
  "netlify.toml",
  "package-lock.json",
  "package.json",
  "vercel.json",
]);
const ROOT_CONFIGURATION_PATTERNS = [
  /^eslint\.config\.(?:cjs|cts|js|mjs|mts|ts)$/,
  /^postcss\.config\.(?:cjs|cts|js|mjs|mts|ts)$/,
  /^tailwind\.config\.(?:cjs|cts|js|mjs|mts|ts)$/,
  /^tsconfig(?:\.[A-Za-z0-9_-]+)?\.json$/,
  /^vite\.config\.(?:cjs|cts|js|mjs|mts|ts)$/,
  /^vitest\.config\.(?:cjs|cts|js|mjs|mts|ts)$/,
];
const TYPESCRIPT_OPTION_KEYS = [
  "allowJs",
  "composite",
  "jsx",
  "lib",
  "module",
  "moduleResolution",
  "noEmit",
  "resolveJsonModule",
  "skipLibCheck",
  "strict",
  "target",
  "types",
];

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

function sanitizeStringList(value) {
  if (!Array.isArray(value)) return [];

  return value
    .filter((item) => typeof item === "string")
    .map(sanitizeMetadataText)
    .filter(Boolean)
    .sort(compareText);
}

function safePathList(value) {
  if (!Array.isArray(value)) return [];

  return value
    .filter((item) => typeof item === "string")
    .map(safeRepositoryPath)
    .filter(Boolean)
    .sort(compareText);
}

function configurationFormat(path) {
  const extension = extname(path).toLowerCase();

  if (extension === ".json") return "json";
  if (extension === ".toml") return "toml";
  if ([".ts", ".mts", ".cts"].includes(extension)) return "typescript";
  if ([".js", ".mjs", ".cjs"].includes(extension)) return "javascript";
  return "text";
}

function configurationType(path) {
  if (path === "package.json") return "package";
  if (path === "package-lock.json") return "package-lock";
  if (path === ".env.example") return "environment-example";
  if (path === "netlify.toml") return "netlify";
  if (path === "vercel.json") return "vercel";
  if (path === "supabase/config.toml") return "supabase";
  if (path.startsWith("tsconfig") && path.endsWith(".json")) return "typescript";
  if (path.startsWith("vite.config.")) return "vite";
  if (path.startsWith("eslint.config.")) return "eslint";
  if (path.startsWith("tailwind.config.")) return "tailwind";
  if (path.startsWith("postcss.config.")) return "postcss";
  if (path.startsWith("vitest.config.")) return "vitest";
  return "configuration";
}

function readTextFile(root, localPath, warnings) {
  const filePath = resolve(root, ...localPath.split("/"));

  try {
    const repositoryRoot = realpathSync(root);
    const relativePath = relative(repositoryRoot, filePath);
    if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
      warnings.push("A recognized configuration path was outside the repository root.");
      return null;
    }
    let currentPath = repositoryRoot;
    for (const segment of relativePath.split(/[\\/]/).filter(Boolean)) {
      currentPath = join(currentPath, segment);
      if (lstatSync(currentPath).isSymbolicLink()) {
        warnings.push("A recognized configuration path used a symbolic link.");
        return null;
      }
    }
    const resolvedFilePath = realpathSync(filePath);
    const resolvedRelativePath = relative(repositoryRoot, resolvedFilePath);
    if (resolvedRelativePath.startsWith("..") || isAbsolute(resolvedRelativePath)) {
      warnings.push("A recognized configuration path was outside the repository root.");
      return null;
    }
    const stat = statSync(filePath);
    if (!stat.isFile()) {
      warnings.push("A recognized configuration path was not a file.");
      return null;
    }
    if (stat.size > MAX_CONFIGURATION_BYTES) {
      warnings.push("A configuration file exceeded the metadata read limit.");
      return null;
    }
    return readFileSync(resolvedFilePath, "utf8");
  } catch {
    warnings.push("A recognized configuration file could not be read.");
    return null;
  }
}

function stripJsonComments(input) {
  let output = "";
  let inString = false;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    const next = input[index + 1];

    if (lineComment) {
      if (character === "\n") {
        lineComment = false;
        output += character;
      }
      continue;
    }

    if (blockComment) {
      if (character === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }

    if (inString) {
      output += character;
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }

    if (character === '"') {
      inString = true;
      output += character;
    } else if (character === "/" && next === "/") {
      lineComment = true;
      index += 1;
    } else if (character === "/" && next === "*") {
      blockComment = true;
      index += 1;
    } else {
      output += character;
    }
  }

  return output.replace(/,(\s*[}\]])/g, "$1");
}

function parseJson(text, path, warnings, { allowComments = false } = {}) {
  try {
    return JSON.parse(allowComments ? stripJsonComments(text) : text);
  } catch {
    warnings.push(`Malformed ${allowComments ? "JSON-like" : "JSON"} configuration: ${path}.`);
    return null;
  }
}

function namedVersions(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];

  return Object.entries(value)
    .filter(([, version]) => typeof version === "string")
    .map(([name, version]) => ({
      name: sanitizeMetadataText(name),
      version: sanitizeMetadataText(version),
    }))
    .sort((left, right) => compareText(left.name, right.name));
}

function namedScripts(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];

  return Object.entries(value)
    .filter(([, command]) => typeof command === "string")
    .map(([name, command]) => ({
      name: sanitizeMetadataText(name),
      command: sanitizeCommandMetadata(command),
    }))
    .sort((left, right) => compareText(left.name, right.name));
}

function packageRecord(path, text, warnings) {
  const parsed = parseJson(text, path, warnings);
  if (!parsed) return malformedRecord(path, "package", "json");

  const dependencies = namedVersions(parsed.dependencies);
  const developmentDependencies = namedVersions(parsed.devDependencies);
  const toolchainNames = new Set([
    "eslint",
    "typescript",
    "typescript-eslint",
    "vite",
    "vitest",
  ]);

  return {
    path,
    type: "package",
    format: "json",
    settings: {
      name: typeof parsed.name === "string" ? sanitizeMetadataText(parsed.name) : null,
      private: typeof parsed.private === "boolean" ? parsed.private : null,
      version: typeof parsed.version === "string" ? sanitizeMetadataText(parsed.version) : null,
      license: typeof parsed.license === "string" ? sanitizeMetadataText(parsed.license) : null,
      packageManager:
        typeof parsed.packageManager === "string"
          ? sanitizeMetadataText(parsed.packageManager)
          : null,
      engines:
        parsed.engines && typeof parsed.engines === "object"
          ? namedVersions(parsed.engines)
          : [],
    },
    scripts: namedScripts(parsed.scripts),
    dependencies,
    developmentDependencies,
    toolchain: [...dependencies, ...developmentDependencies]
      .filter((dependency) => toolchainNames.has(dependency.name))
      .sort((left, right) => compareText(left.name, right.name)),
  };
}

function packageLockRecord(path, text, warnings) {
  const parsed = parseJson(text, path, warnings);
  if (!parsed) return malformedRecord(path, "package-lock", "json");

  const rootPackage = parsed.packages?.[""];

  return {
    path,
    type: "package-lock",
    format: "json",
    summary: {
      lockfileVersion:
        typeof parsed.lockfileVersion === "number" ? parsed.lockfileVersion : null,
      packageCount:
        parsed.packages && typeof parsed.packages === "object"
          ? Object.keys(parsed.packages).length
          : 0,
      rootName:
        typeof (rootPackage?.name ?? parsed.name) === "string"
          ? sanitizeMetadataText(rootPackage?.name ?? parsed.name)
          : null,
      rootVersion:
        typeof (rootPackage?.version ?? parsed.version) === "string"
          ? sanitizeMetadataText(rootPackage?.version ?? parsed.version)
          : null,
    },
  };
}

function typescriptRecord(path, text, warnings) {
  const parsed = parseJson(text, path, warnings, { allowComments: true });
  if (!parsed) return malformedRecord(path, "typescript", "jsonc");

  const compilerOptions = {};
  for (const key of TYPESCRIPT_OPTION_KEYS) {
    const value = parsed.compilerOptions?.[key];
    if (typeof value === "string" || typeof value === "boolean" || typeof value === "number") {
      compilerOptions[key] =
        typeof value === "string" ? sanitizeMetadataText(value) : value;
    } else if (Array.isArray(value)) {
      compilerOptions[key] = sanitizeStringList(value);
    }
  }

  const references = Array.isArray(parsed.references)
    ? parsed.references
        .map((reference) => safeRepositoryPath(reference?.path))
        .filter(Boolean)
        .sort(compareText)
    : [];

  return {
    path,
    type: "typescript",
    format: "jsonc",
    settings: { compilerOptions },
    references,
    entryPoints: {
      files: safePathList(parsed.files),
      include: safePathList(parsed.include),
      exclude: safePathList(parsed.exclude),
    },
  };
}

function extractImports(text) {
  const references = new Set();
  const pattern = /\bfrom\s*["']([^"']+)["']|\bimport\s*["']([^"']+)["']/g;

  for (const match of text.matchAll(pattern)) {
    const reference = sanitizeMetadataText(match[1] ?? match[2]);
    if (reference) references.add(reference);
  }

  return [...references].sort(compareText);
}

function scriptConfigurationRecord(path, text) {
  const type = configurationType(path);

  return {
    path,
    type,
    format: configurationFormat(path),
    settings: {
      usesDefineConfig: /\bdefineConfig\s*\(/.test(text),
      flatConfig: type === "eslint" && /\.config\./.test(path),
    },
    references: extractImports(text),
  };
}

function parseTomlOverview(text) {
  const sections = new Set();
  const keys = new Set();
  const environmentVariables = new Set();
  let section = "";
  let malformed = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const sectionMatch = line.match(/^\[([A-Za-z0-9_.-]+)\]$/);
    const arraySectionMatch = line.match(/^\[\[([A-Za-z0-9_.-]+)\]\]$/);
    if (sectionMatch || arraySectionMatch) {
      section = (sectionMatch ?? arraySectionMatch)[1];
      sections.add(section);
      continue;
    }

    if (line.startsWith("[")) {
      section = "";
      malformed = true;
      continue;
    }

    const keyMatch = line.match(/^([A-Za-z0-9_.-]+)\s*=/);
    if (keyMatch) {
      keys.add(section ? `${section}.${keyMatch[1]}` : keyMatch[1]);
      for (const variable of line.matchAll(/\benv\(([A-Z][A-Z0-9_]*)\)/g)) {
        environmentVariables.add(variable[1]);
      }
      continue;
    }

    if (line.includes("=")) malformed = true;
  }

  return {
    sections: [...sections].map(sanitizeMetadataText).sort(compareText),
    keys: [...keys].map(sanitizeMetadataText).sort(compareText),
    environmentVariables: [...environmentVariables]
      .map(sanitizeMetadataText)
      .sort(compareText),
    malformed,
  };
}

function tomlRecord(path, text, warnings) {
  const overview = parseTomlOverview(text);
  if (overview.malformed) warnings.push(`Malformed TOML-like configuration: ${path}.`);

  return {
    path,
    type: configurationType(path),
    format: "toml",
    settings: {
      sections: overview.sections,
      keys: overview.keys,
    },
    environmentVariables: overview.environmentVariables,
    malformed: overview.malformed,
  };
}

function vercelRecord(path, text, warnings) {
  const parsed = parseJson(text, path, warnings);
  if (!parsed) return malformedRecord(path, "vercel", "json");

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

function malformedRecord(path, type, format) {
  return {
    path,
    type,
    format,
    malformed: true,
  };
}

function commentDescription(value) {
  const text = sanitizeEnvironmentComment(value);
  return /(?:your[-_]|example[-_]?|placeholder[-_]?)/i.test(text) ? "" : text;
}

function parseEnvironmentExample(path, text, environmentVariables) {
  const pendingComments = [];

  for (const [index, rawLine] of text.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line) {
      pendingComments.length = 0;
      continue;
    }
    if (line.startsWith("#")) {
      const description = commentDescription(line.slice(1));
      if (description) pendingComments.push(description);
      continue;
    }

    const declaration = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (declaration) {
      const name = sanitizeMetadataText(declaration[1]);
      const record = environmentVariables.get(name) ?? {
        name,
        declarations: [],
        descriptions: new Set(),
        references: [],
      };
      record.declarations.push({ path, line: index + 1 });
      for (const description of pendingComments) record.descriptions.add(description);
      environmentVariables.set(name, record);
    }

    pendingComments.length = 0;
  }

  return {
    path,
    type: "environment-example",
    format: "dotenv",
    settings: { variableCount: [...environmentVariables.values()].filter((record) => record.declarations.length).length },
  };
}

function sourceLine(content, index) {
  return content.slice(0, index).split(/\r?\n/).length;
}

function addEnvironmentReference(environmentVariables, name, reference) {
  const sanitizedName = sanitizeMetadataText(name);
  const record = environmentVariables.get(sanitizedName) ?? {
    name: sanitizedName,
    declarations: [],
    descriptions: new Set(),
    references: [],
  };

  if (
    !record.references.some(
      (existing) =>
        existing.path === reference.path &&
        existing.line === reference.line &&
        existing.accessStyle === reference.accessStyle,
    )
  ) {
    record.references.push(reference);
  }

  environmentVariables.set(sanitizedName, record);
}

function scanEnvironmentReferences(root, localPath, environmentVariables, warnings) {
  const path = safeRepositoryPath(localPath);
  if (!path) return;

  const text = readTextFile(root, localPath, warnings);
  if (text === null) return;

  for (const match of text.matchAll(/\b(process\.env|import\.meta\.env)\b/g)) {
    const index = match.index ?? 0;
    const base = match[1];
    const remainder = text.slice(index + match[0].length);
    const directAccess = remainder.match(
      /^\s*(?:\?\.|\.)\s*([A-Za-z_][A-Za-z0-9_]*)/,
    );
    const literalAccess = remainder.match(
      /^\s*(?:\?\.)?\[\s*(['"`])([A-Za-z_][A-Za-z0-9_]*)\1\s*\]/,
    );
    const line = sourceLine(text, index);

    if (directAccess) {
      addEnvironmentReference(environmentVariables, directAccess[1], {
        path,
        line,
        accessStyle: `${base}.NAME`,
      });
    } else if (literalAccess) {
      addEnvironmentReference(environmentVariables, literalAccess[2], {
        path,
        line,
        accessStyle: `${base}['NAME']`,
      });
    } else {
      const warning = `An environment variable access could not be resolved statically: ${path}:${line}.`;
      if (!warnings.includes(warning)) warnings.push(warning);
    }
  }
}

function shouldSkipEnvironmentScan(localPath) {
  const path = normalizeRepositoryPath(localPath);
  const segments = path.split("/");
  const filename = segments.at(-1) ?? "";

  return (
    isExcludedRepositoryPath(path) ||
    path === "scripts/intelligence" ||
    path.startsWith("scripts/intelligence/") ||
    segments.some((segment) => ["__tests__", "test", "tests"].includes(segment)) ||
    /\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(filename)
  );
}

function isGitBoundary(directory) {
  try {
    const gitPath = join(directory, ".git");
    const stat = lstatSync(gitPath);
    return stat.isDirectory() || stat.isFile();
  } catch {
    return false;
  }
}

function scanSourceDirectory(root, localDirectory, environmentVariables, warnings) {
  const directory = resolve(root, ...localDirectory.split("/"));
  if (isGitBoundary(directory)) return;

  let entries;

  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }

  entries.sort((left, right) => compareText(left.name, right.name));

  for (const entry of entries) {
    const localPath = `${localDirectory}/${entry.name}`;
    if (shouldSkipEnvironmentScan(localPath)) continue;

    if (entry.isDirectory()) {
      scanSourceDirectory(root, localPath, environmentVariables, warnings);
    } else if (entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
      scanEnvironmentReferences(root, localPath, environmentVariables, warnings);
    }
  }
}

function isServerReference(reference) {
  return reference.path.startsWith("api/");
}

function environmentRecords(environmentVariables, warnings) {
  const records = [];

  for (const record of environmentVariables.values()) {
    record.declarations.sort((left, right) => {
      const pathOrder = compareText(left.path, right.path);
      return pathOrder || left.line - right.line;
    });
    record.references.sort((left, right) => {
      const pathOrder = compareText(left.path, right.path);
      if (pathOrder) return pathOrder;
      return left.line - right.line || compareText(left.accessStyle, right.accessStyle);
    });

    const clientPrefixed = record.name.startsWith("VITE_");
    const clientAccess = record.references.some((reference) =>
      reference.accessStyle.startsWith("import.meta.env"),
    );
    const serverOnly =
      record.references.length > 0 && record.references.every(isServerReference);
    const classification =
      clientPrefixed || clientAccess
        ? "public/client"
        : serverOnly
          ? "server-only"
          : "unknown";

    if (
      (clientPrefixed || clientAccess) &&
      record.references.some(isServerReference)
    ) {
      warnings.push(
        `Client-prefixed environment variable evidence also appears in server code: ${record.name}.`,
      );
    }

    records.push({
      name: record.name,
      classification,
      descriptions: [...record.descriptions].sort(compareText),
      declarations: record.declarations,
      references: record.references,
      accessStyles: [...new Set(record.references.map((reference) => reference.accessStyle))].sort(compareText),
    });
  }

  return records.sort((left, right) => compareText(left.name, right.name));
}

function configurationPaths(root, warnings) {
  let rootEntries;

  try {
    rootEntries = readdirSync(root, { withFileTypes: true });
  } catch {
    warnings.push("Repository-root configuration files could not be listed.");
    return [];
  }

  const paths = rootEntries
    .filter(
      (entry) =>
        ROOT_CONFIGURATION_NAMES.has(entry.name) ||
        ROOT_CONFIGURATION_PATTERNS.some((pattern) => pattern.test(entry.name)),
    )
    .map((entry) => entry.name);

  if (existsSync(join(root, "supabase", "config.toml"))) {
    paths.push("supabase/config.toml");
  }

  return [...new Set(paths)]
    .map(safeRepositoryPath)
    .filter(Boolean)
    .sort(compareText);
}

function collectRootEnvironmentReferences(root, environmentVariables, warnings) {
  let entries;

  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries.sort((left, right) => compareText(left.name, right.name))) {
    if (!entry.isFile() || !/^vite\.config\.(?:cjs|cts|js|mjs|mts|ts)$/.test(entry.name)) {
      continue;
    }
    scanEnvironmentReferences(root, entry.name, environmentVariables, warnings);
  }
}

export function collectConfiguration({ root = process.cwd() } = {}) {
  const repositoryRoot = resolve(root);
  const warnings = [];
  const environmentVariables = new Map();

  try {
    if (!statSync(repositoryRoot).isDirectory()) throw new Error("Not a directory.");
  } catch {
    return {
      status: "unavailable",
      records: [],
      warnings: ["The requested repository directory is unavailable."],
      metadata: {
        environmentVariables: [],
      },
    };
  }

  const records = [];
  for (const path of configurationPaths(repositoryRoot, warnings)) {
    const text = readTextFile(repositoryRoot, path, warnings);
    if (text === null) continue;

    if (path === "package.json") {
      records.push(packageRecord(path, text, warnings));
    } else if (path === "package-lock.json") {
      records.push(packageLockRecord(path, text, warnings));
    } else if (path.startsWith("tsconfig") && path.endsWith(".json")) {
      records.push(typescriptRecord(path, text, warnings));
    } else if (path === ".env.example") {
      records.push(parseEnvironmentExample(path, text, environmentVariables));
    } else if (path === "vercel.json") {
      records.push(vercelRecord(path, text, warnings));
    } else if (path.endsWith(".toml")) {
      records.push(tomlRecord(path, text, warnings));
    } else {
      records.push(scriptConfigurationRecord(path, text));
    }
  }

  for (const directory of SOURCE_DIRECTORIES) {
    if (existsSync(join(repositoryRoot, directory))) {
      scanSourceDirectory(repositoryRoot, directory, environmentVariables, warnings);
    }
  }
  collectRootEnvironmentReferences(repositoryRoot, environmentVariables, warnings);

  const packageConfiguration = records.find((record) => record.type === "package");
  const environment = environmentRecords(environmentVariables, warnings);

  return {
    status: warnings.length ? "partial" : "complete",
    records: records.sort((left, right) => compareText(left.path, right.path)),
    warnings,
    metadata: {
      packageScripts: packageConfiguration?.scripts ?? [],
      dependencies: packageConfiguration?.dependencies ?? [],
      developmentDependencies: packageConfiguration?.developmentDependencies ?? [],
      toolchain: packageConfiguration?.toolchain ?? [],
      environmentVariables: environment,
    },
  };
}
