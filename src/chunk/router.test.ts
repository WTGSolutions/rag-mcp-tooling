import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { dispatchChunker, dispatchChunkerAsync, chunkFile } from './router.js';
import type { WalkedFile } from '../walker.js';
import type { RagChunkConfig } from '../config.js';

// Hermetic grammar cache so tree-sitter routing copies the WASM to a temp dir
// instead of the user's real ~/.cache. ensureGrammars copies from node_modules lazily.
process.env['RAG_GRAMMAR_CACHE'] = mkdtempSync(join(tmpdir(), 'rag-router-grammars-'));

const FIXTURES = join(import.meta.dirname, '../__fixtures__/mini-repo');

function makeFile(language: WalkedFile['language'], overrides: Partial<WalkedFile> = {}): WalkedFile {
  const ext = language === 'typescript' ? 'ts' : language === 'javascript' ? 'js' : language === 'markdown' ? 'md' : 'txt';
  return {
    absolutePath: `/proj/src/file.${ext}`,
    relativePath: `src/file.${ext}`,
    segment: 'web',
    language,
    ...overrides,
  };
}

const DEFAULT_CONFIG: RagChunkConfig = { maxTokens: 512, overlapLines: 4 };

// dispatchChunker is the SYNC path: markdown + line-chunker default only.
// Code languages (TS/JS/Python) are async via tree-sitter → dispatchChunkerAsync.
describe('dispatchChunker', () => {
  const text = 'const x = 1;\nconst y = 2;';
  const fileHash = createHash('sha1').update(text).digest('hex');

  it('routes markdown files to the markdown chunker', () => {
    const file = makeFile('markdown');
    const mdText = '# Heading\nsome content';
    const mdHash = createHash('sha1').update(mdText).digest('hex');

    const chunks = dispatchChunker(mdText, file, DEFAULT_CONFIG, mdHash);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.language).toBe('markdown');
  });

  it('routes unknown language files to the line chunker', () => {
    const file = makeFile('unknown');
    const chunks = dispatchChunker(text, file, DEFAULT_CONFIG, fileHash);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.kind).toBe('block');
  });

  it('all returned chunks carry the supplied fileHash', () => {
    const file = makeFile('markdown');
    const chunks = dispatchChunker(text, file, DEFAULT_CONFIG, fileHash);
    expect(chunks.every((c) => c.fileHash === fileHash)).toBe(true);
  });
});

describe('dispatchChunkerAsync', () => {
  const pyText = [
    'import os',
    '',
    'def greet(name):',
    '    return f"Hi {name}"',
    '',
    'class Dog:',
    '    def speak(self):',
    '        return "Woof"',
    '',
  ].join('\n');
  const pyHash = createHash('sha1').update(pyText).digest('hex');
  const tsText = 'const x = 1;\nconst y = 2;';
  const tsHash = createHash('sha1').update(tsText).digest('hex');

  // Regression guard for the bug where the indexer used the synchronous
  // dispatchChunker (no python case) → .py files were silently line-chunked.
  it('routes python to the tree-sitter chunker — semantic kinds, not line blocks', async () => {
    const file = makeFile('unknown', {
      absolutePath: '/proj/src/s.py',
      relativePath: 'src/s.py',
      language: 'python',
    });

    const chunks = await dispatchChunkerAsync(pyText, file, DEFAULT_CONFIG, pyHash);

    const kinds = new Set(chunks.map((c) => c.kind));
    expect(kinds.has('function')).toBe(true);
    expect(kinds.has('class')).toBe(true);
    expect(kinds.has('method')).toBe(true);
    expect(chunks.some((c) => c.symbol === 'Dog.speak')).toBe(true);
  });

  it('routes typescript to the tree-sitter TS chunker — semantic kinds', async () => {
    const tsCode = [
      'export function add(a: number, b: number): number {',
      '  return a + b;',
      '}',
      'export class Box {',
      '  open() {}',
      '}',
    ].join('\n');
    const file = makeFile('typescript');
    const tsCodeHash = createHash('sha1').update(tsCode).digest('hex');
    const chunks = await dispatchChunkerAsync(tsCode, file, DEFAULT_CONFIG, tsCodeHash);
    expect(chunks[0]!.language).toBe('typescript');
    const kinds = new Set(chunks.map((c) => c.kind));
    expect(kinds.has('function')).toBe(true);
    expect(kinds.has('class')).toBe(true);
    expect(kinds.has('method')).toBe(true);
    expect(chunks.some((c) => c.symbol === 'Box.open')).toBe(true);
  });

  it('delegates unknown language to the line chunker', async () => {
    const file = makeFile('unknown');
    const chunks = await dispatchChunkerAsync(tsText, file, DEFAULT_CONFIG, tsHash);
    expect(chunks.every((c) => c.kind === 'block')).toBe(true);
  });

  it('RAG_FORCE_LINE_CHUNKER=1 forces line chunking even for a tree-sitter language (Phase-5 A/B baseline)', async () => {
    const tsCode = 'export function add(a: number, b: number) { return a + b; }';
    const file = makeFile('typescript');
    process.env['RAG_FORCE_LINE_CHUNKER'] = '1';
    try {
      const chunks = await dispatchChunkerAsync(tsCode, file, DEFAULT_CONFIG, createHash('sha1').update(tsCode).digest('hex'));
      expect(chunks.every((c) => c.kind === 'block')).toBe(true);
      expect(chunks.some((c) => c.symbol === 'add')).toBe(false); // no semantic symbol chunk
    } finally {
      delete process.env['RAG_FORCE_LINE_CHUNKER'];
    }
  });
});

describe('chunkFile', () => {
  it('throws a descriptive error when the file does not exist', async () => {
    // Arrange
    const file: WalkedFile = {
      absolutePath: '/nonexistent/path/missing.ts',
      relativePath: 'missing.ts',
      segment: 'web',
      language: 'typescript',
    };

    // Act + Assert
    await expect(chunkFile(file, DEFAULT_CONFIG)).rejects.toThrow(
      'Failed to read file for chunking: /nonexistent/path/missing.ts',
    );
  });

  it('reads file from disk and produces chunks with correct metadata', async () => {
    // Arrange
    const absolutePath = join(FIXTURES, 'alpha.ts');
    const file: WalkedFile = {
      absolutePath,
      relativePath: 'alpha.ts',
      segment: 'mini',
      language: 'typescript',
    };

    // Act
    const chunks = await chunkFile(file, DEFAULT_CONFIG);

    // Assert
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0]!.segment).toBe('mini');
    expect(chunks[0]!.filePath).toBe('alpha.ts');
    expect(chunks[0]!.language).toBe('typescript');
    expect(chunks[0]!.startLine).toBe(1);
    expect(chunks[0]!.id).toBeTruthy();
    expect(chunks[0]!.fileHash).toBeTruthy();
  });

  it('fileHash matches sha1 of file content', async () => {
    // Arrange
    const { readFile } = await import('node:fs/promises');
    const absolutePath = join(FIXTURES, 'alpha.ts');
    const file: WalkedFile = {
      absolutePath,
      relativePath: 'alpha.ts',
      segment: 'mini',
      language: 'typescript',
    };

    // Act
    const chunks = await chunkFile(file, DEFAULT_CONFIG);
    const rawText = await readFile(absolutePath, 'utf-8');
    const expectedHash = createHash('sha1').update(rawText).digest('hex');

    // Assert
    expect(chunks[0]!.fileHash).toBe(expectedHash);
  });
});
