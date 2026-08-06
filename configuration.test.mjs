import { afterEach, describe, expect, it } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import { collectConfiguration } from "./lib/collect-config.mjs";
import { collectDelivery } from "./lib/collect-delivery.mjs";
import { normalizeRepositoryPath } from "./lib/sanitize.mjs";

const fixtureDirectories = [];

afterEach(() => {
  while (fixtureDirectories.length) {
    rmSync(fixtureDirectories.pop(), { recursive: true, force: true });
  }
});

function createFixture() {
  const directory = mkdtempSync(join(tmpdir(), "sliceboard-configuration-"));
  const root = join(directory, "repo");
  mkdirSync(root);
  fixtureDirectories.push(directory);
  return { directory, root };
}

function writeFixtureFile(root, path, content) {
  const filePath = join(root, ...path.split("/"));
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
}

function packageFixture({ scripts = {}, dependencies = {}, devDependencies = {} } = {}) {
  return JSON.stringify(
    {
      name: "fixture-board",
      version: "1.2.3",
      private: true,
      engines: { node: ">=22" },
      scripts,
      dependencies,
      devDependencies,
    },
    null,
    2,
  );
}

describe("repository intelligence configuration", () => {
  it("collects package scripts, dependencies, toolchain ranges, and lock summaries", () => {
    const { root } = createFixture();
    const lockOnlyValue = ["fixture", "-lock", "-only", "-value"].join("");

    writeFixtureFile(
      root,
      "package.json",
      packageFixture({
        scripts: { build: "vite build", test: "vitest run" },
        dependencies: { react: "^19.0.0" },
        devDependencies: { typescript: "~6.0.0", vite: "^8.0.0" },
      }),
    );
    writeFixtureFile(
      root,
      "package-lock.json",
      JSON.stringify({
        name: "fixture-board",
        lockfileVersion: 3,
        packages: {
          "": { name: "fixture-board", version: "1.2.3" },
          "node_modules/react": { integrity: lockOnlyValue },
        },
      }),
    );
    writeFixtureFile(
      root,
      "tsconfig.json",
      JSON.stringify({
        compilerOptions: { target: "ES2022", strict: true },
        include: ["src"],
        references: [{ path: "./tsconfig.app.json" }],
      }),
    );

    const result = collectConfiguration({ root });
    const packageRecord = result.records.find((record) => record.type === "package");
    const lockRecord = result.records.find((record) => record.type === "package-lock");
    const typescriptRecord = result.records.find((record) => record.type === "typescript");
    const serialized = JSON.stringify(result);

    expect(result.status).toBe("complete");
    expect(packageRecord.scripts).toContainEqual({ name: "build", command: "vite build" });
    expect(packageRecord.dependencies).toContainEqual({ name: "react", version: "^19.0.0" });
    expect(packageRecord.toolchain).toContainEqual({ name: "typescript", version: "~6.0.0" });
    expect(lockRecord.summary).toEqual({
      lockfileVersion: 3,
      packageCount: 2,
      rootName: "fixture-board",
      rootVersion: "1.2.3",
    });
    expect(typescriptRecord.settings.compilerOptions).toEqual({
      strict: true,
      target: "ES2022",
    });
    expect(typescriptRecord.references).toEqual(["tsconfig.app.json"]);
    expect(typescriptRecord.entryPoints.include).toEqual(["src"]);
    expect(serialized).not.toContain(lockOnlyValue);
  });

  it("redacts command credentials and local paths in configuration and delivery scripts", () => {
    const { root } = createFixture();
    const credential = ["fixture", "-deploy", "-credential"].join("");
    const environmentValue = ["fixture", "-deploy", "-environment"].join("");
    const localPath = "/tmp/fixture/private-deploy";

    writeFixtureFile(
      root,
      "package.json",
      packageFixture({
        scripts: {
          deploy: `DEPLOY_REGION=${environmentValue} vercel --token=${credential} --config ${localPath}`,
        },
      }),
    );

    const configuration = collectConfiguration({ root });
    const delivery = collectDelivery({ root });
    const configurationCommand = configuration.metadata.packageScripts[0].command;
    const deliveryCommand = delivery.metadata.deploymentScripts[0].command;

    for (const output of [configurationCommand, deliveryCommand]) {
      expect(output).not.toContain(credential);
      expect(output).not.toContain(environmentValue);
      expect(output).not.toContain(localPath);
      expect(output).toContain("[REDACTED:credential-flag]");
      expect(output).toContain("[REDACTED:environment-value]");
      expect(output).toContain("[REDACTED:local-path]");
    }
  });

  it("collects environment names and references without values or private files", () => {
    const { root } = createFixture();
    const privateValue = ["fixture", "-private", "-value"].join("");
    const commentValue = ["fixture", "-comment", "-value"].join("");
    const privateName = "PRIVATE_ENV_SHOULD_NOT_APPEAR";

    writeFixtureFile(
      root,
      ".env.example",
      [
        "# Contact fixture-comment@example.test",
        `# UNUSED_VALUE=${commentValue}`,
        "VITE_PUBLIC_URL=your-public-value",
        "# Server-only token",
        "SERVER_TOKEN=your-server-secret",
      ].join("\n"),
    );
    writeFixtureFile(root, ".env", `${privateName}=${privateValue}\n`);
    writeFixtureFile(
      root,
      "src/client.ts",
      [
        "const first = import.meta.env.VITE_PUBLIC_URL;",
        "const second = import.meta.env.VITE_PUBLIC_URL;",
      ].join("\n"),
    );
    writeFixtureFile(
      root,
      "api/server.ts",
      [
        "const token = process.env.SERVER_TOKEN;",
        "const misplaced = process.env.VITE_PUBLIC_URL;",
      ].join("\n"),
    );
    const emailPath = ["owner", "@", "example", ".test"].join("");
    writeFixtureFile(
      root,
      `src/${emailPath}-source.ts`,
      "const pathValue = process.env.PATH_TOKEN;\n",
    );

    const result = collectConfiguration({ root });
    const variables = result.metadata.environmentVariables;
    const publicVariable = variables.find((record) => record.name === "VITE_PUBLIC_URL");
    const serverVariable = variables.find((record) => record.name === "SERVER_TOKEN");
    const pathVariable = variables.find((record) => record.name === "PATH_TOKEN");
    const serialized = JSON.stringify(result);

    expect(variables.map((record) => record.name)).toEqual([
      "PATH_TOKEN",
      "SERVER_TOKEN",
      "VITE_PUBLIC_URL",
    ]);
    expect(publicVariable.classification).toBe("public/client");
    expect(publicVariable.references).toHaveLength(3);
    expect(publicVariable.accessStyles).toEqual([
      "import.meta.env.NAME",
      "process.env.NAME",
    ]);
    expect(serverVariable.classification).toBe("server-only");
    expect(serverVariable.accessStyles).toEqual(["process.env.NAME"]);
    expect(pathVariable.references[0].path).toContain("[REDACTED:email]");
    expect(publicVariable.descriptions).toContain("Contact [REDACTED:email]");
    expect(serialized).not.toContain("your-public-value");
    expect(serialized).not.toContain("your-server-secret");
    expect(serialized).not.toContain(privateValue);
    expect(serialized).not.toContain(commentValue);
    expect(serialized).not.toContain(privateName);
    expect(serialized).not.toContain(emailPath);
    expect(
      result.warnings.some((warning) => warning.includes("Client-prefixed environment variable")),
    ).toBe(true);
  });

  it("keeps only bounded, non-value environment comments", () => {
    const { root } = createFixture();
    const commentValue = ["fixture", "-comment", "-credential"].join("");
    const longComment = Array.from({ length: 40 }, () => "documentation").join(" ");

    writeFixtureFile(
      root,
      ".env.example",
      [
        "# Server-only token",
        "SERVER_TOKEN=your-server-token",
        `# API_TOKEN=${commentValue}`,
        "# Token: short-value",
        "API_TOKEN=your-api-token",
        `# ${longComment}`,
        "LONG_COMMENT_VARIABLE=your-placeholder",
        "# Rotate at portal. Current live value is livePlainSecret777 today.",
        "CURRENT_LIVE_VALUE=your-placeholder",
        "# Ask ops for the current key a1b2c3d4e5f6g7h8",
        "OPS_ACCESS_KEY=your-placeholder",
        "# Bucket uses AKIAIOSFODNN7NOTREAL for access",
        "BUCKET_ACCESS_KEY=your-placeholder",
      ].join("\n"),
    );

    const result = collectConfiguration({ root });
    const server = result.metadata.environmentVariables.find(
      (record) => record.name === "SERVER_TOKEN",
    );
    const api = result.metadata.environmentVariables.find(
      (record) => record.name === "API_TOKEN",
    );
    const long = result.metadata.environmentVariables.find(
      (record) => record.name === "LONG_COMMENT_VARIABLE",
    );
    const currentLive = result.metadata.environmentVariables.find(
      (record) => record.name === "CURRENT_LIVE_VALUE",
    );
    const opsAccess = result.metadata.environmentVariables.find(
      (record) => record.name === "OPS_ACCESS_KEY",
    );
    const bucketAccess = result.metadata.environmentVariables.find(
      (record) => record.name === "BUCKET_ACCESS_KEY",
    );
    const serialized = JSON.stringify(result);

    expect(server.descriptions).toEqual(["Server-only token"]);
    expect(api.descriptions).toEqual([]);
    expect(long.descriptions[0]).toHaveLength(240);
    expect(currentLive.descriptions).toEqual([]);
    expect(opsAccess.descriptions).toEqual([]);
    expect(bucketAccess.descriptions).toEqual([]);
    expect(serialized).not.toContain(commentValue);
    expect(serialized).not.toContain("short-value");
    expect(serialized).not.toContain("livePlainSecret777");
    expect(serialized).not.toContain("a1b2c3d4e5f6g7h8");
    expect(serialized).not.toContain("AKIAIOSFODNN7NOTREAL");
  });

  it("merges multi-line environment comments in sorted order and drops assignment-like lines", () => {
    const { root } = createFixture();

    writeFixtureFile(
      root,
      ".env.example",
      [
        "# Public origin that serves hosted share pages and social preview images.",
        "# Falls back to the default origin when unset.",
        "SHARE_PUBLIC_ORIGIN=https://fixture.test",
        "",
        "# Passkeys (WebAuthn). rpID must be a registrable suffix of every allowed",
        "# origin. Defaults: rpID=fixture.test, origins the marketing + app domains.",
        "# For local dev: PASSKEY_RP_ID=localhost, PASSKEY_ORIGINS=http://localhost:5173",
        "PASSKEY_RP_ID=fixture.test",
      ].join("\n"),
    );

    const result = collectConfiguration({ root });
    const shareOrigin = result.metadata.environmentVariables.find(
      (record) => record.name === "SHARE_PUBLIC_ORIGIN",
    );
    const passkeyRpId = result.metadata.environmentVariables.find(
      (record) => record.name === "PASSKEY_RP_ID",
    );

    // Multiple comment lines directly above a declaration all merge into
    // that variable's descriptions, sorted alphabetically at output time
    // (not source order) -- this fixture regression-tests that.
    expect(shareOrigin.descriptions).toEqual([
      "Falls back to the default origin when unset.",
      "Public origin that serves hosted share pages and social preview images.",
    ]);
    // Comment lines that look like assignments ("key=value") are dropped
    // whole rather than redacted in place, even when embedded mid-sentence
    // like "origin. Defaults: rpID=fixture.test, ..." above.
    expect(passkeyRpId.descriptions).toEqual([
      "Passkeys (WebAuthn). rpID must be a registrable suffix of every allowed",
    ]);
  });

  it("does not serialize current process environment values or absolute paths", () => {
    const { root } = createFixture();
    const key = "SLICEBOARD_CONFIGURATION_PROBE";
    const probeValue = ["fixture", "-process", "-environment", "-value"].join("");
    const previousValue = process.env[key];
    const absolutePath = ["C:", "/Users", "/fixture", "/build.mjs"].join("");

    writeFixtureFile(
      root,
      "package.json",
      packageFixture({ scripts: { build: `node ${absolutePath}` } }),
    );
    process.env[key] = probeValue;

    try {
      const serialized = JSON.stringify(collectConfiguration({ root }));

      expect(serialized).not.toContain(probeValue);
      expect(serialized).not.toContain(normalizeRepositoryPath(root));
      expect(serialized).not.toContain(absolutePath);
      expect(serialized).toContain("[REDACTED:local-path]");
    } finally {
      if (previousValue === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previousValue;
      }
    }
  });

  it("collects literal indirect access and warns for unresolved environment access", () => {
    const { root } = createFixture();

    writeFixtureFile(
      root,
      ".env.example",
      [
        "VITE_LITERAL=your-public-value",
        "SERVER_LITERAL=your-server-value",
      ].join("\n"),
    );
    writeFixtureFile(
      root,
      "src/runtime.ts",
      [
        'const client = import.meta.env["VITE_LITERAL"];',
        "const dynamic = process.env[configuredName];",
        "const completeEnvironment = import.meta.env;",
      ].join("\n"),
    );
    writeFixtureFile(
      root,
      "api/server.ts",
      "const server = process.env?.['SERVER_LITERAL'];\n",
    );
    writeFixtureFile(
      root,
      "src/runtime.test.ts",
      "const ignored = process.env.TEST_FIXTURE_SECRET;\n",
    );
    writeFixtureFile(
      root,
      "src/__tests__/fixture.ts",
      "const ignored = process.env.DIRECTORY_FIXTURE_SECRET;\n",
    );
    writeFixtureFile(
      root,
      "scripts/intelligence/fixture.mjs",
      "const ignored = process.env.INTELLIGENCE_FIXTURE_SECRET;\n",
    );

    const result = collectConfiguration({ root });
    const variables = result.metadata.environmentVariables;
    const client = variables.find((record) => record.name === "VITE_LITERAL");
    const server = variables.find((record) => record.name === "SERVER_LITERAL");

    expect(variables.map((record) => record.name)).toEqual([
      "SERVER_LITERAL",
      "VITE_LITERAL",
    ]);
    expect(client).toMatchObject({
      classification: "public/client",
      accessStyles: ["import.meta.env['NAME']"],
    });
    expect(server).toMatchObject({
      classification: "server-only",
      accessStyles: ["process.env['NAME']"],
    });
    expect(
      result.warnings.filter((warning) => warning.includes("could not be resolved statically")),
    ).toHaveLength(2);
  });

  it.each([
    ["src", "directory"],
    ["api", "directory"],
    ["scripts", "directory"],
    ["src", "file"],
    ["api", "file"],
    ["scripts", "file"],
  ])("stops environment scanning at a nested .git %s boundary under %s", (rootName, boundaryKind) => {
    const { root } = createFixture();
    const boundaryRoot = `${rootName}/nested-repository`;
    const ignoredName = `${rootName.toUpperCase()}_NESTED_GIT_SECRET`;
    const includedName = `${rootName.toUpperCase()}_ROOT_SOURCE`;

    writeFixtureFile(root, `${rootName}/root-source.ts`, `const included = process.env.${includedName};\n`);
    if (boundaryKind === "directory") {
      mkdirSync(join(root, ...boundaryRoot.split("/"), ".git"), { recursive: true });
    } else {
      writeFixtureFile(root, `${boundaryRoot}/.git`, "gitdir: ../.git/worktrees/nested\n");
    }
    writeFixtureFile(
      root,
      `${boundaryRoot}/nested-source.ts`,
      `const ignored = process.env.${ignoredName};\n`,
    );

    const result = collectConfiguration({ root });
    const names = result.metadata.environmentVariables.map((record) => record.name);

    expect(names).toContain(includedName);
    expect(names).not.toContain(ignoredName);
  });

  it("preserves root configuration and source environment scanning alongside nested Git boundaries", () => {
    const { root } = createFixture();

    writeFixtureFile(root, "vite.config.ts", "const rootValue = process.env.ROOT_CONFIG_VALUE;\n");
    writeFixtureFile(root, "src/root-source.ts", "const sourceValue = process.env.ROOT_SOURCE_VALUE;\n");
    mkdirSync(join(root, "src", "nested-repository", ".git"), { recursive: true });
    writeFixtureFile(
      root,
      "src/nested-repository/nested-source.ts",
      "const ignored = process.env.NESTED_ROOT_SECRET;\n",
    );

    const result = collectConfiguration({ root });
    const names = result.metadata.environmentVariables.map((record) => record.name);

    expect(result.records).toContainEqual(expect.objectContaining({ path: "vite.config.ts", type: "vite" }));
    expect(names).toEqual(["ROOT_CONFIG_VALUE", "ROOT_SOURCE_VALUE"]);
    expect(names).not.toContain("NESTED_ROOT_SECRET");
  });

  it("reports malformed optional configuration without discarding other evidence", () => {
    const { root } = createFixture();

    writeFixtureFile(root, "package.json", '{"name":');
    writeFixtureFile(root, "tsconfig.json", "{ // incomplete");
    writeFixtureFile(root, "vite.config.ts", "export default {};\n");

    const result = collectConfiguration({ root });

    expect(result.status).toBe("partial");
    expect(result.records).toContainEqual(
      expect.objectContaining({ path: "package.json", malformed: true }),
    );
    expect(result.records).toContainEqual(
      expect.objectContaining({ path: "vite.config.ts", type: "vite" }),
    );
    expect(result.warnings.some((warning) => warning.includes("Malformed JSON"))).toBe(true);
    expect(result.warnings.some((warning) => warning.includes("Malformed JSON-like"))).toBe(true);
  });

  it("recognizes TOML array tables and clears malformed section context", () => {
    const { root } = createFixture();

    writeFixtureFile(
      root,
      "netlify.toml",
      [
        "[build]",
        'command = "npm run build"',
        "[[redirects]]",
        'from = "/old"',
        'to = "/new"',
        "[invalid section]",
        'publish = "dist"',
      ].join("\n"),
    );

    const result = collectConfiguration({ root });
    const netlify = result.records.find((record) => record.path === "netlify.toml");

    expect(result.status).toBe("partial");
    expect(netlify.settings.sections).toEqual(["build", "redirects"]);
    expect(netlify.settings.keys).toEqual([
      "build.command",
      "publish",
      "redirects.from",
      "redirects.to",
    ]);
    expect(netlify.malformed).toBe(true);
  });

  it("does not read configuration symlinks, including links that stay inside the root", () => {
    const { directory, root } = createFixture();
    writeFixtureFile(root, "target.json", JSON.stringify({ name: "inside-target" }));
    writeFileSync(join(directory, "outside.json"), JSON.stringify({ name: "outside-target" }));

    try {
      symlinkSync(join(root, "target.json"), join(root, "package.json"), "file");
      symlinkSync(join(directory, "outside.json"), join(root, "tsconfig.json"), "file");
    } catch {
      return;
    }

    const result = collectConfiguration({ root });

    expect(result.status).toBe("partial");
    expect(result.records).not.toContainEqual(expect.objectContaining({ path: "package.json" }));
    expect(result.warnings).toContain("A recognized configuration path used a symbolic link.");
  });
});

describe("repository intelligence delivery", () => {
  it("collects workflow metadata, delivery scripts, and variable names without values", () => {
    const { root } = createFixture();
    const staticSecret = ["fixture", "-workflow", "-secret"].join("");

    writeFixtureFile(
      root,
      "package.json",
      packageFixture({
        scripts: {
          build: "vite build",
          deploy: "vercel --prod",
          test: "vitest run",
        },
      }),
    );
    writeFixtureFile(
      root,
      ".github/workflows/deploy.yml",
      [
        "name: Fixture Delivery",
        "on:",
        "  push:",
        "    branches: [main]",
        "  workflow_dispatch:",
        "jobs:",
        "  deploy:",
        "    runs-on: [ubuntu-latest, self-hosted]",
        "    env:",
        "      DEPLOY_REGION: us-west-2",
        "      API_TOKEN: ${{ secrets.API_TOKEN }}",
        `      STATIC_SECRET: ${staticSecret}`,
        "    steps:",
        "      - run: npm run build",
        "      - run: npm run deploy",
        "      - run: echo $DEPLOY_REGION",
      ].join("\n"),
    );
    writeFixtureFile(
      root,
      "vercel.json",
      JSON.stringify({ redirects: [{}], rewrites: [{}, {}] }),
    );
    writeFixtureFile(
      root,
      "netlify.toml",
      [
        "[build]",
        "command = \"npm run build\"",
        "[[redirects]]",
        "from = \"/old\"",
        "to = \"/new\"",
      ].join("\n"),
    );
    writeFixtureFile(
      root,
      "supabase/config.toml",
      ["project_id = \"fixture\"", "[api]", "enabled = true", "key = \"env(SUPABASE_KEY)\""].join("\n"),
    );

    const result = collectDelivery({ root });
    const workflow = result.records.find((record) => record.type === "github-workflow");
    const serialized = JSON.stringify(result);

    expect(result.status).toBe("complete");
    expect(workflow.name).toBe("Fixture Delivery");
    expect(workflow.triggers).toEqual(["push", "workflow_dispatch"]);
    expect(workflow.jobs).toContainEqual(
      expect.objectContaining({
        id: "deploy",
        runners: ["self-hosted", "ubuntu-latest"],
        npmScripts: ["build", "deploy"],
      }),
    );
    expect(workflow.environmentVariables.map((entry) => entry.name)).toEqual(
      expect.arrayContaining(["API_TOKEN", "DEPLOY_REGION", "STATIC_SECRET"]),
    );
    // C5 (S5): provenance is typed, and a name legitimately reached through more than
    // one source (declared in env:, then referenced via bare `$NAME` in a run step)
    // keeps every provenance it actually has instead of collapsing to one.
    expect(
      workflow.environmentVariables.find((entry) => entry.name === "DEPLOY_REGION"),
    ).toEqual({ name: "DEPLOY_REGION", provenance: ["env-declaration", "shell"] });
    expect(
      workflow.environmentVariables.find((entry) => entry.name === "API_TOKEN"),
    ).toEqual({ name: "API_TOKEN", provenance: ["env-declaration"] });
    expect(workflow.secretNames).toEqual([
      { name: "API_TOKEN", provenance: ["secret-reference"] },
    ]);
    expect(result.metadata.deploymentScripts).toContainEqual(
      expect.objectContaining({ name: "build", kind: "build" }),
    );
    expect(result.metadata.deploymentScripts).toContainEqual(
      expect.objectContaining({ name: "deploy", kind: "deployment" }),
    );
    expect(result.records).toContainEqual(
      expect.objectContaining({ path: "supabase/config.toml", type: "supabase" }),
    );
    expect(serialized).not.toContain(staticSecret);
  });

  it("uses env-block indentation instead of unrelated workflow mappings", () => {
    const { root } = createFixture();

    writeFixtureFile(
      root,
      ".github/workflows/env-blocks.yml",
      [
        "name: Environment Blocks",
        "on: push",
        "env:",
        "  GLOBAL_ENV: global-value",
        "jobs:",
        "  deploy:",
        "    runs-on: ubuntu-latest",
        "    env:",
        "      JOB_ENV: job-value",
        "    steps:",
        "      - name: Configure",
        "        with:",
        "          UNRELATED_INPUT: literal-value",
        "        env:",
        "          STEP_ENV: step-value",
      ].join("\n"),
    );

    const result = collectDelivery({ root });
    const workflow = result.records.find((record) => record.type === "github-workflow");
    const deploy = workflow.jobs.find((job) => job.id === "deploy");

    expect(result.status).toBe("complete");
    expect(workflow.environmentVariables).toEqual([
      { name: "GLOBAL_ENV", provenance: ["env-declaration"] },
      { name: "JOB_ENV", provenance: ["env-declaration"] },
      { name: "STEP_ENV", provenance: ["env-declaration"] },
    ]);
    expect(deploy.environmentVariables).toEqual([
      { name: "JOB_ENV", provenance: ["env-declaration"] },
      { name: "STEP_ENV", provenance: ["env-declaration"] },
    ]);
    expect(workflow.environmentVariables.map((entry) => entry.name)).not.toContain(
      "UNRELATED_INPUT",
    );
  });

  it("tags bare shell references as provenance 'shell' and excludes CI/OS builtins (S5, RI-WORKFLOW-FLATTEN)", () => {
    const { root } = createFixture();

    writeFixtureFile(
      root,
      ".github/workflows/shell-refs.yml",
      [
        "name: Shell References",
        "on: push",
        "jobs:",
        "  build:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - run: echo $GITHUB_SHA",
        "      - run: echo ${RUNNER_OS}",
        "      - run: echo $CI",
        "      - run: echo $PATH",
        "      - run: echo $CUSTOM_DEPLOY_TARGET",
      ].join("\n"),
    );

    const result = collectDelivery({ root });
    const workflow = result.records.find((record) => record.type === "github-workflow");
    const names = workflow.environmentVariables.map((entry) => entry.name);

    expect(names).not.toContain("GITHUB_SHA");
    expect(names).not.toContain("RUNNER_OS");
    expect(names).not.toContain("CI");
    expect(names).not.toContain("PATH");
    expect(workflow.environmentVariables).toContainEqual({
      name: "CUSTOM_DEPLOY_TARGET",
      provenance: ["shell"],
    });
  });

  it("reports malformed YAML-like and TOML delivery input as partial", () => {
    const { root } = createFixture();

    writeFixtureFile(root, ".github/workflows/broken.yml", "name: Broken\n\tbad: true\n");
    writeFixtureFile(root, "netlify.toml", "[build\ncommand = \"npm run build\"\n");

    const result = collectDelivery({ root });

    expect(result.status).toBe("partial");
    expect(result.warnings.some((warning) => warning.includes("YAML-like workflow"))).toBe(true);
    expect(result.warnings.some((warning) => warning.includes("TOML-like delivery"))).toBe(true);
    expect(result.records).toContainEqual(
      expect.objectContaining({ path: ".github/workflows/broken.yml", malformed: true }),
    );
  });

  it("does not read delivery symlinks, including links that stay inside the root", () => {
    const { directory, root } = createFixture();
    writeFixtureFile(root, "workflow-target.yml", "name: Target\non: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n");
    writeFileSync(join(directory, "workflow-outside.yml"), "name: Outside\non: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n");
    const linkPath = join(root, ".github", "workflows", "linked.yml");
    const outsideLinkPath = join(root, ".github", "workflows", "outside.yml");
    mkdirSync(dirname(linkPath), { recursive: true });

    try {
      symlinkSync(join(root, "workflow-target.yml"), linkPath, "file");
      symlinkSync(join(directory, "workflow-outside.yml"), outsideLinkPath, "file");
    } catch {
      return;
    }

    const result = collectDelivery({ root });

    expect(result.status).toBe("partial");
    expect(result.records).not.toContainEqual(
      expect.objectContaining({ path: ".github/workflows/linked.yml" }),
    );
    expect(result.records).not.toContainEqual(
      expect.objectContaining({ path: ".github/workflows/outside.yml" }),
    );
    expect(result.warnings).toContain("A recognized delivery path used a symbolic link.");
  });
});
