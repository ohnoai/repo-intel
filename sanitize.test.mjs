import { describe, expect, it } from "vitest";

import {
  assertSanitizedMetadata,
  assertSanitizedText,
  findUnsanitizedLocalPaths,
  normalizeRepositoryPath,
  sanitizeCommandMetadata,
  sanitizeEnvironmentComment,
  sanitizeMetadataText,
  sanitizeRemoteUrl,
  sanitizeText,
  validateSanitizedMetadata,
  validateSanitizedText,
} from "./lib/sanitize.mjs";

describe("repository intelligence sanitization", () => {
  it("normalizes Windows repository paths", () => {
    expect(
      normalizeRepositoryPath(
        String.raw`.\scripts\intelligence\lib\sanitize.mjs`,
      ),
    ).toBe("scripts/intelligence/lib/sanitize.mjs");
  });

  it("removes credentials from HTTPS Git remotes", () => {
    expect(
      sanitizeRemoteUrl(
        "https://joey:terrible-password@example.com/owner/repo.git?token=bad#fragment",
      ),
    ).toBe("https://example.com/owner/repo.git");
  });

  it("redacts local metadata paths without corrupting HTTPS URLs", () => {
    const windowsPath = String.raw`C:\Users\fixture\private-build`;
    const posixPath = "/tmp/fixture/private-build";
    const localUri = "file:///tmp/fixture/private-build";
    const httpsUrl = "https://example.test/Users/repository";
    const nestedHttpsUrl = "https://example.test/file:///tmp/repository";
    const output = sanitizeMetadataText(
      `${windowsPath} ${posixPath} ${localUri} ${httpsUrl} ${nestedHttpsUrl}`,
    );

    expect(output).not.toContain(windowsPath);
    expect(output).not.toContain(posixPath);
    expect(output).not.toContain(localUri);
    expect(output).toContain(httpsUrl);
    expect(output).toContain(nestedHttpsUrl);
    expect(output).toContain("[REDACTED:local-path]");
  });

  it("redacts command credential flags and environment assignments", () => {
    const token = ["fixture", "-command", "-token"].join("");
    const apiKey = ["fixture", "-api", "-key"].join("");
    const environmentValue = ["fixture", "-environment", "-value"].join("");
    const output = sanitizeCommandMetadata(
      `DEPLOY_REGION=${environmentValue} deploy --token=${token} --api-key ${apiKey}`,
    );

    expect(output).not.toContain(token);
    expect(output).not.toContain(apiKey);
    expect(output).not.toContain(environmentValue);
    expect(output).toContain("DEPLOY_REGION=[REDACTED:environment-value]");
    expect(output).toContain("--token=[REDACTED:credential-flag]");
    expect(output).toContain("--api-key [REDACTED:credential-flag]");
  });

  it("bounds environment comments and rejects value-like descriptions", () => {
    const longComment = Array.from({ length: 40 }, () => "documentation").join(" ");

    expect(sanitizeEnvironmentComment("Server-only token")).toBe("Server-only token");
    expect(sanitizeEnvironmentComment("API_TOKEN=fixture-value")).toBe("");
    expect(sanitizeEnvironmentComment("Token: fixture-value")).toBe("");
    expect(sanitizeEnvironmentComment(longComment)).toHaveLength(240);
  });

  it("drops prose-embedded mixed-alphanumeric secret-like values", () => {
    expect(
      sanitizeEnvironmentComment(
        "Rotate at portal. Current live value is livePlainSecret777 today.",
      ),
    ).toBe("");
    expect(
      sanitizeEnvironmentComment(
        "Ask ops for the current key a1b2c3d4e5f6g7h8",
      ),
    ).toBe("");
    expect(
      sanitizeEnvironmentComment(
        "Bucket uses AKIAIOSFODNN7NOTREAL for access",
      ),
    ).toBe("");
    expect(
      sanitizeEnvironmentComment(
        "Plain documentation sentence with no values at all",
      ),
    ).toBe("Plain documentation sentence with no values at all");
  });

  it("drops webhook signing keys embedded in comments", () => {
    expect(sanitizeEnvironmentComment("Webhook signing key is abc12345")).toBe("");
  });

  it("preserves safe descriptive environment comments", () => {
    expect(
      sanitizeEnvironmentComment(
        "Public origin used for hosted share pages when the setting is unset.",
      ),
    ).toBe(
      "Public origin used for hosted share pages when the setting is unset.",
    );
    expect(
      sanitizeEnvironmentComment("Passkeys use the WebAuthn relying-party ID."),
    ).toBe("Passkeys use the WebAuthn relying-party ID.");
  });

  it("removes credentials and query strings from SSH Git remotes", () => {
    const username = ["fixture", "user"].join("-");
    const password = ["not", "-a", "-credential"].join("");
    const query = ["access", "_token=fixture", "-value"].join("");
    const remote = `ssh://${username}:${password}@example.com/owner/repo.git?${query}#fragment`;

    expect(sanitizeRemoteUrl(remote)).toBe("ssh://example.com/owner/repo.git");
  });

  it("redacts local filesystem remote paths", () => {
    expect(sanitizeRemoteUrl(String.raw`\\fixture-server\private-repo`)).toBe(
      "[REDACTED:local-remote]",
    );
  });

  it("redacts relative local Git remotes", () => {
    expect(sanitizeRemoteUrl("../mirror")).toBe("[REDACTED:local-remote]");
  });

  it("redacts high-confidence credential formats", () => {
    const sensitiveValues = [
      "sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890",
      "sk_live_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890",
      "whsec_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890",
      "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890",
      "xoxb-123456789012-ABCDEFGHIJKLMNOPQRSTUVWXYZ",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signaturevalue",
      "joey@example.com",
      "very-secret-password",
    ];

    const input = [
      "Authorization: Bearer bearer-secret-value-123456789",
      `ANTHROPIC_API_KEY=${sensitiveValues[0]}`,
      `STRIPE_SECRET_KEY=${sensitiveValues[1]}`,
      `STRIPE_WEBHOOK_SECRET=${sensitiveValues[2]}`,
      `GITHUB_TOKEN=${sensitiveValues[3]}`,
      `SLACK_TOKEN=${sensitiveValues[4]}`,
      `SESSION_TOKEN=${sensitiveValues[5]}`,
      `Contact: ${sensitiveValues[6]}`,
      "DATABASE_URL=postgres://database-user:database-password@localhost:5432/app",
      `SMTP_PASSWORD="${sensitiveValues[7]}"`,
      "-----BEGIN PRIVATE KEY-----",
      "super-secret-private-key-material",
      "-----END PRIVATE KEY-----",
    ].join("\n");

    const result = sanitizeText(input);

    for (const value of sensitiveValues) {
      expect(result.text).not.toContain(value);
    }

    expect(result.text).not.toContain("database-user");
    expect(result.text).not.toContain("database-password");
    expect(result.text).not.toContain(
      "super-secret-private-key-material",
    );

    expect(result.redactionCount).toBeGreaterThan(0);
    expect(() => assertSanitizedText(result.text)).not.toThrow();
  });

  it("preserves environment-variable references and placeholders", () => {
    const input = [
      "const token = process.env.ACCESS_TOKEN;",
      "const secret = import.meta.env.VITE_SUPABASE_ANON_KEY;",
      "VITE_SUPABASE_ANON_KEY=your-anon-or-publishable-key",
      'const environmentName = "STRIPE_WEBHOOK_SECRET";',
    ].join("\n");

    const result = sanitizeText(input, { redactEmails: false });

    expect(result.text).toBe(input);
    expect(result.redactionCount).toBe(0);
  });

  it("redacts generic secret-like literal assignments", () => {
    const result = sanitizeText(
      'SMTP_PASSWORD="this-is-an-actual-password"',
      { redactEmails: false },
    );

    expect(result.text).toBe(
      'SMTP_PASSWORD="[REDACTED:secret-literal]"',
    );
  });

  it("reports unsanitized sensitive content", () => {
    const validation = validateSanitizedText(
      "GITHUB_TOKEN=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890",
    );

    expect(validation.ok).toBe(false);
    expect(validation.findings.length).toBeGreaterThan(0);
  });

  it("produces deterministic output", () => {
    const input = [
      "Authorization: Bearer deterministic-secret-123456",
      "owner@example.com",
    ].join("\n");

    expect(sanitizeText(input)).toEqual(sanitizeText(input));
  });

  describe("metadata-tier local-path superset (S1 privacy boundary)", () => {
    const positiveLocalPathFixtures = [
      ["previously-missing allowlist root /usr", "build log at /usr/local/bin/node failed"],
      ["previously-missing allowlist root /srv", "deployed from /srv/data/app"],
      ["previously-missing allowlist root /data", "cache dir is /data/cache"],
      ["already-covered allowlist root /home", "see /home/joey/project for details"],
      ["Windows drive-letter path", String.raw`build failed at C:\Users\joey\project\file.ts`],
      ["UNC path", String.raw`copied from \\build-server\share\out.log`],
      ["file:// URI", "backup at file:///tmp/fixture/private-build"],
      ["non-allowlisted root, 3+ segments", "artifact at /build/output/app/report.log"],
      ["non-allowlisted root, 2 segments with extension", "artifact at /build2/report.log"],
      ["PowerShell $env: assignment", "$env:SLICEBOARD_TOKEN=super-secret-value"],
      [
        "PowerShell SetEnvironmentVariable call",
        '[Environment]::SetEnvironmentVariable("SLICEBOARD_TOKEN", "super-secret-value")',
      ],
    ];

    const negativeRouteFixtures = [
      ["Stripe webhook route", "posts to /api/stripe-webhook on deploy"],
      ["share-page route with param", "renders /s/:id for shared boards"],
    ];

    it.each(positiveLocalPathFixtures)(
      "redacts and fatal-flags: %s",
      (_label, text) => {
        expect(findUnsanitizedLocalPaths(text).length).toBeGreaterThan(0);
        expect(() => assertSanitizedMetadata(text)).toThrow(/Sanitization validation failed/);

        const sanitized = sanitizeMetadataText(text);
        expect(sanitized).not.toBe(text);
        expect(findUnsanitizedLocalPaths(sanitized)).toEqual([]);
        expect(() => assertSanitizedMetadata(sanitized)).not.toThrow();
      },
    );

    it.each(negativeRouteFixtures)(
      "never fatal-flags SliceBoard's own routes: %s",
      (_label, text) => {
        expect(findUnsanitizedLocalPaths(text)).toEqual([]);
        expect(sanitizeMetadataText(text)).toBe(text);
        expect(() => assertSanitizedMetadata(text)).not.toThrow();
      },
    );

    it("redactor is a superset of the validator (redact-then-validate never fatals)", () => {
      for (const [, text] of [...positiveLocalPathFixtures, ...negativeRouteFixtures]) {
        const sanitized = sanitizeMetadataText(text);
        expect(() => assertSanitizedMetadata(sanitized)).not.toThrow();
      }
    });

    it("never re-flags its own [REDACTED:*] sentinels", () => {
      const sentinelText =
        "[REDACTED:local-path] and [REDACTED:environment-value] and [REDACTED:email]";
      expect(findUnsanitizedLocalPaths(sentinelText)).toEqual([]);
      expect(sanitizeMetadataText(sentinelText)).toBe(sentinelText);
      expect(() => assertSanitizedMetadata(sentinelText)).not.toThrow();
    });

    it("validateSanitizedMetadata still catches secrets and emails (superset of validateSanitizedText)", () => {
      const withSecret = "GITHUB_TOKEN=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890";
      expect(validateSanitizedMetadata(withSecret).ok).toBe(false);
      expect(validateSanitizedText(withSecret).ok).toBe(false);
    });

    it("validation is independent of the redactor's own allowlist (RI-VALIDATOR regression)", () => {
      // A hand-built "already sanitized" string that never went through the redactor
      // must still be caught if it contains an unredacted local path or $env: leak -
      // the validator does not trust its input, only its own detectors.
      const unvalidatedLeak = "reference build output at /data/build/output/app.js";
      expect(() => assertSanitizedMetadata(unvalidatedLeak)).toThrow();
    });
  });
});
