import { describe, it, expect } from 'vitest';
import * as api from './index.js';

// Guards the public API surface: the package.json "main" entry must resolve and
// expose the symbols that the CLI and the Phase 2 MCP server depend on.
describe('public API (index.ts barrel)', () => {
  it('exports the config loader and error', () => {
    expect(typeof api.loadConfig).toBe('function');
    expect(typeof api.ConfigError).toBe('function');
  });

  it('exports the walker', () => {
    expect(typeof api.walkSegments).toBe('function');
    expect(typeof api.detectLanguage).toBe('function');
  });

  it('exports the chunking entry points', () => {
    expect(typeof api.dispatchChunker).toBe('function');
    expect(typeof api.chunkFile).toBe('function');
  });

  it('exports the embedder factory and class', () => {
    expect(typeof api.createEmbedder).toBe('function');
    expect(typeof api.LocalEmbedder).toBe('function');
  });

  it('exports the vector store', () => {
    expect(typeof api.VectorStore).toBe('function');
  });

  it('exports the indexer', () => {
    expect(typeof api.reindex).toBe('function');
  });

  it('exports the sha1 utility', () => {
    expect(typeof api.sha1).toBe('function');
    expect(api.sha1('')).toBe('da39a3ee5e6b4b0d3255bfef95601890afd80709');
  });

  it('does not leak internal chunk helpers', () => {
    // windowLineRanges / makeChunkId / createChunk are implementation details
    expect('windowLineRanges' in api).toBe(false);
    expect('makeChunkId' in api).toBe(false);
    expect('createChunk' in api).toBe(false);
  });
});
