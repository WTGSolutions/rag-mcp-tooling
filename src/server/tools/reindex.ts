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
  unmatchedPaths: z.array(z.string()),
};

export function formatReindex(result: ReindexResult, durationMs: number): string {
  const lines = [
    `Reindex done in ${durationMs}ms:`,
    `  added=${result.added}  skipped=${result.skipped}  removed=${result.removed}`,
    `  total chunks: ${result.totalChunks}`,
  ];
  if (result.unmatchedPaths.length > 0) {
    lines.push(`  WARNING — ${result.unmatchedPaths.length} requested path(s) matched no indexed file:`);
    for (const p of result.unmatchedPaths) lines.push(`    ${p}`);
  }
  return lines.join('\n');
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
      let result: ReindexResult;
      try {
        result = await reindexWithStore(deps.store, {
          config: deps.config,
          embedder: deps.embedder,
          mode: 'incremental',
          cwd: deps.cwd,
          ...(args.segment !== undefined ? { segment: args.segment } : {}),
          ...(args.paths !== undefined ? { paths: args.paths } : {}),
        });
      } catch (e) {
        // Brand non-[rag-mcp] errors (e.g. a raw transformers.js model error)
        // so the agent gets an attributable message.
        const message = (e as Error).message ?? String(e);
        throw new Error(message.startsWith('[rag-mcp]') ? message : `[rag-mcp] reindex: ${message}`);
      }
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
