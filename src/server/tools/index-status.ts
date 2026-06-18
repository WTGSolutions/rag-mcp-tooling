import { z } from 'zod';
import type { SegmentStat, StoreStats } from '../../store/vector-store.js';
import type { ServerDeps } from './index.js';

export const indexStatusOutputShape = {
  chunks: z.number().int(),
  files: z.number().int(),
  modelId: z.string(),
  dimensions: z.number().int(),
  lastIndexed: z.string().nullable(),
  segments: z.array(
    z.object({
      segment: z.string(),
      chunks: z.number().int(),
      files: z.number().int(),
    }),
  ),
};

export function formatStatus(
  stats: StoreStats,
  segments: SegmentStat[],
): string {
  const lines = [
    `Index: ${stats.chunks} chunks across ${stats.files} files`,
    `Model: ${stats.modelId} (${stats.dimensions}d)`,
    `Last indexed: ${stats.lastIndexed ?? 'never'}`,
    '',
    'Segments:',
  ];
  if (segments.length === 0) {
    lines.push('  (none)');
  } else {
    for (const s of segments) {
      lines.push(`  ${s.segment}: ${s.chunks} chunks, ${s.files} files`);
    }
  }
  return lines.join('\n');
}

/**
 * Builds the index_status handler: reports index health (counts per segment,
 * model, dimensions, last-indexed time) so the agent can tell whether the index
 * is built and current. Read-only.
 */
export function makeIndexStatus(deps: ServerDeps) {
  return async () => {
    const stats = deps.store.stats();
    const segments = deps.store.segmentStats();

    return {
      content: [{ type: 'text' as const, text: formatStatus(stats, segments) }],
      structuredContent: {
        chunks: stats.chunks,
        files: stats.files,
        modelId: stats.modelId,
        dimensions: stats.dimensions,
        lastIndexed: stats.lastIndexed,
        segments,
      },
    };
  };
}
