import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RagConfig } from '../../config.js';
import type { Embedder } from '../../embedder/types.js';
import type { VectorStore } from '../../store/vector-store.js';
import {
  makeSearchCodebase,
  searchOutputShape,
  DEFAULT_K,
  MAX_K,
  MAX_QUERY_CHARS,
} from './search-codebase.js';
import { makeGetChunk, getChunkOutputShape } from './get-chunk.js';
import { makeIndexStatus, indexStatusOutputShape } from './index-status.js';
import { makeReindex, reindexOutputShape } from './reindex.js';
import { UsageLogger, wrapHandler } from '../usage-logger.js';

/**
 * Everything the tools need to do their work: the parsed config, the open
 * vector store, and the embedder (same model the index was built with).
 * Injected so tools are testable without stdio or a real model.
 */
export type ServerDeps = {
  config: RagConfig;
  store: VectorStore;
  embedder: Embedder;
  /** Directory for resolving relative segment roots (= the config file's dir). */
  cwd: string;
};

/**
 * Registers the four RAG tools on the server: search_codebase, get_chunk,
 * index_status (read-only) and reindex (the only writer).
 *
 * When a `logger` is provided each call is timed and appended to the usage
 * log (non-fatal — logging errors never reach the MCP SDK).
 */
export function registerTools(server: McpServer, deps: ServerDeps, logger?: UsageLogger): void {
  const ts = () => new Date().toISOString();
  // A disabled logger is a cheap noop; avoids conditional wrapping everywhere.
  const log = logger ?? new UsageLogger('', false);

  server.registerTool(
    'search_codebase',
    {
      description:
        'Semantic search over the indexed codebase. Returns the most relevant code/doc ' +
        'chunks (file path, line range, text) for a natural-language query.',
      inputSchema: {
        query: z.string().min(1).max(MAX_QUERY_CHARS).describe('Natural-language search query'),
        k: z
          .number().int().positive().max(MAX_K).optional()
          .describe(`Max results (default ${DEFAULT_K})`),
        segment: z.string().optional().describe('Restrict to a named segment (e.g. "web")'),
      },
      outputSchema: searchOutputShape,
    },
    wrapHandler(
      makeSearchCodebase(deps),
      (args, result, latencyMs) => {
        if (result === null) return null; // skip on error
        const hits = result.structuredContent.results;
        return {
          ts: ts(),
          tool: 'search_codebase',
          query: args.query,
          k: args.k ?? DEFAULT_K,
          segment: args.segment ?? null,
          results: hits.length,
          topScore: hits[0]?.score ?? null,
          latencyMs,
          paths: hits.map((r) => r.filePath),
        };
      },
      log,
    ),
  );

  server.registerTool(
    'get_chunk',
    {
      description: 'Return the full text and metadata of a single chunk by its id.',
      inputSchema: {
        id: z.string().min(1).describe('Chunk id from a search_codebase result'),
      },
      outputSchema: getChunkOutputShape,
    },
    wrapHandler(
      makeGetChunk(deps),
      (args, result, latencyMs) => ({
        ts: ts(),
        tool: 'get_chunk',
        id: args.id,
        found: result !== null,
        latencyMs,
      }),
      log,
    ),
  );

  server.registerTool(
    'index_status',
    {
      description:
        'Report index health: chunk/file counts, segments, embedding model, dimensions, last indexed time.',
      inputSchema: {},
      outputSchema: indexStatusOutputShape,
    },
    makeIndexStatus(deps),
  );

  server.registerTool(
    'reindex',
    {
      description:
        'Refresh the index incrementally. Optionally limit to specific paths or a segment.',
      inputSchema: {
        paths: z.array(z.string().min(1)).optional().describe('Specific file paths to reindex'),
        segment: z.string().optional().describe('Restrict to a named segment'),
      },
      outputSchema: reindexOutputShape,
    },
    wrapHandler(
      makeReindex(deps),
      (args, result, latencyMs) => {
        if (result === null) return null;
        return {
          ts: ts(),
          tool: 'reindex',
          added: result.structuredContent.added,
          skipped: result.structuredContent.skipped,
          removed: result.structuredContent.removed,
          latencyMs,
        };
      },
      log,
    ),
  );
}

/** The tool names this server exposes — single source of truth for tests. */
export const TOOL_NAMES = ['search_codebase', 'get_chunk', 'index_status', 'reindex'] as const;
