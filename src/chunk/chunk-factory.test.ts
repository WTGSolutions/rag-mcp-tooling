import { describe, it, expect } from 'vitest';
import { createChunk, makeChunkId } from './chunk-factory.js';
import { sha1 } from '../hash.js';
import type { WalkedFile } from '../walker.js';

function makeFile(overrides: Partial<WalkedFile> = {}): WalkedFile {
  return {
    absolutePath: '/proj/web/src/auth.ts',
    relativePath: 'src/auth.ts',
    segment: 'web',
    language: 'typescript',
    ...overrides,
  };
}

describe('makeChunkId', () => {
  it('is deterministic for the same coordinates', () => {
    // Arrange + Act + Assert
    expect(makeChunkId('web', 'src/auth.ts', 1, 10)).toBe(makeChunkId('web', 'src/auth.ts', 1, 10));
  });

  it('matches the documented scheme sha1(segment::filePath:start-end)', () => {
    // Arrange + Act + Assert — locks the id format so AST/MD chunkers stay aligned
    expect(makeChunkId('web', 'src/auth.ts', 1, 10)).toBe(sha1('web::src/auth.ts:1-10'));
  });

  it('differs by segment', () => {
    expect(makeChunkId('web', 'src/auth.ts', 1, 10)).not.toBe(makeChunkId('mobile', 'src/auth.ts', 1, 10));
  });

  it('differs by filePath', () => {
    expect(makeChunkId('web', 'src/a.ts', 1, 10)).not.toBe(makeChunkId('web', 'src/b.ts', 1, 10));
  });

  it('differs by line range', () => {
    expect(makeChunkId('web', 'src/auth.ts', 1, 10)).not.toBe(makeChunkId('web', 'src/auth.ts', 1, 11));
  });
});

describe('createChunk', () => {
  it('maps WalkedFile metadata and derives a matching id', () => {
    // Arrange
    const file = makeFile();

    // Act
    const chunk = createChunk({
      file,
      fileHash: 'abc123',
      startLine: 5,
      endLine: 20,
      text: 'function f() {}',
      kind: 'function',
      symbol: 'f',
    });

    // Assert
    expect(chunk).toEqual({
      id: makeChunkId('web', 'src/auth.ts', 5, 20),
      segment: 'web',
      filePath: 'src/auth.ts',
      startLine: 5,
      endLine: 20,
      language: 'typescript',
      symbol: 'f',
      kind: 'function',
      text: 'function f() {}',
      fileHash: 'abc123',
    });
  });

  it('preserves non-block kinds and symbol names (the AST/markdown path)', () => {
    // Arrange — this is exactly what TASK-004/005 chunkers will produce and
    // what the line chunker never exercises (it always uses block/undefined)
    const file = makeFile();

    // Act
    const klass = createChunk({ file, fileHash: 'h', startLine: 1, endLine: 50, text: 'class C {}', kind: 'class', symbol: 'C' });
    const method = createChunk({ file, fileHash: 'h', startLine: 2, endLine: 8, text: 'm() {}', kind: 'method', symbol: 'C.m' });
    const section = createChunk({ file, fileHash: 'h', startLine: 1, endLine: 3, text: '# Title', kind: 'section', symbol: 'Title' });

    // Assert
    expect(klass.kind).toBe('class');
    expect(klass.symbol).toBe('C');
    expect(method.kind).toBe('method');
    expect(method.symbol).toBe('C.m');
    expect(section.kind).toBe('section');
    expect(section.symbol).toBe('Title');
  });

  it('leaves symbol undefined when not provided', () => {
    // Arrange
    const file = makeFile();

    // Act
    const chunk = createChunk({ file, fileHash: 'h', startLine: 1, endLine: 1, text: 'x', kind: 'block' });

    // Assert
    expect(chunk.symbol).toBeUndefined();
  });
});
