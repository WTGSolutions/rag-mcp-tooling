import { describe, it, expect, beforeAll } from 'vitest';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { chunkTreeSitter } from '../tree-sitter.js';
import { ensureGrammars } from '../../lang/ensure-grammars.js';
import type { WalkedFile } from '../../walker.js';
import type { RagChunkConfig } from '../../config.js';
import { sha1 } from '../../hash.js';

beforeAll(() => {
  ensureGrammars(['python']); // resolve the vendored wasm before the suite
});

const FIXTURES = join(import.meta.dirname, '../../__fixtures__');
const CONFIG: RagChunkConfig = { maxTokens: 512, overlapLines: 4 };

function makePyFile(relativePath = 'sample.py', override: Partial<WalkedFile> = {}): WalkedFile {
  return {
    absolutePath: join(FIXTURES, relativePath),
    relativePath,
    segment: 'test',
    language: 'python',
    ...override,
  };
}

describe('Python walk (generic tree-sitter chunker)', () => {
  it('produces semantic chunks (function, class, method) for sample.py', async () => {
    const text = readFileSync(join(FIXTURES, 'sample.py'), 'utf-8');
    const chunks = await chunkTreeSitter(text, makePyFile(), CONFIG, sha1(text));

    const kinds = chunks.map((c) => c.kind);
    expect(kinds).toContain('function');
    expect(kinds).toContain('class');
    expect(kinds).toContain('method');
  });

  it('top-level functions have kind=function and correct symbol', async () => {
    const text = readFileSync(join(FIXTURES, 'sample.py'), 'utf-8');
    const chunks = await chunkTreeSitter(text, makePyFile(), CONFIG, sha1(text));

    const greet = chunks.find((c) => c.symbol === 'greet');
    expect(greet).toBeDefined();
    expect(greet!.kind).toBe('function');
    expect(greet!.startLine).toBeGreaterThan(0);
    expect(greet!.endLine).toBeGreaterThanOrEqual(greet!.startLine);
  });

  it('class has kind=class and correct symbol', async () => {
    const text = readFileSync(join(FIXTURES, 'sample.py'), 'utf-8');
    const chunks = await chunkTreeSitter(text, makePyFile(), CONFIG, sha1(text));

    const animal = chunks.find((c) => c.symbol === 'Animal');
    expect(animal).toBeDefined();
    expect(animal!.kind).toBe('class');
  });

  it('methods have kind=method and ClassName.methodName symbol', async () => {
    const text = readFileSync(join(FIXTURES, 'sample.py'), 'utf-8');
    const chunks = await chunkTreeSitter(text, makePyFile(), CONFIG, sha1(text));

    const speak = chunks.find((c) => c.symbol === 'Animal.speak');
    expect(speak).toBeDefined();
    expect(speak!.kind).toBe('method');

    const repr = chunks.find((c) => c.symbol === 'Animal.__repr__');
    expect(repr).toBeDefined();
    expect(repr!.kind).toBe('method');
  });

  it('decorated method (Dog.species @staticmethod) is emitted as method', async () => {
    const text = readFileSync(join(FIXTURES, 'sample.py'), 'utf-8');
    const chunks = await chunkTreeSitter(text, makePyFile(), CONFIG, sha1(text));

    const species = chunks.find((c) => c.symbol === 'Dog.species');
    expect(species).toBeDefined();
    expect(species!.kind).toBe('method');
  });

  it('leading # comment lines are included in the chunk', async () => {
    const text = readFileSync(join(FIXTURES, 'sample.py'), 'utf-8');
    const chunks = await chunkTreeSitter(text, makePyFile(), CONFIG, sha1(text));

    // greet() has a leading "# Helper function with leading comment" line
    const greet = chunks.find((c) => c.symbol === 'greet');
    expect(greet!.text).toContain('# Helper function with leading comment');
  });

  it('module-level code (imports, constants) is covered by gap block chunks', async () => {
    const text = readFileSync(join(FIXTURES, 'sample.py'), 'utf-8');
    const chunks = await chunkTreeSitter(text, makePyFile(), CONFIG, sha1(text));

    const hasImportChunk = chunks.some((c) => c.kind === 'block' && c.text.includes('import'));
    expect(hasImportChunk).toBe(true);
  });

  it('all chunks use createChunk id scheme (sha1 of segment::path:start-end)', async () => {
    const text = readFileSync(join(FIXTURES, 'sample.py'), 'utf-8');
    const chunks = await chunkTreeSitter(text, makePyFile(), CONFIG, sha1(text));

    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) {
      expect(chunk.id).toMatch(/^[0-9a-f]{40}$/); // sha1 hex
      expect(chunk.segment).toBe('test');
      expect(chunk.filePath).toBe('sample.py');
      expect(chunk.startLine).toBeGreaterThan(0);
      expect(chunk.endLine).toBeGreaterThanOrEqual(chunk.startLine);
    }
  });

  it('chunks are sorted by start line', async () => {
    const text = readFileSync(join(FIXTURES, 'sample.py'), 'utf-8');
    const chunks = await chunkTreeSitter(text, makePyFile(), CONFIG, sha1(text));

    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i]!.startLine).toBeGreaterThanOrEqual(chunks[i - 1]!.startLine);
    }
  });

  it('empty file falls back to single block chunk (line chunker)', async () => {
    const file: WalkedFile = {
      absolutePath: '/dev/null',
      relativePath: 'empty.py',
      segment: 'test',
      language: 'python',
    };
    const chunks = await chunkTreeSitter('', file, CONFIG, sha1(''));
    expect(chunks.every((c) => c.kind === 'block')).toBe(true);
  });

  it('syntax-error file falls back to line chunker (no throw)', async () => {
    const broken = 'def foo(\n  # unclosed\n';
    const file = makePyFile('broken.py');
    await expect(
      chunkTreeSitter(broken, file, CONFIG, sha1(broken)),
    ).resolves.toBeDefined();
  });

  it('non-tree-sitter language falls back to line chunker', async () => {
    const text = 'plain text, no grammar';
    const file: WalkedFile = {
      absolutePath: '/proj/src/file.txt',
      relativePath: 'file.txt',
      segment: 'test',
      language: 'unknown',
    };
    const chunks = await chunkTreeSitter(text, file, CONFIG, sha1(text));
    expect(chunks.every((c) => c.kind === 'block')).toBe(true);
  });
});

describe('walker integration (detectLanguage)', () => {
  it('detectLanguage returns python for .py and .pyw', async () => {
    const { detectLanguage } = await import('../../walker.js');
    expect(detectLanguage('foo/bar.py')).toBe('python');
    expect(detectLanguage('foo/bar.pyw')).toBe('python');
  });

  it('detectLanguage still works for TypeScript and unknown', async () => {
    const { detectLanguage } = await import('../../walker.js');
    expect(detectLanguage('foo/bar.ts')).toBe('typescript');
    expect(detectLanguage('foo/bar.xyz')).toBe('unknown');
  });
});
