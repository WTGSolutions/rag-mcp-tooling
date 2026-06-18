import type { UsageRecord } from '../server/usage-logger.js';

export type { UsageRecord };

export type SearchStats = {
  count: number;
  topScores: number[];
  latencies: number[];
};

export type GetChunkStats = {
  count: number;
  found: number;
  notFound: number;
};

export type ReindexStats = {
  count: number;
};

export type AggregatedUsage = {
  search: SearchStats;
  getChunk: GetChunkStats;
  reindex: ReindexStats;
  /** Fraction (0–1) of searches followed by a get_chunk within 5 min. Null when no searches. */
  followUpRate: number | null;
  /** [query, count] sorted descending by count. */
  topQueries: [string, number][];
  /** [segment, count] sorted descending by count. */
  topSegments: [string, number][];
};

/** Parse JSONL text into UsageRecord array, silently skipping malformed lines. */
export function parseLog(text: string): UsageRecord[] {
  const records: UsageRecord[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      const obj = JSON.parse(trimmed) as unknown;
      if (isUsageRecord(obj)) records.push(obj);
    } catch {
      // malformed line — skip
    }
  }
  return records;
}

function isUsageRecord(obj: unknown): obj is UsageRecord {
  if (typeof obj !== 'object' || obj === null) return false;
  const r = obj as Record<string, unknown>;
  if (typeof r['ts'] !== 'string') return false;
  if (r['tool'] === 'search_codebase') {
    return (
      typeof r['query'] === 'string' &&
      typeof r['k'] === 'number' &&
      typeof r['results'] === 'number' &&
      typeof r['latencyMs'] === 'number' &&
      Array.isArray(r['paths']) &&
      (r['topScore'] === null || typeof r['topScore'] === 'number') &&
      (r['segment'] === null || typeof r['segment'] === 'string')
    );
  }
  if (r['tool'] === 'get_chunk') {
    return (
      typeof r['id'] === 'string' &&
      typeof r['found'] === 'boolean' &&
      typeof r['latencyMs'] === 'number'
    );
  }
  if (r['tool'] === 'reindex') {
    return (
      typeof r['added'] === 'number' &&
      typeof r['skipped'] === 'number' &&
      typeof r['removed'] === 'number' &&
      typeof r['latencyMs'] === 'number'
    );
  }
  return false; // unknown tool — skip
}

function topN(counts: Map<string, number>, n = 10): [string, number][] {
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
}

const FOLLOW_UP_WINDOW_MS = 5 * 60 * 1000;

/** Aggregate parsed records into summary statistics. */
export function aggregate(records: UsageRecord[]): AggregatedUsage {
  const search: SearchStats = { count: 0, topScores: [], latencies: [] };
  const getChunk: GetChunkStats = { count: 0, found: 0, notFound: 0 };
  const reindex: ReindexStats = { count: 0 };
  const queryCounts = new Map<string, number>();
  const segmentCounts = new Map<string, number>();

  const searchTimes: number[] = [];
  const chunkTimes: number[] = [];

  for (const r of records) {
    if (r.tool === 'search_codebase') {
      search.count++;
      if (r.topScore !== null) search.topScores.push(r.topScore);
      search.latencies.push(r.latencyMs);
      queryCounts.set(r.query, (queryCounts.get(r.query) ?? 0) + 1);
      if (r.segment !== null) {
        segmentCounts.set(r.segment, (segmentCounts.get(r.segment) ?? 0) + 1);
      }
      searchTimes.push(new Date(r.ts).getTime());
    } else if (r.tool === 'get_chunk') {
      getChunk.count++;
      if (r.found) getChunk.found++;
      else getChunk.notFound++;
      chunkTimes.push(new Date(r.ts).getTime());
    } else if (r.tool === 'reindex') {
      reindex.count++;
    }
  }

  // Follow-up: a search is "followed up" when a get_chunk happens within the window after it.
  let followUpRate: number | null = null;
  if (searchTimes.length > 0) {
    let followed = 0;
    for (const t of searchTimes) {
      if (chunkTimes.some((ct) => ct >= t && ct <= t + FOLLOW_UP_WINDOW_MS))
        followed++;
    }
    followUpRate = followed / searchTimes.length;
  }

  return {
    search,
    getChunk,
    reindex,
    followUpRate,
    topQueries: topN(queryCounts),
    topSegments: topN(segmentCounts),
  };
}

function pct(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

function scoreStats(scores: number[]): string {
  if (scores.length === 0) return 'n/a';
  const sorted = [...scores].sort((a, b) => a - b);
  const min = sorted[0]!.toFixed(2);
  const med = sorted[Math.floor(sorted.length / 2)]!.toFixed(2);
  const max = sorted[sorted.length - 1]!.toFixed(2);
  return `min ${min}  median ${med}  max ${max}`;
}

function latencyStats(ms: number[]): string {
  if (ms.length === 0) return 'n/a';
  const avg = Math.round(ms.reduce((a, b) => a + b, 0) / ms.length);
  const sorted = [...ms].sort((a, b) => a - b);
  const p95 = sorted[Math.floor(sorted.length * 0.95)]!;
  return `avg ${avg}ms  p95 ${p95}ms`;
}

/** Format aggregated usage as a human-readable report (stdout-safe). */
export function formatReport(agg: AggregatedUsage): string {
  const lines: string[] = [
    'RAG-MCP Usage Report',
    '====================',
    '',
    `search_codebase: ${agg.search.count} call(s)`,
  ];

  if (agg.search.count > 0) {
    lines.push(`  Top score:  ${scoreStats(agg.search.topScores)}`);
    lines.push(`  Latency:    ${latencyStats(agg.search.latencies)}`);
    if (agg.followUpRate !== null) {
      lines.push(
        `  Follow-up:  ${pct(agg.followUpRate)} of searches followed by get_chunk (≤5 min)`,
      );
    }
  }

  lines.push('');
  lines.push(
    `get_chunk: ${agg.getChunk.count} call(s)` +
      (agg.getChunk.count > 0
        ? `  (found ${agg.getChunk.found}, not-found ${agg.getChunk.notFound})`
        : ''),
  );

  lines.push('');
  lines.push(`reindex: ${agg.reindex.count} call(s)`);

  if (agg.topQueries.length > 0) {
    lines.push('', 'Top queries:');
    for (const [q, n] of agg.topQueries) {
      lines.push(`  ${String(n).padStart(3)}×  "${q}"`);
    }
  }

  if (agg.topSegments.length > 0) {
    lines.push('', 'Top segments:');
    for (const [s, n] of agg.topSegments) {
      lines.push(`  ${String(n).padStart(3)}×  ${s}`);
    }
  }

  return lines.join('\n');
}
