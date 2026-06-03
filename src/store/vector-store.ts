import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import Database, { type Database as DB } from 'better-sqlite3';
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
  vec_rowid: number;
  distance?: number;
};

// Over-fetch multiplier when filtering by segment: ensures enough candidates
// survive the segment filter to fill the requested k.
const SEGMENT_FILTER_MULTIPLIER = 8;

function chunkFromRow(row: ChunkRow): Chunk {
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
  };
}

// L2-normalized vectors: cosine_similarity = 1 - distance²/2
function distanceToScore(distance: number): number {
  return Math.max(0, 1 - (distance * distance) / 2);
}

function vectorToBlob(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

export class VectorStore {
  private readonly db: DB;
  private readonly dimensions: number;
  private readonly modelId: string;

  private constructor(db: DB, dimensions: number, modelId: string) {
    this.db = db;
    this.dimensions = dimensions;
    this.modelId = modelId;
  }

  static open(storePath: string, dimensions: number, modelId: string): VectorStore {
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

    // Virtual table must match the current dimensions. If the schema already
    // exists with a different dimension, we'd get a mismatch — callers must
    // rebuild the store (documented in README). Creating it is idempotent.
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks
        USING vec0(embedding float[${dimensions}]);
    `);

    // Persist metadata so stats() can return it even without an active embedder
    db.prepare(`
      INSERT OR REPLACE INTO store_meta(key, value) VALUES ('model_id', ?)
    `).run(modelId);
    db.prepare(`
      INSERT OR IGNORE INTO store_meta(key, value) VALUES ('dimensions', ?)
    `).run(String(dimensions));

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

    const getVecRowid = this.db.prepare<[string], { vec_rowid: number }>(
      'SELECT vec_rowid FROM chunks WHERE id = ?',
    );
    const deleteVec   = this.db.prepare<[number]>('DELETE FROM vec_chunks WHERE rowid = ?');
    const deleteChunk = this.db.prepare<[string]>('DELETE FROM chunks WHERE id = ?');
    const insertVec   = this.db.prepare<[Buffer]>('INSERT INTO vec_chunks(embedding) VALUES (?)');
    const insertChunk = this.db.prepare<[
      string, string, string, number, number, string,
      string | null, string, string, string, number,
    ]>(`
      INSERT INTO chunks
        (id, segment, file_path, start_line, end_line, language, symbol, kind, text_content, file_hash, vec_rowid)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const updateMeta = this.db.prepare<[string, string]>(
      'INSERT OR REPLACE INTO store_meta(key, value) VALUES (?, ?)',
    );

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
        const existing = getVecRowid.get(chunk.id);
        if (existing) {
          deleteVec.run(existing.vec_rowid);
          deleteChunk.run(chunk.id);
        }

        const { lastInsertRowid } = insertVec.run(vectorToBlob(vector));
        insertChunk.run(
          chunk.id, chunk.segment, chunk.filePath, chunk.startLine, chunk.endLine,
          chunk.language, chunk.symbol ?? null, chunk.kind, chunk.text, chunk.fileHash,
          Number(lastInsertRowid),
        );
      }

      updateMeta.run('last_indexed', new Date().toISOString());
    })();
  }

  deleteByFile(filePath: string): void {
    const rows = this.db.prepare<[string], { vec_rowid: number }>(
      'SELECT vec_rowid FROM chunks WHERE file_path = ?',
    ).all(filePath);

    if (rows.length === 0) return;

    const delVec   = this.db.prepare<[number]>('DELETE FROM vec_chunks WHERE rowid = ?');
    const delChunk = this.db.prepare<[string]>('DELETE FROM chunks WHERE file_path = ?');

    this.db.transaction(() => {
      for (const { vec_rowid } of rows) delVec.run(vec_rowid);
      delChunk.run(filePath);
    })();
  }

  // ── Read ──────────────────────────────────────────────────────────────────

  search(queryVector: Float32Array, k: number, filter?: { segment?: string }): SearchResult[] {
    if (queryVector.length !== this.dimensions) {
      throw new Error(
        `[rag-mcp] search: query vector length ${queryVector.length} ≠ expected ${this.dimensions}`,
      );
    }
    if (k < 1) return [];

    const blob = vectorToBlob(queryVector);
    // Over-fetch when filtering so enough candidates survive the WHERE
    const fetchK = filter?.segment ? k * SEGMENT_FILTER_MULTIPLIER : k;

    const segmentClause = filter?.segment ? 'AND c.segment = ?' : '';
    const params: unknown[] = filter?.segment
      ? [blob, fetchK, filter.segment]
      : [blob, fetchK];

    const rows = this.db.prepare<unknown[], ChunkRow & { distance: number }>(`
      SELECT c.*, v.distance
      FROM vec_chunks v
      JOIN chunks c ON c.vec_rowid = v.rowid
      WHERE v.embedding MATCH ? AND v.k = ?
      ${segmentClause}
      ORDER BY v.distance
      LIMIT ${k}
    `).all(...params);

    return rows.map((row) => ({
      chunk: chunkFromRow(row),
      score: distanceToScore(row.distance),
    }));
  }

  stats(): StoreStats {
    const { chunks } = this.db.prepare<[], { chunks: number }>(
      'SELECT count(*) as chunks FROM chunks',
    ).get()!;

    const { files } = this.db.prepare<[], { files: number }>(
      'SELECT count(DISTINCT file_path) as files FROM chunks',
    ).get()!;

    const segmentRows = this.db.prepare<[], { segment: string }>(
      'SELECT DISTINCT segment FROM chunks ORDER BY segment',
    ).all();

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
    };
  }

  close(): void {
    this.db.close();
  }
}
