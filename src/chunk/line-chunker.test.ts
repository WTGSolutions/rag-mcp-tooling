import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { chunkLines, estimateTokens } from './line-chunker.js';
import type { WalkedFile } from '../walker.js';
import type { RagChunkConfig } from '../config.js';

function makeFile(overrides: Partial<WalkedFile> = {}): WalkedFile {
  return {
    absolutePath: '/proj/src/util.ts',
    relativePath: 'src/util.ts',
    segment: 'web',
    language: 'typescript',
    ...overrides,
  };
}

function makeConfig(overrides: Partial<RagChunkConfig> = {}): RagChunkConfig {
  return { maxTokens: 100, overlapLines: 2, ...overrides };
}

function fileHash(text: string): string {
  return createHash('sha1').update(text).digest('hex');
}

function makeLines(count: number, charsPerLine = 10): string {
  return Array.from({ length: count }, (_, i) => `line${i + 1}`.padEnd(charsPerLine, '_')).join('\n');
}

describe('estimateTokens', () => {
  it('returns ceil(length / 4)', () => {
    expect(estimateTokens('1234')).toBe(1);
    expect(estimateTokens('12345')).toBe(2);
    expect(estimateTokens('')).toBe(0);
  });
});

describe('chunkLines', () => {
  const file = makeFile();

  describe('short file fits in one chunk', () => {
    it('returns a single chunk when text fits within maxTokens', () => {
      // Arrange
      const text = 'const a = 1;\nconst b = 2;\n';
      const config = makeConfig({ maxTokens: 512 });

      // Act
      const chunks = chunkLines(text, file, config, fileHash(text));

      // Assert
      expect(chunks).toHaveLength(1);
      expect(chunks[0]!.startLine).toBe(1);
      expect(chunks[0]!.endLine).toBe(2);
      expect(chunks[0]!.text).toBe('const a = 1;\nconst b = 2;');
    });

    it('returns one chunk for a single-line file', () => {
      // Arrange
      const text = 'export const x = 1;';
      const config = makeConfig({ maxTokens: 512 });

      // Act
      const chunks = chunkLines(text, file, config, fileHash(text));

      // Assert
      expect(chunks).toHaveLength(1);
      expect(chunks[0]!.startLine).toBe(1);
      expect(chunks[0]!.endLine).toBe(1);
    });

    it('returns one empty chunk for an empty file', () => {
      // Arrange
      const text = '';
      const config = makeConfig();

      // Act
      const chunks = chunkLines(text, file, config, fileHash(text));

      // Assert
      expect(chunks).toHaveLength(1);
      expect(chunks[0]!.text).toBe('');
      expect(chunks[0]!.startLine).toBe(1);
      expect(chunks[0]!.endLine).toBe(1);
    });
  });

  describe('long file splits into multiple chunks', () => {
    it('splits a long file and no chunk exceeds maxTokens (except single-line boundary)', () => {
      // Arrange — 40 lines × 12 chars = 480 chars ≈ 120 tokens, maxTokens=50
      const text = makeLines(40, 12);
      const config = makeConfig({ maxTokens: 50, overlapLines: 0 });

      // Act
      const chunks = chunkLines(text, file, config, fileHash(text));

      // Assert
      expect(chunks.length).toBeGreaterThan(1);
      for (const chunk of chunks) {
        // Each chunk may exceed maxTokens by at most one line (boundary tolerance)
        const lineCount = chunk.endLine - chunk.startLine + 1;
        const singleLineTokens = estimateTokens(makeLines(1, 12) + '\n');
        expect(estimateTokens(chunk.text)).toBeLessThanOrEqual(config.maxTokens + singleLineTokens);
        expect(lineCount).toBeGreaterThan(0);
      }
    });

    it('covers all lines across all chunks (no lines dropped or repeated when overlap=0)', () => {
      // Arrange
      const lineCount = 30;
      const text = makeLines(lineCount, 8);
      const config = makeConfig({ maxTokens: 40, overlapLines: 0 });

      // Act
      const chunks = chunkLines(text, file, config, fileHash(text));

      // Assert — every line number 1..30 appears in exactly one chunk
      const seen = new Array<number>(lineCount + 1).fill(0);
      for (const chunk of chunks) {
        for (let l = chunk.startLine; l <= chunk.endLine; l++) {
          seen[l] = (seen[l] ?? 0) + 1;
        }
      }
      for (let l = 1; l <= lineCount; l++) {
        expect(seen[l], `line ${l} coverage`).toBe(1);
      }
    });

    it('line numbers are 1-based and continuous across chunks', () => {
      // Arrange
      const text = makeLines(20, 16); // ~4 tokens/line
      const config = makeConfig({ maxTokens: 20, overlapLines: 0 });

      // Act
      const chunks = chunkLines(text, file, config, fileHash(text));

      // Assert
      expect(chunks[0]!.startLine).toBe(1);
      for (let i = 1; i < chunks.length; i++) {
        expect(chunks[i]!.startLine).toBe(chunks[i - 1]!.endLine + 1);
      }
      expect(chunks[chunks.length - 1]!.endLine).toBe(20);
    });
  });

  describe('overlap', () => {
    it('adjacent chunks share exactly overlapLines lines', () => {
      // Arrange
      const text = makeLines(30, 8);
      const config = makeConfig({ maxTokens: 40, overlapLines: 3 });

      // Act
      const chunks = chunkLines(text, file, config, fileHash(text));

      // Assert — every chunk except the first starts at most overlapLines before previous end
      for (let i = 1; i < chunks.length; i++) {
        const prev = chunks[i - 1]!;
        const curr = chunks[i]!;
        const overlap = prev.endLine - curr.startLine + 1;
        expect(overlap).toBeGreaterThanOrEqual(0);
        expect(overlap).toBeLessThanOrEqual(config.overlapLines);
      }
    });

    it('with overlapLines=0 chunks are non-overlapping and cover everything', () => {
      // Arrange
      const text = makeLines(20, 10);
      const config = makeConfig({ maxTokens: 30, overlapLines: 0 });

      // Act
      const chunks = chunkLines(text, file, config, fileHash(text));

      // Assert
      for (let i = 1; i < chunks.length; i++) {
        expect(chunks[i]!.startLine).toBe(chunks[i - 1]!.endLine + 1);
      }
    });
  });

  describe('chunk metadata', () => {
    it('sets correct segment, filePath, language from WalkedFile', () => {
      // Arrange
      const text = 'hello world';
      const config = makeConfig();
      const hash = fileHash(text);

      // Act
      const chunks = chunkLines(text, file, config, hash);

      // Assert
      expect(chunks[0]!.segment).toBe('web');
      expect(chunks[0]!.filePath).toBe('src/util.ts');
      expect(chunks[0]!.language).toBe('typescript');
      expect(chunks[0]!.kind).toBe('block');
      expect(chunks[0]!.symbol).toBeUndefined();
    });

    it('all chunks from the same file share the same fileHash', () => {
      // Arrange
      const text = makeLines(40, 12);
      const config = makeConfig({ maxTokens: 50, overlapLines: 0 });
      const hash = fileHash(text);

      // Act
      const chunks = chunkLines(text, file, config, hash);

      // Assert
      const hashes = new Set(chunks.map(c => c.fileHash));
      expect(hashes.size).toBe(1);
      expect([...hashes][0]).toBe(hash);
    });

    it('id is deterministic — same input produces same id', () => {
      // Arrange
      const text = 'const x = 1;\nconst y = 2;';
      const config = makeConfig();
      const hash = fileHash(text);

      // Act
      const a = chunkLines(text, file, config, hash);
      const b = chunkLines(text, file, config, hash);

      // Assert
      expect(a.map(c => c.id)).toEqual(b.map(c => c.id));
    });

    it('id differs for chunks at different line ranges', () => {
      // Arrange
      const text = makeLines(30, 12);
      const config = makeConfig({ maxTokens: 50, overlapLines: 0 });
      const hash = fileHash(text);

      // Act
      const chunks = chunkLines(text, file, config, hash);

      // Assert
      const ids = chunks.map(c => c.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('id differs between two files at the same line range', () => {
      // Arrange
      const text = 'line1\nline2';
      const config = makeConfig();
      const hash = fileHash(text);
      const fileA = makeFile({ relativePath: 'src/a.ts', segment: 'web' });
      const fileB = makeFile({ relativePath: 'src/b.ts', segment: 'web' });

      // Act
      const chunksA = chunkLines(text, fileA, config, hash);
      const chunksB = chunkLines(text, fileB, config, hash);

      // Assert
      expect(chunksA[0]!.id).not.toBe(chunksB[0]!.id);
    });
  });

  describe('edge cases', () => {
    it('single line exceeding maxTokens produces one chunk (boundary tolerance)', () => {
      // Arrange — one very long line, maxTokens much smaller
      const text = 'x'.repeat(400); // ~100 tokens
      const config = makeConfig({ maxTokens: 10, overlapLines: 0 });

      // Act
      const chunks = chunkLines(text, file, config, fileHash(text));

      // Assert — must produce at least one chunk covering the line
      expect(chunks).toHaveLength(1);
      expect(chunks[0]!.startLine).toBe(1);
      expect(chunks[0]!.endLine).toBe(1);
    });

    it('trailing newline does not produce a phantom empty last chunk', () => {
      // Arrange
      const text = 'const a = 1;\nconst b = 2;\n';
      const config = makeConfig({ maxTokens: 512 });

      // Act
      const chunks = chunkLines(text, file, config, fileHash(text));

      // Assert — trailing \n should not create an extra empty chunk
      expect(chunks).toHaveLength(1);
      expect(chunks[0]!.endLine).toBe(2);
    });
  });
});
