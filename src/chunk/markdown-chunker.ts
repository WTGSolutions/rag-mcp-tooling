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

type Heading = { lineIndex: number; level: number; title: string }; // lineIndex is 0-based

// CommonMark allows up to 3 leading SPACES (not tabs — a tab is a code indent)
// before a fence or ATX heading.
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;
const HEADING_RE = /^ {0,3}(#{1,6})(?:\s+(.*))?$/;
// A closing fence is the marker run followed by whitespace only — NO info
// string (which would make it an opening fence instead).
const CLOSE_BACKTICK_RE = /^ {0,3}(`{3,})\s*$/;
const CLOSE_TILDE_RE = /^ {0,3}(~{3,})\s*$/;

/**
 * Scans markdown lines for ATX headings, ignoring `#` that appear inside fenced
 * code blocks (``` or ~~~) — the reason a naive `^#` regex is wrong and this
 * tracks fence state instead.
 */
function parseHeadings(lines: string[]): Heading[] {
  const headings: Heading[] = [];
  let inFence = false;
  let fenceChar = '';
  let fenceLen = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';

    if (inFence) {
      // Only a same-char marker of >= opening length, with nothing but
      // whitespace after it, closes the fence.
      const closeRe = fenceChar === '`' ? CLOSE_BACKTICK_RE : CLOSE_TILDE_RE;
      const close = closeRe.exec(line);
      if (close && close[1]!.length >= fenceLen) {
        inFence = false;
        fenceChar = '';
        fenceLen = 0;
      }
      continue; // lines inside a fence are never headings
    }

    const open = FENCE_RE.exec(line);
    if (open) {
      inFence = true;
      fenceChar = open[1]![0]!;
      fenceLen = open[1]!.length;
      continue;
    }

    const h = HEADING_RE.exec(line);
    if (h) {
      const level = h[1]!.length;
      // Strip an optional closing "###" sequence and surrounding space
      const title = (h[2] ?? '')
        .trim()
        .replace(/\s+#+\s*$/, '')
        .trim();
      headings.push({ lineIndex: i, level, title });
    }
  }

  return headings;
}

export function chunkMarkdown(
  text: string,
  file: WalkedFile,
  config: RagChunkConfig,
  fileHash: string,
): Chunk[] {
  // Normalize CRLF → LF so heading/fence regexes (anchored with $) are not
  // defeated by a trailing \r, which would drop every heading in a CRLF file.
  const lines = text.split(/\r?\n/);
  while (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }

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

  const headings = parseHeadings(lines);

  // No headings → not really structured markdown; fall back to line chunking.
  if (headings.length === 0) {
    return chunkLines(text, file, config, fileHash);
  }

  const chunks: Chunk[] = [];

  // Content before the first heading → block chunk(s), like module-level code.
  const firstIndex = headings[0]!.lineIndex;
  if (firstIndex > 0) {
    chunks.push(
      ...windowTrimmedSpan(
        lines.slice(0, firstIndex),
        1,
        file,
        config,
        fileHash,
      ),
    );
  }

  const pathStack: Array<{ level: number; title: string }> = [];

  for (let h = 0; h < headings.length; h++) {
    const heading = headings[h]!;
    const sectionStart = heading.lineIndex; // 0-based, the heading line
    const sectionEnd =
      (h + 1 < headings.length ? headings[h + 1]!.lineIndex : lines.length) - 1; // inclusive 0-based

    // Breadcrumb: drop ancestors at the same-or-deeper level, then append self.
    while (
      pathStack.length > 0 &&
      pathStack[pathStack.length - 1]!.level >= heading.level
    ) {
      pathStack.pop();
    }
    const breadcrumb = [...pathStack.map((s) => s.title), heading.title]
      .filter((t) => t !== '')
      .join(' > ');
    pathStack.push({ level: heading.level, title: heading.title });
    const symbol = breadcrumb || undefined;

    const headingLine = lines[sectionStart]!;
    const bodyLines = lines.slice(sectionStart + 1, sectionEnd + 1);
    const sectionText = lines.slice(sectionStart, sectionEnd + 1).join('\n');

    // Emit the whole section as one chunk when it fits, or when there is no
    // body to split (a heading-only section can't be windowed).
    if (
      bodyLines.length === 0 ||
      estimateTokens(sectionText) <= config.maxTokens
    ) {
      chunks.push(
        createChunk({
          file,
          fileHash,
          startLine: sectionStart + 1,
          endLine: sectionEnd + 1,
          text: sectionText,
          kind: 'section',
          symbol,
        }),
      );
      continue;
    }

    // Long section → split the body, repeating the heading as context in each
    // sub-chunk. Line ranges point at the body window; the heading text is extra
    // context (so a sub-chunk's text spans one more line than its range).
    const headingTokens = estimateTokens(`${headingLine}\n`);
    const budget = Math.max(1, config.maxTokens - headingTokens);
    const bodyBase0 = sectionStart + 1; // 0-based index of the first body line

    for (const { startIdx, endIdx } of windowLineRanges(
      bodyLines,
      budget,
      config.overlapLines,
    )) {
      const windowText = bodyLines.slice(startIdx, endIdx).join('\n');
      chunks.push(
        createChunk({
          file,
          fileHash,
          startLine: bodyBase0 + startIdx + 1,
          endLine: bodyBase0 + endIdx,
          text: `${headingLine}\n${windowText}`,
          kind: 'section',
          symbol,
        }),
      );
    }
  }

  return chunks;
}
