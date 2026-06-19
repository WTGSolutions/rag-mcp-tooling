import { sha1 } from '../hash.js';
import type { WalkedFile } from '../walker.js';
import type { Chunk, ChunkKind } from './types.js';

// Deterministic id so reindex (TASK-008) overwrites the same record and
// get_chunk (TASK-012) can resolve references stably. ALL chunkers (line,
// AST, markdown) MUST build chunks through createChunk to keep the id scheme
// identical — divergence here silently corrupts incremental reindex.
export function makeChunkId(
  segment: string,
  filePath: string,
  startLine: number,
  endLine: number,
): string {
  return sha1(`${segment}::${filePath}:${startLine}-${endLine}`);
}

export type CreateChunkParams = {
  file: WalkedFile;
  fileHash: string;
  startLine: number;
  endLine: number;
  text: string;
  kind: ChunkKind;
  symbol?: string | undefined;
  // Optional structural metadata (TASK-045). Omitted from the chunk when empty so
  // line/markdown chunks stay byte-identical to before (backward compatibility).
  imports?: readonly string[] | undefined;
  callees?: readonly string[] | undefined;
};

export function createChunk(params: CreateChunkParams): Chunk {
  const { file, fileHash, startLine, endLine, text, kind, symbol } = params;
  return {
    id: makeChunkId(file.segment, file.relativePath, startLine, endLine),
    segment: file.segment,
    filePath: file.relativePath,
    startLine,
    endLine,
    language: file.language,
    symbol,
    kind,
    text,
    fileHash,
    ...(params.imports?.length ? { imports: [...params.imports] } : {}),
    ...(params.callees?.length ? { callees: [...params.callees] } : {}),
  };
}
