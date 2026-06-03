import { readFile } from 'node:fs/promises';
import type { RagConfig } from '../config.js';
import type { Embedder } from '../embedder/types.js';
import { sha1 } from '../hash.js';
import { walkSegments } from '../walker.js';
import { dispatchChunker } from '../chunk/router.js';
import { VectorStore } from '../store/vector-store.js';

export type ReindexMode = 'incremental' | 'full';

export type ReindexOptions = {
  config: RagConfig;
  embedder: Embedder;
  /** Default: 'incremental'. 'full' ignores stored hashes and re-indexes everything. */
  mode?: ReindexMode;
  /** Process only this named segment. Undefined = all segments in config. */
  segment?: string;
  /** Working directory for resolving segment roots. Default: process.cwd() */
  cwd?: string;
};

export type ReindexResult = {
  /** Files newly indexed or whose hash changed. */
  added: number;
  /** Files skipped because their hash matched (incremental mode only). */
  skipped: number;
  /** Stored files no longer found on disk — their chunks were removed. */
  removed: number;
  /** Total chunks in the store after the run. */
  totalChunks: number;
};

/**
 * Indexes or incrementally updates the vector store for all (or one) segment.
 *
 * Opens the store, walks files, computes sha1 of each file's content and
 * compares to the stored hash. Unchanged files are skipped (incremental mode).
 * Changed files are deleted then re-indexed. Files no longer on disk are
 * cleaned from the store.
 */
export async function reindex(options: ReindexOptions): Promise<ReindexResult> {
  const { config, embedder, mode = 'incremental', segment, cwd } = options;

  const store = VectorStore.open(config.store.path, embedder.dimensions, embedder.modelId);
  try {
    return await runReindex(store, config, embedder, mode, segment, cwd);
  } finally {
    store.close();
  }
}

async function runReindex(
  store: VectorStore,
  config: RagConfig,
  embedder: Embedder,
  mode: ReindexMode,
  segmentFilter: string | undefined,
  cwd: string | undefined,
): Promise<ReindexResult> {
  // Filter to the requested segments
  const segments = segmentFilter
    ? config.segments.filter((s) => s.name === segmentFilter)
    : config.segments;

  if (segments.length === 0 && segmentFilter) {
    throw new Error(`[rag-mcp] No segment named "${segmentFilter}" in config`);
  }

  let added = 0;
  let skipped = 0;
  let removed = 0;

  for (const seg of segments) {
    const result = await reindexSegment(store, config, embedder, mode, seg.name, cwd);
    added += result.added;
    skipped += result.skipped;
    removed += result.removed;
  }

  return { added, skipped, removed, totalChunks: store.stats().chunks };
}

async function reindexSegment(
  store: VectorStore,
  config: RagConfig,
  embedder: Embedder,
  mode: ReindexMode,
  segmentName: string,
  cwd: string | undefined,
): Promise<{ added: number; skipped: number; removed: number }> {
  // Known file paths + hashes for this segment (empty map for 'full' mode)
  const knownHashes: Map<string, string> =
    mode === 'incremental' ? store.getFileHashes(segmentName) : new Map();

  const seenPaths = new Set<string>();
  let added = 0;
  let skipped = 0;

  // Walk only the target segment by passing a filtered config
  const segConfig = { ...config, segments: config.segments.filter((s) => s.name === segmentName) };

  for await (const file of walkSegments(segConfig, cwd)) {
    seenPaths.add(file.relativePath);

    // Read file content once — used for both hash comparison and chunking
    let text: string;
    try {
      text = await readFile(file.absolutePath, 'utf-8');
    } catch (e) {
      // File disappeared between walk and read (race condition) — skip
      continue;
    }

    const currentHash = sha1(text);

    if (mode === 'incremental' && knownHashes.get(file.relativePath) === currentHash) {
      skipped++;
      continue;
    }

    // File is new or changed — replace stored chunks for this file
    store.deleteFileFromSegment(file.relativePath, segmentName);

    const chunks = dispatchChunker(text, file, config.chunk, currentHash);
    if (chunks.length > 0) {
      const vectors = await embedder.embed(chunks.map((c) => c.text));
      store.upsert(chunks, vectors);
    }
    added++;
  }

  // Detect deleted files: known to the store but not seen in the current walk
  const removed = [...knownHashes.keys()].filter((p) => !seenPaths.has(p));
  for (const filePath of removed) {
    store.deleteFileFromSegment(filePath, segmentName);
  }

  return { added, skipped, removed: removed.length };
}
