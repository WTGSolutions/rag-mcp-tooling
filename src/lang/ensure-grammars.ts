// Copies tree-sitter WASM grammars from their npm packages to a local cache dir so
// the runtime never hits the network. Idempotent: a cached file is reused as-is.
// Keyed by grammar id (not language) so one package can supply several grammars
// (e.g. tree-sitter-typescript ships both `typescript` and `tsx`).
//
// Cache location (first defined wins):
//   $RAG_GRAMMAR_CACHE   explicit override
//   $RAG_MODEL_CACHE     re-use the model cache convention
//   ~/.cache/rag-mcp/grammars

import { createRequire } from 'node:module';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { homedir } from 'node:os';

/** grammar id → npm package + wasm file shipped by that package. */
export type GrammarSpec = { pkg: string; wasm: string };

// The single source of truth for where each grammar's wasm comes from. Adding a
// language adds an entry here (+ a registry entry + a walk) — never touches the core.
export const GRAMMAR_SPECS: Readonly<Record<string, GrammarSpec>> = {
  python:     { pkg: 'tree-sitter-python',     wasm: 'tree-sitter-python.wasm' },
  typescript: { pkg: 'tree-sitter-typescript', wasm: 'tree-sitter-typescript.wasm' },
  tsx:        { pkg: 'tree-sitter-typescript', wasm: 'tree-sitter-tsx.wasm' },
  go:         { pkg: 'tree-sitter-go',         wasm: 'tree-sitter-go.wasm' },
  rust:       { pkg: 'tree-sitter-rust',       wasm: 'tree-sitter-rust.wasm' },
  java:       { pkg: 'tree-sitter-java',       wasm: 'tree-sitter-java.wasm' },
  cpp:        { pkg: 'tree-sitter-cpp',        wasm: 'tree-sitter-cpp.wasm' },
  kotlin:     { pkg: '@tree-sitter-grammars/tree-sitter-kotlin', wasm: 'tree-sitter-kotlin.wasm' },
};

export function grammarCacheDir(): string {
  if (process.env['RAG_GRAMMAR_CACHE']) return process.env['RAG_GRAMMAR_CACHE'];
  if (process.env['RAG_MODEL_CACHE'])   return join(process.env['RAG_MODEL_CACHE'], 'grammars');
  return join(homedir(), '.cache', 'rag-mcp', 'grammars');
}

// Resolve a grammar's wasm inside its installed npm package. Resolve via
// package.json — robust even when the package exposes no importable "main".
function bundleGrammarPath(spec: GrammarSpec): string | null {
  try {
    const req = createRequire(import.meta.url);
    const pkgJson = req.resolve(`${spec.pkg}/package.json`);
    return join(dirname(pkgJson), spec.wasm);
  } catch {
    return null;
  }
}

/**
 * Ensure a single grammar's wasm is in the local cache; returns the cached path,
 * or null if the grammar id is unknown or its package is not installed. Never
 * throws — a null result makes the caller fall back to the line chunker.
 */
export function ensureGrammar(grammarId: string): string | null {
  const spec = GRAMMAR_SPECS[grammarId];
  if (!spec) {
    process.stderr.write(`[rag-mcp] warning: unknown tree-sitter grammar id '${grammarId}'.\n`);
    return null;
  }

  const cacheDir = grammarCacheDir();
  const cachedPath = join(cacheDir, basename(spec.wasm));
  if (existsSync(cachedPath)) return cachedPath;

  const sourcePath = bundleGrammarPath(spec);
  if (!sourcePath || !existsSync(sourcePath)) {
    process.stderr.write(
      `[rag-mcp] warning: tree-sitter grammar '${grammarId}' not found ` +
      `(expected: ${sourcePath ?? `package ${spec.pkg} not installed`}). Falling back to line chunker.\n`,
    );
    return null;
  }

  try {
    mkdirSync(cacheDir, { recursive: true });
    copyFileSync(sourcePath, cachedPath);
    return cachedPath;
  } catch (e) {
    process.stderr.write(`[rag-mcp] warning: failed to cache grammar '${grammarId}': ${(e as Error).message}\n`);
    return null;
  }
}

/** Ensure several grammars at once → map of grammar id → cached path (null if unavailable). */
export function ensureGrammars(grammarIds: readonly string[]): Map<string, string | null> {
  const result = new Map<string, string | null>();
  for (const id of grammarIds) result.set(id, ensureGrammar(id));
  return result;
}
