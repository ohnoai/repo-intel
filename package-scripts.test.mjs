import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Closes the npm-script gap ledgered as a Low in docs/03-current-state.md: two test files
// (observations.test.mjs, git-worktree-probe.test.mjs) existed with no matching npm script,
// discoverable only by knowing to grep for them. This test makes that gap impossible to
// reopen silently -- every root *.test.mjs, including this file itself, must have a
// matching "test:<name>" script that actually runs it.
describe("package.json test scripts (S7)", () => {
  it("has a test:<name> script naming every root *.test.mjs file", () => {
    const packageJson = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));
    const scripts = packageJson.scripts ?? {};

    const testFiles = readdirSync(process.cwd())
      .filter((name) => name.endsWith(".test.mjs"))
      .sort();

    expect(testFiles.length).toBeGreaterThan(0);

    for (const file of testFiles) {
      const scriptName = `test:${file.replace(/\.test\.mjs$/, "")}`;
      expect(Object.keys(scripts), `missing npm script "${scriptName}" for ${file}`).toContain(scriptName);
      expect(scripts[scriptName]).toContain(file);
    }
  });
});
