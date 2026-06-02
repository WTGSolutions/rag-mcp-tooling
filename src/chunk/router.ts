import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { RagChunkConfig } from '../config.js';
import type { WalkedFile } from '../walker.js';
import { chunkLines } from './line-chunker.js';
import type { Chunk } from './types.js';

export function dispatchChunker(
  text: string,
  file: WalkedFile,
  config: RagChunkConfig,
  fileHash: string,
): Chunk[] {
  switch (file.language) {
    case 'typescript':
    case 'javascript':
      return chunkLines(text, file, config, fileHash); // replaced by AST chunker in TASK-004
    case 'markdown':
      return chunkLines(text, file, config, fileHash); // replaced by MD chunker in TASK-005
    default:
      return chunkLines(text, file, config, fileHash);
  }
}

export async function chunkFile(file: WalkedFile, config: RagChunkConfig): Promise<Chunk[]> {
  let text: string;
  try {
    text = await readFile(file.absolutePath, 'utf-8');
  } catch (e) {
    throw new Error(`Failed to read file for chunking: ${file.absolutePath}`, { cause: e });
  }
  const fileHash = createHash('sha1').update(text).digest('hex');
  return dispatchChunker(text, file, config, fileHash);
}
