import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

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
 * Appends one JSONL line per tool call to `.rag/usage.jsonl`.
 * All writes are non-fatal: I/O errors go to stderr, never propagate.
 * Disabled entirely when `RAG_USAGE_LOG=0`.
 */
export class UsageLogger {
  constructor(
    readonly logPath: string,
    private readonly enabled: boolean,
  ) {}

  append(record: UsageRecord): void {
    if (!this.enabled) return;
    try {
      mkdirSync(dirname(this.logPath), { recursive: true });
      appendFileSync(this.logPath, JSON.stringify(record) + '\n');
    } catch {
      process.stderr.write('[rag-mcp] usage log write failed\n');
    }
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
  makeRecord: (args: Args, result: Result | null, latencyMs: number) => UsageRecord | null,
  logger: UsageLogger,
): (args: Args) => Promise<Result> {
  return async (args: Args): Promise<Result> => {
    const t0 = Date.now();
    try {
      const result = await handler(args);
      try {
        const record = makeRecord(args, result, Date.now() - t0);
        if (record !== null) logger.append(record);
      } catch {
        // non-fatal: logging machinery must never affect the caller
      }
      return result;
    } catch (e) {
      try {
        const record = makeRecord(args, null, Date.now() - t0);
        if (record !== null) logger.append(record);
      } catch {
        // non-fatal
      }
      throw e;
    }
  };
}
