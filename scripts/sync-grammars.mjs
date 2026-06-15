#!/usr/bin/env node
// Vendors the tree-sitter grammar .wasm files this tool uses from their (dev-only)
// npm packages into grammars/, which is committed and shipped in the published
// package (package.json "files"). At runtime the chunker resolves grammars from
// grammars/ only — see src/lang/ensure-grammars.ts. This is the single grammar
// model: no optionalDependencies, no install-time native build, no user cache.
//
// Swift has no ABI-compatible npm package; its wasm comes from the grammar
// author's GitHub release (see grammars/NOTICE.md) and is committed directly.
// This script does not fetch it — it only asserts it is present.
//
// Update flow:
//   npm update <tree-sitter-*>      # bump the dev grammar packages
//   npm run sync-grammars           # copy their wasm into grammars/
//   npm run check-grammars          # assert every wasm still loads (ABI gate)
//   git add grammars && git commit

import { createRequire } from 'node:module';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const GRAMMARS_DIR = fileURLToPath(new URL('../grammars/', import.meta.url));

// wasm file ← the npm package (a devDependency) that ships it.
const NPM_SOURCES = [
  { pkg: 'tree-sitter-python',     file: 'tree-sitter-python.wasm' },
  { pkg: 'tree-sitter-typescript', file: 'tree-sitter-typescript.wasm' },
  { pkg: 'tree-sitter-typescript', file: 'tree-sitter-tsx.wasm' },
  { pkg: 'tree-sitter-go',         file: 'tree-sitter-go.wasm' },
  { pkg: 'tree-sitter-rust',       file: 'tree-sitter-rust.wasm' },
  { pkg: 'tree-sitter-java',       file: 'tree-sitter-java.wasm' },
  { pkg: 'tree-sitter-cpp',        file: 'tree-sitter-cpp.wasm' },
  { pkg: '@tree-sitter-grammars/tree-sitter-kotlin', file: 'tree-sitter-kotlin.wasm' },
];

// Vendored from a non-npm source (committed directly); presence-checked only.
const VENDORED_ONLY = ['tree-sitter-swift.wasm'];

function sourcePath(pkg, file) {
  // Resolve via the package's package.json so it works regardless of "main".
  return join(dirname(require.resolve(`${pkg}/package.json`)), file);
}

mkdirSync(GRAMMARS_DIR, { recursive: true });

let copied = 0;
for (const { pkg, file } of NPM_SOURCES) {
  const src = sourcePath(pkg, file);
  if (!existsSync(src)) {
    process.stderr.write(`sync-grammars: MISSING source ${src}\n  → run \`npm install\` first.\n`);
    process.exit(1);
  }
  copyFileSync(src, join(GRAMMARS_DIR, file));
  process.stdout.write(`  ${file.padEnd(32)} ← ${pkg}\n`);
  copied++;
}

for (const file of VENDORED_ONLY) {
  if (!existsSync(join(GRAMMARS_DIR, file))) {
    process.stderr.write(
      `sync-grammars: MISSING vendored ${file}\n` +
      `  → gh release download <tag> --repo alex-pinkus/tree-sitter-swift ` +
      `--pattern ${file} --dir grammars --clobber\n`,
    );
    process.exit(1);
  }
  process.stdout.write(`  ${file.padEnd(32)} (vendored — see grammars/NOTICE.md)\n`);
}

process.stdout.write(`sync-grammars: ${copied} copied from npm, ${VENDORED_ONLY.length} vendored present.\n`);
