import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { dispatchChunker, chunkFile } from './router.js';
import type { WalkedFile } from '../walker.js';
import type { RagChunkConfig } from '../config.js';

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

describe('dispatchChunker', () => {
  const text = 'const x = 1;\nconst y = 2;';
  const fileHash = createHash('sha1').update(text).digest('hex');

  it('routes typescript files and returns chunk array', () => {
    // Arrange
    const file = makeFile('typescript');

    // Act
    const chunks = dispatchChunker(text, file, DEFAULT_CONFIG, fileHash);

    // Assert
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.language).toBe('typescript');
    expect(chunks[0]!.text).toBe(text);
  });

  it('routes javascript files and returns chunk array with correct filePath', () => {
    // Arrange
    const file = makeFile('javascript');

    // Act
    const chunks = dispatchChunker(text, file, DEFAULT_CONFIG, fileHash);

    // Assert
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.language).toBe('javascript');
    expect(chunks[0]!.filePath).toBe('src/file.js');
  });

  it('routes markdown files and returns chunk array', () => {
    // Arrange
    const file = makeFile('markdown');
    const mdText = '# Heading\nsome content';
    const mdHash = createHash('sha1').update(mdText).digest('hex');

    // Act
    const chunks = dispatchChunker(mdText, file, DEFAULT_CONFIG, mdHash);

    // Assert
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.language).toBe('markdown');
  });

  it('routes unknown language files to line chunker', () => {
    // Arrange
    const file = makeFile('unknown');

    // Act
    const chunks = dispatchChunker(text, file, DEFAULT_CONFIG, fileHash);

    // Assert
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.kind).toBe('block');
  });

  it('all returned chunks carry the supplied fileHash', () => {
    // Arrange
    const file = makeFile('typescript');

    // Act
    const chunks = dispatchChunker(text, file, DEFAULT_CONFIG, fileHash);

    // Assert
    expect(chunks.every(c => c.fileHash === fileHash)).toBe(true);
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
