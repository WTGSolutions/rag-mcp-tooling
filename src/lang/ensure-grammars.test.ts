import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { ensureGrammar, ensureGrammars, grammarPath, GRAMMAR_SPECS } from './ensure-grammars.js';

describe('ensureGrammar', () => {
  it('resolves a known grammar to its vendored wasm in grammars/', () => {
    const path = ensureGrammar('python');
    expect(path).not.toBeNull();
    expect(existsSync(path!)).toBe(true);
    expect(path!.endsWith('tree-sitter-python.wasm')).toBe(true);
    expect(path).toBe(grammarPath('tree-sitter-python.wasm'));
  });

  it('resolves swift the same way as every other grammar (one model)', () => {
    const path = ensureGrammar('swift');
    expect(path).not.toBeNull();
    expect(path!.endsWith('tree-sitter-swift.wasm')).toBe(true);
  });

  it('is a pure path lookup — same result every call, no copy/cache', () => {
    expect(ensureGrammar('go')).toBe(ensureGrammar('go'));
  });

  // An unknown grammar id hits the same null-return contract a missing wasm would:
  // the chunker degrades to the line chunker, never throws. This is the guarantee
  // that keeps a grammar gap non-fatal.
  it('returns null and warns for an unknown grammar (line-chunker fallback)', () => {
    const stderrChunks: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderrChunks.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;

    let result: string | null;
    try {
      result = ensureGrammar('nonexistent-language');
    } finally {
      process.stderr.write = origWrite;
    }

    expect(result).toBeNull();
    expect(stderrChunks.join('')).toContain('nonexistent-language');
  });
});

describe('ensureGrammars', () => {
  it('resolves several grammars at once', () => {
    const result = ensureGrammars(['python', 'go', 'swift']);
    for (const id of ['python', 'go', 'swift']) {
      expect(result.get(id)).not.toBeNull();
    }
  });

  it('every GRAMMAR_SPECS entry resolves to an existing file', () => {
    for (const id of Object.keys(GRAMMAR_SPECS)) {
      const path = ensureGrammar(id);
      expect(path, `${id} must resolve`).not.toBeNull();
      expect(existsSync(path!), `${id} wasm must exist`).toBe(true);
    }
  });
});
