import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadQuerySet } from './queries.js';

const here = dirname(fileURLToPath(import.meta.url));
const queriesPath = resolve(here, '../../eval/queries.hard.json');
// expectedFiles are repo-relative from the MONOREPO ROOT (e.g. "web/src/..."), because
// the hard set runs against the real index (config at the repo root). src/eval → src →
// rag-mcp → tools → repo root.
const repoRoot = resolve(here, '../../../../');

describe('queries.hard.json (Phase 7 headroom benchmark)', () => {
  const set = loadQuerySet(queriesPath); // parseQuerySet throws on malformed GT

  it('declares a ground-truth status and a non-trivial number of queries', () => {
    expect(set.queries.length).toBeGreaterThanOrEqual(15);
    expect(set.groundTruthStatus.length).toBeGreaterThan(0);
  });

  it('covers all four segments (web, mobile, wiki, tools)', () => {
    const segments = new Set(set.queries.map((q) => q.segment));
    expect(segments).toEqual(new Set(['web', 'mobile', 'wiki', 'tools']));
  });

  it('every ground-truth file exists on disk (anti-typo, from the repo root)', () => {
    const missing: string[] = [];
    for (const q of set.queries) {
      for (const f of q.expectedFiles) {
        if (!existsSync(resolve(repoRoot, f))) missing.push(`${q.id} → ${f}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('every expectedSpan is 1-based and within its file bounds', () => {
    for (const q of set.queries) {
      for (const s of q.expectedSpans ?? []) {
        const lineCount = readFileSync(resolve(repoRoot, s.file), 'utf8').split('\n').length;
        expect(s.start, `${q.id} span start ≥1`).toBeGreaterThanOrEqual(1);
        expect(s.start, `${q.id} span start ≤ end`).toBeLessThanOrEqual(s.end);
        expect(s.end, `${q.id} span end ≤ ${lineCount}`).toBeLessThanOrEqual(lineCount);
      }
    }
  });

  it('every expectedSymbol base name appears in one of its expected files (anti-typo)', () => {
    const missing: string[] = [];
    for (const q of set.queries) {
      const sources = q.expectedFiles.map((f) => readFileSync(resolve(repoRoot, f), 'utf8'));
      for (const sym of q.expectedSymbols ?? []) {
        const base = sym.split('.').pop()!; // `Class.method` → `method`; bare name unchanged
        if (!sources.some((src) => src.includes(base))) missing.push(`${q.id} → ${sym} (base "${base}")`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('every query carries file-level GT and at least one of symbol/span GT (except wiki docs)', () => {
    for (const q of set.queries) {
      expect(q.expectedFiles.length, q.id).toBeGreaterThan(0);
      if (q.segment !== 'wiki') {
        const hasFiner = (q.expectedSymbols?.length ?? 0) > 0 || (q.expectedSpans?.length ?? 0) > 0;
        expect(hasFiner, `${q.id} should carry symbol or span GT`).toBe(true);
      }
    }
  });
});
