import { readFile } from 'node:fs/promises';
import { sha1 } from '../hash.js';
import type { RagChunkConfig } from '../config.js';
import type { WalkedFile } from '../walker.js';
import { TREE_SITTER_LANGS } from '../lang/registry.js';
import { chunkLines } from './line-chunker.js';
import { chunkMarkdown } from './markdown-chunker.js';
import { chunkTreeSitter } from './tree-sitter.js';
import type { Chunk } from './types.js';

/**
 * Synchronous chunkers only: Markdown and the line-chunker default. All semantic
 * code chunking (TS/JS and Python) is async via tree-sitter — callers that may
 * encounter code files MUST use dispatchChunkerAsync; using this directly
 * silently line-chunks them.
 */
export function dispatchChunker(
  text: string,
  file: WalkedFile,
  config: RagChunkConfig,
  fileHash: string,
): Chunk[] {
  switch (file.language) {
    case 'markdown':
      return chunkMarkdown(text, file, config, fileHash);
    default:
      return chunkLines(text, file, config, fileHash);
  }
}

/**
 * Full chunk routing. TS/JS and the registry-driven tree-sitter languages (Python,
 * …) go to their async WASM chunkers; everything else delegates to the synchronous
 * dispatchChunker. The indexer and chunkFile route through here so code files are
 * parsed into semantic chunks.
 */
export async function dispatchChunkerAsync(
  text: string,
  file: WalkedFile,
  config: RagChunkConfig,
  fileHash: string,
): Promise<Chunk[]> {
  // Phase-5 A/B eval baseline (TASK-023): RAG_FORCE_LINE_CHUNKER=1 forces every
  // file through the line chunker — the "before AST-awareness" index — so the
  // same harness can measure line-chunker vs tree-sitter. Unset in production.
  if (process.env['RAG_FORCE_LINE_CHUNKER'] === '1') {
    return chunkLines(text, file, config, fileHash);
  }
  if (file.language in TREE_SITTER_LANGS) {
    return chunkTreeSitter(text, file, config, fileHash);
  }
  return dispatchChunker(text, file, config, fileHash);
}

export async function chunkFile(file: WalkedFile, config: RagChunkConfig): Promise<Chunk[]> {
  let text: string;
  try {
    text = await readFile(file.absolutePath, 'utf-8');
  } catch (e) {
    throw new Error(`Failed to read file for chunking: ${file.absolutePath}`, { cause: e });
  }
  return dispatchChunkerAsync(text, file, config, sha1(text));
}
