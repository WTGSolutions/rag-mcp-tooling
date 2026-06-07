import { describe, it, expect } from 'vitest';
import {
  toRepoPath,
  firstHitPosition,
  evaluate,
  evaluateSymbol,
  evaluateSpan,
  aggregate,
  extractKeywords,
  estimateTokens,
  type Outcome,
  type RankedChunk,
  type ExpectedSpan,
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

describe('evaluateSpan', () => {
  const rc = (
    repoPath: string,
    startLine: number | undefined,
    endLine: number | undefined,
  ): RankedChunk => ({
    repoPath,
    symbol: undefined,
    ...(startLine !== undefined ? { startLine } : {}),
    ...(endLine !== undefined ? { endLine } : {}),
  });

  const span = (file: string, start: number, end: number): ExpectedSpan => ({ file, start, end });

  it('hits when chunk range exactly matches the golden span', () => {
    const ordered = [rc('target.ts', 10, 20)];
    expect(evaluateSpan(ordered, [span('target.ts', 10, 20)], 5))
      .toEqual({ hit: true, position: 1, reciprocalRank: 1 });
  });

  it('hits when chunk range fully contains the golden span (span inside chunk)', () => {
    const ordered = [rc('target.ts', 5, 30)];
    expect(evaluateSpan(ordered, [span('target.ts', 10, 20)], 5).hit).toBe(true);
  });

  it('hits when golden span fully contains the chunk range (chunk inside span)', () => {
    const ordered = [rc('target.ts', 12, 18)];
    expect(evaluateSpan(ordered, [span('target.ts', 10, 20)], 5).hit).toBe(true);
  });

  it('hits on left-edge overlap (chunk ends inside span)', () => {
    // chunk: 5-15, span: 10-20 → overlap at 10-15
    const ordered = [rc('target.ts', 5, 15)];
    expect(evaluateSpan(ordered, [span('target.ts', 10, 20)], 5).hit).toBe(true);
  });

  it('hits on right-edge overlap (chunk starts inside span)', () => {
    // chunk: 15-25, span: 10-20 → overlap at 15-20
    const ordered = [rc('target.ts', 15, 25)];
    expect(evaluateSpan(ordered, [span('target.ts', 10, 20)], 5).hit).toBe(true);
  });

  it('misses when chunk is immediately adjacent (no overlap)', () => {
    // chunk ends at 9, span starts at 10
    const ordered = [rc('target.ts', 1, 9)];
    expect(evaluateSpan(ordered, [span('target.ts', 10, 20)], 5).hit).toBe(false);
  });

  it('misses when chunk starts after span ends (no overlap)', () => {
    const ordered = [rc('target.ts', 21, 30)];
    expect(evaluateSpan(ordered, [span('target.ts', 10, 20)], 5).hit).toBe(false);
  });

  it('misses when correct range but wrong file', () => {
    const ordered = [rc('other.ts', 10, 20)];
    expect(evaluateSpan(ordered, [span('target.ts', 10, 20)], 5).hit).toBe(false);
  });

  it('skips chunks without startLine/endLine (line-chunker case)', () => {
    const ordered = [rc('target.ts', undefined, undefined)];
    expect(evaluateSpan(ordered, [span('target.ts', 10, 20)], 5).hit).toBe(false);
  });

  it('returns correct 1-based rank when first hit is not at position 1', () => {
    const ordered = [rc('target.ts', 50, 60), rc('target.ts', 10, 20)];
    const out = evaluateSpan(ordered, [span('target.ts', 10, 20)], 5);
    expect(out).toEqual({ hit: true, position: 2, reciprocalRank: 0.5 });
  });

  it('respects the k cutoff', () => {
    const ordered = [
      rc('x', 1, 5), rc('x', 6, 10), rc('x', 11, 15), rc('x', 16, 20), rc('x', 21, 25),
      rc('target.ts', 10, 20), // rank 6, beyond k=5
    ];
    expect(evaluateSpan(ordered, [span('target.ts', 10, 20)], 5).hit).toBe(false);
  });

  it('accepts any matching span from a multi-span list', () => {
    const ordered = [rc('target.ts', 100, 150)];
    const spans = [span('target.ts', 10, 20), span('target.ts', 100, 150)];
    expect(evaluateSpan(ordered, spans, 5).hit).toBe(true);
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
