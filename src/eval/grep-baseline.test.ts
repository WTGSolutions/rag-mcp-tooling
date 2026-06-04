import { describe, it, expect } from 'vitest';
import { grepRank, type CorpusFile } from './grep-baseline.js';

const corpus: CorpusFile[] = [
  { path: 'src/auth.ts', content: 'export function login() { authenticate the session }' },
  { path: 'src/nip.ts', content: 'NIP validation checksum for tax number' },
  { path: 'src/empty.ts', content: 'unrelated content here' },
  { path: 'src/also-auth.ts', content: 'login helper, authenticate again' },
];

describe('grepRank', () => {
  it('ranks files by the count of distinct query keywords they contain', () => {
    // "login authenticate session" → auth.ts has all 3, also-auth.ts has 2
    const ranked = grepRank(corpus, 'login authenticate session', 5);
    expect(ranked[0]).toBe('src/auth.ts');
    expect(ranked[1]).toBe('src/also-auth.ts');
    expect(ranked).not.toContain('src/empty.ts');
  });

  it('breaks ties by path ascending for determinism', () => {
    // both files match the single keyword "login" once → alphabetical order
    const ranked = grepRank(corpus, 'login', 5);
    expect(ranked).toEqual(['src/also-auth.ts', 'src/auth.ts']);
  });

  it('honors the k cutoff', () => {
    expect(grepRank(corpus, 'login authenticate', 1)).toHaveLength(1);
  });

  it('returns nothing when the query has no content keywords', () => {
    expect(grepRank(corpus, 'to be or', 5)).toEqual([]);
  });
});
