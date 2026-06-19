// Resolves tree-sitter grammar WASM files for the chunker. One model: every
// grammar is vendored in this package's grammars/ dir (committed + shipped via
// package.json "files"), populated from dev-only npm packages by
// scripts/sync-grammars.mjs. The runtime never copies, caches, or downloads —
// it resolves a path in grammars/ and returns it, or null (→ line-chunker
// fallback). Keyed by grammar id, not language, so one entry serves a variant
// (tree-sitter-typescript supplies both `typescript` and `tsx`).

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// grammars/ ships in the published tarball. From both src/lang/ and dist/lang/
// it is two levels up — the package root.
const GRAMMARS_DIR = fileURLToPath(new URL('../../grammars/', import.meta.url));

// The single source of truth: grammar id → vendored wasm filename. Adding a
// language adds an entry here (+ a registry entry + a walk + sync-grammars source)
// — never touches the core.
export const GRAMMAR_SPECS: Readonly<Record<string, string>> = {
  python: 'tree-sitter-python.wasm',
  typescript: 'tree-sitter-typescript.wasm',
  tsx: 'tree-sitter-tsx.wasm',
  go: 'tree-sitter-go.wasm',
  rust: 'tree-sitter-rust.wasm',
  java: 'tree-sitter-java.wasm',
  cpp: 'tree-sitter-cpp.wasm',
  kotlin: 'tree-sitter-kotlin.wasm',
  swift: 'tree-sitter-swift.wasm',
};

/** Absolute path to a grammar's vendored wasm (whether or not it exists on disk). */
export function grammarPath(wasmFile: string): string {
  return join(GRAMMARS_DIR, wasmFile);
}

/**
 * Resolve a single grammar's wasm path, or null if the grammar id is unknown or
 * its wasm is missing from grammars/. Never throws — a null result makes the
 * caller fall back to the line chunker.
 */
export function ensureGrammar(grammarId: string): string | null {
  const wasm = GRAMMAR_SPECS[grammarId];
  if (!wasm) {
    process.stderr.write(
      `[rag-mcp] warning: unknown tree-sitter grammar id '${grammarId}'.\n`,
    );
    return null;
  }

  const path = grammarPath(wasm);
  if (existsSync(path)) return path;

  process.stderr.write(
    `[rag-mcp] warning: grammar '${grammarId}' missing at ${path} ` +
      `(run \`npm run sync-grammars\`). Falling back to line chunker.\n`,
  );
  return null;
}

/** Resolve several grammars at once → map of grammar id → path (null if unavailable). */
export function ensureGrammars(
  grammarIds: readonly string[],
): Map<string, string | null> {
  const result = new Map<string, string | null>();
  for (const id of grammarIds) result.set(id, ensureGrammar(id));
  return result;
}
