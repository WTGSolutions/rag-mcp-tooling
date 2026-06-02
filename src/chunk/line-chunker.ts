import { createHash } from 'node:crypto';
import type { RagChunkConfig } from '../config.js';
import type { WalkedFile } from '../walker.js';
import type { Chunk } from './types.js';

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function makeChunk(
  text: string,
  file: WalkedFile,
  fileHash: string,
  startLine: number,
  endLine: number,
): Chunk {
  const id = createHash('sha1')
    .update(`${file.segment}::${file.relativePath}:${startLine}-${endLine}`)
    .digest('hex');

  return {
    id,
    segment: file.segment,
    filePath: file.relativePath,
    startLine,
    endLine,
    language: file.language,
    symbol: undefined,
    kind: 'block',
    text,
    fileHash,
  };
}

export function chunkLines(
  text: string,
  file: WalkedFile,
  config: RagChunkConfig,
  fileHash: string,
): Chunk[] {
  const lines = text.split('\n');

  // Remove the trailing empty string produced by a file ending with \n
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }

  if (lines.length === 0) {
    return [makeChunk('', file, fileHash, 1, 1)];
  }

  const chunks: Chunk[] = [];
  let startIdx = 0;

  while (startIdx < lines.length) {
    let tokens = 0;
    let endIdx = startIdx;

    while (endIdx < lines.length) {
      const lineTokens = estimateTokens((lines[endIdx] ?? '') + '\n');
      // Always include at least one line per chunk even if it exceeds maxTokens
      if (tokens + lineTokens > config.maxTokens && endIdx > startIdx) break;
      tokens += lineTokens;
      endIdx++;
    }

    chunks.push(makeChunk(
      lines.slice(startIdx, endIdx).join('\n'),
      file,
      fileHash,
      startIdx + 1,  // convert to 1-based
      endIdx,        // exclusive 0-based == inclusive 1-based
    ));

    // If we consumed all remaining lines there is nothing left to overlap into
    if (endIdx >= lines.length) break;

    // Advance with overlap: back up overlapLines from end, but always progress
    startIdx = Math.max(startIdx + 1, endIdx - config.overlapLines);
  }

  return chunks;
}
