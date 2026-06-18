import type { FileLanguage } from '../walker.js';

export type ChunkKind =
  | 'function'
  | 'class'
  | 'method'
  | 'interface'
  | 'type'
  | 'section'
  | 'block';

export type Chunk = {
  id: string;
  segment: string;
  filePath: string; // relative to segment root
  startLine: number; // 1-based, inclusive
  endLine: number; // 1-based, inclusive
  language: FileLanguage;
  symbol: string | undefined;
  kind: ChunkKind;
  text: string;
  fileHash: string;
  // ── Structural metadata (TASK-045) ─────────────────────────────────────────
  // Optional, populated only by language walks that extract it (TS/Python today);
  // absent for line/markdown/other-language chunks. Stored as sidecar columns —
  // NOT part of the embedded text, so adding them never re-embeds existing vectors.
  /** File-level import targets (module specifiers), e.g. ['node:path', './config.js']. */
  imports?: string[];
  /** Symbols referenced (called) inside this chunk's body — the basis for callers. */
  callees?: string[];
};
