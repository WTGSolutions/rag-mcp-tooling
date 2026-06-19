import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { RagConfig } from '../../config.js';
import type { Chunk } from '../../chunk/types.js';
import type { Embedder } from '../../embedder/types.js';
import { VectorStore } from '../../store/vector-store.js';
import { getChunkOutputShape, makeGetChunk } from './get-chunk.js';

// TASK-045: get_chunk surfaces structural context (imports / callers / docLinks).

const DIM = 4;
const vec = () => new Float32Array([1, 0, 0, 0]);

function makeChunk(id: string, o: Partial<Chunk> = {}): Chunk {
  return {
    id,
    segment: 'web',
    filePath: 'src/a.ts',
    startLine: 1,
    endLine: 5,
    language: 'typescript',
    symbol: 'foo',
    kind: 'function',
    text: 'function foo() {}',
    fileHash: 'h',
    ...o,
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
  return { modelId: 'fake', dimensions: DIM, embed: async (t) => t.map(() => vec()) };
}

describe('get_chunk structural metadata (TASK-045)', () => {
  let dir: string;
  let store: VectorStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rag-getmeta-'));
    store = VectorStore.open(join(dir, 'index.db'), DIM, 'fake');
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const deps = () => ({ config: makeConfig(), store, embedder: fakeEmbedder(), cwd: '/' });

  function seed() {
    store.upsert(
      [
        // target symbol foo()
        makeChunk('foo', { imports: ['node:fs'] }),
        // a caller that references foo
        makeChunk('run', { id: 'run', filePath: 'src/b.ts', symbol: 'run', callees: ['foo'] }),
        // a doc section mentioning foo
        makeChunk('doc', {
          id: 'doc',
          segment: 'wiki',
          filePath: 'guide.md',
          language: 'markdown',
          kind: 'section',
          symbol: undefined,
          text: 'Use foo() to do the thing.',
        }),
      ],
      [vec(), vec(), vec()],
    );
  }

  it('surfaces imports, callers and docLinks in structuredContent', async () => {
    seed();
    const result = await makeGetChunk(deps())({ id: 'foo' });
    const sc = (result as { structuredContent: Record<string, unknown> }).structuredContent;

    expect(sc.imports).toEqual(['node:fs']);
    expect((sc.callers as Array<{ id: string }>).map((c) => c.id)).toEqual(['run']);
    expect((sc.docLinks as Array<{ filePath: string }>).map((c) => c.filePath)).toEqual(['guide.md']);
  });

  it('renders imports/callers/docs in the human-readable text', async () => {
    seed();
    const result = await makeGetChunk(deps())({ id: 'foo' });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('imports: node:fs');
    expect(text).toContain('callers: src/b.ts:1');
    expect(text).toContain('docs: guide.md:1');
  });

  it('output satisfies the declared schema (always-present arrays)', async () => {
    seed();
    const result = await makeGetChunk(deps())({ id: 'run' });
    const sc = (result as { structuredContent: Record<string, unknown> }).structuredContent;
    expect(() => z.object(getChunkOutputShape).parse(sc)).not.toThrow();
    // run() has no stored imports and nobody calls it → empty arrays, not missing
    expect(sc.imports).toEqual([]);
    expect(sc.callers).toEqual([]);
    expect(sc.docLinks).toEqual([]);
  });

  it('a chunk without a symbol gets empty callers/docLinks', async () => {
    store.upsert([makeChunk('nosym', { symbol: undefined })], [vec()]);
    const result = await makeGetChunk(deps())({ id: 'nosym' });
    const sc = (result as { structuredContent: Record<string, unknown> }).structuredContent;
    expect(sc.callers).toEqual([]);
    expect(sc.docLinks).toEqual([]);
  });
});
