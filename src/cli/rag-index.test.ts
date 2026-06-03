import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join, resolve, dirname } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { parseCliArgs, run } from './rag-index.js';
import type { CliArgs } from './rag-index.js';

// ── parseCliArgs ──────────────────────────────────────────────────────────────

describe('parseCliArgs', () => {
  it('defaults to rag.config.json and incremental mode', () => {
    // Arrange + Act
    const args = parseCliArgs([]);

    // Assert
    expect(args).not.toBeNull();
    expect(args!.configPath).toBe(resolve('rag.config.json'));
    expect(args!.mode).toBe('incremental');
    expect(args!.segment).toBeUndefined();
  });

  it('--full sets mode to full', () => {
    const args = parseCliArgs(['--full']);
    expect(args!.mode).toBe('full');
  });

  it('--changed keeps incremental (it is the default)', () => {
    const args = parseCliArgs(['--changed']);
    expect(args!.mode).toBe('incremental');
  });

  it('--config resolves the path', () => {
    const args = parseCliArgs(['--config', 'custom/rag.config.json']);
    expect(args!.configPath).toBe(resolve('custom/rag.config.json'));
  });

  it('-c short form resolves the path', () => {
    const args = parseCliArgs(['-c', 'custom/rag.config.json']);
    expect(args!.configPath).toBe(resolve('custom/rag.config.json'));
  });

  it('--full and --changed together: --full wins (full mode)', () => {
    const args = parseCliArgs(['--full', '--changed']);
    expect(args!.mode).toBe('full');
  });

  it('--segment sets the segment filter', () => {
    const args = parseCliArgs(['--segment', 'mobile']);
    expect(args!.segment).toBe('mobile');
  });

  it('-s short form sets the segment filter', () => {
    const args = parseCliArgs(['-s', 'web']);
    expect(args!.segment).toBe('web');
  });

  it('--help returns null (signals no-op exit)', () => {
    const args = parseCliArgs(['--help']);
    expect(args).toBeNull();
  });

  it('-h returns null', () => {
    const args = parseCliArgs(['-h']);
    expect(args).toBeNull();
  });

  it('throws on unknown flag', () => {
    expect(() => parseCliArgs(['--unknown'])).toThrow();
  });
});

// ── run (integration) ─────────────────────────────────────────────────────────

let repoDir: string;
let storeDir: string;

beforeEach(() => {
  repoDir = mkdtempSync(join(tmpdir(), 'rag-cli-'));
  storeDir = mkdtempSync(join(tmpdir(), 'rag-store-'));
  mkdirSync(join(repoDir, 'src'));
});

afterEach(() => {
  rmSync(repoDir, { recursive: true, force: true });
  rmSync(storeDir, { recursive: true, force: true });
});

function writeConfig(configPath: string): void {
  const config = {
    segments: [
      { name: 'src', root: join(repoDir, 'src'), include: ['**/*.ts'] },
    ],
    exclude: [],
    embedder: { provider: 'local', model: 'Xenova/bge-small-en-v1.5' },
    chunk: { maxTokens: 512, overlapLines: 0 },
    store: { path: join(storeDir, 'index.db') },
  };
  writeFileSync(configPath, JSON.stringify(config, null, 2));
}

function makeArgs(overrides: Partial<CliArgs> = {}): CliArgs {
  const configPath = join(repoDir, 'rag.config.json');
  writeConfig(configPath);
  return {
    configPath,
    mode: 'full',
    segment: undefined,
    // Match parseCliArgs behaviour: cwd = dirname(configPath)
    cwd: dirname(configPath),
    ...overrides,
  };
}

describe('run', () => {
  it('throws ConfigError for a missing config file', async () => {
    // Arrange
    const args: CliArgs = {
      configPath: '/nonexistent/rag.config.json',
      mode: 'full',
      segment: undefined,
      cwd: '/',
    };

    // Act + Assert
    await expect(run(args)).rejects.toThrow();
  });

  it('completes without error on an empty repository (no matching files)', async () => {
    // Arrange — no .ts files written, src/ is empty
    const args = makeArgs();

    // Act + Assert
    await expect(run(args)).resolves.toBeUndefined();
  });

  it.skipIf(process.env['RAG_RUN_MODEL_TESTS'] !== '1')('successfully indexes TypeScript files using the real offline bge-small model', async () => {
    // Arrange
    writeFileSync(join(repoDir, 'src', 'a.ts'), 'export const a = 1;');
    writeFileSync(join(repoDir, 'src', 'b.ts'), 'export const b = 2;');
    const args = makeArgs({ mode: 'full' });

    // Act — this downloads/loads the model (already cached from TASK-006)
    await run(args);

    // Assert — store exists and has chunks
    const { VectorStore } = await import('../store/vector-store.js');
    const store = VectorStore.open(join(storeDir, 'index.db'), 384, 'Xenova/bge-small-en-v1.5');
    const stats = store.stats();
    store.close();

    expect(stats.chunks).toBeGreaterThan(0);
    expect(stats.modelId).toBe('Xenova/bge-small-en-v1.5');
    expect(stats.lastIndexed).not.toBeNull();
  }, 120_000);

  it.skipIf(process.env['RAG_RUN_MODEL_TESTS'] !== '1')('--segment filters to only the named segment', async () => {
    // Arrange — two-segment config
    const configPath = join(repoDir, 'rag.config.json');
    const multiConfig = {
      segments: [
        { name: 'alpha', root: join(repoDir, 'src'), include: ['a.ts'] },
        { name: 'beta',  root: join(repoDir, 'src'), include: ['b.ts'] },
      ],
      exclude: [],
      embedder: { provider: 'local', model: 'Xenova/bge-small-en-v1.5' },
      chunk: { maxTokens: 512, overlapLines: 0 },
      store: { path: join(storeDir, 'index.db') },
    };
    writeFileSync(configPath, JSON.stringify(multiConfig));
    writeFileSync(join(repoDir, 'src', 'a.ts'), 'export const a = 1;');
    writeFileSync(join(repoDir, 'src', 'b.ts'), 'export const b = 2;');

    const args: CliArgs = { configPath, mode: 'full', segment: 'alpha', cwd: '/' };

    // Act
    await run(args);

    // Assert — only alpha's file is in the store
    const { VectorStore } = await import('../store/vector-store.js');
    const store = VectorStore.open(join(storeDir, 'index.db'), 384, 'Xenova/bge-small-en-v1.5');
    const stats = store.stats();
    store.close();

    expect(stats.segments).toEqual(['alpha']);
  }, 120_000);
});
