import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, relative, sep } from 'node:path';
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
  /**
   * Restrict to specific files (absolute or cwd-relative). Within the filter,
   * unchanged files are still skipped by hash; a listed path that no longer
   * exists on disk has its chunks removed.
   */
  paths?: string[];
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
  /**
   * In `paths` mode, requested paths that matched no indexed file (outside any
   * segment, excluded by include globs, or a typo). Empty otherwise. Lets the
   * caller distinguish "nothing changed" from "your path was bogus".
   */
  unmatchedPaths: string[];
};

// macOS/Windows filesystems are case-insensitive: compare requested paths to
// walked paths case-insensitively there so a mis-cased path still matches.
const CASE_INSENSITIVE_FS = process.platform === 'darwin' || process.platform === 'win32';
function normPath(p: string): string {
  return CASE_INSENSITIVE_FS ? p.toLowerCase() : p;
}

/**
 * Opens the store, runs reindexWithStore, and closes it. The one-shot entry
 * for the CLI. Long-running callers (the MCP server) that hold the store open
 * should call reindexWithStore directly so reindex and search share one handle.
 */
export async function reindex(options: ReindexOptions): Promise<ReindexResult> {
  const store = VectorStore.open(
    options.config.store.path,
    options.embedder.dimensions,
    options.embedder.modelId,
  );
  try {
    return await reindexWithStore(store, options);
  } finally {
    store.close();
  }
}

/**
 * Reindex against an already-open store — the orchestration core, decoupled
 * from the store's lifecycle (so the MCP server can reindex through the same
 * handle search_codebase reads from, seeing updates immediately).
 */
export async function reindexWithStore(
  store: VectorStore,
  options: ReindexOptions,
): Promise<ReindexResult> {
  const { config, embedder, mode = 'incremental', segment: segmentFilter, paths, cwd, _readFile } = options;
  const readFileFn = _readFile ?? ((p: string) => readFile(p, 'utf-8'));

  const segments = segmentFilter
    ? config.segments.filter((s) => s.name === segmentFilter)
    : config.segments;

  if (segments.length === 0 && segmentFilter) {
    throw new Error(`[rag-mcp] No segment named "${segmentFilter}" in config`);
  }

  // Map normalized-absolute → original requested path, so matching is
  // case-insensitive where the FS is, while unmatched reporting keeps the
  // path exactly as the caller wrote it.
  const pathMap = paths
    ? new Map(paths.map((p) => {
        const abs = resolve(cwd ?? process.cwd(), p);
        return [normPath(abs), abs] as const;
      }))
    : undefined;
  const matched = new Set<string>(); // original requested paths that were handled

  let added = 0;
  let skipped = 0;
  let removed = 0;

  for (const seg of segments) {
    const result = await reindexSegment(store, config, embedder, mode, seg, cwd, readFileFn, pathMap, matched);
    added += result.added;
    skipped += result.skipped;
    removed += result.removed;
  }

  const unmatchedPaths = pathMap
    ? [...pathMap.values()].filter((abs) => !matched.has(abs))
    : [];

  return { added, skipped, removed, totalChunks: store.stats().chunks, unmatchedPaths };
}

function isUnder(root: string, absPath: string): boolean {
  return absPath === root || absPath.startsWith(root + sep);
}

/** Full-walk stale cleanup: store files not seen in the walk are deleted. */
function removeStaleAfterWalk(
  store: VectorStore,
  segment: RagSegment,
  knownHashes: Map<string, string>,
  seenPaths: Set<string>,
): string[] {
  const removed = [...knownHashes.keys()].filter((p) => !seenPaths.has(p));
  for (const filePath of removed) store.deleteFileFromSegment(filePath, segment.name);
  return removed;
}

/**
 * paths-mode stale cleanup: only a requested path under this segment that no
 * longer exists on disk is removed — files outside the requested set are never
 * touched.
 */
function removeStaleInPaths(
  store: VectorStore,
  segment: RagSegment,
  cwd: string | undefined,
  knownHashes: Map<string, string>,
  seenPaths: Set<string>,
  pathMap: Map<string, string>,
  matched: Set<string>,
): string[] {
  const removed: string[] = [];
  const segmentRoot = resolve(cwd ?? process.cwd(), segment.root);
  for (const absPath of pathMap.values()) {
    if (!isUnder(segmentRoot, absPath)) continue;
    const rel = relative(segmentRoot, absPath);
    if (knownHashes.has(rel) && !seenPaths.has(rel) && !existsSync(absPath)) {
      store.deleteFileFromSegment(rel, segment.name);
      removed.push(rel);
      matched.add(absPath); // a deleted requested path counts as handled
    }
  }
  return removed;
}

async function reindexSegment(
  store: VectorStore,
  config: RagConfig,
  embedder: Embedder,
  mode: ReindexMode,
  segment: RagSegment,
  cwd: string | undefined,
  readFileFn: (path: string) => Promise<string>,
  pathMap: Map<string, string> | undefined,
  matched: Set<string>,
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
    // paths mode: only process the requested files (still respects include/.gitignore).
    if (pathMap) {
      const requested = pathMap.get(normPath(file.absolutePath));
      if (requested === undefined) continue;
      matched.add(requested);
    }
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

    // Embed FIRST so the file's old chunks stay visible during the (async)
    // embed; then delete + upsert run back-to-back synchronously. better-sqlite3
    // operations can't interleave without an await, so a concurrent
    // search_codebase sharing this store sees either the complete old version
    // or the complete new one — never the file momentarily absent. A failure
    // during embed leaves the old chunks intact (nothing was deleted yet).
    const chunks = dispatchChunker(text, file, config.chunk, currentHash);
    if (chunks.length > 0) {
      const vectors = await embedder.embed(chunks.map((c) => c.text));
      store.deleteFileFromSegment(file.relativePath, segment.name);
      store.upsert(chunks, vectors);
    } else {
      // Empty file: remove any old chunks, nothing to add. (No hash recorded, so
      // it is re-processed on each run — acceptable for empty files.)
      store.deleteFileFromSegment(file.relativePath, segment.name);
    }
    added++;
  }

  const removed = pathMap
    ? removeStaleInPaths(store, segment, cwd, knownHashes, seenPaths, pathMap, matched)
    : removeStaleAfterWalk(store, segment, knownHashes, seenPaths);

  return { added, skipped, removed: removed.length };
}
