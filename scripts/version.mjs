#!/usr/bin/env node
/**
 * Version helpers for the CI workflows (Docker image releases).
 *
 * `version.txt` at the repository root is the SINGLE SOURCE OF TRUTH: format
 * `MAJOR.MINOR.PATCH` (e.g. `0.1.0`), no `v` prefix, no pre-release suffix.
 *
 * Release rule (same as Yuki / Docky): the image is published with the version
 * that is CURRENTLY in `version.txt`, then the PATCH component is incremented by
 * one. MAJOR/MINOR are bumped by hand in `version.txt` when a deliberate
 * breaking / feature release is wanted; the workflow then only increments the
 * patch from there.
 *
 * Keeping the arithmetic here (instead of inline shell in the workflow) makes it
 * testable and dry-runnable away from CI:
 *
 *   node scripts/version.mjs show                       # current version
 *   node scripts/version.mjs validate                   # exit 1 if malformed
 *   node scripts/version.mjs resolve --published=0.1.0  # dry-run: version + next
 *   node scripts/version.mjs bump --dry-run             # next version, no write
 *   node scripts/version.mjs bump                       # write next version
 *   node scripts/version.mjs selftest                   # assertions (exit 1 on failure)
 *
 * `resolve`/`bump` print `key=value` lines, so the workflow can append them
 * straight to `$GITHUB_OUTPUT`.
 *
 * No dependency, no network, no git: this script never tags or pushes anything.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

/** Absolute path of the version file (repository root). */
export const VERSION_FILE = path.resolve(fileURLToPath(new URL('..', import.meta.url)), 'version.txt');

const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** Error carrying a stable `code` so callers/tests can branch on the failure. */
export class VersionError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'VersionError';
    this.code = code;
  }
}

/**
 * Parse a `MAJOR.MINOR.PATCH` string.
 * @param {unknown} raw
 * @returns {{ major: number, minor: number, patch: number }}
 */
export function parseVersion(raw) {
  const value = String(raw ?? '').trim();
  const match = SEMVER_RE.exec(value);
  if (!match) {
    throw new VersionError(
      `invalid version ${JSON.stringify(value)} (expected MAJOR.MINOR.PATCH, e.g. 0.1.0)`,
      'INVALID_VERSION',
    );
  }
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

/**
 * Render a parsed version back to `MAJOR.MINOR.PATCH`.
 * @param {{ major: number, minor: number, patch: number }} version
 */
export function formatVersion({ major, minor, patch }) {
  return `${major}.${minor}.${patch}`;
}

/**
 * Increment the patch component. MAJOR and MINOR are never touched automatically.
 * @param {unknown} raw
 */
export function bumpPatch(raw) {
  const { major, minor, patch } = parseVersion(raw);
  return formatVersion({ major, minor, patch: patch + 1 });
}

/**
 * Read the version file and return the trimmed version string.
 * @param {string} [file]
 */
export function readVersionFile(file = VERSION_FILE) {
  let content;
  try {
    content = readFileSync(file, 'utf8');
  } catch (err) {
    throw new VersionError(`cannot read ${file}: ${err.message}`, 'VERSION_FILE_MISSING');
  }
  const version = content.trim();
  if (!version) {
    throw new VersionError(`${file} is empty`, 'VERSION_FILE_EMPTY');
  }
  return version;
}

/**
 * Normalise a comma/space separated list of already-published versions.
 * @param {unknown} raw
 * @returns {string[]}
 */
export function parsePublished(raw) {
  return String(raw ?? '')
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * Plan a release without touching anything.
 *
 * The target version is the CURRENT one (the image is tagged `:<version>` before
 * the bump). Refuse to plan when that version has already been published — the
 * workflow must not silently republish (or silently skip) a release.
 *
 * @param {{ current: string, published?: string[] }} input
 * @returns {{ version: string, next: string, collision: boolean }}
 */
export function planRelease({ current, published = [] }) {
  const version = formatVersion(parseVersion(current));
  if (published.includes(version)) {
    throw new VersionError(
      `version ${version} is already published — bump version.txt by hand (e.g. to ${bumpPatch(version)}) and re-run`,
      'ALREADY_PUBLISHED',
    );
  }
  return { version, next: bumpPatch(version), collision: false };
}

/* ------------------------------------------------------------------------- *
 * CLI
 * ------------------------------------------------------------------------- */

function printPlan(plan) {
  process.stdout.write(`version=${plan.version}\n`);
  process.stdout.write(`next=${plan.next}\n`);
  process.stdout.write(`collision=${plan.collision}\n`);
}

function selftest() {
  /** @type {Array<{ name: string, run: () => void }>} */
  const cases = [];
  const eq = (actual, expected, label) => {
    if (actual !== expected) {
      throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
  };
  const throwsCode = (fn, code, label) => {
    try {
      fn();
    } catch (err) {
      if (err instanceof VersionError && err.code === code) return;
      throw new Error(`${label}: expected VersionError(${code}), got ${err && err.message}`);
    }
    throw new Error(`${label}: expected VersionError(${code}), but nothing was thrown`);
  };

  const plan = (current, published = []) => planRelease({ current, published });

  cases.push({
    name: 'first release 0.0.0 → publishes 0.0.0, next 0.0.1',
    run: () => {
      const p = plan('0.0.0');
      eq(p.version, '0.0.0', 'version');
      eq(p.next, '0.0.1', 'next');
    },
  });
  cases.push({
    name: 'patch release 0.1.0 → publishes 0.1.0, next 0.1.1',
    run: () => {
      const p = plan('0.1.0');
      eq(p.version, '0.1.0', 'version');
      eq(p.next, '0.1.1', 'next');
    },
  });
  cases.push({
    name: 'patch rollover 0.9.9 → next 0.9.10 (no carry into MINOR)',
    run: () => eq(plan('0.9.9').next, '0.9.10', 'next'),
  });
  cases.push({
    name: 'manual MINOR release 0.2.0 → next 0.2.1',
    run: () => eq(plan('0.2.0').next, '0.2.1', 'next'),
  });
  cases.push({
    name: 'manual MAJOR release 1.0.0 → next 1.0.1',
    run: () => eq(plan('1.0.0').next, '1.0.1', 'next'),
  });
  cases.push({
    name: 'already published 0.1.1 with 0.1.0/0.1.1 in registry → refused',
    run: () => throwsCode(() => plan('0.1.1', ['0.1.0', '0.1.1']), 'ALREADY_PUBLISHED', 'refusal'),
  });
  cases.push({
    name: 'already published via sha-style entries stays unaffected',
    run: () => eq(plan('0.1.2', ['0.1.1', 'sha-abc1234']).version, '0.1.2', 'version'),
  });
  for (const bad of ['1.2', 'v1.2.3', '1.2.3-rc1', '01.2.3', '1.2.3.4', '', '  ']) {
    cases.push({
      name: `invalid version ${JSON.stringify(bad)} → refused`,
      run: () => throwsCode(() => parseVersion(bad), 'INVALID_VERSION', 'parse'),
    });
  }
  cases.push({
    name: 'whitespace-padded version accepted (file read trims)',
    run: () => eq(parseVersion(' 0.1.0\n').patch, 0, 'patch'),
  });
  cases.push({
    name: 'resolve on the repository version.txt is self-consistent',
    run: () => {
      const current = readVersionFile();
      const p = plan(current);
      eq(p.version, current, 'version');
      eq(p.next, bumpPatch(current), 'next');
    },
  });

  let failed = 0;
  for (const testCase of cases) {
    try {
      testCase.run();
      process.stdout.write(`ok   - ${testCase.name}\n`);
    } catch (err) {
      failed += 1;
      process.stdout.write(`FAIL - ${testCase.name}\n       ${err.message}\n`);
    }
  }
  process.stdout.write(`\n${cases.length - failed}/${cases.length} assertions passed\n`);
  if (failed > 0) process.exitCode = 1;
}

function parseFlag(args, name) {
  const prefix = `--${name}=`;
  const hit = args.find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : undefined;
}

function fail(err) {
  if (err instanceof VersionError) {
    process.stderr.write(`error: ${err.message} (code: ${err.code})\n`);
    process.exit(1);
  }
  throw err;
}

function main(argv) {
  const [command, ...args] = argv;
  const dryRun = args.includes('--dry-run');

  switch (command) {
    case 'show': {
      process.stdout.write(`${readVersionFile()}\n`);
      return;
    }
    case 'validate': {
      const version = formatVersion(parseVersion(readVersionFile()));
      process.stdout.write(`version.txt OK: ${version}\n`);
      return;
    }
    case 'resolve': {
      const current = readVersionFile();
      const published = parsePublished(parseFlag(args, 'published'));
      printPlan(planRelease({ current, published }));
      return;
    }
    case 'bump': {
      const current = readVersionFile();
      const next = bumpPatch(current);
      if (dryRun) {
        process.stdout.write(`${next}\n`);
        return;
      }
      writeFileSync(VERSION_FILE, `${next}\n`, 'utf8');
      process.stdout.write(`${next}\n`);
      return;
    }
    case 'selftest': {
      selftest();
      return;
    }
    default: {
      process.stderr.write(
        'usage: node scripts/version.mjs <show|validate|resolve|bump|selftest> [--dry-run] [--published=a,b]\n',
      );
      process.exitCode = 2;
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    fail(err);
  }
}
