import { z } from 'zod';
import type { Chunk } from '../../chunk/types.js';
import type { ServerDeps } from './index.js';
import { chunkBaseShape, chunkRef, chunkToStructured } from './format.js';

export type GetChunkArgs = { id: string };

// Full chunk metadata + text — the complement to search_codebase's snippets.
export const getChunkOutputShape = {
  ...chunkBaseShape,
  language: z.string(),
  fileHash: z.string(),
  text: z.string(),
};

export function formatChunk(chunk: Chunk): string {
  return `${chunkRef(chunk, chunk.language)}\nid=${chunk.id}\n\n${chunk.text}`;
}

export function toStructuredChunk(chunk: Chunk) {
  return {
    ...chunkToStructured(chunk),
    language: chunk.language,
    fileHash: chunk.fileHash,
    text: chunk.text,
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
