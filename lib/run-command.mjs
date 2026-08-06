import { spawnSync } from "node:child_process";

const DEFAULT_MAX_BUFFER = 5 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const GIT_ENVIRONMENT_KEYS = new Set([
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_EXTERNAL_DIFF",
]);

function outputText(value) {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  return "";
}

function commandError(error) {
  if (!error) return null;

  if (error.code === "ENOENT") {
    return {
      code: "ENOENT",
      message: "Command was not found.",
    };
  }

  if (error.code === "ETIMEDOUT") {
    return {
      code: "ETIMEDOUT",
      message: "Command timed out.",
    };
  }

  return {
    code: typeof error.code === "string" ? error.code : "COMMAND_ERROR",
    message: "Command execution failed.",
  };
}

function sanitizedGitEnvironment() {
  const environment = { ...process.env };

  for (const key of Object.keys(environment)) {
    if (GIT_ENVIRONMENT_KEYS.has(key.toUpperCase())) {
      delete environment[key];
    }
  }

  environment.GIT_CONFIG_NOSYSTEM = "1";
  return environment;
}

/**
 * Runs a command without a shell and returns process output for callers to parse.
 * Process failures are returned instead of thrown so optional calls remain safe.
 */
export function runCommand(command, args = [], { cwd } = {}) {
  if (typeof command !== "string" || !command) {
    throw new TypeError("A command string is required.");
  }

  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
    throw new TypeError("Command arguments must be strings.");
  }

  if (typeof cwd !== "string" || !cwd) {
    throw new TypeError("An explicit working directory is required.");
  }

  let result;

  try {
    result = spawnSync(command, args, {
      cwd,
      encoding: "utf8",
      shell: false,
      maxBuffer: DEFAULT_MAX_BUFFER,
      timeout: DEFAULT_TIMEOUT_MS,
      env: sanitizedGitEnvironment(),
    });
  } catch (error) {
    return {
      ok: false,
      status: null,
      stdout: "",
      stderr: "",
      error: commandError(error),
    };
  }

  const status = typeof result.status === "number" ? result.status : null;
  const ok = !result.error && status === 0;

  return {
    ok,
    status,
    stdout: outputText(result.stdout),
    stderr: outputText(result.stderr),
    error:
      commandError(result.error) ??
      (ok
        ? null
        : {
            code: "EXIT_NON_ZERO",
            message: "Command exited with a non-zero status.",
          }),
  };
}
