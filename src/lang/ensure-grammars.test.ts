import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureGrammars } from './ensure-grammars.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'rag-grammars-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env['RAG_GRAMMAR_CACHE'];
});

describe('ensureGrammars', () => {
  it('copies python.wasm from npm bundle to cache dir', () => {
    process.env['RAG_GRAMMAR_CACHE'] = tmpDir;

    const result = ensureGrammars(['python']);

    const wasmPath = result.get('python');
    expect(wasmPath).not.toBeNull();
    expect(existsSync(wasmPath!)).toBe(true);
    expect(wasmPath!.endsWith('tree-sitter-python.wasm')).toBe(true);
  });

  it('is idempotent — second call returns same path, no error', () => {
    process.env['RAG_GRAMMAR_CACHE'] = tmpDir;

    const first  = ensureGrammars(['python']).get('python');
    const second = ensureGrammars(['python']).get('python');

    expect(first).toBe(second);
    expect(first).not.toBeNull();
  });

  // An unknown grammar id exercises the same null-return contract that an
  // uninstalled optional grammar package would hit (GRAMMAR_SPECS miss vs.
  // require.resolve miss both → null). This is the guarantee that makes moving
  // tree-sitter-* to optionalDependencies safe (TASK-036): a missing grammar
  // degrades to the line chunker, never throws.
  it('returns null and warns for an unavailable grammar (line-chunker fallback)', () => {
    process.env['RAG_GRAMMAR_CACHE'] = tmpDir;
    const stderrChunks: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderrChunks.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;

    let result: ReturnType<typeof ensureGrammars>;
    try {
      result = ensureGrammars(['nonexistent-language']);
    } finally {
      process.stderr.write = origWrite;
    }

    expect(result.get('nonexistent-language')).toBeNull();
    expect(stderrChunks.join('')).toContain('nonexistent-language');
  });

  it('uses RAG_GRAMMAR_CACHE env var for cache location', () => {
    const customCache = join(tmpDir, 'custom-cache');
    process.env['RAG_GRAMMAR_CACHE'] = customCache;

    const result = ensureGrammars(['python']);

    expect(result.get('python')).toContain(customCache);
    expect(existsSync(result.get('python')!)).toBe(true);
  });

  // The vendored Swift grammar (no ABI-compatible npm build) is resolved in
  // place from grammars/, NOT copied to the cache — so RAG_GRAMMAR_CACHE must
  // not influence its path. This is the { vendored } spec branch (TASK-042).
  it('resolves a vendored grammar (swift) in place, ignoring the cache dir', () => {
    process.env['RAG_GRAMMAR_CACHE'] = tmpDir;

    const wasmPath = ensureGrammars(['swift']).get('swift');

    expect(wasmPath).not.toBeNull();
    expect(existsSync(wasmPath!)).toBe(true);
    expect(wasmPath!.endsWith('tree-sitter-swift.wasm')).toBe(true);
    expect(wasmPath!.startsWith(tmpDir)).toBe(false); // not copied into the cache
  });
});
