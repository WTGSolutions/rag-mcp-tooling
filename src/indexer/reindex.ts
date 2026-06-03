import { readFile } from 'node:fs/promises';
import type { RagConfig, RagSegment } from '../config.js';
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
  /**
   * Injectable file reader — override in tests to simulate read errors without
   * touching the filesystem. Production code always uses node:fs/promises readFile.
   */
  _readFile?: (absolutePath: string) => Promise<string>;
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
 * cleaned from the store (both modes).
 *
 * Note: `deleteFileFromSegment` and the subsequent `upsert` are not wrapped in
 * a single transaction because the `embed()` call is async. A crash between
 * them leaves the file chunk-less until the next run re-processes it.
 */
export async function reindex(options: ReindexOptions): Promise<ReindexResult> {
  const { config, embedder, mode = 'incremental', segment, cwd, _readFile } = options;
  const readFileFn = _readFile ?? ((p: string) => readFile(p, 'utf-8'));

  const store = VectorStore.open(config.store.path, embedder.dimensions, embedder.modelId);
  try {
    return await runReindex(store, config, embedder, mode, segment, cwd, readFileFn);
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
  readFileFn: (path: string) => Promise<string>,
): Promise<ReindexResult> {
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
    const result = await reindexSegment(store, config, embedder, mode, seg, cwd, readFileFn);
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
  segment: RagSegment,
  cwd: string | undefined,
  readFileFn: (path: string) => Promise<string>,
): Promise<{ added: number; skipped: number; removed: number }> {
  // Always fetch known hashes — needed for stale-entry cleanup in both modes.
  // In incremental mode they are also used to skip unchanged files.
  const knownHashes = store.getFileHashes(segment.name);

  const seenPaths = new Set<string>();
  let added = 0;
  let skipped = 0;

  // Walk only the target segment by passing a single-segment config.
  // The segment object itself is passed by reference (not cloned) but walkSegments
  // only reads its fields, so no mutation risk.
  const segConfig = { ...config, segments: [segment] };

  for await (const file of walkSegments(segConfig, cwd)) {
    seenPaths.add(file.relativePath);

    // Read file content once — used for both hash comparison and chunking.
    let text: string;
    try {
      text = await readFileFn(file.absolutePath);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        // File vanished between walk and read — leave it out of seenPaths so
        // the post-walk cleanup below removes it from the store.
        continue;
      }
      // Transient error (EACCES, EMFILE, …): mark as seen to prevent a
      // spurious deletion of chunks that are still valid.
      continue; // seenPaths already has file.relativePath from the add above
    }

    const currentHash = sha1(text);

    if (mode === 'incremental' && knownHashes.get(file.relativePath) === currentHash) {
      skipped++;
      continue;
    }

    // File is new or changed — replace stored chunks for this file.
    store.deleteFileFromSegment(file.relativePath, segment.name);

    const chunks = dispatchChunker(text, file, config.chunk, currentHash);
    if (chunks.length > 0) {
      const vectors = await embedder.embed(chunks.map((c) => c.text));
      store.upsert(chunks, vectors);
    }
    // Files that produce 0 chunks (e.g., empty files) are deleted from the store
    // but have no hash recorded. They will be re-processed on every subsequent run
    // (no stored hash to match). This is acceptable for empty files.
    added++;
  }

  // Remove stale entries: files known to the store but absent from the walk.
  // This runs in BOTH modes so that full-mode runs also clean up deleted files.
  const removed = [...knownHashes.keys()].filter((p) => !seenPaths.has(p));
  for (const filePath of removed) {
    store.deleteFileFromSegment(filePath, segment.name);
  }

  return { added, skipped, removed: removed.length };
}
