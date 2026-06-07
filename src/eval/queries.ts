import { readFileSync } from 'node:fs';
import type { ExpectedSpan } from './metrics.js';

/**
 * One acceptance query. `query` is what gets embedded / grepped (English, to
 * match the English embedder); `concept` is the human-readable PL label;
 * `expectedFiles` is the human-validated ground truth (repo-relative paths) — a
 * hit means any of them lands in the top-k.
 */
export type EvalQuery = {
  id: string;
  concept: string;
  query: string;
  segment: string;
  expectedFiles: string[];
  /**
   * Optional symbol-level ground truth (TASK-027): the symbol(s) that answer the
   * query inside an expected file (e.g. `DynamoDBStorage.queryPaginated`). When
   * present, the harness also scores symbol-level retrieval. Absent → file-level
   * only (backward-compatible).
   */
  expectedSymbols?: string[];
  /**
   * Optional span-level ground truth (TASK-029): the golden line-range region(s)
   * that answer the query. `file` is repo-relative (like `expectedFiles`); `start`
   * and `end` are 1-based inclusive. When present, the harness also scores
   * span-level retrieval — the only lens that distinguishes which sub-window of an
   * oversized symbol was retrieved. Absent → file/symbol-level only.
   */
  expectedSpans?: ExpectedSpan[];
};

export type QuerySet = {
  /** Whether the ground truth has been human-validated (anti-bias gate). */
  groundTruthStatus: string;
  queries: EvalQuery[];
};

function asNonEmptyString(value: unknown, where: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`[rag-mcp] queries: ${where} must be a non-empty string`);
  }
  return value;
}

/** Validate raw JSON into a QuerySet, failing loudly on malformed ground truth. */
export function parseQuerySet(raw: unknown): QuerySet {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('[rag-mcp] queries: root must be an object');
  }
  const obj = raw as Record<string, unknown>;
  const groundTruthStatus = asNonEmptyString(obj['groundTruthStatus'], 'groundTruthStatus');

  if (!Array.isArray(obj['queries']) || obj['queries'].length === 0) {
    throw new Error('[rag-mcp] queries: "queries" must be a non-empty array');
  }

  const ids = new Set<string>();
  const queries = obj['queries'].map((q, i) => {
    const where = `queries[${i}]`;
    if (typeof q !== 'object' || q === null) throw new Error(`[rag-mcp] queries: ${where} must be an object`);
    const e = q as Record<string, unknown>;
    const id = asNonEmptyString(e['id'], `${where}.id`);
    if (ids.has(id)) throw new Error(`[rag-mcp] queries: duplicate id "${id}"`);
    ids.add(id);

    if (!Array.isArray(e['expectedFiles']) || e['expectedFiles'].length === 0) {
      throw new Error(`[rag-mcp] queries: ${where}.expectedFiles must be a non-empty array`);
    }
    const expectedFiles = e['expectedFiles'].map((f, j) =>
      asNonEmptyString(f, `${where}.expectedFiles[${j}]`),
    );

    // Optional symbol-level ground truth (TASK-027). When present it must be a
    // non-empty array of non-empty strings; absent leaves the query file-level only.
    let expectedSymbols: string[] | undefined;
    if (e['expectedSymbols'] !== undefined) {
      if (!Array.isArray(e['expectedSymbols']) || e['expectedSymbols'].length === 0) {
        throw new Error(`[rag-mcp] queries: ${where}.expectedSymbols must be a non-empty array when present`);
      }
      expectedSymbols = e['expectedSymbols'].map((s, j) =>
        asNonEmptyString(s, `${where}.expectedSymbols[${j}]`),
      );
    }

    // Optional span-level ground truth (TASK-029). When present it must be a
    // non-empty array of {file, start, end} objects with start<=end positive ints.
    let expectedSpans: ExpectedSpan[] | undefined;
    if (e['expectedSpans'] !== undefined) {
      if (!Array.isArray(e['expectedSpans']) || e['expectedSpans'].length === 0) {
        throw new Error(`[rag-mcp] queries: ${where}.expectedSpans must be a non-empty array when present`);
      }
      expectedSpans = e['expectedSpans'].map((s, j) => {
        if (typeof s !== 'object' || s === null) {
          throw new Error(`[rag-mcp] queries: ${where}.expectedSpans[${j}] must be an object`);
        }
        const sp = s as Record<string, unknown>;
        const file = asNonEmptyString(sp['file'], `${where}.expectedSpans[${j}].file`);
        const start = sp['start'];
        const end = sp['end'];
        if (typeof start !== 'number' || !Number.isInteger(start) || start < 1) {
          throw new Error(
            `[rag-mcp] queries: ${where}.expectedSpans[${j}].start must be a positive integer`,
          );
        }
        if (typeof end !== 'number' || !Number.isInteger(end) || end < 1) {
          throw new Error(
            `[rag-mcp] queries: ${where}.expectedSpans[${j}].end must be a positive integer`,
          );
        }
        if (start > end) {
          throw new Error(
            `[rag-mcp] queries: ${where}.expectedSpans[${j}] start (${start}) > end (${end})`,
          );
        }
        return { file, start, end };
      });
    }

    return {
      id,
      concept: asNonEmptyString(e['concept'], `${where}.concept`),
      query: asNonEmptyString(e['query'], `${where}.query`),
      segment: asNonEmptyString(e['segment'], `${where}.segment`),
      expectedFiles,
      ...(expectedSymbols ? { expectedSymbols } : {}),
      ...(expectedSpans ? { expectedSpans } : {}),
    };
  });

  return { groundTruthStatus, queries };
}

export function loadQuerySet(path: string): QuerySet {
  return parseQuerySet(JSON.parse(readFileSync(path, 'utf8')));
}
