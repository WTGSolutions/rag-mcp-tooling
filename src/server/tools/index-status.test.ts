import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { makeIndexStatus, formatStatus } from './index-status.js';
import { VectorStore } from '../../store/vector-store.js';
import type { Embedder } from '../../embedder/types.js';
import type { RagConfig } from '../../config.js';
import type { Chunk } from '../../chunk/types.js';
import type { StoreStats, SegmentStat } from '../../store/vector-store.js';

const DIM = 4;

function makeChunk(id: string, overrides: Partial<Chunk> = {}): Chunk {
  return {
    id, segment: 'web', filePath: 'src/a.ts', startLine: 1, endLine: 5,
    language: 'typescript', symbol: undefined, kind: 'block', text: 't', fileHash: 'h',
    ...overrides,
  };
}

function makeConfig(): RagConfig {
  return {
    segments: [{ name: 'web', root: 'src', include: ['**/*.ts'] }],
    exclude: [],
    embedder: { provider: 'local', model: 'fake' },
    chunk: { maxTokens: 512, overlapLines: 0 },
    store: { path: ':memory:' },
  };
}

function fakeEmbedder(): Embedder {
  return { modelId: 'fake-model', dimensions: DIM, embed: async (t) => t.map(() => new Float32Array(DIM)) };
}

function vec(...v: number[]): Float32Array {
  return new Float32Array(v);
}

describe('formatStatus', () => {
  it('renders totals, model, last-indexed, and per-segment lines', () => {
    const stats: StoreStats = {
      chunks: 5, files: 2, segments: ['mobile', 'web'],
      modelId: 'bge', dimensions: 384, lastIndexed: '2026-06-04T00:00:00.000Z',
    };
    const segs: SegmentStat[] = [
      { segment: 'mobile', chunks: 2, files: 1 },
      { segment: 'web', chunks: 3, files: 1 },
    ];

    const text = formatStatus(stats, segs);

    expect(text).toContain('5 chunks across 2 files');
    expect(text).toContain('bge (384d)');
    expect(text).toContain('2026-06-04');
    expect(text).toContain('mobile: 2 chunks, 1 files');
    expect(text).toContain('web: 3 chunks, 1 files');
  });

  it('shows "never" when the index was not built', () => {
    const stats: StoreStats = { chunks: 0, files: 0, segments: [], modelId: 'm', dimensions: 4, lastIndexed: null };
    expect(formatStatus(stats, [])).toContain('Last indexed: never');
  });
});

describe('makeIndexStatus', () => {
  let tmpDir: string;
  let store: VectorStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'rag-status-'));
    store = VectorStore.open(join(tmpDir, 'index.db'), DIM, 'fake-model');
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('maps store stats + per-segment counts into structuredContent', async () => {
    // Arrange — 2 web files (3 chunks), 1 mobile file (1 chunk)
    store.upsert(
      [
        makeChunk('w1', { segment: 'web', filePath: 'a.ts' }),
        makeChunk('w2', { segment: 'web', filePath: 'a.ts' }),
        makeChunk('w3', { segment: 'web', filePath: 'b.ts' }),
        makeChunk('m1', { segment: 'mobile', filePath: 'c.ts' }),
      ],
      [vec(1, 0, 0, 0), vec(0, 1, 0, 0), vec(0, 0, 1, 0), vec(0, 0, 0, 1)],
    );
    const handler = makeIndexStatus({ config: makeConfig(), store, embedder: fakeEmbedder() });

    // Act
    const result = await handler();

    // Assert
    const s = (result as { structuredContent: {
      chunks: number; files: number; modelId: string; dimensions: number;
      lastIndexed: string | null; segments: SegmentStat[];
    } }).structuredContent;
    expect(s.chunks).toBe(4);
    expect(s.files).toBe(3);
    expect(s.modelId).toBe('fake-model');
    expect(s.dimensions).toBe(DIM);
    expect(s.lastIndexed).not.toBeNull();
    expect(s.segments).toEqual([
      { segment: 'mobile', chunks: 1, files: 1 },
      { segment: 'web', chunks: 3, files: 2 },
    ]);
  });

  it('reports an empty index without crashing', async () => {
    const handler = makeIndexStatus({ config: makeConfig(), store, embedder: fakeEmbedder() });
    const result = await handler();
    const s = (result as { structuredContent: { chunks: number; segments: SegmentStat[]; lastIndexed: string | null } }).structuredContent;
    expect(s.chunks).toBe(0);
    expect(s.segments).toEqual([]);
    expect(s.lastIndexed).toBeNull();
  });

  it('does not modify the store (read-only)', async () => {
    store.upsert([makeChunk('w1')], [vec(1, 0, 0, 0)]);
    const before = store.stats().chunks;
    await makeIndexStatus({ config: makeConfig(), store, embedder: fakeEmbedder() })();
    expect(store.stats().chunks).toBe(before);
  });
});
