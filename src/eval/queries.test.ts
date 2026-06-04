import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseQuerySet, loadQuerySet } from './queries.js';

const here = dirname(fileURLToPath(import.meta.url));
const queriesPath = resolve(here, '../../eval/queries.json');
const repoRoot = resolve(here, '../../../../'); // src/eval → src → rag-mcp → tools → repo

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
});

describe('queries.json (acceptance set)', () => {
  const set = loadQuerySet(queriesPath);

  it('has 50 queries covering all four segments', () => {
    expect(set.queries.length).toBeGreaterThanOrEqual(50);
    const segments = new Set(set.queries.map((q) => q.segment));
    expect(segments).toEqual(new Set(['web', 'mobile', 'wiki', 'tools']));
  });

  it('points every ground-truth file at a path that actually exists', () => {
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
