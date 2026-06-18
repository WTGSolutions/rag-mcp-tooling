// Public API of @wtgsolutions/rag-mcp.
// Consumers (the rag-index CLI, and the Phase 2 MCP server) import from here.
// Internal helpers (chunk windowing, the chunk factory, pipeline plumbing) are
// intentionally NOT re-exported.

// ── Chunking ────────────────────────────────────────────────────────────────
export {
  chunkFile,
  dispatchChunker,
  dispatchChunkerAsync,
} from './chunk/router.js';
export type { Chunk, ChunkKind } from './chunk/types.js';
export type {
  RagChunkConfig,
  RagConfig,
  RagEmbedderConfig,
  RagSegment,
  RagStoreConfig,
} from './config.js';
// ── Config ──────────────────────────────────────────────────────────────────
export { ConfigError, loadConfig } from './config.js';
// ── Embedder ────────────────────────────────────────────────────────────────
export { createEmbedder, LocalEmbedder } from './embedder/local-embedder.js';
export type { Embedder, Pooling } from './embedder/types.js';
// ── Utilities ─────────────────────────────────────────────────────────────────
export { sha1 } from './hash.js';
export type {
  ReindexMode,
  ReindexOptions,
  ReindexResult,
} from './indexer/reindex.js';
// ── Indexer ─────────────────────────────────────────────────────────────────
export { reindex } from './indexer/reindex.js';
export type { SearchResult, StoreStats } from './store/vector-store.js';
// ── Vector store ──────────────────────────────────────────────────────────────
export { VectorStore } from './store/vector-store.js';
export type { FileLanguage, WalkedFile } from './walker.js';
// ── Walker ──────────────────────────────────────────────────────────────────
export { detectLanguage, walkSegments } from './walker.js';
