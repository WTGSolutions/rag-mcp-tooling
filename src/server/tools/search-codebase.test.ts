import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { makeSearchCodebase, formatResults, DEFAULT_K, searchOutputShape } from './search-codebase.js';
import { VectorStore, type SearchResult } from '../../store/vector-store.js';
import type { Embedder } from '../../embedder/types.js';
import type { RagConfig } from '../../config.js';
import type { Chunk } from '../../chunk/types.js';

const DIM = 4;

function makeChunk(id: string, overrides: Partial<Chunk> = {}): Chunk {
  return {
    id,
    segment: 'web',
    filePath: 'src/a.ts',
    startLine: 10,
    endLine: 20,
    language: 'typescript',
    symbol: 'doThing',
    kind: 'function',
    text: 'function doThing() { return 1; }',
    fileHash: 'h',
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

/** Records embed inputs and returns a fixed unit vector. */
function spyEmbedder() {
  const calls: string[][] = [];
  const embedder: Embedder = {
    modelId: 'fake',
    dimensions: DIM,
    embed: async (texts) => {
      calls.push(texts);
      return texts.map(() => new Float32Array([1, 0, 0, 0]));
    },
  };
  return { embedder, calls };
}

/** Records search() arguments and returns a fixed result set. */
function spyStore(results: SearchResult[]) {
  const calls: Array<{ vector: Float32Array; k: number; filter: unknown }> = [];
  const store = {
    search: (vector: Float32Array, k: number, filter?: unknown) => {
      calls.push({ vector, k, filter });
      return results;
    },
  } as unknown as VectorStore;
  return { store, calls };
}

function deps(embedder: Embedder, store: VectorStore) {
  return { config: makeConfig(), store, embedder, cwd: '/' };
}

describe('formatResults', () => {
  it('renders a clickable file:line header, id, score, and truncated snippet', () => {
    // Arrange
    const results: SearchResult[] = [
      { chunk: makeChunk('id1', { filePath: 'web/src/auth.ts', startLine: 5, endLine: 9 }), score: 0.82 },
    ];

    // Act
    const text = formatResults(results, 'auth');

    // Assert
    expect(text).toContain('web/src/auth.ts:5'); // clickable ref at start line
    expect(text).toContain('(lines 5-9)');
    expect(text).toContain('id=id1');
    expect(text).toContain('score 0.82');
    expect(text).toContain('get_chunk');
  });

  it('truncates a long snippet with an ellipsis', () => {
    // Arrange
    const longText = 'x'.repeat(500);
    const results: SearchResult[] = [{ chunk: makeChunk('id1', { text: longText }), score: 0.5 }];

    // Act
    const text = formatResults(results, 'q');

    // Assert — snippet is shortened, not the full 500 chars
    expect(text).toContain('…');
    expect(text.length).toBeLessThan(longText.length);
  });

  it('reports no matches clearly', () => {
    expect(formatResults([], 'nothing')).toBe('No matches for "nothing".');
  });

  it('uses kind alone when a chunk has no symbol', () => {
    const results: SearchResult[] = [{ chunk: makeChunk('id1', { symbol: undefined, kind: 'block' }), score: 0.3 }];
    const text = formatResults(results, 'q');
    expect(text).toContain('[block ·');
  });

  it('formats a perfect score as 1.00', () => {
    const results: SearchResult[] = [{ chunk: makeChunk('id1'), score: 1 }];
    expect(formatResults(results, 'q')).toContain('score 1.00');
  });

  it('does not slice a surrogate pair (emoji) mid-character', () => {
    // 279 ASCII + a 2-code-unit emoji: the cut at 280 would split the emoji.
    const results: SearchResult[] = [{ chunk: makeChunk('id1', { text: 'a'.repeat(279) + '🎯 trailing' }), score: 0.5 }];
    const text = formatResults(results, 'q');
    // No lone high surrogate left dangling before the ellipsis.
    expect(/[\uD800-\uDBFF] …/.test(text)).toBe(false);
  });

  it('omits the snippet line for an empty-text chunk (no whitespace-only line)', () => {
    const results: SearchResult[] = [{ chunk: makeChunk('id1', { text: '' }), score: 0.5 }];
    const text = formatResults(results, 'q');
    // Ends right after the id line — no trailing indented blank line.
    expect(text).toContain('id=id1');
    expect(text).not.toMatch(/id=id1\n {3}\n/);
  });
});

describe('makeSearchCodebase — pipeline', () => {
  it('embeds the query and passes the vector + default k to the store', async () => {
    // Arrange
    const { embedder, calls: embedCalls } = spyEmbedder();
    const { store, calls: searchCalls } = spyStore([{ chunk: makeChunk('id1'), score: 0.9 }]);
    const handler = makeSearchCodebase(deps(embedder, store));

    // Act
    const result = await handler({ query: 'find auth' });

    // Assert
    expect(embedCalls).toEqual([['find auth']]);            // query embedded once
    expect(searchCalls[0]!.k).toBe(DEFAULT_K);              // default k
    expect(searchCalls[0]!.filter).toBeUndefined();         // no segment → no filter
    expect(searchCalls[0]!.vector).toEqual(new Float32Array([1, 0, 0, 0]));
    expect((result.content[0] as { text: string }).text).toContain('id=id1');
  });

  it('returns machine-readable structuredContent matching the chunks', async () => {
    // Arrange
    const { embedder } = spyEmbedder();
    const chunk = makeChunk('id-abc', { filePath: 'web/x.ts', startLine: 3, endLine: 7, segment: 'web', kind: 'function', symbol: 'foo' });
    const { store } = spyStore([{ chunk, score: 0.77 }]);
    const handler = makeSearchCodebase(deps(embedder, store));

    // Act
    const result = await handler({ query: 'q' });

    // Assert — agent reads structuredContent (not the prose) to chain into get_chunk
    const structured = (result as { structuredContent: { results: Array<Record<string, unknown>> } }).structuredContent;
    expect(structured.results).toHaveLength(1);
    expect(structured.results[0]).toEqual({
      id: 'id-abc', filePath: 'web/x.ts', startLine: 3, endLine: 7,
      segment: 'web', kind: 'function', symbol: 'foo', score: 0.77,
    });
    // The structured payload must satisfy the declared output schema, or the
    // MCP SDK silently strips the offending fields.
    expect(() => z.object(searchOutputShape).parse(structured)).not.toThrow();
  });

  it('omits symbol in structuredContent when the chunk has none', async () => {
    const { embedder } = spyEmbedder();
    const { store } = spyStore([{ chunk: makeChunk('id1', { symbol: undefined }), score: 0.5 }]);
    const handler = makeSearchCodebase(deps(embedder, store));
    const result = await handler({ query: 'q' });
    const structured = (result as { structuredContent: { results: Array<Record<string, unknown>> } }).structuredContent;
    expect('symbol' in structured.results[0]!).toBe(false);
  });

  it('preserves store ordering in both text and structuredContent (no re-sort)', async () => {
    // Arrange — store returns a, b, c in that order
    const { embedder } = spyEmbedder();
    const { store } = spyStore([
      { chunk: makeChunk('a', { filePath: 'a.ts' }), score: 0.9 },
      { chunk: makeChunk('b', { filePath: 'b.ts' }), score: 0.8 },
      { chunk: makeChunk('c', { filePath: 'c.ts' }), score: 0.7 },
    ]);
    const handler = makeSearchCodebase(deps(embedder, store));

    // Act
    const result = await handler({ query: 'q' });
    const text = (result.content[0] as { text: string }).text;
    const structured = (result as { structuredContent: { results: Array<{ id: string }> } }).structuredContent;

    // Assert — order matches store output exactly
    expect(structured.results.map((r) => r.id)).toEqual(['a', 'b', 'c']);
    expect(text.indexOf('1. a.ts')).toBeLessThan(text.indexOf('2. b.ts'));
    expect(text.indexOf('2. b.ts')).toBeLessThan(text.indexOf('3. c.ts'));
  });

  it('wraps an embedder failure in a branded, actionable error', async () => {
    // Arrange — embedder rejects (e.g. model load failure)
    const embedder: Embedder = {
      modelId: 'bge-x',
      dimensions: DIM,
      embed: async () => { throw new Error('onnxruntime: file not found'); },
    };
    const { store } = spyStore([]);
    const handler = makeSearchCodebase(deps(embedder, store));

    // Act + Assert — agent gets a [rag-mcp] message naming the model, not a raw stack
    await expect(handler({ query: 'q' })).rejects.toThrow('[rag-mcp] search_codebase: embedding failed for model bge-x');
  });

  it('passes k and segment through to the store', async () => {
    // Arrange
    const { embedder } = spyEmbedder();
    const { store, calls } = spyStore([]);
    const handler = makeSearchCodebase(deps(embedder, store));

    // Act
    await handler({ query: 'q', k: 3, segment: 'mobile' });

    // Assert
    expect(calls[0]!.k).toBe(3);
    expect(calls[0]!.filter).toEqual({ segment: 'mobile' });
  });

  it('trims the query before embedding', async () => {
    // Arrange
    const { embedder, calls } = spyEmbedder();
    const { store } = spyStore([]);
    const handler = makeSearchCodebase(deps(embedder, store));

    // Act
    await handler({ query: '  spaced  ' });

    // Assert
    expect(calls[0]).toEqual(['spaced']);
  });

  describe('validation', () => {
    it('rejects an empty / whitespace-only query', async () => {
      const { embedder } = spyEmbedder();
      const { store } = spyStore([]);
      const handler = makeSearchCodebase(deps(embedder, store));
      await expect(handler({ query: '   ' })).rejects.toThrow('must not be empty');
    });

    it('rejects an over-long query', async () => {
      const { embedder } = spyEmbedder();
      const { store } = spyStore([]);
      const handler = makeSearchCodebase(deps(embedder, store));
      await expect(handler({ query: 'x'.repeat(2000) })).rejects.toThrow('too long');
    });

    it('rejects k out of range', async () => {
      const { embedder } = spyEmbedder();
      const { store } = spyStore([]);
      const handler = makeSearchCodebase(deps(embedder, store));
      await expect(handler({ query: 'q', k: 0 })).rejects.toThrow('k must be');
      await expect(handler({ query: 'q', k: 999 })).rejects.toThrow('k must be');
    });
  });
});

describe('makeSearchCodebase — real mini-index', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'rag-search-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns the nearest chunk for a query vector (orthogonal fixtures)', async () => {
    // Arrange — three orthogonal unit vectors; query aligns with "beta"
    const store = VectorStore.open(join(tmpDir, 'index.db'), DIM, 'fake');
    store.upsert(
      [
        makeChunk('alpha', { filePath: 'a.ts', segment: 'web' }),
        makeChunk('beta', { filePath: 'b.ts', segment: 'mobile' }),
        makeChunk('gamma', { filePath: 'c.ts', segment: 'web' }),
      ],
      [
        new Float32Array([1, 0, 0, 0]),
        new Float32Array([0, 1, 0, 0]),
        new Float32Array([0, 0, 1, 0]),
      ],
    );

    // Embedder that maps any query to the "beta" direction
    const embedder: Embedder = {
      modelId: 'fake',
      dimensions: DIM,
      embed: async (texts) => texts.map(() => new Float32Array([0, 1, 0, 0])),
    };
    const handler = makeSearchCodebase({ config: makeConfig(), store, embedder, cwd: '/' });

    // Act
    const result = await handler({ query: 'whatever', k: 1 });
    const text = (result.content[0] as { text: string }).text;
    store.close();

    // Assert — top hit is beta (b.ts), not alpha/gamma
    expect(text).toContain('b.ts:10');
    expect(text).not.toContain('a.ts:10');
  });

  it('restricts results to the requested segment', async () => {
    // Arrange
    const store = VectorStore.open(join(tmpDir, 'index.db'), DIM, 'fake');
    store.upsert(
      [
        makeChunk('w1', { filePath: 'web1.ts', segment: 'web' }),
        makeChunk('m1', { filePath: 'mob1.ts', segment: 'mobile' }),
      ],
      [new Float32Array([1, 0, 0, 0]), new Float32Array([0.99, 0.1, 0, 0])],
    );
    const embedder: Embedder = {
      modelId: 'fake',
      dimensions: DIM,
      embed: async (texts) => texts.map(() => new Float32Array([1, 0, 0, 0])),
    };
    const handler = makeSearchCodebase({ config: makeConfig(), store, embedder, cwd: '/' });

    // Act
    const result = await handler({ query: 'q', k: 5, segment: 'mobile' });
    const text = (result.content[0] as { text: string }).text;
    store.close();

    // Assert — only the mobile chunk, despite the web chunk being nearer
    expect(text).toContain('mob1.ts');
    expect(text).not.toContain('web1.ts');
  });
});
