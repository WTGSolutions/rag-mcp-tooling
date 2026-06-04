import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { makeGetChunk, formatChunk } from './get-chunk.js';
import { makeSearchCodebase } from './search-codebase.js';
import { VectorStore } from '../../store/vector-store.js';
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
    text: 'function doThing() {\n  return 1;\n}',
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

function fakeEmbedder(): Embedder {
  return { modelId: 'fake', dimensions: DIM, embed: async (t) => t.map(() => new Float32Array([1, 0, 0, 0])) };
}

describe('formatChunk', () => {
  it('renders the clickable ref, metadata, id, and full (untruncated) text', () => {
    const chunk = makeChunk('id1', { text: 'x'.repeat(500) });
    const text = formatChunk(chunk);
    expect(text).toContain('src/a.ts:10');
    expect(text).toContain('[function doThing · web · typescript]');
    expect(text).toContain('id=id1');
    expect(text).toContain('x'.repeat(500)); // full text, not truncated
  });
});

describe('makeGetChunk', () => {
  let tmpDir: string;
  let store: VectorStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'rag-getchunk-'));
    store = VectorStore.open(join(tmpDir, 'index.db'), DIM, 'fake');
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function deps() {
    return { config: makeConfig(), store, embedder: fakeEmbedder(), cwd: '/' };
  }

  it('returns full text + structured metadata for an existing id', async () => {
    // Arrange
    store.upsert([makeChunk('abc', { text: 'hello world' })], [new Float32Array([1, 0, 0, 0])]);
    const handler = makeGetChunk(deps());

    // Act
    const result = await handler({ id: 'abc' });

    // Assert
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('hello world');
    const structured = (result as { structuredContent: Record<string, unknown> }).structuredContent;
    expect(structured).toMatchObject({
      id: 'abc', filePath: 'src/a.ts', startLine: 10, endLine: 20,
      segment: 'web', kind: 'function', symbol: 'doThing', language: 'typescript', text: 'hello world',
    });
  });

  it('omits symbol in structuredContent when the chunk has none', async () => {
    store.upsert([makeChunk('nosym', { symbol: undefined })], [new Float32Array([1, 0, 0, 0])]);
    const result = await makeGetChunk(deps())({ id: 'nosym' });
    const structured = (result as { structuredContent: Record<string, unknown> }).structuredContent;
    expect('symbol' in structured).toBe(false);
  });

  it('throws a clear "not found" error for an unknown id', async () => {
    const handler = makeGetChunk(deps());
    await expect(handler({ id: 'does-not-exist' })).rejects.toThrow('no chunk found with id "does-not-exist"');
  });

  it('rejects an empty id', async () => {
    const handler = makeGetChunk(deps());
    await expect(handler({ id: '  ' })).rejects.toThrow('id must not be empty');
  });

  it('trims surrounding whitespace before lookup (ids copied from prose)', async () => {
    // Arrange
    store.upsert([makeChunk('abc', { text: 'trimmed lookup' })], [new Float32Array([1, 0, 0, 0])]);
    const handler = makeGetChunk(deps());

    // Act — id pasted with stray whitespace
    const result = await handler({ id: '  abc  ' });

    // Assert — resolves the same chunk
    expect((result.content[0] as { text: string }).text).toContain('trimmed lookup');
  });

  it('renders an empty-text chunk without crashing', async () => {
    // Arrange
    store.upsert([makeChunk('empty', { text: '' })], [new Float32Array([1, 0, 0, 0])]);
    const handler = makeGetChunk(deps());

    // Act
    const result = await handler({ id: 'empty' });

    // Assert — header + id present, text section empty
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('id=empty');
    expect((result as { structuredContent: { text: string } }).structuredContent.text).toBe('');
  });

  it('does not modify the store (read-only)', async () => {
    store.upsert([makeChunk('abc')], [new Float32Array([1, 0, 0, 0])]);
    const before = store.stats().chunks;
    await makeGetChunk(deps())({ id: 'abc' });
    expect(store.stats().chunks).toBe(before);
  });

  describe('contract with search_codebase', () => {
    it('an id returned by search_codebase resolves via get_chunk', async () => {
      // Arrange — index a chunk, search to obtain its id from structuredContent
      store.upsert(
        [makeChunk('real-id', { text: 'the indexed body', filePath: 'web/auth.ts' })],
        [new Float32Array([0, 1, 0, 0])],
      );
      const searchEmbedder: Embedder = {
        modelId: 'fake', dimensions: DIM, embed: async (t) => t.map(() => new Float32Array([0, 1, 0, 0])),
      };
      const search = makeSearchCodebase({ config: makeConfig(), store, embedder: searchEmbedder, cwd: '/' });
      const getChunk = makeGetChunk(deps());

      // Act — take the id from search's structuredContent, feed it to get_chunk
      const searchResult = await search({ query: 'auth' });
      const id = (searchResult as { structuredContent: { results: Array<{ id: string }> } }).structuredContent.results[0]!.id;
      const chunkResult = await getChunk({ id });

      // Assert — same chunk, full text now present
      expect(id).toBe('real-id');
      expect((chunkResult.content[0] as { text: string }).text).toContain('the indexed body');
    });
  });
});
