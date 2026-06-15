#!/usr/bin/env node
// ABI gate for the vendored grammars. Loads every grammars/*.wasm under the
// pinned web-tree-sitter and asserts a compatible parser ABI. This catches the
// failure mode we actually hit (an old-ABI prebuilt that fails to load) after a
// web-tree-sitter bump or a grammar re-sync — before it ships.
//
// Run: npm run check-grammars   (also enforced in the test suite via
//                                src/lang/grammars-abi.test.ts)

import { Parser, Language } from 'web-tree-sitter';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// web-tree-sitter 0.26.x loads grammars built for tree-sitter ABI 14+.
const MIN_ABI = 14;
const GRAMMARS_DIR = fileURLToPath(new URL('../grammars/', import.meta.url));

await Parser.init();

const wasms = readdirSync(GRAMMARS_DIR).filter((f) => f.endsWith('.wasm')).sort();
let failed = 0;

for (const w of wasms) {
  try {
    const lang = await Language.load(join(GRAMMARS_DIR, w));
    const abi = lang.abiVersion;
    const ok = typeof abi === 'number' && abi >= MIN_ABI;
    process.stdout.write(`  ${ok ? 'OK ' : 'BAD'} ${w.padEnd(32)} ABI ${abi}\n`);
    if (!ok) failed++;
  } catch (e) {
    process.stdout.write(`  BAD ${w.padEnd(32)} load failed: ${(e.message || String(e)).split('\n')[0]}\n`);
    failed++;
  }
}

if (failed) {
  process.stderr.write(`check-grammars: ${failed}/${wasms.length} grammar(s) incompatible (need ABI >= ${MIN_ABI}).\n`);
  process.exit(1);
}
process.stdout.write(`check-grammars: all ${wasms.length} grammars load (ABI >= ${MIN_ABI}).\n`);
