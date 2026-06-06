import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chunkTreeSitter } from './tree-sitter.js';
import { ensureGrammars } from '../lang/ensure-grammars.js';
import type { WalkedFile } from '../walker.js';
import type { RagChunkConfig } from '../config.js';
import { sha1 } from '../hash.js';

const grammarTmpDir = mkdtempSync(join(tmpdir(), 'rag-core-'));
process.env['RAG_GRAMMAR_CACHE'] = grammarTmpDir;

beforeAll(() => {
  ensureGrammars(['python']);
});

const FIXTURES = join(import.meta.dirname, '../__fixtures__');

// Tight budget triggers windowing for big(); small() still fits.
const TIGHT: RagChunkConfig = { maxTokens: 20, overlapLines: 4 };
// Default budget: no windowing needed for the fixture.
const DEFAULT: RagChunkConfig = { maxTokens: 512, overlapLines: 8 };

function makePy(relativePath = 'oversized.py'): WalkedFile {
  return {
    absolutePath: join(FIXTURES, relativePath),
    relativePath,
    segment: 'test',
    language: 'python',
  };
}

// ── Windowing: oversized symbol ───────────────────────────────────────────────

describe('emit windowing — oversized symbol', () => {
  it('oversized function → ≥2 sub-windows, symbol and kind preserved in all', async () => {
    const text = readFileSync(join(FIXTURES, 'oversized.py'), 'utf-8');
    const chunks = await chunkTreeSitter(text, makePy(), TIGHT, sha1(text));

    const bigChunks = chunks.filter((c) => c.symbol === 'big');
    expect(bigChunks.length).toBeGreaterThanOrEqual(2);
    for (const c of bigChunks) {
      expect(c.kind).toBe('function');
      expect(c.symbol).toBe('big');
    }
  });

  it('each sub-window text starts with the signature line', async () => {
    const text = readFileSync(join(FIXTURES, 'oversized.py'), 'utf-8');
    const chunks = await chunkTreeSitter(text, makePy(), TIGHT, sha1(text));

    const bigChunks = chunks.filter((c) => c.symbol === 'big');
    for (const c of bigChunks) {
      expect(c.text).toMatch(/^def big\(x\):/);
    }
  });

  it('sub-window line ranges are disjoint (no overlap)', async () => {
    const text = readFileSync(join(FIXTURES, 'oversized.py'), 'utf-8');
    const chunks = await chunkTreeSitter(text, makePy(), TIGHT, sha1(text));

    const sorted = chunks.filter((c) => c.symbol === 'big').sort((a, b) => a.startLine - b.startLine);
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i]!.startLine).toBeGreaterThan(sorted[i - 1]!.endLine);
    }
  });

  it('sub-window ranges are perfectly adjacent (no gap in body coverage)', async () => {
    const text = readFileSync(join(FIXTURES, 'oversized.py'), 'utf-8');
    const chunks = await chunkTreeSitter(text, makePy(), TIGHT, sha1(text));

    const sorted = chunks.filter((c) => c.symbol === 'big').sort((a, b) => a.startLine - b.startLine);
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i]!.startLine).toBe(sorted[i - 1]!.endLine + 1);
    }
  });

  it('all chunks have valid 1-based line numbers', async () => {
    const text = readFileSync(join(FIXTURES, 'oversized.py'), 'utf-8');
    const chunks = await chunkTreeSitter(text, makePy(), TIGHT, sha1(text));

    for (const c of chunks) {
      expect(c.startLine).toBeGreaterThan(0);
      expect(c.endLine).toBeGreaterThanOrEqual(c.startLine);
    }
  });

  it('sub-window IDs are all distinct (createChunk scheme, disjoint ranges)', async () => {
    const text = readFileSync(join(FIXTURES, 'oversized.py'), 'utf-8');
    const chunks = await chunkTreeSitter(text, makePy(), TIGHT, sha1(text));

    const bigIds = chunks.filter((c) => c.symbol === 'big').map((c) => c.id);
    expect(new Set(bigIds).size).toBe(bigIds.length);
    for (const id of bigIds) {
      expect(id).toMatch(/^[0-9a-f]{40}$/);
    }
  });
});

// ── Parity: small symbol and default budget ───────────────────────────────────

describe('emit windowing — parity for small symbols', () => {
  it('small function (fits in budget) → exactly one chunk', async () => {
    const text = readFileSync(join(FIXTURES, 'oversized.py'), 'utf-8');
    const chunks = await chunkTreeSitter(text, makePy(), TIGHT, sha1(text));

    const smallChunks = chunks.filter((c) => c.symbol === 'small');
    expect(smallChunks.length).toBe(1);
    expect(smallChunks[0]!.kind).toBe('function');
  });

  it('default budget (512 tokens) — both functions produce exactly one chunk each', async () => {
    const text = readFileSync(join(FIXTURES, 'oversized.py'), 'utf-8');
    const chunks = await chunkTreeSitter(text, makePy(), DEFAULT, sha1(text));

    expect(chunks.filter((c) => c.symbol === 'big').length).toBe(1);
    expect(chunks.filter((c) => c.symbol === 'small').length).toBe(1);
  });

  it('second chunking call with same inputs returns identical chunks (deterministic)', async () => {
    const text = readFileSync(join(FIXTURES, 'oversized.py'), 'utf-8');
    const hash = sha1(text);
    const file = makePy();

    const run1 = await chunkTreeSitter(text, file, TIGHT, hash);
    const run2 = await chunkTreeSitter(text, file, TIGHT, hash);

    expect(run1.map((c) => c.id)).toEqual(run2.map((c) => c.id));
  });
});
