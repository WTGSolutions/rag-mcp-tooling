import { describe, it, expect } from 'vitest';
import {
  toRepoPath,
  firstHitPosition,
  evaluate,
  aggregate,
  extractKeywords,
  estimateTokens,
  type Outcome,
} from './metrics.js';

describe('toRepoPath', () => {
  const roots = new Map([['web', 'web/src'], ['tools', 'tools/rag-mcp']]);

  it('prefixes the segment root onto the segment-relative path', () => {
    expect(toRepoPath(roots, 'web', 'auth.ts')).toBe('web/src/auth.ts');
  });

  it('falls back to the bare path for an unknown segment', () => {
    expect(toRepoPath(roots, 'mystery', 'x.ts')).toBe('x.ts');
  });
});

describe('firstHitPosition', () => {
  it('returns the 1-based rank of the first expected path', () => {
    expect(firstHitPosition(['a', 'b', 'c'], ['c', 'b'])).toBe(2);
  });

  it('returns null when no expected path is present', () => {
    expect(firstHitPosition(['a', 'b'], ['z'])).toBeNull();
  });
});

describe('evaluate', () => {
  it('counts a hit inside the cutoff and computes reciprocal rank', () => {
    const out = evaluate(['a', 'b', 'target', 'd'], ['target'], 5);
    expect(out).toEqual({ hit: true, position: 3, reciprocalRank: 1 / 3 });
  });

  it('treats a correct file beyond k as a miss', () => {
    // target is at rank 6 but k=5 → miss
    const ordered = ['a', 'b', 'c', 'd', 'e', 'target'];
    expect(evaluate(ordered, ['target'], 5)).toEqual({ hit: false, position: null, reciprocalRank: 0 });
  });
});

describe('aggregate', () => {
  it('computes hit-rate and MRR across outcomes', () => {
    const outcomes: Outcome[] = [
      { hit: true, position: 1, reciprocalRank: 1 },
      { hit: true, position: 2, reciprocalRank: 0.5 },
      { hit: false, position: null, reciprocalRank: 0 },
      { hit: false, position: null, reciprocalRank: 0 },
    ];
    expect(aggregate(outcomes)).toEqual({ count: 4, hits: 2, hitRate: 0.5, mrr: (1 + 0.5) / 4 });
  });

  it('is zero, not NaN, for an empty set', () => {
    expect(aggregate([])).toEqual({ count: 0, hits: 0, hitRate: 0, mrr: 0 });
  });
});

describe('extractKeywords', () => {
  it('lowercases, drops stop-words and short tokens, and dedupes', () => {
    expect(extractKeywords('Refresh the FCM push push token to')).toEqual([
      'refresh',
      'fcm',
      'push',
      'token',
    ]);
  });

  it('returns an empty list when nothing survives filtering', () => {
    expect(extractKeywords('to be or')).toEqual([]);
  });
});

describe('estimateTokens', () => {
  it('approximates ~4 chars per token, rounding up', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
  });
});
