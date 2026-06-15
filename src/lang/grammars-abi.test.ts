import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync } from 'node:fs';
import { Parser, Language } from 'web-tree-sitter';
import { GRAMMAR_SPECS, grammarPath } from './ensure-grammars.js';

// ABI gate (mirrors scripts/check-grammars.mjs, enforced here in CI): every
// vendored grammar must be present and load under the pinned web-tree-sitter.
// This catches an old-ABI wasm that fails to load — the failure we hit with the
// prebuilt collections — before it ships, instead of at a user's first query.
const MIN_ABI = 14;

beforeAll(async () => { await Parser.init(); });

describe('vendored grammars', () => {
  const entries = Object.entries(GRAMMAR_SPECS);

  it('declares at least the known languages', () => {
    expect(entries.length).toBeGreaterThanOrEqual(9);
  });

  it.each(entries)('%s → wasm is present in grammars/', (_id, wasm) => {
    expect(existsSync(grammarPath(wasm))).toBe(true);
  });

  it.each(entries)(`%s → loads with a compatible ABI (>= ${MIN_ABI})`, async (_id, wasm) => {
    const lang = await Language.load(grammarPath(wasm));
    expect(lang.abiVersion).toBeGreaterThanOrEqual(MIN_ABI);
  });
});
