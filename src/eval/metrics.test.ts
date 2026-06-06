import { describe, it, expect } from 'vitest';
import {
  toRepoPath,
  firstHitPosition,
  evaluate,
  evaluateSymbol,
  aggregate,
  extractKeywords,
  estimateTokens,
  type Outcome,
  type RankedChunk,
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

describe('evaluateSymbol', () => {
  const rc = (repoPath: string, symbol: string | undefined): RankedChunk => ({ repoPath, symbol });

  it('hits only when both file AND symbol match, at the right rank', () => {
    const ordered = [
      rc('other.ts', 'foo'),            // wrong file
      rc('target.ts', 'wrongSymbol'),   // right file, wrong symbol
      rc('target.ts', 'Calc.add'),      // right file + right symbol → hit at #3
    ];
    expect(evaluateSymbol(ordered, ['target.ts'], ['Calc.add'], 5))
      .toEqual({ hit: true, position: 3, reciprocalRank: 1 / 3 });
  });

  it('does not hit on the right symbol in the wrong file', () => {
    const ordered = [rc('other.ts', 'Calc.add')];
    expect(evaluateSymbol(ordered, ['target.ts'], ['Calc.add'], 5))
      .toEqual({ hit: false, position: null, reciprocalRank: 0 });
  });

  it('does not hit on the right file with a missing/undefined symbol (line-chunker case)', () => {
    const ordered = [rc('target.ts', undefined), rc('target.ts', undefined)];
    expect(evaluateSymbol(ordered, ['target.ts'], ['Calc.add'], 5).hit).toBe(false);
  });

  it('respects the k cutoff', () => {
    const ordered = [
      rc('x', 'a'), rc('x', 'b'), rc('x', 'c'), rc('x', 'd'), rc('x', 'e'),
      rc('target.ts', 'Calc.add'), // rank 6, beyond k=5
    ];
    expect(evaluateSymbol(ordered, ['target.ts'], ['Calc.add'], 5).hit).toBe(false);
  });

  it('accepts any of several expected symbols', () => {
    const ordered = [rc('target.ts', 'Calc.zero')];
    expect(evaluateSymbol(ordered, ['target.ts'], ['Calc.add', 'Calc.zero'], 5).position).toBe(1);
  });

  it('a container class chunk satisfies a query for one of its methods', () => {
    // expected the method, search returned the whole class (which contains it) → right region
    const ordered = [rc('target.ts', 'Calc')];
    expect(evaluateSymbol(ordered, ['target.ts'], ['Calc.add'], 5).position).toBe(1);
  });

  it('a member chunk satisfies a query for its container', () => {
    const ordered = [rc('target.ts', 'TokenBucket.allow')];
    expect(evaluateSymbol(ordered, ['target.ts'], ['TokenBucket'], 5).position).toBe(1);
  });

  it('a sibling method does NOT satisfy (wrong symbol, same class)', () => {
    const ordered = [rc('target.ts', 'Calc.zero')];
    expect(evaluateSymbol(ordered, ['target.ts'], ['Calc.add'], 5).hit).toBe(false);
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
