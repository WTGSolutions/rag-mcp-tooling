import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { VectorStore } from './vector-store.js';
import type { Chunk } from '../chunk/types.js';

const DIM = 4;
const MODEL = 'Xenova/bge-small-en-v1.5';

function makeChunk(id: string, overrides: Partial<Chunk> = {}): Chunk {
  return {
    id,
    segment: 'web',
    filePath: 'src/a.ts',
    startLine: 1,
    endLine: 10,
    language: 'typescript',
    symbol: undefined,
    kind: 'function',
    text: `text for ${id}`,
    fileHash: 'hash-a',
    ...overrides,
  };
}

function makeVec(...values: number[]): Float32Array {
  return new Float32Array(values);
}

// L2-normalise a float32 vector (unit vector for cosine-equivalent search)
function normalise(v: Float32Array): Float32Array {
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return new Float32Array(v.map(x => x / norm));
}

let tmpDir: string;
let storePath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'rag-test-'));
  storePath = join(tmpDir, '.rag', 'index.db');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('VectorStore.open', () => {
  it('creates the store file and parent directories', () => {
    // Arrange + Act
    const store = VectorStore.open(storePath, DIM, MODEL);
    store.close();

    // Assert — file should exist (non-empty)
    expect(statSync(storePath).size).toBeGreaterThan(0);
  });

  it('throws with a descriptive error when reopened with wrong dimensions', () => {
    // Arrange — first open creates schema with DIM=4
    const store = VectorStore.open(storePath, DIM, MODEL);
    store.close();

    // Act + Assert — reopen with wrong dimensions must fail early, not silently
    expect(() => VectorStore.open(storePath, 8, MODEL)).toThrow('Dimension mismatch');
    expect(() => VectorStore.open(storePath, 8, MODEL)).toThrow('4');
    expect(() => VectorStore.open(storePath, 8, MODEL)).toThrow('8');
  });

  it('reopens successfully with matching dimensions', () => {
    // Arrange
    const s1 = VectorStore.open(storePath, DIM, MODEL);
    s1.upsert([makeChunk('c1')], [normalise(makeVec(1, 0, 0, 0))]);
    s1.close();

    // Act + Assert — same dimensions → no error
    const s2 = VectorStore.open(storePath, DIM, MODEL);
    expect(s2.stats().chunks).toBe(1);
    s2.close();
  });
});

describe('upsert', () => {
  it('stores chunks; second open reads them back', () => {
    // Arrange
    const store = VectorStore.open(storePath, DIM, MODEL);
    const chunk = makeChunk('c1');
    const vec = normalise(makeVec(1, 0, 0, 0));

    // Act
    store.upsert([chunk], [vec]);
    store.close();

    // Assert — reopen and check stats
    const store2 = VectorStore.open(storePath, DIM, MODEL);
    const s = store2.stats();
    expect(s.chunks).toBe(1);
    store2.close();
  });

  it('overwrites an existing chunk with the same id (no duplicates)', () => {
    // Arrange
    const store = VectorStore.open(storePath, DIM, MODEL);
    const chunk = makeChunk('c1', { text: 'original' });
    const vecA = normalise(makeVec(1, 0, 0, 0));

    // Act
    store.upsert([chunk], [vecA]);
    const chunkV2 = makeChunk('c1', { text: 'updated', fileHash: 'hash-v2' });
    const vecB = normalise(makeVec(0, 1, 0, 0));
    store.upsert([chunkV2], [vecB]);

    const s = store.stats();
    store.close();

    // Assert — still exactly 1 chunk
    expect(s.chunks).toBe(1);
  });

  it('throws when chunk and vector arrays have different lengths', () => {
    // Arrange
    const store = VectorStore.open(storePath, DIM, MODEL);

    // Act + Assert
    expect(() =>
      store.upsert([makeChunk('c1')], [makeVec(1, 0, 0, 0), makeVec(0, 1, 0, 0)])
    ).toThrow('chunks.length');

    store.close();
  });

  it('throws when a vector has the wrong dimension', () => {
    // Arrange
    const store = VectorStore.open(storePath, DIM, MODEL);

    // Act + Assert
    expect(() =>
      store.upsert([makeChunk('c1')], [new Float32Array([1, 0, 0])])  // 3 ≠ DIM=4
    ).toThrow('length');

    store.close();
  });

  it('handles duplicate chunk id within a single batch (last entry wins)', () => {
    // Arrange
    const store = VectorStore.open(storePath, DIM, MODEL);
    const v1 = normalise(makeVec(1, 0, 0, 0));
    const v2 = normalise(makeVec(0, 1, 0, 0));
    const v3 = normalise(makeVec(0, 0, 1, 0));

    // Act — 'c1' appears twice; second entry should win
    store.upsert([
      makeChunk('c1', { text: 'first' }),
      makeChunk('c2', { text: 'other' }),
      makeChunk('c1', { text: 'second' }),
    ], [v1, v2, v3]);

    const s = store.stats();
    store.close();

    // Assert — exactly 2 unique chunks, not 3
    expect(s.chunks).toBe(2);
  });

  it('no-ops for empty input', () => {
    // Arrange
    const store = VectorStore.open(storePath, DIM, MODEL);

    // Act + Assert
    expect(() => store.upsert([], [])).not.toThrow();
    expect(store.stats().chunks).toBe(0);
    store.close();
  });
});

describe('search', () => {
  let store: VectorStore;

  // Vectors: orthogonal unit vectors for predictable distance ordering
  const vecs = {
    alpha:  normalise(makeVec(1, 0, 0, 0)),
    beta:   normalise(makeVec(0, 1, 0, 0)),
    gamma:  normalise(makeVec(0, 0, 1, 0)),
    delta:  normalise(makeVec(0, 0, 0, 1)),
    nearA:  normalise(makeVec(0.9, 0.1, 0, 0)),
  };

  beforeEach(() => {
    store = VectorStore.open(storePath, DIM, MODEL);
    store.upsert([
      makeChunk('alpha', { segment: 'web',    filePath: 'src/a.ts' }),
      makeChunk('beta',  { segment: 'web',    filePath: 'src/b.ts' }),
      makeChunk('gamma', { segment: 'mobile', filePath: 'src/c.ts' }),
      makeChunk('delta', { segment: 'mobile', filePath: 'src/d.ts' }),
    ], [vecs.alpha, vecs.beta, vecs.gamma, vecs.delta]);
  });

  afterEach(() => store.close());

  it('returns k results ordered by descending score', () => {
    // Arrange + Act
    const results = store.search(vecs.nearA, 3);

    // Assert
    expect(results).toHaveLength(3);
    // scores must be non-increasing
    for (let i = 1; i < results.length; i++) {
      expect(results[i]!.score).toBeLessThanOrEqual(results[i - 1]!.score);
    }
    // closest match is 'alpha' (same direction as nearA)
    expect(results[0]!.chunk.id).toBe('alpha');
  });

  it('score is ~1 for identical vector and ≥0', () => {
    // Arrange + Act
    const [top] = store.search(vecs.alpha, 1);

    // Assert
    expect(top!.score).toBeCloseTo(1, 4);
    expect(top!.score).toBeGreaterThanOrEqual(0);
  });

  it('returns complete chunk metadata', () => {
    // Arrange + Act
    const [top] = store.search(vecs.alpha, 1);

    // Assert
    const c = top!.chunk;
    expect(c.id).toBe('alpha');
    expect(c.segment).toBe('web');
    expect(c.filePath).toBe('src/a.ts');
    expect(c.language).toBe('typescript');
    expect(c.kind).toBe('function');
  });

  it('filters by segment', () => {
    // Arrange + Act — all docs, filter to mobile
    const results = store.search(vecs.alpha, 4, { segment: 'mobile' });

    // Assert — only mobile chunks
    expect(results.length).toBeGreaterThan(0);
    expect(results.every(r => r.chunk.segment === 'mobile')).toBe(true);
  });

  it('returns fewer than k results when the segment has fewer matches', () => {
    // Arrange + Act
    const results = store.search(vecs.alpha, 10, { segment: 'web' });

    // Assert — only 2 web chunks
    expect(results).toHaveLength(2);
  });

  it('returns [] for k < 1', () => {
    expect(store.search(vecs.alpha, 0)).toEqual([]);
  });

  it('returns [] for non-finite k values (Infinity, NaN) without throwing', () => {
    expect(store.search(vecs.alpha, Infinity)).toEqual([]);
    expect(store.search(vecs.alpha, NaN)).toEqual([]);
  });

  it('truncates fractional k to integer (k=1.9 returns 1 result)', () => {
    const results = store.search(vecs.alpha, 1.9);
    expect(results).toHaveLength(1);
  });

  it('throws when query vector has wrong dimension', () => {
    expect(() => store.search(new Float32Array([1, 0, 0]), 1)).toThrow('length');
  });
});

describe('deleteByFile', () => {
  it('removes all chunks for a given filePath', () => {
    // Arrange
    const store = VectorStore.open(storePath, DIM, MODEL);
    store.upsert([
      makeChunk('c1', { filePath: 'src/del.ts', fileHash: 'h' }),
      makeChunk('c2', { filePath: 'src/del.ts', fileHash: 'h' }),
      makeChunk('c3', { filePath: 'src/keep.ts', fileHash: 'h2' }),
    ], [
      normalise(makeVec(1, 0, 0, 0)),
      normalise(makeVec(0, 1, 0, 0)),
      normalise(makeVec(0, 0, 1, 0)),
    ]);

    // Act
    store.deleteByFile('src/del.ts');

    // Assert
    expect(store.stats().chunks).toBe(1);
    const results = store.search(normalise(makeVec(1, 0, 0, 0)), 5);
    expect(results.every(r => r.chunk.filePath === 'src/keep.ts')).toBe(true);
    store.close();
  });

  it('no-ops when the file does not exist', () => {
    // Arrange
    const store = VectorStore.open(storePath, DIM, MODEL);

    // Act + Assert
    expect(() => store.deleteByFile('nonexistent.ts')).not.toThrow();
    store.close();
  });
});

describe('stats', () => {
  it('returns correct counts, model, dimensions, and lastIndexed', () => {
    // Arrange
    const store = VectorStore.open(storePath, DIM, MODEL);
    store.upsert([
      makeChunk('c1', { filePath: 'src/a.ts', segment: 'web' }),
      makeChunk('c2', { filePath: 'src/a.ts', segment: 'web' }),
      makeChunk('c3', { filePath: 'src/b.ts', segment: 'mobile' }),
    ], [
      normalise(makeVec(1, 0, 0, 0)),
      normalise(makeVec(0, 1, 0, 0)),
      normalise(makeVec(0, 0, 1, 0)),
    ]);

    // Act
    const s = store.stats();
    store.close();

    // Assert
    expect(s.chunks).toBe(3);
    expect(s.files).toBe(2);
    expect(s.segments).toEqual(['mobile', 'web']);
    expect(s.modelId).toBe(MODEL);
    expect(s.dimensions).toBe(DIM);
    expect(s.lastIndexed).not.toBeNull();
    expect(new Date(s.lastIndexed!).getFullYear()).toBeGreaterThanOrEqual(2024);
  });

  it('returns null lastIndexed on a fresh store with no upserts', () => {
    // Arrange + Act
    const store = VectorStore.open(storePath, DIM, MODEL);
    const s = store.stats();
    store.close();

    // Assert
    expect(s.chunks).toBe(0);
    expect(s.lastIndexed).toBeNull();
  });
});
