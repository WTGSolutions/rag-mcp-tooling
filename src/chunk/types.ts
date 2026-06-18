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
};
