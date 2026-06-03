import { readFile } from 'node:fs/promises';
import { sha1 } from '../hash.js';
import type { RagChunkConfig } from '../config.js';
import type { WalkedFile } from '../walker.js';
import { chunkAst } from './ast-chunker.js';
import { chunkLines } from './line-chunker.js';
import { chunkMarkdown } from './markdown-chunker.js';
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
      return chunkAst(text, file, config, fileHash);
    case 'markdown':
      return chunkMarkdown(text, file, config, fileHash);
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
  const fileHash = sha1(text);
  return dispatchChunker(text, file, config, fileHash);
}
