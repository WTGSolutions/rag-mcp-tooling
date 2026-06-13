import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UsageLogger, createUsageLogger, wrapHandler } from './usage-logger.js';
import type { UsageRecord } from './usage-logger.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'rag-usage-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env['RAG_USAGE_LOG'];
});

function logPath(): string {
  return join(tmpDir, '.rag', 'usage.jsonl');
}

function readLines(): UsageRecord[] {
  const text = readFileSync(logPath(), 'utf8');
  return text
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as UsageRecord);
}

describe('UsageLogger', () => {
  it('creates directories and writes a JSONL line', () => {
    const logger = new UsageLogger(logPath(), true);
    const record: UsageRecord = {
      ts: '2026-01-01T00:00:00.000Z',
      tool: 'search_codebase',
      query: 'test query',
      k: 5,
      segment: null,
      results: 2,
      topScore: 0.9,
      latencyMs: 42,
      paths: ['a.ts', 'b.ts'],
    };
    logger.append(record);
    const lines = readLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject(record);
  });

  it('appends multiple records', () => {
    const logger = new UsageLogger(logPath(), true);
    const r1: UsageRecord = {
      ts: '2026-01-01T00:00:00.000Z', tool: 'get_chunk', id: 'abc', found: true, latencyMs: 10,
    };
    const r2: UsageRecord = {
      ts: '2026-01-01T00:00:01.000Z', tool: 'reindex', added: 5, skipped: 2, removed: 0, latencyMs: 500,
    };
    logger.append(r1);
    logger.append(r2);
    expect(readLines()).toHaveLength(2);
  });

  it('is a noop when disabled', () => {
    const logger = new UsageLogger(logPath(), false);
    logger.append({ ts: '', tool: 'get_chunk', id: 'x', found: true, latencyMs: 0 });
    expect(existsSync(logPath())).toBe(false);
  });

  it('multiple appends all succeed after the directory is created once', () => {
    const logger = new UsageLogger(logPath(), true);
    const record: UsageRecord = { ts: '', tool: 'get_chunk', id: 'a', found: true, latencyMs: 1 };
    logger.append(record);
    logger.append(record);
    logger.append(record);
    expect(readLines()).toHaveLength(3);
  });

  it('rotates the file to .1 when it reaches maxBytes, then starts a fresh one', () => {
    // Arrange — tiny cap so the second append crosses it
    const record: UsageRecord = { ts: '2026-01-01T00:00:00.000Z', tool: 'get_chunk', id: 'a', found: true, latencyMs: 1 };
    const cap = JSON.stringify(record).length; // first line alone reaches the cap
    const logger = new UsageLogger(logPath(), true, cap);

    // Act
    logger.append(record);
    logger.append(record); // triggers rotation before writing

    // Assert — old line moved aside, new file holds exactly the post-rotation line
    expect(readLines()).toHaveLength(1);
    const rotated = readFileSync(`${logPath()}.1`, 'utf8').split('\n').filter((l) => l.trim());
    expect(rotated).toHaveLength(1);
  });

  it('rotation replaces a previous .1 generation (disk usage stays bounded)', () => {
    const record: UsageRecord = { ts: '', tool: 'get_chunk', id: 'b', found: true, latencyMs: 1 };
    const cap = JSON.stringify(record).length;
    const logger = new UsageLogger(logPath(), true, cap);

    logger.append(record);
    logger.append(record); // rotation #1
    logger.append(record); // rotation #2 — overwrites .1

    expect(readLines()).toHaveLength(1);
    expect(existsSync(`${logPath()}.2`)).toBe(false);
  });

  it('is non-fatal on I/O error (writes to stderr)', () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    // Use a path whose parent cannot be created (empty string dirname resolves to '.')
    // Instead, pass a file path under a non-existent deeply nested read-only path
    const badPath = '/dev/null/not-writable/usage.jsonl';
    const logger = new UsageLogger(badPath, true);
    expect(() =>
      logger.append({ ts: '', tool: 'get_chunk', id: 'x', found: false, latencyMs: 0 }),
    ).not.toThrow();
    stderrSpy.mockRestore();
  });
});

describe('createUsageLogger', () => {
  it('creates an enabled logger by default', () => {
    delete process.env['RAG_USAGE_LOG'];
    const logger = createUsageLogger(logPath());
    logger.append({ ts: new Date().toISOString(), tool: 'get_chunk', id: 'x', found: true, latencyMs: 1 });
    expect(existsSync(logPath())).toBe(true);
  });

  it('creates a disabled logger when RAG_USAGE_LOG=0', () => {
    process.env['RAG_USAGE_LOG'] = '0';
    const logger = createUsageLogger(logPath());
    logger.append({ ts: '', tool: 'get_chunk', id: 'x', found: true, latencyMs: 0 });
    expect(existsSync(logPath())).toBe(false);
  });
});

describe('wrapHandler', () => {
  it('measures latency and records success', async () => {
    const logger = new UsageLogger(logPath(), true);
    const handler = async (args: { n: number }) => args.n * 2;
    const wrapped = wrapHandler(
      handler,
      (args, result, latencyMs): UsageRecord => ({
        ts: new Date().toISOString(),
        tool: 'get_chunk',
        id: String(args.n),
        found: result !== null,
        latencyMs,
      }),
      logger,
    );

    const result = await wrapped({ n: 3 });
    expect(result).toBe(6);

    const lines = readLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ tool: 'get_chunk', id: '3', found: true });
    expect((lines[0] as { latencyMs: number }).latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('records null result and re-throws on handler error', async () => {
    const logger = new UsageLogger(logPath(), true);
    const handler = async (_args: { id: string }): Promise<string> => {
      throw new Error('not found');
    };
    const wrapped = wrapHandler(
      handler,
      (args, result, latencyMs): UsageRecord => ({
        ts: new Date().toISOString(),
        tool: 'get_chunk',
        id: args.id,
        found: result !== null,
        latencyMs,
      }),
      logger,
    );

    await expect(wrapped({ id: 'missing' })).rejects.toThrow('not found');

    const lines = readLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ found: false });
  });

  it('is non-fatal when makeRecord throws', async () => {
    const logger = new UsageLogger(logPath(), true);
    const handler = async (args: { x: number }) => args.x;
    const wrapped = wrapHandler(
      handler,
      () => { throw new Error('boom in makeRecord'); },
      logger,
    );

    await expect(wrapped({ x: 1 })).resolves.toBe(1);
    // No line written (makeRecord threw before logger.append)
    expect(existsSync(logPath())).toBe(false);
  });

  it('skips logging when makeRecord returns null', async () => {
    const logger = new UsageLogger(logPath(), true);
    const wrapped = wrapHandler(
      async (args: { x: number }) => args.x,
      () => null,
      logger,
    );
    await wrapped({ x: 99 });
    expect(existsSync(logPath())).toBe(false);
  });
});
