import { z } from 'zod';
import type { SearchResult } from '../../store/vector-store.js';
import type { ServerDeps } from './index.js';
import { chunkBaseShape, chunkRef, chunkToStructured } from './format.js';

export const DEFAULT_K = 8;
export const MAX_K = 100;
export const MAX_QUERY_CHARS = 1000;
// Default snippet length — kept short so search stays token-cheap; the agent
// pulls the full chunk via get_chunk(id) only when it needs it.
const SNIPPET_MAX_CHARS = 280;

export type SearchArgs = {
  query: string;
  k?: number | undefined;
  segment?: string | undefined;
};

// Machine-readable output: agents read structuredContent (stable fields) to
// chain into get_chunk(id) reliably, instead of regexing the prose snippet.
export const searchOutputShape = {
  results: z.array(z.object({ ...chunkBaseShape, score: z.number() })),
};

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  let cut = max;
  // Don't slice through a surrogate pair (emoji/CJK on the astral plane): if the
  // last kept code unit is a lone high surrogate, drop it so we never emit a
  // broken character. The docs contain emoji (🎯, ✅), so this is reachable.
  const last = text.charCodeAt(cut - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut -= 1;
  return `${text.slice(0, cut).trimEnd()} …`;
}

function indent(text: string): string {
  return text
    .split('\n')
    .map((line) => `   ${line}`)
    .join('\n');
}

function formatResult(result: SearchResult, index: number): string {
  const c = result.chunk;
  const header = `${index + 1}. ${chunkRef(c, `score ${result.score.toFixed(2)}`)}`;

  const snippet = truncate(c.text, SNIPPET_MAX_CHARS);
  const snippetLine = snippet.trim() === '' ? '' : `\n${indent(snippet)}`;
  return `${header}\n   id=${c.id}${snippetLine}`;
}

export function formatResults(results: SearchResult[], query: string): string {
  if (results.length === 0) {
    return `No matches for "${query}".`;
  }
  const body = results.map(formatResult).join('\n\n');
  return (
    `${results.length} result(s) for "${query}":\n\n${body}\n\n` +
    `Use get_chunk(id) for a chunk's full text.`
  );
}

export function toStructured(results: SearchResult[]) {
  return {
    results: results.map((r) => ({ ...chunkToStructured(r.chunk), score: r.score })),
  };
}

/**
 * Builds the search_codebase handler: embed the query with the same model the
 * index was built with, run kNN over the vector store, and return both a
 * human-readable text rendering and machine-readable structuredContent.
 */
export function makeSearchCodebase(deps: ServerDeps) {
  return async (args: SearchArgs) => {
    const query = args.query.trim();
    if (query === '') {
      throw new Error('[rag-mcp] search_codebase: query must not be empty');
    }
    if (query.length > MAX_QUERY_CHARS) {
      throw new Error(
        `[rag-mcp] search_codebase: query too long (${query.length} > ${MAX_QUERY_CHARS} chars)`,
      );
    }

    const k = args.k ?? DEFAULT_K;
    if (!Number.isInteger(k) || k < 1 || k > MAX_K) {
      throw new Error(`[rag-mcp] search_codebase: k must be an integer in 1..${MAX_K}, got ${k}`);
    }

    let vectors: Float32Array[];
    try {
      vectors = await deps.embedder.embed([query], 'query');
    } catch (e) {
      // Surface a branded, actionable error instead of a raw transformers.js
      // message (e.g. a missing-model/ONNX error on a cold/offline cache).
      throw new Error(
        `[rag-mcp] search_codebase: embedding failed for model ${deps.embedder.modelId} — ${(e as Error).message}`,
      );
    }

    const vector = vectors[0];
    if (!vector) {
      throw new Error('[rag-mcp] search_codebase: embedder returned no vector for the query');
    }

    const filter = args.segment !== undefined ? { segment: args.segment } : undefined;
    // With a reranker (TASK-033), fetch a deeper candidate pool, re-score the
    // (query, chunk) pairs with the cross-encoder, and keep the reordered top-k.
    // Without one, plain top-k kNN (default).
    const fetchN = deps.reranker ? Math.max(k, deps.reranker.candidates) : k;
    const fetched = deps.store.search(vector, fetchN, filter);
    const results = deps.reranker ? await deps.reranker.rerank(query, fetched, k) : fetched;

    return {
      content: [{ type: 'text' as const, text: formatResults(results, query) }],
      structuredContent: toStructured(results),
    };
  };
}
