import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { makeReindex } from './reindex.js';
import { makeSearchCodebase } from './search-codebase.js';
import { VectorStore } from '../../store/vector-store.js';
import type { Embedder } from '../../embedder/types.js';
import type { RagConfig } from '../../config.js';
import type { ServerDeps } from './index.js';

const DIM = 4;

// Deterministic embedder: vector encodes the first char of each text so
// "changed content" produces a different, detectable vector.
function fakeEmbedder(): Embedder {
  return {
    modelId: 'fake',
    dimensions: DIM,
    embed: async (texts) =>
      texts.map((t) => {
        const v = new Float32Array(DIM);
        v[0] = ((t.charCodeAt(0) || 0) % 64) / 64;
        v[1] = 1 - v[0]!;
        return v;
      }),
  };
}

describe('makeReindex — argument mapping (mock pipeline via spy store)', () => {
  // A store that records nothing but lets reindexWithStore run over an empty repo.
  let tmpDir: string;
  let repoDir: string;
  let store: VectorStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'rag-reidx-'));
    repoDir = mkdtempSync(join(tmpdir(), 'rag-repo-'));
    mkdirSync(join(repoDir, 'src'));
    store = VectorStore.open(join(tmpDir, 'index.db'), DIM, 'fake');
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(repoDir, { recursive: true, force: true });
  });

  function config(): RagConfig {
    return {
      segments: [{ name: 'src', root: join(repoDir, 'src'), include: ['**/*.ts'] }],
      exclude: [],
      embedder: { provider: 'local', model: 'fake' },
      chunk: { maxTokens: 512, overlapLines: 0 },
      store: { path: join(tmpDir, 'index.db') },
    };
  }

  function deps(): ServerDeps {
    return { config: config(), store, embedder: fakeEmbedder(), cwd: '/' };
  }

  it('returns a summary with counts and a duration', async () => {
    // Arrange
    writeFileSync(join(repoDir, 'src', 'a.ts'), 'export const a = 1;');
    const handler = makeReindex(deps());

    // Act
    const result = await handler({});

    // Assert
    const s = (result as { structuredContent: { added: number; durationMs: number } }).structuredContent;
    expect(s.added).toBe(1);
    expect(typeof s.durationMs).toBe('number');
    expect((result.content[0] as { text: string }).text).toContain('Reindex done');
  });

  it('restricts to a named segment', async () => {
    // Arrange — two segments, only "src" should be touched
    const cfg = config();
    cfg.segments.push({ name: 'other', root: join(repoDir, 'nope'), include: ['**/*.ts'] });
    writeFileSync(join(repoDir, 'src', 'a.ts'), 'export const a = 1;');
    const handler = makeReindex({ config: cfg, store, embedder: fakeEmbedder(), cwd: '/' });

    // Act
    const result = await handler({ segment: 'src' });

    // Assert — no throw about the (nonexistent) "other" root, src processed
    expect((result as { structuredContent: { added: number } }).structuredContent.added).toBe(1);
  });

  it('a second run with no changes skips everything (added=0)', async () => {
    // Arrange
    writeFileSync(join(repoDir, 'src', 'a.ts'), 'export const a = 1;');
    writeFileSync(join(repoDir, 'src', 'b.ts'), 'export const b = 2;');
    const handler = makeReindex(deps());
    await handler({});

    // Act — nothing changed
    const result = await handler({});

    // Assert
    const s = (result as { structuredContent: { added: number; skipped: number; removed: number } }).structuredContent;
    expect(s.added).toBe(0);
    expect(s.skipped).toBe(2);
    expect(s.removed).toBe(0);
  });

  it('throws a clear error for an unknown segment', async () => {
    const handler = makeReindex(deps());
    await expect(handler({ segment: 'nope' })).rejects.toThrow('No segment named "nope"');
  });
});

describe('makeReindex — concurrency', () => {
  let tmpDir: string;
  let repoDir: string;
  let store: VectorStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'rag-reidx-'));
    repoDir = mkdtempSync(join(tmpdir(), 'rag-repo-'));
    mkdirSync(join(repoDir, 'src'));
    store = VectorStore.open(join(tmpDir, 'index.db'), DIM, 'fake');
    writeFileSync(join(repoDir, 'src', 'a.ts'), 'export const a = 1;');
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(repoDir, { recursive: true, force: true });
  });

  function deps(slowEmbed = false): ServerDeps {
    const base = fakeEmbedder();
    const embedder: Embedder = slowEmbed
      ? { ...base, embed: async (t) => { await new Promise((r) => setTimeout(r, 30)); return base.embed(t); } }
      : base;
    return {
      config: {
        segments: [{ name: 'src', root: join(repoDir, 'src'), include: ['**/*.ts'] }],
        exclude: [],
        embedder: { provider: 'local', model: 'fake' },
        chunk: { maxTokens: 512, overlapLines: 0 },
        store: { path: join(tmpDir, 'index.db') },
      },
      store,
      embedder,
      cwd: '/',
    };
  }

  it('rejects a concurrent reindex with a clear error (mutex)', async () => {
    // Arrange — handler with a slow embed so the first run is still in flight
    const handler = makeReindex(deps(true));

    // Act — fire two without awaiting the first
    const first = handler({});
    const second = handler({});

    // Assert — the second is rejected, the first succeeds
    await expect(second).rejects.toThrow('already in progress');
    await expect(first).resolves.toBeDefined();
  });

  it('allows a new reindex once the previous one finished', async () => {
    // Arrange
    const handler = makeReindex(deps());

    // Act + Assert — sequential calls both succeed (lock released after each)
    await expect(handler({})).resolves.toBeDefined();
    await expect(handler({})).resolves.toBeDefined();
  });

  it('releases the mutex after an error so a later reindex can run', async () => {
    // Arrange — embedder fails on the first embed, succeeds afterwards
    writeFileSync(join(repoDir, 'src', 'a.ts'), 'export const a = 1;');
    const base = fakeEmbedder();
    let embedCalls = 0;
    const embedder: Embedder = {
      ...base,
      embed: async (t) => {
        embedCalls++;
        if (embedCalls === 1) throw new Error('boom: model failed');
        return base.embed(t);
      },
    };
    const d: ServerDeps = {
      config: {
        segments: [{ name: 'src', root: join(repoDir, 'src'), include: ['**/*.ts'] }],
        exclude: [],
        embedder: { provider: 'local', model: 'fake' },
        chunk: { maxTokens: 512, overlapLines: 0 },
        store: { path: join(tmpDir, 'index.db') },
      },
      store, embedder, cwd: '/',
    };
    const handler = makeReindex(d);

    // Act + Assert — first throws (branded), but the lock is released
    await expect(handler({})).rejects.toThrow('[rag-mcp] reindex: boom: model failed');
    await expect(handler({})).resolves.toBeDefined(); // not wedged at "already in progress"
  });
});

describe('makeReindex — integration (search sees updates through the shared store)', () => {
  let tmpDir: string;
  let repoDir: string;
  let store: VectorStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'rag-reidx-'));
    repoDir = mkdtempSync(join(tmpdir(), 'rag-repo-'));
    mkdirSync(join(repoDir, 'src'));
    store = VectorStore.open(join(tmpDir, 'index.db'), DIM, 'fake');
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(repoDir, { recursive: true, force: true });
  });

  function deps(): ServerDeps {
    return {
      config: {
        segments: [{ name: 'src', root: join(repoDir, 'src'), include: ['**/*.ts'] }],
        exclude: [],
        embedder: { provider: 'local', model: 'fake' },
        chunk: { maxTokens: 512, overlapLines: 0 },
        store: { path: join(tmpDir, 'index.db') },
      },
      store,
      embedder: fakeEmbedder(),
      cwd: '/',
    };
  }

  it('a changed file is re-indexed and search returns the new content', async () => {
    // Arrange
    const d = deps();
    const reindex = makeReindex(d);
    const search = makeSearchCodebase(d);
    writeFileSync(join(repoDir, 'src', 'a.ts'), 'export const original = 1;');
    await reindex({});

    // Act — change the file then reindex
    writeFileSync(join(repoDir, 'src', 'a.ts'), 'export const updated = 2;');
    const r = await reindex({});

    // Assert — the changed file was re-added, and search (same store) sees new text
    expect((r as { structuredContent: { added: number } }).structuredContent.added).toBe(1);
    const result = await search({ query: 'updated', k: 5 });
    expect((result.content[0] as { text: string }).text).toContain('updated');
  });

  it('a deleted file is removed and disappears from search', async () => {
    // Arrange
    const d = deps();
    const reindex = makeReindex(d);
    const search = makeSearchCodebase(d);
    writeFileSync(join(repoDir, 'src', 'a.ts'), 'export const a = 1;');
    writeFileSync(join(repoDir, 'src', 'b.ts'), 'export const b = 2;');
    await reindex({});

    // Act — delete a.ts, reindex
    unlinkSync(join(repoDir, 'src', 'a.ts'));
    const r = await reindex({});

    // Assert
    expect((r as { structuredContent: { removed: number } }).structuredContent.removed).toBe(1);
    const result = await search({ query: 'a', k: 5 });
    expect((result.content[0] as { text: string }).text).not.toContain('a.ts:');
  });

  it('paths mode reindexes only the listed file', async () => {
    // Arrange
    const d = deps();
    const reindex = makeReindex(d);
    writeFileSync(join(repoDir, 'src', 'a.ts'), 'export const a = 1;');
    writeFileSync(join(repoDir, 'src', 'b.ts'), 'export const b = 2;');
    await reindex({});

    // Change both, but reindex only a.ts via paths
    writeFileSync(join(repoDir, 'src', 'a.ts'), 'export const a = 99;');
    writeFileSync(join(repoDir, 'src', 'b.ts'), 'export const b = 99;');

    // Act
    const r = await reindex({ paths: [join(repoDir, 'src', 'a.ts')] });

    // Assert — only a.ts re-added (b.ts changed but not in paths → untouched)
    expect((r as { structuredContent: { added: number } }).structuredContent.added).toBe(1);
  });

  it('paths mode removes a listed file that was deleted', async () => {
    // Arrange
    const d = deps();
    const reindex = makeReindex(d);
    writeFileSync(join(repoDir, 'src', 'a.ts'), 'export const a = 1;');
    writeFileSync(join(repoDir, 'src', 'b.ts'), 'export const b = 2;');
    await reindex({});

    // Act — delete a.ts, reindex only that path
    unlinkSync(join(repoDir, 'src', 'a.ts'));
    const r = await reindex({ paths: [join(repoDir, 'src', 'a.ts')] });

    // Assert — a.ts removed, b.ts untouched
    expect((r as { structuredContent: { removed: number } }).structuredContent.removed).toBe(1);
  });

  it('reports requested paths that matched no indexed file', async () => {
    // Arrange
    const d = deps();
    const reindex = makeReindex(d);
    writeFileSync(join(repoDir, 'src', 'a.ts'), 'export const a = 1;');
    await reindex({});

    // Act — request a path that is not under any segment / does not exist
    const bogus = join(repoDir, 'src', 'ghost.ts');
    const r = await reindex({ paths: [bogus] });

    // Assert — surfaced in structuredContent and the text warning, no silent no-op
    const s = (r as { structuredContent: { unmatchedPaths: string[] } }).structuredContent;
    expect(s.unmatchedPaths).toContain(bogus);
    expect((r.content[0] as { text: string }).text).toContain('matched no indexed file');
  });

  it('a concurrent search during reindex sees the old version, never the file absent', async () => {
    // Arrange — index "alpha", then gate the reindex's embed so we can observe
    // the store mid-reindex.
    const base = fakeEmbedder();
    let gateActive = false;
    let gateCount = 0;
    let releaseGate: () => void = () => {};
    let signalEntered: () => void = () => {};
    const gate = new Promise<void>((r) => { releaseGate = r; });
    const entered = new Promise<void>((r) => { signalEntered = r; });
    const embedder: Embedder = {
      ...base,
      embed: async (t) => {
        if (gateActive && gateCount === 0) { gateCount++; signalEntered(); await gate; }
        return base.embed(t);
      },
    };
    const d: ServerDeps = {
      config: {
        segments: [{ name: 'src', root: join(repoDir, 'src'), include: ['**/*.ts'] }],
        exclude: [],
        embedder: { provider: 'local', model: 'fake' },
        chunk: { maxTokens: 512, overlapLines: 0 },
        store: { path: join(tmpDir, 'index.db') },
      },
      store, embedder, cwd: '/',
    };
    const reindex = makeReindex(d);
    const search = makeSearchCodebase(d);
    writeFileSync(join(repoDir, 'src', 'a.ts'), 'export const alpha = 1;');
    await reindex({}); // initial index (gate inactive)

    // Act — change the file, start a gated reindex (blocks inside embed)
    writeFileSync(join(repoDir, 'src', 'a.ts'), 'export const beta = 2;');
    gateActive = true;
    const running = reindex({});
    await entered; // reindex is now inside embed, BEFORE delete+upsert

    // Assert — mid-reindex, the OLD version is still fully present (not absent)
    const mid = await search({ query: 'alpha', k: 1 });
    expect((mid.content[0] as { text: string }).text).toContain('alpha');

    // Release the embed and let reindex finish, then the new version is visible
    releaseGate();
    await running;
    const after = await search({ query: 'beta', k: 1 });
    expect((after.content[0] as { text: string }).text).toContain('beta');
  });
});
