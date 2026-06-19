// YAML chunker: splits a file into top-level key blocks — the natural semantic
// unit of a config file (one service, one CI job, one stanza), mirroring the
// markdown chunker's heading split. tree-sitter is deliberately not used: the
// value here is the top-level key structure, not a full AST, and tree-sitter-yaml
// ships no wasm. A leading `# comment` directly above a key attaches to its block.
// Multi-document streams (`---`) work for free: each document's top-level keys are
// their own anchors, so every document's stanzas are indexed separately.

import type { RagChunkConfig } from '../config.js';
import type { WalkedFile } from '../walker.js';
import { createChunk } from './chunk-factory.js';
import {
  chunkLines,
  estimateTokens,
  windowLineRanges,
  windowTrimmedSpan,
} from './line-chunker.js';
import type { Chunk } from './types.js';

// A top-level mapping key: column 0 (no indent), not a comment / list item /
// document marker, with `key:` followed by whitespace or end-of-line. `[^:]*`
// cannot cross a colon, so `url: http://x` keys on `url`, not the scheme.
// Limitation (inherent to a line-based, non-AST approach): a continuation line of
// a multi-line double-quoted scalar that happens to start `word: ` at column 0
// is misread as a key. This is rare in config YAML and the markdown chunker makes
// the same line-vs-AST tradeoff; the alternative (a full YAML parser) is overkill.
const TOP_KEY_RE = /^[^\s#-][^:]*:(\s|$)/;

function isTopKey(line: string): boolean {
  return TOP_KEY_RE.test(line);
}

function keyName(line: string): string {
  const raw = line.slice(0, line.indexOf(':')).trim();
  return raw.replace(/^['"]|['"]$/g, ''); // unquote "my key": …
}

function isComment(line: string): boolean {
  return line.trim().startsWith('#');
}

export function chunkYaml(
  text: string,
  file: WalkedFile,
  config: RagChunkConfig,
  fileHash: string,
): Chunk[] {
  // Normalize CRLF so the anchored key regex is not defeated by a trailing \r.
  const lines = text.split(/\r?\n/);
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  if (lines.length === 0) {
    return [
      createChunk({
        file,
        fileHash,
        startLine: 1,
        endLine: 1,
        text: '',
        kind: 'block',
      }),
    ];
  }

  // Anchor = every top-level key line (0-based index + key name).
  const anchors: Array<{ idx: number; key: string }> = [];
  for (let i = 0; i < lines.length; i++) {
    if (isTopKey(lines[i]!)) anchors.push({ idx: i, key: keyName(lines[i]!) });
  }

  // No top-level mapping (a top-level list, or comments only) → line-chunk it.
  if (anchors.length === 0) return chunkLines(text, file, config, fileHash);

  // Extend each anchor upward over contiguous leading comment lines, bounded by
  // the previous anchor's key line so adjacent sections never overlap.
  const starts = anchors.map((a, h) => {
    const lowerBound = h === 0 ? 0 : anchors[h - 1]!.idx + 1;
    let s = a.idx;
    while (s - 1 >= lowerBound && isComment(lines[s - 1]!)) s--;
    return s;
  });

  const chunks: Chunk[] = [];

  // Preamble before the first section (leading `---`, top-of-file comments).
  if (starts[0]! > 0) {
    chunks.push(
      ...windowTrimmedSpan(
        lines.slice(0, starts[0]!),
        1,
        file,
        config,
        fileHash,
      ),
    );
  }

  for (let h = 0; h < anchors.length; h++) {
    const sStart = starts[h]!; // 0-based, inclusive
    const sEnd = (h + 1 < anchors.length ? starts[h + 1]! : lines.length) - 1; // inclusive
    const symbol = anchors[h]!.key || undefined;
    const sectionLines = lines.slice(sStart, sEnd + 1);
    const sectionText = sectionLines.join('\n');

    // Whole block as one chunk when it fits.
    if (estimateTokens(sectionText) <= config.maxTokens) {
      chunks.push(
        createChunk({
          file,
          fileHash,
          startLine: sStart + 1,
          endLine: sEnd + 1,
          text: sectionText,
          kind: 'block',
          symbol,
        }),
      );
      continue;
    }

    // Oversized block → window by token budget; every window keeps the key symbol.
    for (const { startIdx, endIdx } of windowLineRanges(
      sectionLines,
      config.maxTokens,
      config.overlapLines,
    )) {
      chunks.push(
        createChunk({
          file,
          fileHash,
          startLine: sStart + startIdx + 1,
          endLine: sStart + endIdx,
          text: sectionLines.slice(startIdx, endIdx).join('\n'),
          kind: 'block',
          symbol,
        }),
      );
    }
  }

  return chunks;
}
