// Public API of @wtgsolutions/rag-mcp.
// Consumers (the rag-index CLI, and the Phase 2 MCP server) import from here.
// Internal helpers (chunk windowing, the chunk factory, pipeline plumbing) are
// intentionally NOT re-exported.

// ── Config ──────────────────────────────────────────────────────────────────
export { loadConfig, ConfigError } from './config.js';
export type {
  RagConfig,
  RagSegment,
  RagEmbedderConfig,
  RagChunkConfig,
  RagStoreConfig,
} from './config.js';

// ── Walker ──────────────────────────────────────────────────────────────────
export { walkSegments, detectLanguage } from './walker.js';
export type { WalkedFile, FileLanguage } from './walker.js';

// ── Chunking ────────────────────────────────────────────────────────────────
export { dispatchChunker, dispatchChunkerAsync, chunkFile } from './chunk/router.js';
export type { Chunk, ChunkKind } from './chunk/types.js';

// ── Embedder ────────────────────────────────────────────────────────────────
export { createEmbedder, LocalEmbedder } from './embedder/local-embedder.js';
export type { Embedder, Pooling } from './embedder/types.js';

// ── Vector store ──────────────────────────────────────────────────────────────
export { VectorStore } from './store/vector-store.js';
export type { SearchResult, StoreStats } from './store/vector-store.js';

// ── Indexer ─────────────────────────────────────────────────────────────────
export { reindex } from './indexer/reindex.js';
export type { ReindexOptions, ReindexResult, ReindexMode } from './indexer/reindex.js';

// ── Utilities ─────────────────────────────────────────────────────────────────
export { sha1 } from './hash.js';
