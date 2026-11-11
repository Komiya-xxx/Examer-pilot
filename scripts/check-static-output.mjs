#!/usr/bin/env node
// Static-output privacy scanner for the ExamerFrame static build.
//
// Recursively scans a build directory (default: `dist`) and exits non-zero
// when anything that must never ship to a public Pages site is present:
//   - PEM / SSH private-key headers
//   - Supabase secret keys (`sb_secret_` with an actual token suffix)
//   - service-role keys (decoded JWT role, service-only env key names),
//     secret/credential assignments
//   - private environment files (`.env`, `.env.*`) and key material
//   - private paths (`src/`, `source/`, `test(s)/`, `results/`,
//     question data, `exports/`, backups, migrations, ...)
//   - symbolic links anywhere under the tree (resolved, never silently skipped)
// It also requires the build to contain an `index.html` entry point.
//
// Usage:
//   node scripts/check-static-output.mjs [directory]
//   node scripts/check-static-output.mjs --help
//
// Zero dependencies; every pattern is a literal defined below.

import { readdir, readFile, lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_DIR = "dist";
// Files are read whole; each is scanned for the literals below.
const PRIVATE_KEY_MARKERS = [
  "-----BEGIN PRIVATE KEY-----",
  "-----BEGIN RSA PRIVATE KEY-----",
  "-----BEGIN EC PRIVATE KEY-----",
  "-----BEGIN DSA PRIVATE KEY-----",
  "-----BEGIN OPENSSH PRIVATE KEY-----",
  "-----BEGIN ENCRYPTED PRIVATE KEY-----",
  "-----BEGIN PGP PRIVATE KEY BLOCK-----",
  "-----BEGIN SSH2 ENCRYPTED PRIVATE KEY-----",
  "PuTTY-User-Key-File-",
];

// A real Supabase secret key is `sb_secret_` followed by a base64url token
// (44+ chars). The Supabase SDK ships helper strings like `sb_secret_` as a
// *literal prefix* for comparison — those are false positives. Only a token
// with a substantive suffix counts as an embedded secret.
const SECRET_TOKEN_RE = /sb_secret_[A-Za-z0-9_-]{12,}/;

// Names that are private regardless of where they appear.
const PRIVATE_FILE_NAMES = new Set([".npmrc", ".netrc", ".pgpass", ".envrc"]);

const PRIVATE_FILE_PATTERNS = [
  /^\.env(?:\.[A-Za-z0-9_-]+)*$/i, // .env, .env.local, .env.production...
  /\.env(?:\.[A-Za-z0-9_-]+)*$/i, // prefix.env, app.env.local, foo.env.bak
  /\.pem$/i,
  /\.key$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /\.jks$/i,
  /\.keystore$/i,
  /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?$/i,
  /service[-_]?role/i,
];

// Path segments (case-insensitive) that must never appear in the build.
const PRIVATE_PATH_SEGMENTS = new Set([
  "src",
  "source",
  "test",
  "tests",
  "__tests__",
  "fixtures",
  "seed",
  "seeds",
  "results",
  "exports",
  "question-data",
  "question_data",
  "questiondata",
  "question-bank",
  "question_bank",
  "questionbank",
  "answer-key",
  "answer_key",
  "answerkey",
  "backup",
  "backups",
  "private",
  "credentials",
  "secrets",
  "migrations",
  ".git",
  ".github",
  "node_modules",
]);

// Substring markers checked against the lower-cased relative path.
const PRIVATE_PATH_SUBSTRINGS = [
  ".sql",
  "supabase/migrations",
  "supabase/.temp",
  "package.json",
  "package-lock.json",
  "astro.config.",
  "tsconfig.json",
  "source-question",
  "service_role",
  "sb_secret_",
];

// Service-only / server-only environment keys that must never be present.
const SERVICE_ONLY_KEY_PATTERNS = [
  {
    pattern: /(?:^|[^A-Za-z0-9_])SUPABASE_SERVICE_ROLE_KEY\b/,
    reason: "service_role key name",
  },
  {
    pattern: /(?:^|[^A-Za-z0-9_])SUPABASE_SERVICE_KEY\b/,
    reason: "service key name",
  },
  {
    pattern: /(?:^|[^A-Za-z0-9_])SUPABASE_JWT_SECRET\b/,
    reason: "JWT secret name",
  },
  {
    pattern: /(?:^|[^A-Za-z0-9_])SUPABASE_SECRET_KEY\b/,
    reason: "Supabase secret key name",
  },
];

// Secret/credential references inside file content.
const SECRET_CONTENT_PATTERNS = [
  {
    pattern:
      /\bSUPABASE_(?:SERVICE_ROLE_KEY|SERVICE_KEY|SECRET_KEY|JWT_SECRET|DB_PASSWORD|ACCESS_TOKEN)\b/,
    reason: "Supabase server-only credential name",
  },
  { pattern: /\bservice_role\b/, reason: "service_role reference" },
  {
    pattern:
      /\b(?:API[_-]?SECRET|SECRET[_-]?KEY|ACCESS[_-]?TOKEN|PRIVATE[_-]?TOKEN|DB[_-]?PASSWORD|DATABASE[_-]?PASSWORD)\s*[=:]/,
    reason: "secret assignment",
  },
];

const B64URL_RE = /^[A-Za-z0-9_-]+$/;

function relativeDisplay(absPath, root) {
  return path.relative(root, absPath).split(path.sep).join("/") || ".";
}

// Returns a human-readable reason when the relative path is private.
function nameViolation(relPath) {
  const segments = relPath.split("/");
  const base = segments[segments.length - 1] ?? "";
  if (PRIVATE_FILE_NAMES.has(base.toLowerCase())) {
    return `private file "${base}"`;
  }
  for (const pattern of PRIVATE_FILE_PATTERNS) {
    if (pattern.test(base)) {
      return `private file name "${base}"`;
    }
  }
  for (const segment of segments) {
    const lower = segment.toLowerCase();
    if (PRIVATE_PATH_SEGMENTS.has(lower)) {
      return `private path segment "${segment}"`;
    }
    for (const marker of PRIVATE_PATH_SUBSTRINGS) {
      if (lower.includes(marker)) {
        return `private path marker "${marker}"`;
      }
    }
  }
  return null;
}

// Decode each JWT payload segment and look for `role: service_role`. The role
// is base64url-encoded inside the token, so the literal never appears in the
// raw text; we must decode to detect it.
function jwtHasServiceRole(text) {
  const match = text.match(/eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g);
  if (!match) return false;
  for (const token of match) {
    const segment = token.split(".")[1];
    if (!B64URL_RE.test(segment)) continue;
    try {
      const payload = Buffer.from(segment, "base64url").toString("utf8");
      if (/"role"\s*:\s*"service_role"/.test(payload)) {
        return true;
      }
    } catch {
      // Ignore segments that do not decode cleanly; cannot prove a role.
    }
  }
  return false;
}

async function* walk(root) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error && error.code === "ENOENT") return;
    throw error;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const absPath = path.join(root, entry.name);
    // Resolve every entry's true type so symlinks are never silently skipped.
    let meta;
    try {
      meta = await lstat(absPath);
    } catch (error) {
      if (error && error.code === "ENOENT") continue;
      throw error;
    }
    if (meta.isSymbolicLink()) {
      yield { absPath, isSymlink: true };
      continue;
    }
    if (meta.isDirectory()) {
      yield* walk(absPath);
    } else if (meta.isFile()) {
      yield { absPath, isSymlink: false };
    }
    // Other special files (sockets, devices) are ignored.
  }
}

async function contentViolations(absPath) {
  const text = await readFile(absPath, "utf8");
  const lower = text.toLowerCase();
  const findings = [];
  for (const marker of PRIVATE_KEY_MARKERS) {
    if (lower.includes(marker.toLowerCase())) {
      findings.push(`private key header "${marker}"`);
    }
  }
  // Only an actual secret token (long suffix) is an embedded secret; the bare
  // `sb_secret_` prefix alone is not.
  if (SECRET_TOKEN_RE.test(text)) {
    findings.push("Supabase secret key token (sb_secret_...)");
  }
  if (jwtHasServiceRole(text)) {
    findings.push("JWT with service_role role");
  }
  for (const { pattern, reason } of SERVICE_ONLY_KEY_PATTERNS) {
    if (pattern.test(text)) {
      findings.push(reason);
    }
  }
  for (const { pattern, reason } of SECRET_CONTENT_PATTERNS) {
    if (pattern.test(text)) findings.push(reason);
  }
  return findings;
}

function printHelp() {
  process.stdout.write(
    [
      "Usage: node scripts/check-static-output.mjs [directory]",
      "",
      "Recursively scans the static build output (default: dist) and exits 1",
      "when private keys, sb_secret_ tokens, service_role JWTs, .env files,",
      "secret assignments, private paths or symbolic links are found, or when",
      "index.html is missing.",
      "",
    ].join("\n"),
  );
}

async function main(argv) {
  const args = argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    return 0;
  }
  const options = args.filter((arg) => arg.startsWith("-"));
  if (options.length > 0) {
    process.stderr.write(`check-static-output: unknown option ${options[0]}\n`);
    printHelp();
    return 2;
  }

  const cwd = process.cwd();
  const target = path.resolve(cwd, args[0] ?? DEFAULT_DIR);
  const display = relativeDisplay(target, cwd);

  let info;
  try {
    info = await lstat(target);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      process.stderr.write(
        `check-static-output: ${display} does not exist; run the build first.\n`,
      );
      return 1;
    }
    throw error;
  }
  if (info.isSymbolicLink()) {
    process.stderr.write(
      `check-static-output: ${display} is a symbolic link; refusing to scan it.\n`,
    );
    return 1;
  }
  if (!info.isDirectory()) {
    process.stderr.write(`check-static-output: ${display} is not a directory.\n`);
    return 1;
  }

  const findings = [];
  let scanned = 0;
  let hasIndex = false;

  for await (const entry of walk(target)) {
    const { absPath, isSymlink } = entry;
    const rel = relativeDisplay(absPath, target);
    if (isSymlink) {
      // A symlink in a static bundle can silently diverge from what was
      // reviewed; report it rather than following or dropping it.
      let targetDisplay = "unknown target";
      try {
        targetDisplay = await realpath(absPath);
      } catch {
        // Broken symlink; still report it.
      }
      findings.push({
        file: rel,
        reason: `symbolic link -> ${targetDisplay}`,
      });
      continue;
    }
    scanned += 1;
    if (rel === "index.html") hasIndex = true;
    const nameIssue = nameViolation(rel);
    if (nameIssue) {
      // Report the name only; private files are never read back.
      findings.push({ file: rel, reason: nameIssue });
      continue;
    }
    for (const reason of await contentViolations(absPath)) {
      findings.push({ file: rel, reason });
    }
  }

  if (!hasIndex) {
    findings.push({ file: ".", reason: "missing index.html entry point" });
  }

  if (findings.length > 0) {
    process.stderr.write(
      `check-static-output: ${findings.length} problem(s) in ${display}:\n`,
    );
    for (const { file, reason } of findings) {
      process.stderr.write(`  - ${display}/${file}: ${reason}\n`);
    }
    return 1;
  }

  process.stdout.write(
    `check-static-output: ${display} OK (${scanned} files scanned, index.html present).\n`,
  );
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main(process.argv)
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(
        `check-static-output: scan failed: ${
          error && error.message ? error.message : String(error)
        }\n`,
      );
      process.exitCode = 1;
    });
}

export { main, nameViolation, jwtHasServiceRole };
