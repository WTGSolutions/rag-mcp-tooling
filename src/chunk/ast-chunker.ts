import { extname } from 'node:path';
import { Project, Node, type Statement } from 'ts-morph';
import type { RagChunkConfig } from '../config.js';
import type { WalkedFile } from '../walker.js';
import { createChunk } from './chunk-factory.js';
import { chunkLines, windowLines } from './line-chunker.js';
import type { Chunk, ChunkKind } from './types.js';

type LineRange = { start: number; end: number };

function scriptKindExtension(relativePath: string): string {
  const ext = extname(relativePath).toLowerCase();
  // .tsx/.jsx must keep their extension so JSX parses; everything else → .ts/.js
  switch (ext) {
    case '.tsx':
      return '.tsx';
    case '.jsx':
      return '.jsx';
    case '.js':
    case '.mjs':
    case '.cjs':
      return '.js';
    default:
      return '.ts';
  }
}

/**
 * Chunks a TS/JS file into semantic units (functions, classes, methods,
 * interfaces, types) via ts-morph. Module-level "loose" code (imports,
 * top-level constants) is captured as block chunks filling the gaps between
 * symbols. Any parse failure falls back to the line chunker so indexing
 * never aborts on one file.
 */
export function chunkAst(
  text: string,
  file: WalkedFile,
  config: RagChunkConfig,
  fileHash: string,
): Chunk[] {
  let chunks: Chunk[];
  try {
    chunks = extractAstChunks(text, file, config, fileHash);
  } catch {
    return chunkLines(text, file, config, fileHash);
  }

  // Empty file or a file ts-morph yielded nothing for → line fallback
  if (chunks.length === 0) {
    return chunkLines(text, file, config, fileHash);
  }

  // Stable, readable order: by start line, then end line, then kind
  chunks.sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine || a.kind.localeCompare(b.kind));
  return chunks;
}

function extractAstChunks(
  text: string,
  file: WalkedFile,
  config: RagChunkConfig,
  fileHash: string,
): Chunk[] {
  const project = new Project({
    useInMemoryFileSystem: true,
    skipFileDependencyResolution: true,
    compilerOptions: { allowJs: true },
  });
  const sourceFile = project.createSourceFile(`source${scriptKindExtension(file.relativePath)}`, text);

  const fileLines = text.split('\n');
  const chunks: Chunk[] = [];
  const topLevelRanges: LineRange[] = [];

  const sliceText = (start: number, end: number): string =>
    fileLines.slice(start - 1, end).join('\n');

  const emit = (
    node: { getStartLineNumber(includeJsDoc?: boolean): number; getEndLineNumber(): number },
    kind: ChunkKind,
    symbol: string | undefined,
    countAsTopLevel: boolean,
  ): void => {
    const start = node.getStartLineNumber(true); // include leading JSDoc
    const end = node.getEndLineNumber();
    chunks.push(createChunk({
      file,
      fileHash,
      startLine: start,
      endLine: end,
      text: sliceText(start, end),
      kind,
      symbol,
    }));
    if (countAsTopLevel) topLevelRanges.push({ start, end });
  };

  for (const stmt of sourceFile.getStatements()) {
    emitStatement(stmt, emit);
  }

  // Module-level loose code (imports, top-level constants, expressions) →
  // block chunks filling the gaps between top-level symbols.
  for (const gap of computeGaps(topLevelRanges, fileLines.length)) {
    appendGapChunks(gap, fileLines, file, config, fileHash, chunks);
  }

  return chunks;
}

function emitStatement(
  stmt: Statement,
  emit: (
    node: { getStartLineNumber(includeJsDoc?: boolean): number; getEndLineNumber(): number },
    kind: ChunkKind,
    symbol: string | undefined,
    countAsTopLevel: boolean,
  ) => void,
): void {
  if (Node.isFunctionDeclaration(stmt)) {
    emit(stmt, 'function', stmt.getName(), true);
    return;
  }

  if (Node.isClassDeclaration(stmt)) {
    const className = stmt.getName() ?? 'default';
    emit(stmt, 'class', stmt.getName(), true);
    // Each member is also its own chunk (overlaps the class chunk by design)
    for (const m of stmt.getMethods()) emit(m, 'method', `${className}.${m.getName()}`, false);
    for (const c of stmt.getConstructors()) emit(c, 'method', `${className}.constructor`, false);
    for (const a of stmt.getGetAccessors()) emit(a, 'method', `${className}.${a.getName()}`, false);
    for (const a of stmt.getSetAccessors()) emit(a, 'method', `${className}.${a.getName()}`, false);
    return;
  }

  if (Node.isInterfaceDeclaration(stmt)) {
    emit(stmt, 'interface', stmt.getName(), true);
    return;
  }

  if (Node.isTypeAliasDeclaration(stmt)) {
    emit(stmt, 'type', stmt.getName(), true);
    return;
  }

  if (Node.isEnumDeclaration(stmt)) {
    emit(stmt, 'type', stmt.getName(), true);
    return;
  }

  if (Node.isVariableStatement(stmt)) {
    // `export const foo = () => {}` / `const foo = function() {}` → function chunk
    const fnDecl = stmt.getDeclarations().find((d) => {
      const init = d.getInitializer();
      return init !== undefined && (Node.isArrowFunction(init) || Node.isFunctionExpression(init));
    });
    if (fnDecl) emit(stmt, 'function', fnDecl.getName(), true);
    // Non-function variable statements stay as module code → gap chunks
  }
}

function computeGaps(ranges: LineRange[], totalLines: number): LineRange[] {
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

function appendGapChunks(
  gap: LineRange,
  fileLines: string[],
  file: WalkedFile,
  config: RagChunkConfig,
  fileHash: string,
  out: Chunk[],
): void {
  let start = gap.start;
  let end = gap.end;

  // Trim leading and trailing blank lines so a gap that is only whitespace
  // (or trailing newline) produces no chunk.
  while (start <= end && (fileLines[start - 1] ?? '').trim() === '') start++;
  while (end >= start && (fileLines[end - 1] ?? '').trim() === '') end--;
  if (start > end) return;

  const gapLines = fileLines.slice(start - 1, end);
  out.push(...windowLines(gapLines, start, file, config, fileHash));
}
