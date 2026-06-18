// Generic tree-sitter chunker. Fully registry-driven: the language entry supplies
// the walk, comment prefixes, and grammar; this file (and the core) stay untouched
// when a language is added. Falls back to the line chunker for non-tree-sitter
// languages or a missing grammar.

import type { RagChunkConfig } from '../config.js';
import { ensureGrammar } from '../lang/ensure-grammars.js';
import {
  TREE_SITTER_LANGS,
  type TreeSitterLanguage,
} from '../lang/registry.js';
import type { WalkedFile } from '../walker.js';
import { chunkLines } from './line-chunker.js';
import { runTreeSitterChunk } from './tree-sitter-core.js';
import type { Chunk } from './types.js';

function isTreeSitterLanguage(lang: string): lang is TreeSitterLanguage {
  return lang in TREE_SITTER_LANGS;
}

// Memoise grammar id → cached wasm path so we resolve/stat each grammar once.
const wasmCache = new Map<string, string | null>();
function resolveWasm(grammarId: string): string | null {
  const cached = wasmCache.get(grammarId);
  if (cached !== undefined) return cached;
  const path = ensureGrammar(grammarId);
  wasmCache.set(grammarId, path);
  return path;
}

export function chunkTreeSitter(
  text: string,
  file: WalkedFile,
  config: RagChunkConfig,
  fileHash: string,
): Promise<Chunk[]> {
  const lang = file.language;
  if (!isTreeSitterLanguage(lang))
    return Promise.resolve(chunkLines(text, file, config, fileHash));

  const entry = TREE_SITTER_LANGS[lang];
  return runTreeSitterChunk({
    text,
    file,
    config,
    fileHash,
    wasmPath: resolveWasm(entry.grammarFor(file)),
    commentPrefixes: entry.commentPrefixes,
    walk: entry.walk,
  });
}
