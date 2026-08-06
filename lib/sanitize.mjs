const REDACTIONS = Object.freeze({
  privateKey: "[REDACTED:private-key]",
  bearerToken: "[REDACTED:bearer-token]",
  apiToken: "[REDACTED:api-token]",
  stripeSecret: "[REDACTED:stripe-secret]",
  webhookSecret: "[REDACTED:webhook-secret]",
  githubToken: "[REDACTED:github-token]",
  slackToken: "[REDACTED:slack-token]",
  jwt: "[REDACTED:jwt]",
  username: "[REDACTED:username]",
  password: "[REDACTED:password]",
  email: "[REDACTED:email]",
  secretLiteral: "[REDACTED:secret-literal]",
  environmentValue: "[REDACTED:environment-value]",
  credentialFlag: "[REDACTED:credential-flag]",
  localPath: "[REDACTED:local-path]",
});

const HIGH_CONFIDENCE_PATTERNS = [
  {
    id: "private_key",
    label: "Private key block",
    regex:
      /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g,
    replacement: REDACTIONS.privateKey,
  },
  {
    id: "authorization_bearer",
    label: "Bearer authorization token",
    regex: /\b(Authorization\s*:\s*Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi,
    replacement: (_match, prefix) => `${prefix}${REDACTIONS.bearerToken}`,
  },
  {
    id: "anthropic_api_key",
    label: "Anthropic API key",
    regex: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
    replacement: REDACTIONS.apiToken,
  },
  {
    id: "openai_api_key",
    label: "OpenAI-style API key",
    regex: /\bsk-[A-Za-z0-9_-]{20,}\b/g,
    replacement: REDACTIONS.apiToken,
  },
  {
    id: "stripe_secret_key",
    label: "Stripe secret key",
    regex: /\bsk_(?:live|test)_[A-Za-z0-9]{20,}\b/g,
    replacement: REDACTIONS.stripeSecret,
  },
  {
    id: "stripe_webhook_secret",
    label: "Stripe webhook secret",
    regex: /\bwhsec_[A-Za-z0-9]{20,}\b/g,
    replacement: REDACTIONS.webhookSecret,
  },
  {
    id: "github_token",
    label: "GitHub token",
    regex: /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g,
    replacement: REDACTIONS.githubToken,
  },
  {
    id: "slack_token",
    label: "Slack token",
    regex: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g,
    replacement: REDACTIONS.slackToken,
  },
  {
    id: "jwt",
    label: "JSON Web Token",
    regex: /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g,
    replacement: REDACTIONS.jwt,
  },
  {
    id: "credential_url",
    label: "Credentials embedded in URL",
    regex: /\b([a-z][a-z0-9+.-]*:\/\/)([^:\s/@]+):([^@\s/]+)@/gi,
replacement: (_match, protocol) => protocol,
  },
];

const EMAIL_PATTERN =
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;

const SECRET_ASSIGNMENT_PATTERN =
  /^(\s*["']?[A-Za-z0-9_]*(?:SECRET|TOKEN|PASSWORD|PRIVATE_KEY|SERVICE_ROLE|API_KEY|WEBHOOK)[A-Za-z0-9_]*["']?\s*[:=]\s*)(["']?)([^"'\s,;}{]+)\2(.*)$/gim;

const CREDENTIAL_FLAG_PATTERN =
  /(--(?:token|auth(?:entication)?|password|passwd|api[-_]?key|secret|credentials?|access[-_]?token|client[-_]?secret)(?:=|\s+))(?:"[^"]*"|'[^']*'|(?!-)\S+)/gi;

const COMMAND_ENVIRONMENT_ASSIGNMENT_PATTERN =
  /(^|[\s;&|])([A-Za-z_][A-Za-z0-9_]*=)(?:"[^"]*"|'[^']*'|[^\s;&|]+)/g;

const SUSPICIOUS_COMMENT_TOKEN_PATTERN =
  /[A-Za-z0-9+/_=-]{32,}|\b(?=[A-Za-z0-9]*[0-9])(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{12,}\b/;
const ENVIRONMENT_ASSIGNMENT_COMMENT_PATTERN =
  /(?:^|\s)[A-Za-z_][A-Za-z0-9_]*\s*=/;
const SUSPICIOUS_COMMENT_VALUE_PATTERN =
  /\b(?:api[-_ ]?key|access[-_ ]?key|signing[-_ ]?key|webhook[-_ ]?key|token|password|secret|credential)\s*(?:[:=]|\bis\b)\s*[^\s]+/i;

function cloneRegex(regex) {
  return new RegExp(regex.source, regex.flags);
}

// Filesystem-root segments treated as local/private regardless of what follows them.
// Shared by the redactor and the fatal validator so neither can drift from the other
// (the "constrained superset" invariant: whatever the validator flags, the redactor
// must already have redacted).
const LOCAL_ROOT_SEGMENTS = new Set([
  "home",
  "users",
  "root",
  "opt",
  "mnt",
  "tmp",
  "var",
  "etc",
  "private",
  "volumes",
  "workspace",
  "usr",
  "srv",
  "data",
]);

const DRIVE_PATH_PATTERN = /(^|[\s"'`=(])([A-Za-z]:[\\/][^\s"'`)<>{}\],;]+)/g;
const UNC_PATH_PATTERN = /(^|[\s"'`=(])(\\\\[^\s"'`)<>{}\],;]+)/g;
const FILE_URL_PATTERN = /(^|[\s"'`=(])(file:\/\/(?:\/)?[^\s"'`)<>{}\],;]+)/gi;
const POSIX_PATH_TOKEN_PATTERN = /(^|[\s"'`=(])(\/[^\s"'`)<>{}\],;]+)/g;

// PowerShell environment assignment shapes. Redacted regardless of host OS, since
// this tool's evidence may be inspected on Windows too.
const POWERSHELL_ENV_ASSIGNMENT_PATTERN =
  /(\$env:[A-Za-z_][A-Za-z0-9_]*\s*=\s*)(?:"[^"]*"|'[^']*'|(?!\[REDACTED:)[^\s;]+)/gi;
const POWERSHELL_SET_ENV_PATTERN =
  /(\[Environment\]::SetEnvironmentVariable\(\s*(["'])[^"']*\2\s*,\s*)(["'])[^"']*\3/gi;

// Deliberately NOT "any leading slash" - that would fatal on route strings like
// "/api/stripe-webhook" or "/s/:id". A POSIX absolute path is treated as a
// local-filesystem leak when its first segment is a known root, or it is deep enough
// / shaped enough (3+ segments, or 2 segments with a file-extension-like tail) to look
// like a real path rather than a route. This heuristic is tuned against a real route
// corpus (see the negative fixtures in the test suite) and may need broadening for
// deeper route shapes in a given target repository.
function posixPathSegments(candidate) {
  return candidate.split("/").filter(Boolean);
}

function isSuspiciousPosixPath(candidate) {
  const segments = posixPathSegments(candidate);
  if (segments.length === 0) return false;
  if (LOCAL_ROOT_SEGMENTS.has(segments[0].toLowerCase())) return true;
  if (segments.length >= 3) return true;
  if (segments.length === 2) {
    const last = segments[1];
    return !last.includes(":") && /\.[A-Za-z0-9]{1,6}$/.test(last);
  }
  return false;
}

// The validator's local-path/PowerShell-env detectors. Used both to decide what the
// redactor rewrites and, independently, to fatal-check text that has already been
// through the redactor - never gated on the redactor's own allowlist.
export function findUnsanitizedLocalPaths(input) {
  const text = String(input ?? "");
  const findings = [];

  const driveMatches = text.match(cloneRegex(DRIVE_PATH_PATTERN));
  appendFinding(findings, "local_path_drive", "Windows drive-letter path", driveMatches?.length ?? 0);

  const uncMatches = text.match(cloneRegex(UNC_PATH_PATTERN));
  appendFinding(findings, "local_path_unc", "UNC path", uncMatches?.length ?? 0);

  const fileUrlMatches = text.match(cloneRegex(FILE_URL_PATTERN));
  appendFinding(findings, "local_path_file_url", "file:// URI", fileUrlMatches?.length ?? 0);

  let posixCount = 0;
  for (const match of text.matchAll(cloneRegex(POSIX_PATH_TOKEN_PATTERN))) {
    if (isSuspiciousPosixPath(match[2])) posixCount += 1;
  }
  appendFinding(findings, "local_path_posix", "Local filesystem path", posixCount);

  const envAssignmentMatches = text.match(cloneRegex(POWERSHELL_ENV_ASSIGNMENT_PATTERN));
  appendFinding(
    findings,
    "powershell_env_assignment",
    "PowerShell $env: assignment",
    envAssignmentMatches?.length ?? 0,
  );

  const setEnvMatches = text.match(cloneRegex(POWERSHELL_SET_ENV_PATTERN));
  appendFinding(
    findings,
    "powershell_set_env",
    "PowerShell SetEnvironmentVariable call",
    setEnvMatches?.length ?? 0,
  );

  return findings;
}

function shouldPreserveAssignmentValue(value) {
  const candidate = value.trim();

  return (
    candidate.startsWith("[REDACTED:") ||
    /^(?:process\.env\.|import\.meta\.env\.)/i.test(candidate) ||
    /^(?:your[-_]|example[-_]?|placeholder[-_]?)/i.test(candidate) ||
    /^(?:undefined|null|true|false)$/i.test(candidate) ||
    /^[A-Z][A-Z0-9_]+$/.test(candidate) ||
    candidate.startsWith("${") ||
    candidate.startsWith("<")
  );
}

function appendFinding(findings, id, label, count) {
  if (count > 0) {
    findings.push({ id, label, count });
  }
}

function replacePattern(input, pattern, findings) {
  let count = 0;

  const text = input.replace(cloneRegex(pattern.regex), (...args) => {
    count += 1;

    return typeof pattern.replacement === "function"
      ? pattern.replacement(...args)
      : pattern.replacement;
  });

  appendFinding(findings, pattern.id, pattern.label, count);
  return text;
}

function redactSecretAssignments(input, findings) {
  let count = 0;

  const text = input.replace(
    cloneRegex(SECRET_ASSIGNMENT_PATTERN),
    (match, prefix, quote, value, suffix) => {
      if (shouldPreserveAssignmentValue(value)) {
        return match;
      }

      count += 1;
      return `${prefix}${quote}${REDACTIONS.secretLiteral}${quote}${suffix}`;
    },
  );

  appendFinding(
    findings,
    "secret_literal_assignment",
    "Secret-like literal assignment",
    count,
  );

  return text;
}

export function normalizeRepositoryPath(input) {
  return String(input)
    .replace(/\\/g, "/")
    .replace(/^(?:\.\/)+/, "")
    .replace(/\/{2,}/g, "/");
}

function redactLocalAbsolutePaths(input) {
  let text = String(input ?? "");

  text = text.replace(
    cloneRegex(DRIVE_PATH_PATTERN),
    (_match, prefix) => `${prefix}${REDACTIONS.localPath}`,
  );
  text = text.replace(
    cloneRegex(UNC_PATH_PATTERN),
    (_match, prefix) => `${prefix}${REDACTIONS.localPath}`,
  );
  text = text.replace(
    cloneRegex(FILE_URL_PATTERN),
    (_match, prefix) => `${prefix}${REDACTIONS.localPath}`,
  );
  text = text.replace(
    cloneRegex(POSIX_PATH_TOKEN_PATTERN),
    (fullMatch, prefix, candidate) =>
      isSuspiciousPosixPath(candidate) ? `${prefix}${REDACTIONS.localPath}` : fullMatch,
  );
  text = text.replace(
    cloneRegex(POWERSHELL_ENV_ASSIGNMENT_PATTERN),
    (_match, prefix) => `${prefix}${REDACTIONS.environmentValue}`,
  );
  text = text.replace(
    cloneRegex(POWERSHELL_SET_ENV_PATTERN),
    (_match, prefix) => `${prefix}${REDACTIONS.environmentValue}`,
  );

  return text;
}

export function sanitizeMetadataText(input) {
  return redactLocalAbsolutePaths(sanitizeText(input).text);
}

export function sanitizeCommandMetadata(input) {
  const text = sanitizeMetadataText(input).replace(
    COMMAND_ENVIRONMENT_ASSIGNMENT_PATTERN,
    (_match, prefix, name) => `${prefix}${name}${REDACTIONS.environmentValue}`,
  );

  return text.replace(
    CREDENTIAL_FLAG_PATTERN,
    (_match, flag) => `${flag}${REDACTIONS.credentialFlag}`,
  );
}

export function sanitizeEnvironmentComment(input) {
  const text = sanitizeMetadataText(input).trim();

  if (
    !text ||
    ENVIRONMENT_ASSIGNMENT_COMMENT_PATTERN.test(text) ||
    SUSPICIOUS_COMMENT_TOKEN_PATTERN.test(text) ||
    SUSPICIOUS_COMMENT_VALUE_PATTERN.test(text)
  ) {
    return "";
  }

  return text.slice(0, 240);
}

export function normalizeAndSanitizeRepositoryPath(input) {
  return normalizeRepositoryPath(sanitizeMetadataText(normalizeRepositoryPath(input)));
}

export function sanitizeRemoteUrl(input) {
  const value = String(input || "").trim();
  if (!value) return "";

  if (/^(?:[\\/]+|[A-Za-z]:[\\/])/.test(value)) {
    return "[REDACTED:local-remote]";
  }

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    try {
      const url = new URL(value);

      if (url.protocol === "file:") {
        return "[REDACTED:local-remote]";
      }

      url.username = "";
      url.password = "";
      url.search = "";
      url.hash = "";
      return url.toString();
    } catch {
      // Fall through to the conservative non-URL cleanup below.
    }
  }

  const withoutQueryOrFragment = value.replace(/[?#].*$/, "");
  const scpLike = withoutQueryOrFragment.match(
    /^(?:[^@\s/:]+@)?([^:\s/]+):(.*)$/,
  );

  if (scpLike) {
    return `${sanitizeText(scpLike[1]).text}:${sanitizeText(scpLike[2]).text}`;
  }

  return "[REDACTED:local-remote]";
}

export function sanitizeText(input, { redactEmails = true } = {}) {
  let text = String(input ?? "");
  const findings = [];

  for (const pattern of HIGH_CONFIDENCE_PATTERNS) {
    text = replacePattern(text, pattern, findings);
  }

  text = redactSecretAssignments(text, findings);

  if (redactEmails) {
    let emailCount = 0;

    text = text.replace(cloneRegex(EMAIL_PATTERN), () => {
      emailCount += 1;
      return REDACTIONS.email;
    });

    appendFinding(findings, "email", "Email address", emailCount);
  }

  const redactionCount = findings.reduce(
    (total, finding) => total + finding.count,
    0,
  );

  return {
    text,
    findings,
    redactionCount,
  };
}

export function validateSanitizedText(
  input,
  { allowEmails = false } = {},
) {
  const text = String(input ?? "");
  const findings = [];

  for (const pattern of HIGH_CONFIDENCE_PATTERNS) {
    const matches = text.match(cloneRegex(pattern.regex));

    if (matches?.length) {
      findings.push({
        id: pattern.id,
        label: pattern.label,
        count: matches.length,
      });
    }
  }

  const assignmentMatches = [];

  for (const match of text.matchAll(cloneRegex(SECRET_ASSIGNMENT_PATTERN))) {
    const value = match[3];

    if (!shouldPreserveAssignmentValue(value)) {
      assignmentMatches.push(match);
    }
  }

  appendFinding(
    findings,
    "secret_literal_assignment",
    "Secret-like literal assignment",
    assignmentMatches.length,
  );

  if (!allowEmails) {
    const emailMatches = text.match(cloneRegex(EMAIL_PATTERN));

    appendFinding(
      findings,
      "email",
      "Email address",
      emailMatches?.length ?? 0,
    );
  }

  return {
    ok: findings.length === 0,
    findings,
  };
}

export function assertSanitizedText(input, options) {
  const validation = validateSanitizedText(input, options);

  if (!validation.ok) {
    const detail = validation.findings
      .map((finding) => `${finding.label} (${finding.count})`)
      .join(", ");

    throw new Error(`Sanitization validation failed: ${detail}`);
  }
}

// The metadata-tier superset validator (C3): everything `validateSanitizedText` checks,
// plus local-path and PowerShell-environment residue. This is deliberately not "equal to
// the redactor" - it is an independent detector so a redactor gap becomes a fatal error
// instead of a silent pass. Sentinels (`[REDACTED:...]`) never match these detectors
// (they contain neither a path separator nor a `$env:`/`SetEnvironmentVariable` shape),
// so validating already-sanitized output does not self-fatal.
export function validateSanitizedMetadata(input, options) {
  const base = validateSanitizedText(input, options);
  const localPathFindings = findUnsanitizedLocalPaths(input);

  return {
    ok: base.ok && localPathFindings.length === 0,
    findings: [...base.findings, ...localPathFindings],
  };
}

export function assertSanitizedMetadata(input, options) {
  const validation = validateSanitizedMetadata(input, options);

  if (!validation.ok) {
    const detail = validation.findings
      .map((finding) => `${finding.label} (${finding.count})`)
      .join(", ");

    throw new Error(`Sanitization validation failed: ${detail}`);
  }
}
