import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RagConfig } from '../../config.js';
import type { Embedder } from '../../embedder/types.js';
import type { VectorStore } from '../../store/vector-store.js';

/**
 * Everything the tools need to do their work: the parsed config, the open
 * vector store, and the embedder (same model the index was built with).
 * Injected so tools are testable without stdio or a real model.
 */
export type ServerDeps = {
  config: RagConfig;
  store: VectorStore;
  embedder: Embedder;
};

// Placeholder until the real handlers land. Returns a clear, non-crashing
// "not implemented" so `tools/list` works and a premature call is graceful.
function stub(tool: string, task: string) {
  return async () => ({
    content: [{ type: 'text' as const, text: `[rag-mcp] ${tool} is not implemented yet (${task}).` }],
    isError: true,
  });
}

/**
 * Registers the four RAG tools on the server. TASK-010 wires the schemas with
 * stub handlers; the real handlers replace the stubs in TASK-011 (search),
 * TASK-012 (get_chunk + index_status) and TASK-013 (reindex).
 */
export function registerTools(server: McpServer, _deps: ServerDeps): void {
  server.registerTool(
    'search_codebase',
    {
      description:
        'Semantic search over the indexed codebase. Returns the most relevant code/doc ' +
        'chunks (file path, line range, text) for a natural-language query.',
      inputSchema: {
        query: z.string().min(1).describe('Natural-language search query'),
        k: z.number().int().positive().max(100).optional().describe('Max results (default 8)'),
        segment: z.string().optional().describe('Restrict to a named segment (e.g. "web")'),
      },
    },
    stub('search_codebase', 'TASK-011'),
  );

  server.registerTool(
    'get_chunk',
    {
      description: 'Return the full text and metadata of a single chunk by its id.',
      inputSchema: {
        id: z.string().min(1).describe('Chunk id from a search_codebase result'),
      },
    },
    stub('get_chunk', 'TASK-012'),
  );

  server.registerTool(
    'index_status',
    {
      description:
        'Report index health: chunk/file counts, segments, embedding model, dimensions, last indexed time.',
      inputSchema: {},
    },
    stub('index_status', 'TASK-012'),
  );

  server.registerTool(
    'reindex',
    {
      description:
        'Refresh the index incrementally. Optionally limit to specific paths or a segment.',
      inputSchema: {
        paths: z.array(z.string()).optional().describe('Specific file paths to reindex'),
        segment: z.string().optional().describe('Restrict to a named segment'),
      },
    },
    stub('reindex', 'TASK-013'),
  );
}

/** The tool names this server exposes — single source of truth for tests. */
export const TOOL_NAMES = ['search_codebase', 'get_chunk', 'index_status', 'reindex'] as const;
