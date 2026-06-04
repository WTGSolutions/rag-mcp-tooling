import { z } from 'zod';
import { reindexWithStore, type ReindexResult } from '../../indexer/reindex.js';
import type { ServerDeps } from './index.js';

export type ReindexArgs = {
  paths?: string[] | undefined;
  segment?: string | undefined;
};

export const reindexOutputShape = {
  added: z.number().int(),
  skipped: z.number().int(),
  removed: z.number().int(),
  totalChunks: z.number().int(),
  durationMs: z.number().int(),
};

export function formatReindex(result: ReindexResult, durationMs: number): string {
  return (
    `Reindex done in ${durationMs}ms:\n` +
    `  added=${result.added}  skipped=${result.skipped}  removed=${result.removed}\n` +
    `  total chunks: ${result.totalChunks}`
  );
}

/**
 * Builds the reindex handler. The ONLY tool with side effects (writes the
 * store). An in-process mutex rejects concurrent reindex calls so two runs
 * can't interleave their delete/upsert operations on the same database; the
 * synchronous check-and-set is race-free under Node's single-threaded model.
 *
 * Reindex runs through the server's open store (reindexWithStore), so
 * search_codebase — sharing that same handle — sees the updates immediately.
 */
export function makeReindex(deps: ServerDeps) {
  let running = false;

  return async (args: ReindexArgs) => {
    if (running) {
      throw new Error('[rag-mcp] reindex: a reindex is already in progress — try again when it finishes');
    }
    running = true;
    try {
      const t0 = Date.now();
      const result = await reindexWithStore(deps.store, {
        config: deps.config,
        embedder: deps.embedder,
        mode: 'incremental',
        cwd: deps.cwd,
        ...(args.segment !== undefined ? { segment: args.segment } : {}),
        ...(args.paths !== undefined ? { paths: args.paths } : {}),
      });
      const durationMs = Date.now() - t0;

      return {
        content: [{ type: 'text' as const, text: formatReindex(result, durationMs) }],
        structuredContent: { ...result, durationMs },
      };
    } finally {
      running = false;
    }
  };
}
