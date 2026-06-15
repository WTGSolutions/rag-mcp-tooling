import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadQuerySet } from './queries.js';
import { runEval } from './run-eval.js';
import { chunkTreeSitter } from '../chunk/tree-sitter.js';
import { ensureGrammars } from '../lang/ensure-grammars.js';
import { sha1 } from '../hash.js';
import { loadConfig, resolveStorePath } from '../config.js';
import { createEmbedder } from '../embedder/local-embedder.js';
import { reindex } from '../indexer/reindex.js';
import type { WalkedFile } from '../walker.js';
import type { FileLanguage } from '../lang/registry.js';
import type { RagChunkConfig } from '../config.js';
import type { Chunk } from '../chunk/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const ragMcpDir = resolve(here, '../../'); // src/eval → src → rag-mcp; expectedFiles are relative to here
const queriesPath = resolve(ragMcpDir, 'eval/queries.oversized.json');
const configPath = resolve(ragMcpDir, 'rag.config.oversized.json');

// The real corpus budget — fixtures are authored to exceed it so windowing fires.
const CONFIG: RagChunkConfig = { maxTokens: 512, overlapLines: 8 };

const OVERSIZED = [
  { file: 'src/__fixtures__/oversized/sensor_pipeline.py', language: 'python' as const, symbol: 'normalize_sensor_batch' },
  { file: 'src/__fixtures__/oversized/shift_roster.ts', language: 'typescript' as const, symbol: 'assignShiftRoster' },
  { file: 'src/__fixtures__/oversized/digest_report.ts', language: 'typescript' as const, symbol: 'renderDigestReport' },
];

// ── Offline: ground-truth self-validation (anti-bias, anti-typo) ───────────────

describe('queries.oversized.json (Phase 6b windowing A/B set)', () => {
  const set = loadQuerySet(queriesPath); // parseQuerySet throws on malformed GT

  it('is PO-validated and non-empty', () => {
    expect(set.queries.length).toBeGreaterThanOrEqual(7);
    expect(set.groundTruthStatus).toMatch(/VALIDATED/);
  });

  it('every query targets the oversized segment and carries file + symbol + span GT', () => {
    for (const q of set.queries) {
      expect(q.segment, q.id).toBe('oversized');
      expect(q.expectedFiles.length, q.id).toBeGreaterThan(0);
      expect(q.expectedSymbols?.length, q.id).toBeGreaterThan(0);
      expect(q.expectedSpans?.length, q.id).toBeGreaterThan(0);
    }
  });

  it('every ground-truth file exists on disk', () => {
    for (const q of set.queries) {
      for (const f of q.expectedFiles) {
        expect(existsSync(resolve(ragMcpDir, f)), `${q.id} → ${f}`).toBe(true);
      }
    }
  });

  it('every expectedSpan is 1-based and within its file bounds', () => {
    for (const q of set.queries) {
      for (const s of q.expectedSpans ?? []) {
        const lineCount = readFileSync(resolve(ragMcpDir, s.file), 'utf8').split('\n').length;
        expect(s.start, `${q.id} span start`).toBeGreaterThanOrEqual(1);
        expect(s.start, `${q.id} span order`).toBeLessThanOrEqual(s.end);
        expect(s.end, `${q.id} span end ≤ ${lineCount}`).toBeLessThanOrEqual(lineCount);
      }
    }
  });

  it('every expectedSymbol base name appears in its expected file (anti-typo)', () => {
    for (const q of set.queries) {
      const sources = q.expectedFiles.map((f) => readFileSync(resolve(ragMcpDir, f), 'utf8'));
      for (const sym of q.expectedSymbols ?? []) {
        const base = sym.split('.').pop()!;
        expect(sources.some((src) => src.includes(base)), `${q.id} → ${sym}`).toBe(true);
      }
    }
  });

  it('covers both Python and TypeScript (windowing is language-agnostic)', () => {
    const exts = new Set(set.queries.flatMap((q) => q.expectedFiles.map((f) => f.split('.').pop())));
    expect(exts.has('py')).toBe(true);
    expect(exts.has('ts')).toBe(true);
  });
});

// ── Offline: the corpus actually triggers windowing at the real 512-token budget ──

describe('oversized corpus — windowing fires at the production budget', () => {
  beforeAll(() => {
    ensureGrammars(['python', 'typescript']);
  });

  function walked(file: string, language: FileLanguage): WalkedFile {
    return { absolutePath: resolve(ragMcpDir, file), relativePath: file, segment: 'oversized', language };
  }

  async function chunkFixture(file: string, language: FileLanguage): Promise<Chunk[]> {
    const text = readFileSync(resolve(ragMcpDir, file), 'utf8');
    return chunkTreeSitter(text, walked(file, language), CONFIG, sha1(text));
  }

  for (const { file, language, symbol } of OVERSIZED) {
    it(`${symbol} → ≥2 disjoint, adjacent windows (window mode)`, async () => {
      delete process.env['RAG_DISABLE_SYMBOL_WINDOWING'];
      const windows = (await chunkFixture(file, language))
        .filter((c) => c.symbol === symbol)
        .sort((a, b) => a.startLine - b.startLine);

      expect(windows.length, `${symbol} windows`).toBeGreaterThanOrEqual(2);
      for (let i = 1; i < windows.length; i++) {
        // disjoint + adjacent (no overlap, no gap) — stable incremental-reindex IDs
        expect(windows[i]!.startLine).toBe(windows[i - 1]!.endLine + 1);
      }
    });

    it(`${symbol} → exactly 1 chunk under RAG_DISABLE_SYMBOL_WINDOWING (truncate mode)`, async () => {
      process.env['RAG_DISABLE_SYMBOL_WINDOWING'] = '1';
      try {
        const chunks = (await chunkFixture(file, language)).filter((c) => c.symbol === symbol);
        expect(chunks.length, `${symbol} truncate chunk count`).toBe(1);
      } finally {
        delete process.env['RAG_DISABLE_SYMBOL_WINDOWING'];
      }
    });
  }
});

// ── Gated (RAG_RUN_MODEL_TESTS=1): live A/B — windowing lifts span hit@5 ───────

describe.skipIf(process.env['RAG_RUN_MODEL_TESTS'] !== '1')('Phase 6b live A/B (real model)', () => {
  it('span hit@5(window) > span hit@5(truncate) on the oversized corpus', async () => {
    const config = loadConfig(configPath);
    const embedder = createEmbedder(config.embedder);
    const resolvedConfig = { ...config, store: { ...config.store, path: resolveStorePath(configPath, config) } };
    const evalArgs = { config: configPath, queries: queriesPath, dry: false };

    // truncate first, window last (leaves the store in production/window mode).
    process.env['RAG_DISABLE_SYMBOL_WINDOWING'] = '1';
    await reindex({ config: resolvedConfig, embedder, mode: 'full', cwd: ragMcpDir });
    const truncate = await runEval(evalArgs);

    delete process.env['RAG_DISABLE_SYMBOL_WINDOWING'];
    await reindex({ config: resolvedConfig, embedder, mode: 'full', cwd: ragMcpDir });
    const window = await runEval(evalArgs);

    // The measured Phase 6b result: tail retrievable only when windowed.
    expect(window.ragSpan).not.toBeNull();
    expect(truncate.ragSpan).not.toBeNull();
    expect(window.ragSpan!.hitRate).toBeGreaterThan(truncate.ragSpan!.hitRate);
  }, 120_000);
});
