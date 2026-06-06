import { describe, it, expect } from 'vitest';
import { parseLog, aggregate, formatReport } from './report.js';
import type { UsageRecord } from '../server/usage-logger.js';

// ── helpers ──────────────────────────────────────────────────────────────────

function makeSearch(overrides?: Partial<UsageRecord & { tool: 'search_codebase' }>): string {
  const r: UsageRecord = {
    ts: new Date().toISOString(),
    tool: 'search_codebase',
    query: 'test query',
    k: 5,
    segment: null,
    results: 3,
    topScore: 0.85,
    latencyMs: 50,
    paths: ['a.ts'],
    ...overrides,
  };
  return JSON.stringify(r);
}

function makeChunk(overrides?: Partial<UsageRecord & { tool: 'get_chunk' }>): string {
  const r: UsageRecord = {
    ts: new Date().toISOString(),
    tool: 'get_chunk',
    id: 'chunk-1',
    found: true,
    latencyMs: 5,
    ...overrides,
  };
  return JSON.stringify(r);
}

function makeReindex(overrides?: Partial<UsageRecord & { tool: 'reindex' }>): string {
  const r: UsageRecord = {
    ts: new Date().toISOString(),
    tool: 'reindex',
    added: 10,
    skipped: 2,
    removed: 1,
    latencyMs: 800,
    ...overrides,
  };
  return JSON.stringify(r);
}

// ── parseLog ─────────────────────────────────────────────────────────────────

describe('parseLog', () => {
  it('returns empty array for empty string', () => {
    expect(parseLog('')).toHaveLength(0);
  });

  it('parses valid JSONL records', () => {
    const text = [makeSearch(), makeChunk(), makeReindex()].join('\n');
    const records = parseLog(text);
    expect(records).toHaveLength(3);
    expect(records[0]!.tool).toBe('search_codebase');
    expect(records[1]!.tool).toBe('get_chunk');
    expect(records[2]!.tool).toBe('reindex');
  });

  it('skips malformed lines', () => {
    const text = [makeSearch(), 'not-json', '{broken}', makeChunk()].join('\n');
    const records = parseLog(text);
    expect(records).toHaveLength(2);
  });

  it('skips objects missing required fields', () => {
    const text = ['{"x":1}', makeSearch()].join('\n');
    const records = parseLog(text);
    expect(records).toHaveLength(1);
  });

  it('skips structurally incomplete known-tool records (prevents scoreStats crash)', () => {
    // A line with correct tool but missing tool-specific fields must be rejected.
    const partial = JSON.stringify({ tool: 'search_codebase', ts: new Date().toISOString() });
    const text = [partial, makeSearch()].join('\n');
    const records = parseLog(text);
    expect(records).toHaveLength(1);
  });

  it('skips unknown tool values', () => {
    const unknown = JSON.stringify({ tool: 'index_status', ts: new Date().toISOString() });
    const text = [unknown, makeChunk()].join('\n');
    expect(parseLog(text)).toHaveLength(1);
  });

  it('skips blank lines', () => {
    const text = [makeSearch(), '', '   ', makeChunk()].join('\n');
    expect(parseLog(text)).toHaveLength(2);
  });
});

// ── aggregate ────────────────────────────────────────────────────────────────

describe('aggregate', () => {
  it('counts tool calls', () => {
    const records = parseLog([makeSearch(), makeSearch(), makeChunk(), makeReindex()].join('\n'));
    const agg = aggregate(records);
    expect(agg.search.count).toBe(2);
    expect(agg.getChunk.count).toBe(1);
    expect(agg.reindex.count).toBe(1);
  });

  it('tracks found/not-found for get_chunk', () => {
    const records = parseLog([
      makeChunk({ found: true }),
      makeChunk({ found: false }),
      makeChunk({ found: true }),
    ].join('\n'));
    const agg = aggregate(records);
    expect(agg.getChunk.found).toBe(2);
    expect(agg.getChunk.notFound).toBe(1);
  });

  it('collects topScores (excludes null)', () => {
    const records = parseLog([
      makeSearch({ topScore: 0.9 }),
      makeSearch({ topScore: null, results: 0 }),
    ].join('\n'));
    const agg = aggregate(records);
    expect(agg.search.topScores).toHaveLength(1);
    expect(agg.search.topScores[0]).toBeCloseTo(0.9);
  });

  it('returns null followUpRate when no searches', () => {
    const records = parseLog(makeChunk());
    expect(aggregate(records).followUpRate).toBeNull();
  });

  it('computes followUpRate: get_chunk within 5 min of search = followed', () => {
    const searchTs = '2026-01-01T10:00:00.000Z';
    const chunkTs  = '2026-01-01T10:04:00.000Z'; // 4 min later — within window
    const text = [
      makeSearch({ ts: searchTs }),
      makeChunk({ ts: chunkTs }),
    ].join('\n');
    const agg = aggregate(parseLog(text));
    expect(agg.followUpRate).toBe(1);
  });

  it('computes followUpRate: get_chunk after 5 min = not followed', () => {
    const searchTs = '2026-01-01T10:00:00.000Z';
    const chunkTs  = '2026-01-01T10:06:00.000Z'; // 6 min later — outside window
    const text = [
      makeSearch({ ts: searchTs }),
      makeChunk({ ts: chunkTs }),
    ].join('\n');
    const agg = aggregate(parseLog(text));
    expect(agg.followUpRate).toBe(0);
  });

  it('tracks top queries sorted by frequency', () => {
    const text = [
      makeSearch({ query: 'auth token' }),
      makeSearch({ query: 'auth token' }),
      makeSearch({ query: 'refresh token' }),
    ].join('\n');
    const agg = aggregate(parseLog(text));
    expect(agg.topQueries[0]).toEqual(['auth token', 2]);
    expect(agg.topQueries[1]).toEqual(['refresh token', 1]);
  });

  it('tracks top segments', () => {
    const text = [
      makeSearch({ segment: 'web' }),
      makeSearch({ segment: 'web' }),
      makeSearch({ segment: 'mobile' }),
    ].join('\n');
    const agg = aggregate(parseLog(text));
    expect(agg.topSegments[0]).toEqual(['web', 2]);
    expect(agg.topSegments[1]).toEqual(['mobile', 1]);
  });
});

// ── formatReport ──────────────────────────────────────────────────────────────

describe('formatReport', () => {
  it('renders header and zero counts', () => {
    const agg = aggregate([]);
    const report = formatReport(agg);
    expect(report).toContain('RAG-MCP Usage Report');
    expect(report).toContain('search_codebase: 0');
    expect(report).toContain('get_chunk: 0');
    expect(report).toContain('reindex: 0');
  });

  it('includes follow-up rate when there are searches', () => {
    const searchTs = '2026-01-01T10:00:00.000Z';
    const chunkTs  = '2026-01-01T10:01:00.000Z';
    const text = [makeSearch({ ts: searchTs }), makeChunk({ ts: chunkTs })].join('\n');
    const report = formatReport(aggregate(parseLog(text)));
    expect(report).toContain('Follow-up');
    expect(report).toContain('100%');
  });

  it('includes top queries and segments when present', () => {
    const text = [
      makeSearch({ query: 'lost participant detection', segment: 'mobile' }),
    ].join('\n');
    const report = formatReport(aggregate(parseLog(text)));
    expect(report).toContain('lost participant detection');
    expect(report).toContain('mobile');
  });
});
