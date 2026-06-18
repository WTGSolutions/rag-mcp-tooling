import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import Database, { type Database as DB, type Statement } from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import type { Chunk, ChunkKind } from '../chunk/types.js';
import type { FileLanguage } from '../walker.js';

export type SearchResult = {
  chunk: Chunk;
  /** Cosine similarity: 1 = identical, 0 = orthogonal. Requires L2-normalized vectors. */
  score: number;
};

export type StoreStats = {
  chunks: number;
  files: number;
  segments: string[];
  modelId: string;
  dimensions: number;
  lastIndexed: string | null;
  /** Fraction (0–1) of chunks carrying structural metadata (imports/callees), TASK-045. */
  metadataCoverage: number;
};

export type SegmentStat = {
  segment: string;
  chunks: number;
  files: number;
};

type ChunkRow = {
  id: string;
  segment: string;
  file_path: string;
  start_line: number;
  end_line: number;
  language: string;
  symbol: string | null;
  kind: string;
  text_content: string;
  file_hash: string;
  imports_json?: string | null;
  callees_json?: string | null;
  vec_rowid: number;
  distance?: number;
};

// Parse a JSON string array stored in a sidecar column; tolerate corruption/legacy
// values by returning undefined rather than throwing mid-query.
function parseStringArray(
  json: string | null | undefined,
): string[] | undefined {
  if (!json) return undefined;
  try {
    const v = JSON.parse(json);
    if (
      Array.isArray(v) &&
      v.every((x) => typeof x === 'string') &&
      v.length > 0
    ) {
      return v as string[];
    }
  } catch {
    /* fall through */
  }
  return undefined;
}

// Escape LIKE wildcards so an identifier containing `_` (valid in JS/Python names)
// is matched literally, not as a single-char wildcard. Pair with ESCAPE '\'.
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

// Over-fetch multiplier when filtering by segment: ensures enough candidates
// survive the segment filter to fill the requested k.
const SEGMENT_FILTER_MULTIPLIER = 8;

function chunkFromRow(row: ChunkRow): Chunk {
  const imports = parseStringArray(row.imports_json);
  const callees = parseStringArray(row.callees_json);
  return {
    id: row.id,
    segment: row.segment,
    filePath: row.file_path,
    startLine: row.start_line,
    endLine: row.end_line,
    language: row.language as FileLanguage,
    symbol: row.symbol ?? undefined,
    kind: row.kind as ChunkKind,
    text: row.text_content,
    fileHash: row.file_hash,
    ...(imports ? { imports } : {}),
    ...(callees ? { callees } : {}),
  };
}

// L2-normalized vectors: cosine_similarity = 1 - distance²/2
function distanceToScore(distance: number): number {
  // Math.max(0, NaN) returns NaN, so guard explicitly against a non-finite
  // distance (degenerate/zero-norm vector) leaking a "NaN" score into output.
  if (!Number.isFinite(distance)) return 0;
  return Math.max(0, 1 - (distance * distance) / 2);
}

function vectorToBlob(v: Float32Array): Buffer {
  // Use offset + length so subarray slices (shared parent buffer) serialize correctly.
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

export class VectorStore {
  private readonly db: DB;
  private readonly dimensions: number;
  private readonly modelId: string;

  // Prepared statements cached once at construction — avoids re-compiling
  // SQL on every upsert() call, which matters for batch indexing thousands of files.
  private readonly stmtGetVecRowid: Statement<[string], { vec_rowid: number }>;
  private readonly stmtDeleteVec: Statement<[number]>;
  private readonly stmtDeleteChunk: Statement<[string]>;
  private readonly stmtInsertVec: Statement<[Buffer]>;
  private readonly stmtInsertChunk: Statement<
    [
      string,
      string,
      string,
      number,
      number,
      string,
      string | null,
      string,
      string,
      string,
      string | null, // imports_json (TASK-045)
      string | null, // callees_json (TASK-045)
      number,
    ]
  >;
  private readonly stmtUpdateMeta: Statement<[string, string]>;

  private constructor(db: DB, dimensions: number, modelId: string) {
    this.db = db;
    this.dimensions = dimensions;
    this.modelId = modelId;

    this.stmtGetVecRowid = db.prepare(
      'SELECT vec_rowid FROM chunks WHERE id = ?',
    );
    this.stmtDeleteVec = db.prepare('DELETE FROM vec_chunks WHERE rowid = ?');
    this.stmtDeleteChunk = db.prepare('DELETE FROM chunks WHERE id = ?');
    this.stmtInsertVec = db.prepare(
      'INSERT INTO vec_chunks(embedding) VALUES (?)',
    );
    this.stmtInsertChunk = db.prepare(`
      INSERT INTO chunks
        (id, segment, file_path, start_line, end_line, language, symbol, kind, text_content, file_hash, imports_json, callees_json, vec_rowid)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.stmtUpdateMeta = db.prepare(
      'INSERT OR REPLACE INTO store_meta(key, value) VALUES (?, ?)',
    );
  }

  static open(
    storePath: string,
    dimensions: number,
    modelId: string,
  ): VectorStore {
    const absPath = resolve(storePath);
    mkdirSync(dirname(absPath), { recursive: true });

    const db = new Database(absPath);
    sqliteVec.load(db);

    // WAL mode for better concurrent read performance
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    db.exec(`
      CREATE TABLE IF NOT EXISTS chunks (
        id          TEXT    PRIMARY KEY,
        segment     TEXT    NOT NULL,
        file_path   TEXT    NOT NULL,
        start_line  INTEGER NOT NULL,
        end_line    INTEGER NOT NULL,
        language    TEXT    NOT NULL,
        symbol      TEXT,
        kind        TEXT    NOT NULL,
        text_content TEXT   NOT NULL,
        file_hash   TEXT    NOT NULL,
        imports_json TEXT,
        callees_json TEXT,
        vec_rowid   INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_chunks_file_path ON chunks(file_path);
      CREATE INDEX IF NOT EXISTS idx_chunks_file_hash  ON chunks(file_hash);
      CREATE INDEX IF NOT EXISTS idx_chunks_segment    ON chunks(segment);
      CREATE INDEX IF NOT EXISTS idx_chunks_vec_rowid  ON chunks(vec_rowid);

      CREATE TABLE IF NOT EXISTS store_meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);

    // Migrate pre-TASK-045 stores: CREATE TABLE IF NOT EXISTS won't add columns to
    // an existing table, so add the sidecar metadata columns when missing. Old rows
    // keep NULL (→ empty metadata) until a reindex repopulates them; vectors and the
    // virtual table are untouched, so no re-embedding is forced.
    const chunkCols = new Set(
      db
        .prepare<[], { name: string }>('PRAGMA table_info(chunks)')
        .all()
        .map((r) => r.name),
    );
    for (const col of ['imports_json', 'callees_json']) {
      if (!chunkCols.has(col)) {
        db.exec(`ALTER TABLE chunks ADD COLUMN ${col} TEXT`);
      }
    }

    // Virtual table must match the current dimensions. If the schema already
    // exists with a different dimension, we'd get a mismatch — callers must
    // rebuild the store (documented in README). Creating it is idempotent.
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks
        USING vec0(embedding float[${dimensions}]);
    `);

    // Persist metadata so stats() can return it even without an active embedder.
    // INSERT OR IGNORE for dimensions: once written, it must not change without a
    // full rebuild (the virtual table schema is locked). We validate on reopen.
    db.prepare(
      'INSERT OR REPLACE INTO store_meta(key, value) VALUES (?, ?)',
    ).run('model_id', modelId);
    db.prepare(
      'INSERT OR IGNORE INTO store_meta(key, value) VALUES (?, ?)',
    ).run('dimensions', String(dimensions));

    // Validate that the stored dimensions match the caller's value. If they differ,
    // the caller opened an existing store with a different model — a rebuild is needed.
    const storedDimsRow = db
      .prepare<[string], { value: string }>(
        'SELECT value FROM store_meta WHERE key = ?',
      )
      .get('dimensions');
    const storedDims = storedDimsRow ? Number(storedDimsRow.value) : dimensions;
    if (storedDims !== dimensions) {
      db.close();
      throw new Error(
        `[rag-mcp] Dimension mismatch: store was built with ${storedDims} dimensions ` +
          `but embedder has ${dimensions}. Run: rag-index --reset to rebuild.`,
      );
    }

    return new VectorStore(db, dimensions, modelId);
  }

  // ── Write ─────────────────────────────────────────────────────────────────

  upsert(chunks: Chunk[], vectors: Float32Array[]): void {
    if (chunks.length !== vectors.length) {
      throw new Error(
        `[rag-mcp] upsert: chunks.length (${chunks.length}) ≠ vectors.length (${vectors.length})`,
      );
    }
    if (chunks.length === 0) return;

    this.db.transaction(() => {
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i]!;
        const vector = vectors[i]!;

        if (vector.length !== this.dimensions) {
          throw new Error(
            `[rag-mcp] upsert: vector[${i}] length ${vector.length} ≠ expected ${this.dimensions}`,
          );
        }

        // Remove existing row for this chunk id (upsert semantics)
        const existing = this.stmtGetVecRowid.get(chunk.id);
        if (existing) {
          this.stmtDeleteVec.run(existing.vec_rowid);
          this.stmtDeleteChunk.run(chunk.id);
        }

        const { lastInsertRowid } = this.stmtInsertVec.run(
          vectorToBlob(vector),
        );
        this.stmtInsertChunk.run(
          chunk.id,
          chunk.segment,
          chunk.filePath,
          chunk.startLine,
          chunk.endLine,
          chunk.language,
          chunk.symbol ?? null,
          chunk.kind,
          chunk.text,
          chunk.fileHash,
          chunk.imports?.length ? JSON.stringify(chunk.imports) : null,
          chunk.callees?.length ? JSON.stringify(chunk.callees) : null,
          // better-sqlite3 returns BigInt for lastInsertRowid; bind it directly
          // to avoid precision loss for rowids > Number.MAX_SAFE_INTEGER.
          Number(lastInsertRowid),
        );
      }

      this.stmtUpdateMeta.run('last_indexed', new Date().toISOString());
    })();
  }

  deleteByFile(filePath: string): void {
    // Atomic: SELECT + DELETE in one transaction so no orphaned vec rows
    // can appear if a concurrent writer modifies the file between operations.
    this.db.transaction(() => {
      this.db
        .prepare(`
        DELETE FROM vec_chunks WHERE rowid IN (
          SELECT vec_rowid FROM chunks WHERE file_path = ?
        )
      `)
        .run(filePath);
      this.db.prepare('DELETE FROM chunks WHERE file_path = ?').run(filePath);
    })();
  }

  /** Segment-scoped delete — safe when two segments share the same relative path. */
  deleteFileFromSegment(filePath: string, segment: string): void {
    this.db.transaction(() => {
      this.db
        .prepare(`
        DELETE FROM vec_chunks WHERE rowid IN (
          SELECT vec_rowid FROM chunks WHERE file_path = ? AND segment = ?
        )
      `)
        .run(filePath, segment);
      this.db
        .prepare('DELETE FROM chunks WHERE file_path = ? AND segment = ?')
        .run(filePath, segment);
    })();
  }

  /**
   * Returns a map of filePath → fileHash for all files in the given segment
   * (or all segments when omitted). Used by the incremental reindexer to detect
   * unchanged files and deleted files.
   */
  getFileHashes(segment?: string): Map<string, string> {
    // GROUP BY file_path (not DISTINCT on the pair) so we always get exactly one
    // row per file. DISTINCT on (file_path, file_hash) would return two rows if
    // a crash left old chunks (hash H1) and new chunks (hash H2) for the same
    // file, causing Map to silently keep only the last hash and perpetuating
    // the corruption through incremental runs.
    const rows: Array<{ file_path: string; file_hash: string }> = segment
      ? this.db
          .prepare<[string], { file_path: string; file_hash: string }>(
            'SELECT file_path, MAX(file_hash) as file_hash FROM chunks WHERE segment = ? GROUP BY file_path',
          )
          .all(segment)
      : this.db
          .prepare<[], { file_path: string; file_hash: string }>(
            'SELECT file_path, MAX(file_hash) as file_hash FROM chunks GROUP BY file_path',
          )
          .all();
    return new Map(rows.map((r) => [r.file_path, r.file_hash]));
  }

  // ── Read ──────────────────────────────────────────────────────────────────

  /** Returns a single chunk by its id, or undefined if not found. Read-only. */
  getChunkById(id: string): Chunk | undefined {
    const row = this.db
      .prepare<[string], ChunkRow>('SELECT * FROM chunks WHERE id = ?')
      .get(id);
    return row ? chunkFromRow(row) : undefined;
  }

  /**
   * Chunks whose body calls `name` — the reverse of the `callees` metadata
   * (TASK-045). Approximate: matches the bare call name against each chunk's
   * stored callee list, so same-named methods on different classes can collide.
   * `excludeId` drops the chunk itself (self/recursive call). Read-only.
   */
  findCallers(name: string, excludeId?: string, limit = 20): Chunk[] {
    if (name === '') return [];
    const needle = `%"${escapeLike(name)}"%`;
    const rows = this.db
      .prepare<[string, number], ChunkRow>(
        `SELECT * FROM chunks WHERE callees_json LIKE ? ESCAPE '\\' LIMIT ?`,
      )
      .all(needle, limit);
    return rows.map(chunkFromRow).filter((c) => c.id !== excludeId);
  }

  /**
   * Doc/markdown chunks that mention `name` by text (TASK-045) — a cheap
   * documentation backlink. Approximate substring match on section chunks. Read-only.
   */
  findDocMentions(name: string, limit = 10): Chunk[] {
    if (name === '') return [];
    const needle = `%${escapeLike(name)}%`;
    const rows = this.db
      .prepare<[string, number], ChunkRow>(
        `SELECT * FROM chunks WHERE kind = 'section' AND text_content LIKE ? ESCAPE '\\' LIMIT ?`,
      )
      .all(needle, limit);
    return rows.map(chunkFromRow);
  }

  /** Per-segment chunk and file counts, for index_status. Read-only. */
  segmentStats(): SegmentStat[] {
    return this.db
      .prepare<[], SegmentStat>(`
      SELECT segment, COUNT(*) as chunks, COUNT(DISTINCT file_path) as files
      FROM chunks
      GROUP BY segment
      ORDER BY segment
    `)
      .all();
  }

  search(
    queryVector: Float32Array,
    k: number,
    filter?: { segment?: string },
  ): SearchResult[] {
    if (queryVector.length !== this.dimensions) {
      throw new Error(
        `[rag-mcp] search: query vector length ${queryVector.length} ≠ expected ${this.dimensions}`,
      );
    }
    if (!Number.isFinite(k) || k < 1) return [];
    const safeK = Math.trunc(k);

    const blob = vectorToBlob(queryVector);
    // Over-fetch when filtering so enough candidates survive the WHERE.
    const fetchK = filter?.segment ? safeK * SEGMENT_FILTER_MULTIPLIER : safeK;

    const segmentClause = filter?.segment ? 'AND c.segment = ?' : '';
    const params: unknown[] = filter?.segment
      ? [blob, fetchK, filter.segment]
      : [blob, fetchK];

    const rows = this.db
      .prepare<unknown[], ChunkRow & { distance: number }>(`
      SELECT c.*, v.distance
      FROM vec_chunks v
      JOIN chunks c ON c.vec_rowid = v.rowid
      WHERE v.embedding MATCH ? AND v.k = ?
      ${segmentClause}
      ORDER BY v.distance
      LIMIT ${safeK}
    `)
      .all(...params);

    return rows.map((row) => ({
      chunk: chunkFromRow(row),
      score: distanceToScore(row.distance),
    }));
  }

  stats(): StoreStats {
    const { chunks } = this.db
      .prepare<[], { chunks: number }>('SELECT count(*) as chunks FROM chunks')
      .get()!;

    const { files } = this.db
      .prepare<[], { files: number }>(
        'SELECT count(DISTINCT file_path) as files FROM chunks',
      )
      .get()!;

    const segmentRows = this.db
      .prepare<[], { segment: string }>(
        'SELECT DISTINCT segment FROM chunks ORDER BY segment',
      )
      .all();

    const { withMeta } = this.db
      .prepare<[], { withMeta: number }>(
        'SELECT count(*) as withMeta FROM chunks WHERE imports_json IS NOT NULL OR callees_json IS NOT NULL',
      )
      .get()!;

    const getMeta = this.db.prepare<[string], { value: string }>(
      'SELECT value FROM store_meta WHERE key = ?',
    );

    return {
      chunks,
      files,
      segments: segmentRows.map((r) => r.segment),
      modelId: getMeta.get('model_id')?.value ?? this.modelId,
      dimensions: Number(getMeta.get('dimensions')?.value ?? this.dimensions),
      lastIndexed: getMeta.get('last_indexed')?.value ?? null,
      metadataCoverage: chunks > 0 ? withMeta / chunks : 0,
    };
  }

  close(): void {
    this.db.close();
  }
}
