import { z } from 'zod';
import type { Chunk } from '../../chunk/types.js';
import type { ServerDeps } from './index.js';

export type GetChunkArgs = { id: string };

// Full chunk metadata + text — the complement to search_codebase's snippets.
export const getChunkOutputShape = {
  id: z.string(),
  filePath: z.string(),
  startLine: z.number().int(),
  endLine: z.number().int(),
  segment: z.string(),
  kind: z.string(),
  symbol: z.string().optional(),
  language: z.string(),
  fileHash: z.string(),
  text: z.string(),
};

export function formatChunk(chunk: Chunk): string {
  const label = chunk.symbol ? `${chunk.kind} ${chunk.symbol}` : chunk.kind;
  const header =
    `${chunk.filePath}:${chunk.startLine}  ` +
    `[${label} · ${chunk.segment} · ${chunk.language}]  (lines ${chunk.startLine}-${chunk.endLine})`;
  return `${header}\nid=${chunk.id}\n\n${chunk.text}`;
}

export function toStructuredChunk(chunk: Chunk) {
  return {
    id: chunk.id,
    filePath: chunk.filePath,
    startLine: chunk.startLine,
    endLine: chunk.endLine,
    segment: chunk.segment,
    kind: chunk.kind,
    language: chunk.language,
    fileHash: chunk.fileHash,
    text: chunk.text,
    ...(chunk.symbol !== undefined ? { symbol: chunk.symbol } : {}),
  };
}

/**
 * Builds the get_chunk handler: resolves a chunk id (from a search_codebase
 * result) to its full text and metadata. Read-only.
 */
export function makeGetChunk(deps: ServerDeps) {
  return async (args: GetChunkArgs) => {
    const id = args.id.trim();
    if (id === '') {
      throw new Error('[rag-mcp] get_chunk: id must not be empty');
    }

    const chunk = deps.store.getChunkById(id);
    if (!chunk) {
      throw new Error(`[rag-mcp] get_chunk: no chunk found with id "${id}"`);
    }

    return {
      content: [{ type: 'text' as const, text: formatChunk(chunk) }],
      structuredContent: toStructuredChunk(chunk),
    };
  };
}
