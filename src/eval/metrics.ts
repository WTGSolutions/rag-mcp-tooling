// Pure scoring helpers for the acceptance harness (TASK-016). No I/O, no model —
// every function here is deterministic and unit-tested offline.

/** Segment name → segment root (repo-relative, e.g. "web/src"), from the config. */
export type SegmentRoots = ReadonlyMap<string, string>;

/**
 * Reconstruct a repo-relative path from a chunk's `segment` + segment-relative
 * `filePath`, so search hits can be compared against the repo-relative
 * `expectedFiles` in the query set. Falls back to the bare path if the segment
 * is unknown.
 */
export function toRepoPath(roots: SegmentRoots, segment: string, filePath: string): string {
  const root = roots.get(segment);
  return root ? `${root}/${filePath}` : filePath;
}

/** 1-based position of the first path in `ordered` that is in `expected`; null if none. */
export function firstHitPosition(ordered: readonly string[], expected: readonly string[]): number | null {
  const want = new Set(expected);
  for (let i = 0; i < ordered.length; i++) {
    if (want.has(ordered[i] as string)) return i + 1;
  }
  return null;
}

export type Outcome = {
  hit: boolean;
  /** 1-based rank of the first correct file within the top-k, or null on a miss. */
  position: number | null;
  reciprocalRank: number;
};

/** Evaluate one ranked result list against the expected files at cutoff `k`. */
export function evaluate(ordered: readonly string[], expected: readonly string[], k: number): Outcome {
  const position = firstHitPosition(ordered.slice(0, k), expected);
  return {
    hit: position !== null,
    position,
    reciprocalRank: position === null ? 0 : 1 / position,
  };
}

export type Aggregate = { count: number; hits: number; hitRate: number; mrr: number };

/** Aggregate per-query outcomes into hit-rate and mean reciprocal rank. */
export function aggregate(outcomes: readonly Outcome[]): Aggregate {
  const count = outcomes.length;
  const hits = outcomes.reduce((n, o) => n + (o.hit ? 1 : 0), 0);
  const rrSum = outcomes.reduce((s, o) => s + o.reciprocalRank, 0);
  return {
    count,
    hits,
    hitRate: count === 0 ? 0 : hits / count,
    mrr: count === 0 ? 0 : rrSum / count,
  };
}

// Tiny English stop-list — the queries are written in English to match the
// English embedder (bge-small-en); the grep baseline drops these so it keys off
// content words, not glue.
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'for', 'to', 'in', 'on', 'is', 'are',
  'with', 'by', 'how', 'where', 'what', 'when', 'from', 'into',
]);

/** Lowercase alphanumeric tokens ≥3 chars, minus stop-words, deduped (stable order). */
export function extractKeywords(query: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tok of query.toLowerCase().split(/[^a-z0-9]+/)) {
    if (tok.length < 3 || STOPWORDS.has(tok) || seen.has(tok)) continue;
    seen.add(tok);
    out.push(tok);
  }
  return out;
}

/**
 * Rough token estimate: ~4 chars/token. A heuristic, not a real tokenizer — it
 * only needs to be consistent across RAG-snippet vs broad-file so the *ratio*
 * is meaningful.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
