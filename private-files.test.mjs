import { describe, expect, it } from "vitest";

import { isEnvironmentFile, isPrivateEnvironmentFile } from "./lib/private-files.mjs";

describe("isEnvironmentFile", () => {
  it("matches .env and its dotenv variants", () => {
    expect(isEnvironmentFile(".env")).toBe(true);
    expect(isEnvironmentFile(".env.local")).toBe(true);
    expect(isEnvironmentFile(".env.production")).toBe(true);
    expect(isEnvironmentFile("api/.env")).toBe(true);
  });

  it("matches a file whose extension is literally .env", () => {
    expect(isEnvironmentFile("config/settings.env")).toBe(true);
  });

  it("also matches .env.example (S7: not the right check for read-safety, see isPrivateEnvironmentFile)", () => {
    expect(isEnvironmentFile(".env.example")).toBe(true);
  });

  it("does not match unrelated files", () => {
    expect(isEnvironmentFile("README.md")).toBe(false);
    expect(isEnvironmentFile("src/environment.ts")).toBe(false);
    expect(isEnvironmentFile("envfile.txt")).toBe(false);
  });
});

describe("isPrivateEnvironmentFile", () => {
  it("matches real dotenv files, same as isEnvironmentFile", () => {
    expect(isPrivateEnvironmentFile(".env")).toBe(true);
    expect(isPrivateEnvironmentFile(".env.local")).toBe(true);
    expect(isPrivateEnvironmentFile("api/.env")).toBe(true);
    expect(isPrivateEnvironmentFile("config/settings.env")).toBe(true);
  });

  it("excludes .env.example, the one known-safe template file", () => {
    expect(isPrivateEnvironmentFile(".env.example")).toBe(false);
    expect(isPrivateEnvironmentFile("api/.env.example")).toBe(false);
  });

  it("does not match unrelated files", () => {
    expect(isPrivateEnvironmentFile("README.md")).toBe(false);
    expect(isPrivateEnvironmentFile("src/environment.ts")).toBe(false);
  });
});
