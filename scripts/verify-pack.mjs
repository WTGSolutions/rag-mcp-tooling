#!/usr/bin/env node
// Asserts the published tarball is clean: runs `npm pack --dry-run --json`
// (which triggers `prepack` → lean build) and checks the file list against an
// allow/deny policy. Exits non-zero with a readable report on any violation, so
// it doubles as a CI guard against the dist/tests/fixtures ever leaking back in.
//
// Run: npm run verify:pack

import { execFileSync } from 'node:child_process';

/** Paths that must NOT appear in the tarball (regex tested against each path). */
const DENY = [
  { re: /^src\//, why: 'TypeScript sources (ship dist/ only)' },
  { re: /__fixtures__/, why: 'test fixtures' },
  { re: /\.test\.(js|ts|d\.ts)/, why: 'compiled unit tests' },
  { re: /^dist\/eval\//, why: 'eval harness (maintainer-only)' },
  { re: /\.tasks\//, why: 'task tracking docs' },
];

/** Paths that MUST appear (the package is useless without them). */
const REQUIRE = [
  'package.json',
  'dist/index.js',
  'dist/server/server.js',
  'dist/cli/rag-index.js',
  'dist/cli/rag-init.js',
  'dist/cli/rag-usage.js',
  'scripts/reindex-bg.sh',
  'grammars/tree-sitter-swift.wasm', // vendored grammar must ship in the tarball
  'README.md',
];

function packFileList() {
  // --json prints the manifest to stdout; npm notices go to stderr.
  const out = execFileSync('npm', ['pack', '--dry-run', '--json'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const parsed = JSON.parse(out);
  const entry = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!entry || !Array.isArray(entry.files)) {
    throw new Error('Unexpected `npm pack --json` shape: no files[] in output');
  }
  return entry.files.map((f) => f.path);
}

function main() {
  const files = packFileList();

  const violations = [];
  for (const path of files) {
    for (const { re, why } of DENY) {
      if (re.test(path)) violations.push(`  ✗ ${path}  (${why})`);
    }
  }

  const missing = REQUIRE.filter((req) => !files.includes(req));

  if (violations.length || missing.length) {
    process.stderr.write(`verify:pack — tarball is NOT clean (${files.length} files)\n`);
    if (violations.length) {
      process.stderr.write(`\nForbidden entries present:\n${violations.join('\n')}\n`);
    }
    if (missing.length) {
      process.stderr.write(`\nRequired entries missing:\n${missing.map((m) => `  ✗ ${m}`).join('\n')}\n`);
    }
    process.exit(1);
  }

  process.stdout.write(`verify:pack — OK: ${files.length} files, no forbidden entries, all required present.\n`);
}

main();
