import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

// Rotation threshold. The log grows one line per tool call across months of
// sessions; at the cap the file is renamed to `<path>.1` (replacing the previous
// generation), so disk usage is bounded at ~2× the cap while recent history —
// the only part the usage report mines — stays available.
const MAX_LOG_BYTES = 5 * 1024 * 1024;

export type SearchRecord = {
  ts: string;
  tool: 'search_codebase';
  query: string;
  k: number;
  segment: string | null;
  results: number;
  topScore: number | null;
  latencyMs: number;
  paths: string[];
};

export type GetChunkRecord = {
  ts: string;
  tool: 'get_chunk';
  id: string;
  found: boolean;
  latencyMs: number;
};

export type ReindexRecord = {
  ts: string;
  tool: 'reindex';
  added: number;
  skipped: number;
  removed: number;
  latencyMs: number;
};

export type UsageRecord = SearchRecord | GetChunkRecord | ReindexRecord;

/**
 * Appends one JSONL line per tool call to `.rag/usage.jsonl`, rotating the file
 * to `.rag/usage.jsonl.1` once it exceeds `maxBytes` so it never grows unbounded.
 * All writes are non-fatal: I/O errors go to stderr, never propagate.
 * Disabled entirely when `RAG_USAGE_LOG=0`.
 */
export class UsageLogger {
  private dirEnsured = false;

  constructor(
    readonly logPath: string,
    private readonly enabled: boolean,
    private readonly maxBytes: number = MAX_LOG_BYTES,
  ) {}

  append(record: UsageRecord): void {
    if (!this.enabled) return;
    try {
      if (!this.dirEnsured) {
        mkdirSync(dirname(this.logPath), { recursive: true });
        this.dirEnsured = true;
      }
      this.rotateIfNeeded();
      appendFileSync(this.logPath, `${JSON.stringify(record)}\n`);
    } catch {
      process.stderr.write('[rag-mcp] usage log write failed\n');
    }
  }

  // Size check + rename, both before the append: the cap is enforced between
  // records, so a rotated file always ends on a complete JSONL line.
  private rotateIfNeeded(): void {
    let size: number;
    try {
      size = statSync(this.logPath).size;
    } catch {
      return; // no log file yet — nothing to rotate
    }
    if (size < this.maxBytes) return;
    renameSync(this.logPath, `${this.logPath}.1`);
  }
}

export function createUsageLogger(logPath: string): UsageLogger {
  const enabled = process.env['RAG_USAGE_LOG'] !== '0';
  return new UsageLogger(logPath, enabled);
}

/**
 * Wraps a tool handler, measures wall-clock latency, and appends a usage
 * record after each call (success or error thrown by the handler).
 *
 * `makeRecord` receives `null` as `result` when the handler threw — callers
 * that want to skip logging on errors should return `null` from `makeRecord`.
 * Logging is always non-fatal: a failure inside `makeRecord` or `logger.append`
 * never prevents the handler result (or thrown error) from reaching the MCP SDK.
 */
export function wrapHandler<Args, Result>(
  handler: (args: Args) => Promise<Result>,
  makeRecord: (
    args: Args,
    result: Result | null,
    latencyMs: number,
  ) => UsageRecord | null,
  logger: UsageLogger,
): (args: Args) => Promise<Result> {
  return async (args: Args): Promise<Result> => {
    const t0 = Date.now();
    const tryLog = (result: Result | null) => {
      try {
        const record = makeRecord(args, result, Date.now() - t0);
        if (record !== null) logger.append(record);
      } catch {
        // non-fatal: logging machinery must never affect the caller
      }
    };
    try {
      const result = await handler(args);
      tryLog(result);
      return result;
    } catch (e) {
      tryLog(null);
      throw e;
    }
  };
}
