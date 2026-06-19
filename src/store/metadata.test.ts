import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Chunk } from '../chunk/types.js';
import { VectorStore } from './vector-store.js';

// TASK-045: sidecar metadata columns (imports_json/callees_json) — round-trip,
// reverse lookups (callers/doc mentions), coverage stat, and migration of a
// pre-TASK-045 store (no columns → added on open, vectors untouched).

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

describe('VectorStore metadata (TASK-045)', () => {
  let dir: string;
  let store: VectorStore;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rag-meta-'));
    path = join(dir, 'index.db');
    store = VectorStore.open(path, DIM, 'fake');
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips imports and callees through upsert/getChunkById', () => {
    store.upsert(
      [makeChunk('a', { imports: ['node:fs', './x.js'], callees: ['bar', 'baz'] })],
      [vec()],
    );
    const got = store.getChunkById('a');
    expect(got?.imports).toEqual(['node:fs', './x.js']);
    expect(got?.callees).toEqual(['bar', 'baz']);
  });

  it('leaves imports/callees undefined when not provided', () => {
    store.upsert([makeChunk('a')], [vec()]);
    const got = store.getChunkById('a');
    expect(got?.imports).toBeUndefined();
    expect(got?.callees).toBeUndefined();
  });

  it('findCallers returns chunks whose callees include the name, excluding self', () => {
    store.upsert(
      [
        makeChunk('caller', { symbol: 'run', callees: ['foo', 'log'] }),
        makeChunk('other', { id: 'other', symbol: 'idle', callees: ['unrelated'] }),
        makeChunk('self', { id: 'self', symbol: 'foo', callees: ['foo'] }), // recursive
      ],
      [vec(), vec(), vec()],
    );
    const callers = store.findCallers('foo', 'self');
    const ids = callers.map((c) => c.id);
    expect(ids).toContain('caller');
    expect(ids).not.toContain('other');
    expect(ids).not.toContain('self'); // excluded
  });

  it('findCallers escapes LIKE wildcards (underscore is literal in identifiers)', () => {
    store.upsert(
      [
        makeChunk('m', { symbol: 'r', callees: ['do_thing'] }),
        makeChunk('n', { id: 'n', symbol: 's', callees: ['doXthing'] }),
      ],
      [vec(), vec()],
    );
    // "do_thing" must not match "doXthing" via the `_` wildcard
    expect(store.findCallers('do_thing').map((c) => c.id)).toEqual(['m']);
  });

  it('findDocMentions returns section chunks mentioning the name', () => {
    store.upsert(
      [
        makeChunk('doc', {
          id: 'doc',
          segment: 'wiki',
          filePath: 'guide.md',
          language: 'markdown',
          kind: 'section',
          symbol: undefined,
          text: 'The foo() helper does things.',
        }),
        makeChunk('code', { id: 'code', kind: 'function', text: 'no mention here' }),
      ],
      [vec(), vec()],
    );
    const docs = store.findDocMentions('foo');
    expect(docs.map((c) => c.id)).toEqual(['doc']);
  });

  it('stats().metadataCoverage reflects the fraction with metadata', () => {
    store.upsert(
      [
        makeChunk('a', { callees: ['x'] }),
        makeChunk('b', { id: 'b', startLine: 6, endLine: 9 }),
      ],
      [vec(), vec()],
    );
    expect(store.stats().metadataCoverage).toBeCloseTo(0.5);
  });

  it('migrates a pre-TASK-045 store (missing columns added on open)', () => {
    // Arrange — populate, then simulate the old schema by dropping the columns.
    store.upsert([makeChunk('a', { callees: ['bar'] })], [vec()]);
    store.close();

    const raw = new Database(path);
    raw.exec('ALTER TABLE chunks DROP COLUMN imports_json');
    raw.exec('ALTER TABLE chunks DROP COLUMN callees_json');
    raw.close();

    // Act — reopening must add the columns back without throwing.
    store = VectorStore.open(path, DIM, 'fake');

    // Assert — existing row survives; metadata now reads as empty (NULL), not a crash.
    const got = store.getChunkById('a');
    expect(got).toBeDefined();
    expect(got?.callees).toBeUndefined();
    // and new writes carry metadata again
    store.upsert([makeChunk('b', { id: 'b', callees: ['baz'] })], [vec()]);
    expect(store.getChunkById('b')?.callees).toEqual(['baz']);
  });
});
