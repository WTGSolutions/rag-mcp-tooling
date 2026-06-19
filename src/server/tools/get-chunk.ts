import { z } from 'zod';
import type { Chunk } from '../../chunk/types.js';
import { chunkBaseShape, chunkRef, chunkToStructured } from './format.js';
import type { ServerDeps } from './index.js';

export type GetChunkArgs = { id: string };

// Structural context (TASK-045) surfaced alongside the chunk: its file imports,
// the chunks that call its symbol (callers), and doc sections mentioning it.
export type ChunkContext = {
  imports: string[];
  callers: ReturnType<typeof chunkToStructured>[];
  docLinks: ReturnType<typeof chunkToStructured>[];
};

// Full chunk metadata + text — the complement to search_codebase's snippets.
export const getChunkOutputShape = {
  ...chunkBaseShape,
  language: z.string(),
  fileHash: z.string(),
  text: z.string(),
  // Structural metadata (TASK-045). Always present; empty when unavailable
  // (line/markdown/other-language chunks, or symbols with no callers/docs).
  imports: z.array(z.string()),
  callers: z.array(z.object(chunkBaseShape)),
  docLinks: z.array(z.object(chunkBaseShape)),
};

export function formatChunk(chunk: Chunk, ctx?: ChunkContext): string {
  const head = `${chunkRef(chunk, chunk.language)}\nid=${chunk.id}`;
  const meta: string[] = [];
  if (ctx?.imports.length) meta.push(`imports: ${ctx.imports.join(', ')}`);
  if (ctx?.callers.length) {
    meta.push(
      `callers: ${ctx.callers.map((c) => `${c.filePath}:${c.startLine}`).join(', ')}`,
    );
  }
  if (ctx?.docLinks.length) {
    meta.push(
      `docs: ${ctx.docLinks.map((c) => `${c.filePath}:${c.startLine}`).join(', ')}`,
    );
  }
  const metaBlock = meta.length ? `\n${meta.join('\n')}` : '';
  return `${head}${metaBlock}\n\n${chunk.text}`;
}

export function toStructuredChunk(chunk: Chunk, ctx?: ChunkContext) {
  return {
    ...chunkToStructured(chunk),
    language: chunk.language,
    fileHash: chunk.fileHash,
    text: chunk.text,
    imports: ctx?.imports ?? [],
    callers: ctx?.callers ?? [],
    docLinks: ctx?.docLinks ?? [],
  };
}

/**
 * Builds the get_chunk handler: resolves a chunk id (from a search_codebase
 * result) to its full text and structural context (imports, callers, doc links).
 * Read-only.
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

    // `Class.method` → callers/docs are keyed by the bare name the call sites use.
    const bareName = chunk.symbol?.split('.').pop() ?? '';
    const ctx: ChunkContext = {
      imports: chunk.imports ?? [],
      callers: bareName
        ? deps.store.findCallers(bareName, chunk.id).map(chunkToStructured)
        : [],
      docLinks: bareName
        ? deps.store.findDocMentions(bareName).map(chunkToStructured)
        : [],
    };

    return {
      content: [{ type: 'text' as const, text: formatChunk(chunk, ctx) }],
      structuredContent: toStructuredChunk(chunk, ctx),
    };
  };
}
