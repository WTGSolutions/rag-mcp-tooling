import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { reindex } from './reindex.js';
import type { ReindexOptions } from './reindex.js';
import type { RagConfig } from '../config.js';
import type { Embedder } from '../embedder/types.js';

// ── Test helpers ──────────────────────────────────────────────────────────────

const DIM = 4;

/**
 * Fake embedder: returns deterministic unit vectors derived from input text
 * so tests can reason about which chunks end up in the store.
 */
function fakeEmbedder(): Embedder {
  return {
    modelId: 'fake-model',
    dimensions: DIM,
    embed: async (texts: string[]) =>
      texts.map((t) => {
        const v = new Float32Array(DIM);
        v[0] = (t.charCodeAt(0) % 256) / 256;
        v[1] = 1 - v[0];
        const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
        return v.map((x) => x / norm) as unknown as Float32Array;
      }) as Float32Array[],
  };
}

let repoDir: string;  // acts as project root (cwd)
let storeDir: string;

beforeEach(() => {
  repoDir = mkdtempSync(join(tmpdir(), 'rag-repo-'));
  storeDir = mkdtempSync(join(tmpdir(), 'rag-store-'));
  // Create a src/ sub-directory for TypeScript files
  mkdirSync(join(repoDir, 'src'));
});

afterEach(() => {
  rmSync(repoDir, { recursive: true, force: true });
  rmSync(storeDir, { recursive: true, force: true });
});

function write(relPath: string, content: string): void {
  writeFileSync(join(repoDir, relPath), content);
}

function remove(relPath: string): void {
  unlinkSync(join(repoDir, relPath));
}

function makeConfig(): RagConfig {
  return {
    segments: [
      { name: 'src', root: join(repoDir, 'src'), include: ['**/*.ts'] },
    ],
    exclude: [],
    embedder: { provider: 'local', model: 'fake-model' },
    chunk: { maxTokens: 512, overlapLines: 0 },
    store: { path: join(storeDir, 'index.db') },
  };
}

function makeOpts(overrides: Partial<ReindexOptions> = {}): ReindexOptions {
  return {
    config: makeConfig(),
    embedder: fakeEmbedder(),
    mode: 'full',  // default to full in tests for clarity
    cwd: '/',      // segment root is absolute in makeConfig
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('reindex — full mode', () => {
  it('indexes all files and returns correct counts', async () => {
    // Arrange
    write('src/a.ts', 'export const a = 1;');
    write('src/b.ts', 'export const b = 2;');

    // Act
    const result = await reindex(makeOpts());

    // Assert
    expect(result.added).toBe(2);
    expect(result.skipped).toBe(0);
    expect(result.removed).toBe(0);
    expect(result.totalChunks).toBeGreaterThan(0);
  });

  it('re-indexes everything on second full run (no skips)', async () => {
    // Arrange — first run creates one file
    write('src/a.ts', 'export const a = 1;');
    await reindex(makeOpts());

    // Act — second full run, same files
    const result2 = await reindex(makeOpts());

    // Assert — full mode never skips; exactly the 1 file present is re-indexed
    expect(result2.added).toBe(1);
    expect(result2.skipped).toBe(0);
  });

  it('cleans up stale entries on full run after file deletion', async () => {
    // Arrange — first full index, then delete a file
    write('src/a.ts', 'export const a = 1;');
    write('src/b.ts', 'export const b = 2;');
    const r1 = await reindex(makeOpts());
    expect(r1.totalChunks).toBeGreaterThan(0);

    remove('src/b.ts');

    // Act — full run should remove stale chunks for b.ts even in full mode
    const r2 = await reindex(makeOpts({ mode: 'full' }));

    // Assert
    expect(r2.removed).toBe(1);
    expect(r2.totalChunks).toBeLessThan(r1.totalChunks);
  });
});

describe('reindex — incremental mode', () => {
  it('skips unchanged files on second run', async () => {
    // Arrange — first run (full, to populate hashes)
    write('src/a.ts', 'export const a = 1;');
    write('src/b.ts', 'export const b = 2;');
    await reindex(makeOpts({ mode: 'full' }));

    // Act — second run, no files changed
    const result2 = await reindex(makeOpts({ mode: 'incremental' }));

    // Assert — 0 new embeddings, 2 skipped
    expect(result2.added).toBe(0);
    expect(result2.skipped).toBe(2);
    expect(result2.removed).toBe(0);
  });

  it('re-indexes only the changed file', async () => {
    // Arrange
    write('src/a.ts', 'export const a = 1;');
    write('src/b.ts', 'export const b = 2;');
    await reindex(makeOpts({ mode: 'full' }));

    // Act — change one file
    write('src/b.ts', 'export const b = 99; // updated');
    const result2 = await reindex(makeOpts({ mode: 'incremental' }));

    // Assert
    expect(result2.added).toBe(1);
    expect(result2.skipped).toBe(1);
    expect(result2.removed).toBe(0);
  });

  it('removes chunks for a deleted file', async () => {
    // Arrange
    write('src/a.ts', 'export const a = 1;');
    write('src/b.ts', 'export const b = 2;');
    const r1 = await reindex(makeOpts({ mode: 'full' }));
    const chunksBefore = r1.totalChunks;

    // Act — delete one file
    remove('src/b.ts');
    const result2 = await reindex(makeOpts({ mode: 'incremental' }));

    // Assert
    expect(result2.removed).toBe(1);
    expect(result2.totalChunks).toBeLessThan(chunksBefore);
  });

  it('does not delete store chunks when readFile fails with a transient error (non-ENOENT)', async () => {
    // Arrange — first full index
    write('src/a.ts', 'export const a = 1;');
    write('src/b.ts', 'export const b = 2;');
    await reindex(makeOpts({ mode: 'full' }));
    const { totalChunks: chunksBefore } = await reindex(makeOpts({ mode: 'incremental' }));

    // Inject a readFile that throws EACCES for a.ts (simulates transient permission error)
    const { readFile } = await import('node:fs/promises');
    const eaccesReadFile = async (p: string) => {
      if (p.endsWith('a.ts')) {
        const err = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
        throw err;
      }
      return readFile(p, 'utf-8');
    };

    // Act
    const result = await reindex(makeOpts({ mode: 'incremental', _readFile: eaccesReadFile }));

    // Assert — transient EACCES on a.ts must NOT remove its chunks from the store
    expect(result.removed).toBe(0);
    expect(result.totalChunks).toBe(chunksBefore);
  });

  it('treats a file removed before the run as deleted (counts as removed, not error)', async () => {
    // Arrange — first full index
    write('src/a.ts', 'export const a = 1;');
    await reindex(makeOpts({ mode: 'full' }));

    // File is removed before the incremental run starts (ENOENT during walk,
    // not a mid-walk race; walkSegments simply does not yield the file).
    remove('src/a.ts');

    // Act — should not throw; file counts as removed
    const result = await reindex(makeOpts({ mode: 'incremental' }));
    expect(result.removed).toBe(1);
    expect(result.totalChunks).toBe(0);
  });

  it('leaves no orphaned chunks after mixed changes', async () => {
    // Arrange — first run
    write('src/a.ts', 'export const a = 1;');
    write('src/b.ts', 'export const b = 2;');
    write('src/c.ts', 'export const c = 3;');
    await reindex(makeOpts({ mode: 'full' }));

    // Act — change a, delete c, keep b
    write('src/a.ts', 'export const a = 99;');
    remove('src/c.ts');
    const result = await reindex(makeOpts({ mode: 'incremental' }));

    // Assert — only a (changed) + b (unchanged), no trace of c
    expect(result.added).toBe(1);   // a updated
    expect(result.skipped).toBe(1); // b unchanged
    expect(result.removed).toBe(1); // c deleted
    expect(result.totalChunks).toBeGreaterThan(0);

    // Re-run with no changes → 2 files, 0 removed
    const result2 = await reindex(makeOpts({ mode: 'incremental' }));
    expect(result2.skipped).toBe(2);
    expect(result2.removed).toBe(0);
  });
});

describe('reindex — segment filter', () => {
  it('processes only the named segment, ignores others', async () => {
    // Arrange — config with two segments
    const config: RagConfig = {
      segments: [
        { name: 'alpha', root: join(repoDir, 'src'), include: ['a.ts'] },
        { name: 'beta',  root: join(repoDir, 'src'), include: ['b.ts'] },
      ],
      exclude: [],
      embedder: { provider: 'local', model: 'fake-model' },
      chunk: { maxTokens: 512, overlapLines: 0 },
      store: { path: join(storeDir, 'index.db') },
    };
    write('src/a.ts', 'export const a = 1;');
    write('src/b.ts', 'export const b = 2;');

    // Act — only 'alpha'
    const result = await reindex({ config, embedder: fakeEmbedder(), mode: 'full', segment: 'alpha', cwd: '/' });

    // Assert — only alpha's file indexed
    expect(result.added).toBe(1);
    // beta's file should not be in the store
    const result2 = await reindex({ config, embedder: fakeEmbedder(), mode: 'incremental', segment: 'alpha', cwd: '/' });
    expect(result2.skipped).toBe(1);
    // beta still not seen → no removal counted
    expect(result2.removed).toBe(0);
  });

  it('throws for an unknown segment name', async () => {
    // Arrange + Act + Assert
    await expect(
      reindex(makeOpts({ segment: 'nonexistent' })),
    ).rejects.toThrow('nonexistent');
  });
});
