import type { RagChunkConfig } from '../config.js';
import type { WalkedFile } from '../walker.js';
import { createChunk } from './chunk-factory.js';
import type { Chunk } from './types.js';

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Splits an array of lines into windows by token budget with overlap, returning
 * index ranges [startIdx, endIdx) (endIdx exclusive). The pure windowing core,
 * reused by windowLines (block chunks) and the markdown chunker (TASK-005,
 * splitting long sections while repeating the heading).
 */
export function windowLineRanges(
  lines: string[],
  maxTokens: number,
  overlapLines: number,
): Array<{ startIdx: number; endIdx: number }> {
  const ranges: Array<{ startIdx: number; endIdx: number }> = [];
  let startIdx = 0;

  while (startIdx < lines.length) {
    let tokens = 0;
    let endIdx = startIdx;

    while (endIdx < lines.length) {
      const lineTokens = estimateTokens(`${lines[endIdx] ?? ''}\n`);
      // Always include at least one line per window even if it exceeds maxTokens
      if (tokens + lineTokens > maxTokens && endIdx > startIdx) break;
      tokens += lineTokens;
      endIdx++;
    }

    ranges.push({ startIdx, endIdx });

    // If we consumed all remaining lines there is nothing left to overlap into
    if (endIdx >= lines.length) break;

    // Advance with overlap: back up overlapLines from end, but always progress
    startIdx = Math.max(startIdx + 1, endIdx - overlapLines);
  }

  return ranges;
}

/**
 * Windows an array of lines into block chunks by maxTokens with overlap.
 * Reused by the AST chunker (TASK-004) to chunk module-level "loose" code
 * spans, which is why it takes an explicit baseLine offset (the 1-based line
 * number of lines[0] in the original file) instead of assuming line 1.
 */
export function windowLines(
  lines: string[],
  baseLine: number,
  file: WalkedFile,
  config: RagChunkConfig,
  fileHash: string,
): Chunk[] {
  if (lines.length === 0) {
    return [
      createChunk({
        file,
        fileHash,
        startLine: baseLine,
        endLine: baseLine,
        text: '',
        kind: 'block',
      }),
    ];
  }

  return windowLineRanges(lines, config.maxTokens, config.overlapLines).map(
    ({ startIdx, endIdx }) =>
      createChunk({
        file,
        fileHash,
        startLine: baseLine + startIdx, // 1-based, offset by base
        endLine: baseLine + endIdx - 1, // inclusive
        text: lines.slice(startIdx, endIdx).join('\n'),
        kind: 'block',
      }),
  );
}

export function chunkLines(
  text: string,
  file: WalkedFile,
  config: RagChunkConfig,
  fileHash: string,
): Chunk[] {
  const lines = text.split('\n');

  // Strip all trailing empty strings produced by files ending with \n, \n\n, etc.
  while (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }

  return windowLines(lines, 1, file, config, fileHash);
}

/**
 * Trims leading/trailing blank lines from a span, then windows the remainder
 * into block chunks. Shared by the AST chunker (module-level gaps) and the
 * markdown chunker (preamble before the first heading). `baseLine` is the
 * 1-based line number of lines[0] in the original file. Returns [] if the span
 * is entirely blank.
 */
export function windowTrimmedSpan(
  lines: string[],
  baseLine: number,
  file: WalkedFile,
  config: RagChunkConfig,
  fileHash: string,
): Chunk[] {
  let start = 0;
  let end = lines.length - 1;
  while (start <= end && (lines[start] ?? '').trim() === '') start++;
  while (end >= start && (lines[end] ?? '').trim() === '') end--;
  if (start > end) return [];

  return windowLines(
    lines.slice(start, end + 1),
    baseLine + start,
    file,
    config,
    fileHash,
  );
}
