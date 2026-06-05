import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync, chmodSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// scripts/reindex-bg.sh and the TS fixtures live relative to this source file.
const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(here, '../../scripts/reindex-bg.sh');
const MINI_REPO = resolve(here, '../__fixtures__/mini-repo');

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rag-bg-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Run reindex-bg.sh in a child shell, returning the spawn result. */
function run(...args: string[]): ReturnType<typeof spawnSync> {
  return spawnSync('sh', [SCRIPT, ...args], { encoding: 'utf8' });
}

function writeConfig(): string {
  const cfg = {
    segments: [{ name: 'mini', root: MINI_REPO, include: ['**/*.ts', '**/*.tsx', '**/*.md'] }],
    store: { path: '.rag/index.db' },
  };
  const p = join(dir, 'rag.config.json');
  writeFileSync(p, JSON.stringify(cfg));
  return p;
}

// ── Guards (no embedder model needed — always run) ────────────────────────────

describe('reindex-bg.sh — non-fatal guards', () => {
  it('exits 0 with no config argument', () => {
    const r = run();
    expect(r.status).toBe(0);
  });

  it('exits 0 when the config file is missing, creating nothing', () => {
    const r = run(join(dir, 'nope.json'));
    expect(r.status).toBe(0);
    expect(existsSync(join(dir, '.rag'))).toBe(false);
  });

  it('skips before any work when the lock is held, leaving the foreign lock intact', () => {
    // Arrange — pre-create the lock dir to simulate a concurrent reindex
    const config = writeConfig();
    mkdirSync(join(dir, '.rag', 'reindex.lock'), { recursive: true });

    // Act
    const r = run(config);

    // Assert — exits 0, never reached the run block (no log), did not steal the lock
    expect(r.status).toBe(0);
    expect(existsSync(join(dir, '.rag', 'reindex.log'))).toBe(false);
    expect(existsSync(join(dir, '.rag', 'reindex.lock'))).toBe(true);
  });

  it('releases the lock and writes the log on a successful run (stubbed node)', () => {
    // Arrange — a fake `node` on PATH that exits 0 drives the success branch and
    // its EXIT trap without needing the real model, so this runs in normal CI.
    const config = writeConfig();
    const binDir = join(dir, 'bin');
    mkdirSync(binDir);
    const stub = join(binDir, 'node');
    writeFileSync(stub, '#!/bin/sh\nexit 0\n');
    chmodSync(stub, 0o755);

    // Act
    const r = spawnSync('sh', [SCRIPT, config], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${binDir}:${process.env['PATH'] ?? ''}` },
    });

    // Assert — exit 0, header logged, lock released by the trap
    expect(r.status).toBe(0);
    const log = join(dir, '.rag', 'reindex.log');
    expect(existsSync(log)).toBe(true);
    expect(readFileSync(log, 'utf8')).toMatch(/post-commit auto-reindex/);
    expect(existsSync(join(dir, '.rag', 'reindex.lock'))).toBe(false);
  });

  it('reclaims a stale lock (older than an hour) left by a crashed run', () => {
    // Arrange — stub node + a 2h-old lock dir simulating a SIGKILLed run whose
    // EXIT trap never fired. The script should reclaim it instead of skipping.
    const config = writeConfig();
    const binDir = join(dir, 'bin');
    mkdirSync(binDir);
    const stub = join(binDir, 'node');
    writeFileSync(stub, '#!/bin/sh\nexit 0\n');
    chmodSync(stub, 0o755);
    const lock = join(dir, '.rag', 'reindex.lock');
    mkdirSync(lock, { recursive: true });
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(lock, old, old);

    // Act
    const r = spawnSync('sh', [SCRIPT, config], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${binDir}:${process.env['PATH'] ?? ''}` },
    });

    // Assert — reclaimed → it ran (log exists) and released the lock on exit
    expect(r.status).toBe(0);
    expect(existsSync(join(dir, '.rag', 'reindex.log'))).toBe(true);
    expect(existsSync(lock)).toBe(false);
  });
});

// ── Happy path (real reindex → needs the offline model, gated) ────────────────

describe.skipIf(process.env['RAG_RUN_MODEL_TESTS'] !== '1')('reindex-bg.sh — happy path', () => {
  it('reindexes the repo, writes the log, releases the lock, exits 0', () => {
    // Arrange
    const config = writeConfig();

    // Act
    const r = run(config);

    // Assert
    expect(r.status).toBe(0);
    const log = join(dir, '.rag', 'reindex.log');
    expect(existsSync(log)).toBe(true);
    expect(readFileSync(log, 'utf8')).toMatch(/post-commit auto-reindex/);
    expect(existsSync(join(dir, '.rag', 'index.db'))).toBe(true); // store was built
    expect(existsSync(join(dir, '.rag', 'reindex.lock'))).toBe(false); // lock released on exit
  }, 120_000);
});
