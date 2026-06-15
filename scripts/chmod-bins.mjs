#!/usr/bin/env node
// Makes the compiled CLI entry points executable. tsc emits .js as 0644, which
// drops the executable bit the shebang needs — so `npx rag-index` (or any direct
// .bin/ invocation) fails with "Permission denied" on install methods where npm
// doesn't force +x itself (local path / file: / npm link). Running this after the
// build bakes 0755 into dist/, and npm pack preserves the mode into the tarball,
// so every install method gets runnable bins. Derives targets from package.json
// "bin" so a new bin can't be forgotten. Portable (no `chmod` shell dependency).
//
// Diagnostics go to STDERR: this runs inside `prepack`, whose stdout is captured
// as JSON by `npm pack --json` (verify-pack.mjs) — any stdout here corrupts it.

import { chmodSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const bins = Object.values(pkg.bin ?? {});

for (const rel of bins) {
  const path = fileURLToPath(new URL(`../${rel}`, import.meta.url));
  chmodSync(path, 0o755);
  process.stderr.write(`  chmod 755 ${rel}\n`);
}
process.stderr.write(`chmod-bins: ${bins.length} bin(s) made executable.\n`);
