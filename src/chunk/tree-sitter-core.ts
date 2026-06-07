// Language-agnostic core for tree-sitter chunkers. The per-language modules
// (python, typescript) supply only a node-type WALK + comment prefixes + a wasm
// path; everything mechanical (parser init/memoisation, leading-comment capture,
// chunk emission, gap filling, fallback, sort) lives here. Adding a language
// never touches this file — criterion #1 of TASK-021.

import type { Node as SyntaxNode, Parser as ParserType } from 'web-tree-sitter';
import { Parser } from 'web-tree-sitter';
import type { RagChunkConfig } from '../config.js';
import type { WalkedFile } from '../walker.js';
import { createChunk } from './chunk-factory.js';
import { chunkLines, estimateTokens, windowLineRanges, windowTrimmedSpan } from './line-chunker.js';
import type { Chunk, ChunkKind } from './types.js';

export type LineRange = { start: number; end: number };

// ── Parser initialisation & memoisation ──────────────────────────────────────

let parserInitDone = false;

async function initParser(): Promise<void> {
  if (parserInitDone) return;
  await Parser.init();
  parserInitDone = true;
}

const parserCache = new Map<string, ParserType>();

/** Returns a memoised parser for the given grammar wasm path (one per wasm). */
export async function getParser(wasmPath: string): Promise<ParserType> {
  const cached = parserCache.get(wasmPath);
  if (cached) return cached;

  await initParser();
  const { Language } = await import('web-tree-sitter');
  const language = await Language.load(wasmPath);
  const parser = new Parser();
  parser.setLanguage(language);
  parserCache.set(wasmPath, parser);
  return parser;
}

// ── Shared walk context + emission ────────────────────────────────────────────

export type EmitCtx = {
  lines: readonly string[];
  file: WalkedFile;
  fileHash: string;
  /** Comment line prefixes for leading-comment capture (e.g. ['#'] or ['//','*','/*']). */
  commentPrefixes: readonly string[];
  chunks: Chunk[];
  topLevelRanges: LineRange[];
  config: RagChunkConfig;
  /**
   * When true, oversized symbols are emitted as a single (truncated) chunk instead
   * of sub-windows. Set from `RAG_DISABLE_SYMBOL_WINDOWING=1` — the Phase 6b A/B
   * "before TASK-028" baseline. Read once in `runTreeSitterChunk` and propagated
   * here so `emit` does not re-read the env on every call.
   */
  disableSymbolWindowing: boolean;
};

/** A per-language top-level walk: classify named children and emit chunks. */
export type WalkFn = (root: SyntaxNode, ctx: EmitCtx) => void;

export function nodeName(node: SyntaxNode): string | undefined {
  return node.childForFieldName('name')?.text ?? undefined;
}

// Walk backward from a symbol's start to include contiguous leading comment lines
// (matches the AST chunker including leading JSDoc/docstring). A blank line ends
// the run; a line is a comment if it starts with — or ends with — a known marker.
function withLeadingComments(
  startLine: number,
  lines: readonly string[],
  prefixes: readonly string[],
): number {
  let idx = startLine - 2; // 0-based index of the line just above the symbol
  while (idx >= 0) {
    const t = (lines[idx] ?? '').trim();
    if (t === '') break;
    const isComment = prefixes.some((p) => t.startsWith(p)) || t.endsWith('*/');
    if (!isComment) break;
    idx--;
  }
  return idx + 2; // back to 1-based
}

/**
 * Split an oversized symbol into disjoint sub-windows, each anchored by the
 * symbol's **declaration** line (e.g. `def foo(...)` / `class X {`), mirroring
 * the markdown chunker's heading-repeat pattern. The declaration — not a leading
 * comment line — is the anchor, so every window carries the symbol's identity
 * even when it has a leading docstring/JSDoc (the common case for large, well
 * documented symbols). Leading comments ride along in the first window only.
 * The body (lines after the declaration) is windowed with overlap=0 so ranges
 * are disjoint and adjacent — a requirement for stable incremental reindex IDs.
 *
 * @param start    1-based first line of the span (a leading comment, if any).
 * @param declLine 1-based declaration line — the repeated anchor.
 * @param end      1-based last line of the symbol (inclusive).
 */
function emitWindowedSymbol(
  start: number,
  declLine: number,
  end: number,
  kind: ChunkKind,
  symbol: string | undefined,
  ctx: EmitCtx,
): void {
  const { lines } = ctx;
  const signatureLine = lines[declLine - 1] ?? '';
  const leading = lines.slice(start - 1, declLine - 1); // comment lines above the declaration (maybe empty)
  const bodyLines = lines.slice(declLine, end);          // lines after the declaration (1-based declLine+1..end)

  // Declaration with no body (rare: a giant single-line signature) — one chunk.
  if (bodyLines.length === 0) {
    ctx.chunks.push(createChunk({
      file: ctx.file,
      fileHash: ctx.fileHash,
      startLine: start,
      endLine: end,
      text: [...leading, signatureLine].join('\n'),
      kind,
      symbol,
    }));
    return;
  }

  const budget = Math.max(1, ctx.config.maxTokens - estimateTokens(signatureLine + '\n'));
  const bodyBase = declLine + 1; // 1-based line number of bodyLines[0]

  windowLineRanges(bodyLines as string[], budget, 0).forEach(({ startIdx, endIdx }, w) => {
    const slice = bodyLines.slice(startIdx, endIdx).join('\n');
    if (w === 0) {
      // First window: leading comments + declaration + first body slice, contiguous.
      ctx.chunks.push(createChunk({
        file: ctx.file,
        fileHash: ctx.fileHash,
        startLine: start,
        endLine: bodyBase + endIdx - 1,
        text: [...leading, signatureLine, slice].join('\n'),
        kind,
        symbol,
      }));
    } else {
      // Later windows: repeat the declaration as a context anchor (text only).
      ctx.chunks.push(createChunk({
        file: ctx.file,
        fileHash: ctx.fileHash,
        startLine: bodyBase + startIdx,
        endLine: bodyBase + endIdx - 1,
        text: `${signatureLine}\n${slice}`,
        kind,
        symbol,
      }));
    }
  });
}

/**
 * Emit one chunk for a node. `spanNode` defines the line span (1-based, inclusive,
 * extended upward over leading comments); `kind`/`symbol` classify it. Top-level
 * symbols record their range so gap filling can cover the loose code between them.
 *
 * When the symbol's text exceeds `config.maxTokens`, it is split into disjoint
 * sub-windows via `emitWindowedSymbol` (TASK-028) so no tokens are silently
 * truncated. Symbols that fit are emitted as a single chunk (parity with before).
 */
export function emit(
  spanNode: SyntaxNode,
  kind: ChunkKind,
  symbol: string | undefined,
  ctx: EmitCtx,
  countAsTopLevel: boolean,
): void {
  const end = spanNode.endPosition.row + 1;        // tree-sitter rows are 0-based
  const declLine = spanNode.startPosition.row + 1; // the declaration line, before leading comments
  const start = withLeadingComments(declLine, ctx.lines, ctx.commentPrefixes);
  const text = ctx.lines.slice(start - 1, end).join('\n');

  if (!ctx.disableSymbolWindowing && estimateTokens(text) > ctx.config.maxTokens) {
    emitWindowedSymbol(start, declLine, end, kind, symbol, ctx);
  } else {
    ctx.chunks.push(createChunk({
      file: ctx.file,
      fileHash: ctx.fileHash,
      startLine: start,
      endLine: end,
      text,
      kind,
      symbol,
    }));
  }
  if (countAsTopLevel) ctx.topLevelRanges.push({ start, end });
}

function computeGaps(ranges: readonly LineRange[], totalLines: number): LineRange[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const gaps: LineRange[] = [];
  let cursor = 1;
  for (const { start, end } of sorted) {
    if (start > cursor) gaps.push({ start: cursor, end: start - 1 });
    cursor = Math.max(cursor, end + 1);
  }
  if (cursor <= totalLines) gaps.push({ start: cursor, end: totalLines });
  return gaps;
}

// ── Generic chunker skeleton ──────────────────────────────────────────────────

export type RunChunkOptions = {
  text: string;
  file: WalkedFile;
  config: RagChunkConfig;
  fileHash: string;
  /** Resolved grammar wasm path, or null → line-chunker fallback. */
  wasmPath: string | null;
  commentPrefixes: readonly string[];
  walk: WalkFn;
};

/**
 * Parse with the grammar, run the language walk, fill gaps between top-level
 * symbols with block chunks, sort. Any missing grammar, parse failure, or empty
 * result falls back to the line chunker so indexing never aborts on one file.
 */
export async function runTreeSitterChunk(opts: RunChunkOptions): Promise<Chunk[]> {
  const { text, file, config, fileHash, wasmPath, commentPrefixes, walk } = opts;
  if (!wasmPath) return chunkLines(text, file, config, fileHash);

  let chunks: Chunk[];
  try {
    const parser = await getParser(wasmPath);
    const tree = parser.parse(text);
    if (!tree) return chunkLines(text, file, config, fileHash);

    const lines = text.split('\n');
    const ctx: EmitCtx = {
      lines, file, fileHash, commentPrefixes, config, chunks: [], topLevelRanges: [],
      disableSymbolWindowing: process.env['RAG_DISABLE_SYMBOL_WINDOWING'] === '1',
    };
    walk(tree.rootNode, ctx);

    // Module-level loose code → block chunks filling the gaps between top-level
    // symbols. With zero symbols this windows the whole file into block chunks.
    for (const gap of computeGaps(ctx.topLevelRanges, lines.length)) {
      ctx.chunks.push(
        ...windowTrimmedSpan(lines.slice(gap.start - 1, gap.end), gap.start, file, config, fileHash),
      );
    }
    chunks = ctx.chunks;
  } catch {
    return chunkLines(text, file, config, fileHash);
  }

  if (chunks.length === 0) return chunkLines(text, file, config, fileHash);

  chunks.sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine || a.kind.localeCompare(b.kind));
  return chunks;
}
