import { z } from 'zod';
import type { Chunk } from '../../chunk/types.js';

/**
 * Zod shape for the chunk fields shared by search_codebase and get_chunk tool
 * output — the schema counterpart of chunkToStructured below. Keeping both in
 * one place stops the output schema and the runtime object from drifting (a
 * missing field would be silently stripped by the MCP SDK). Each tool spreads
 * this and adds its own fields (search → score; get_chunk → language/text/…).
 */
export const chunkBaseShape = {
  id: z.string(),
  filePath: z.string(),
  startLine: z.number().int(),
  endLine: z.number().int(),
  segment: z.string(),
  kind: z.string(),
  symbol: z.string().optional(),
};

/**
 * Shared one-line chunk reference used by both search_codebase hits and
 * get_chunk: `path:startLine  [kind symbol · segment · <variant>]  (lines a-b)`.
 * `variant` is the per-tool field — a score for search, the language for
 * get_chunk. `path:startLine` is the agent's clickable editor reference.
 */
export function chunkRef(chunk: Chunk, variant: string): string {
  const label = chunk.symbol ? `${chunk.kind} ${chunk.symbol}` : chunk.kind;
  return (
    `${chunk.filePath}:${chunk.startLine}  ` +
    `[${label} · ${chunk.segment} · ${variant}]  (lines ${chunk.startLine}-${chunk.endLine})`
  );
}

/**
 * Common machine-readable chunk fields, with `symbol` omitted when absent.
 * Callers add the bits specific to their tool (search adds `score`; get_chunk
 * adds `language`, `fileHash`, `text`).
 */
export function chunkToStructured(chunk: Chunk) {
  return {
    id: chunk.id,
    filePath: chunk.filePath,
    startLine: chunk.startLine,
    endLine: chunk.endLine,
    segment: chunk.segment,
    kind: chunk.kind,
    ...(chunk.symbol !== undefined ? { symbol: chunk.symbol } : {}),
  };
}
