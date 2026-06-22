import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseQuerySet, loadQuerySet } from './queries.js';

const here = dirname(fileURLToPath(import.meta.url));
const queriesPath = resolve(here, '../../eval/queries.json');
const repoRoot = resolve(here, '../../../../'); // src/eval → src → rag-mcp → tools → repo
// The acceptance set's ground truth points at the GuideTrackee monorepo (web/, mobile/).
// In the standalone published repo (CI) that corpus is absent, so the on-disk GT checks
// can't run — guard them, while the schema/structure tests run everywhere.
const HAS_CORPUS =
  existsSync(resolve(repoRoot, 'web')) && existsSync(resolve(repoRoot, 'mobile'));

describe('parseQuerySet', () => {
  const valid = {
    groundTruthStatus: 'PROPOSED',
    queries: [{ id: 'q1', concept: 'c', query: 'q', segment: 'web', expectedFiles: ['a.ts'] }],
  };

  it('accepts a well-formed set', () => {
    expect(parseQuerySet(valid).queries).toHaveLength(1);
  });

  it('rejects an empty expectedFiles array', () => {
    const bad = { ...valid, queries: [{ ...valid.queries[0], expectedFiles: [] }] };
    expect(() => parseQuerySet(bad)).toThrow(/expectedFiles/);
  });

  it('rejects a missing required field', () => {
    const bad = { ...valid, queries: [{ id: 'q1', concept: 'c', query: 'q', expectedFiles: ['a.ts'] }] };
    expect(() => parseQuerySet(bad)).toThrow(/segment/);
  });

  it('rejects duplicate ids', () => {
    const bad = { ...valid, queries: [valid.queries[0], valid.queries[0]] };
    expect(() => parseQuerySet(bad)).toThrow(/duplicate id/);
  });

  it('accepts optional expectedSymbols (TASK-027)', () => {
    const withSym = { ...valid, queries: [{ ...valid.queries[0], expectedSymbols: ['Foo.bar'] }] };
    expect(parseQuerySet(withSym).queries[0]!.expectedSymbols).toEqual(['Foo.bar']);
  });

  it('leaves expectedSymbols undefined when absent (backward-compatible)', () => {
    expect(parseQuerySet(valid).queries[0]!.expectedSymbols).toBeUndefined();
  });

  it('rejects an empty expectedSymbols array when the field is present', () => {
    const bad = { ...valid, queries: [{ ...valid.queries[0], expectedSymbols: [] }] };
    expect(() => parseQuerySet(bad)).toThrow(/expectedSymbols/);
  });

  // expectedSpans (TASK-029) ──────────────────────────────────────────────────

  it('accepts optional expectedSpans (TASK-029)', () => {
    const withSpans = {
      ...valid,
      queries: [{ ...valid.queries[0], expectedSpans: [{ file: 'web/src/foo.ts', start: 10, end: 20 }] }],
    };
    expect(parseQuerySet(withSpans).queries[0]!.expectedSpans).toEqual([
      { file: 'web/src/foo.ts', start: 10, end: 20 },
    ]);
  });

  it('leaves expectedSpans undefined when absent (backward-compatible)', () => {
    expect(parseQuerySet(valid).queries[0]!.expectedSpans).toBeUndefined();
  });

  it('rejects an empty expectedSpans array when the field is present', () => {
    const bad = { ...valid, queries: [{ ...valid.queries[0], expectedSpans: [] }] };
    expect(() => parseQuerySet(bad)).toThrow(/expectedSpans/);
  });

  it('rejects a non-object span entry', () => {
    const bad = { ...valid, queries: [{ ...valid.queries[0], expectedSpans: ['bad'] }] };
    expect(() => parseQuerySet(bad)).toThrow(/expectedSpans\[0\]/);
  });

  it('rejects a span with start > end', () => {
    const bad = {
      ...valid,
      queries: [{ ...valid.queries[0], expectedSpans: [{ file: 'a.ts', start: 20, end: 10 }] }],
    };
    expect(() => parseQuerySet(bad)).toThrow(/start.*>.*end|start \(20\) > end \(10\)/);
  });

  it('rejects a span with non-positive start', () => {
    const bad = {
      ...valid,
      queries: [{ ...valid.queries[0], expectedSpans: [{ file: 'a.ts', start: 0, end: 10 }] }],
    };
    expect(() => parseQuerySet(bad)).toThrow(/start must be a positive integer/);
  });

  it('rejects a span with non-integer end', () => {
    const bad = {
      ...valid,
      queries: [{ ...valid.queries[0], expectedSpans: [{ file: 'a.ts', start: 1, end: 1.5 }] }],
    };
    expect(() => parseQuerySet(bad)).toThrow(/end must be a positive integer/);
  });

  it('rejects a span with an empty file string', () => {
    const bad = {
      ...valid,
      queries: [{ ...valid.queries[0], expectedSpans: [{ file: '', start: 1, end: 10 }] }],
    };
    expect(() => parseQuerySet(bad)).toThrow(/file/);
  });
});

describe('queries.json (acceptance set)', () => {
  const set = loadQuerySet(queriesPath);

  it('has 50 queries covering all four segments', () => {
    expect(set.queries.length).toBeGreaterThanOrEqual(50);
    const segments = new Set(set.queries.map((q) => q.segment));
    expect(segments).toEqual(new Set(['web', 'mobile', 'wiki', 'tools']));
  });

  it.skipIf(!HAS_CORPUS)('points every ground-truth file at a path that actually exists', () => {
    // Self-validating ground truth: catches typos / moved files before measurement.
    const missing: string[] = [];
    for (const q of set.queries) {
      for (const f of q.expectedFiles) {
        if (!existsSync(resolve(repoRoot, f))) missing.push(`${q.id}: ${f}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
