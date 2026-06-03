import type { SearchResult } from '../../store/vector-store.js';
import type { ServerDeps } from './index.js';

export const DEFAULT_K = 8;
const MAX_K = 100;
const MAX_QUERY_CHARS = 1000;
// Default snippet length — kept short so search stays token-cheap; the agent
// pulls the full chunk via get_chunk(id) only when it needs it.
const SNIPPET_MAX_CHARS = 280;

export type SearchArgs = {
  query: string;
  k?: number | undefined;
  segment?: string | undefined;
};

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max).trimEnd()} …` : text;
}

function indent(text: string): string {
  return text
    .split('\n')
    .map((line) => `   ${line}`)
    .join('\n');
}

function formatResult(result: SearchResult, index: number): string {
  const c = result.chunk;
  const label = c.symbol ? `${c.kind} ${c.symbol}` : c.kind;
  // `filePath:startLine` is the clickable reference for the agent's editor.
  const header =
    `${index + 1}. ${c.filePath}:${c.startLine}  ` +
    `[${label} · ${c.segment} · score ${result.score.toFixed(2)}]  (lines ${c.startLine}-${c.endLine})`;
  return `${header}\n   id=${c.id}\n${indent(truncate(c.text, SNIPPET_MAX_CHARS))}`;
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

/**
 * Builds the search_codebase handler: embed the query with the same model the
 * index was built with, run kNN over the vector store, and render the top-K
 * chunks as clickable file:line references with short snippets.
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

    const vectors = await deps.embedder.embed([query]);
    const vector = vectors[0];
    if (!vector) {
      throw new Error('[rag-mcp] search_codebase: embedder returned no vector for the query');
    }

    const filter = args.segment !== undefined ? { segment: args.segment } : undefined;
    const results = deps.store.search(vector, k, filter);

    return {
      content: [{ type: 'text' as const, text: formatResults(results, query) }],
    };
  };
}
