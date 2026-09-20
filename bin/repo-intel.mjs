#!/usr/bin/env node
// Global entrypoint for `npm link` / `repo-intel` on PATH. Kept separate from export.mjs
// because that file must stay shebang-free (Vitest imports it as a module).
import { run } from "../export.mjs";

try {
  run();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
