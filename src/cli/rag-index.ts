#!/usr/bin/env node
import { realpathSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { ConfigError, loadConfig, resolveStorePath } from '../config.js';
import { createEmbedder } from '../embedder/local-embedder.js';
import type { ReindexMode } from '../indexer/reindex.js';
import { reindex } from '../indexer/reindex.js';

const USAGE = `
rag-index — semantic code indexer

Usage:
  rag-index [options]

Options:
  -c, --config <path>   Path to rag.config.json (default: rag.config.json)
  --full                Re-index everything, ignoring stored hashes
  --changed             Only re-index changed files (default)
  --reset               Delete the vector store and re-index from scratch
                        (use after changing embedder.model to avoid dimension
                        mismatches; implies --full)
  -s, --segment <name>  Process only the named segment
  -h, --help            Show this help

Exit codes:
  0   Success
  1   Error (bad config, I/O failure, etc.)
`.trim();

export type CliArgs = {
  configPath: string;
  mode: ReindexMode;
  segment: string | undefined;
  cwd: string;
  reset: boolean;
};

export function parseCliArgs(argv: string[]): CliArgs | null {
  const { values } = parseArgs({
    args: argv,
    options: {
      config: { type: 'string', short: 'c', default: 'rag.config.json' },
      full: { type: 'boolean', default: false },
      changed: { type: 'boolean', default: false },
      reset: { type: 'boolean', default: false },
      segment: { type: 'string', short: 's' },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
  });

  if (values.help) {
    process.stdout.write(`${USAGE}\n`);
    return null;
  }

  const reset = values.reset as boolean;
  // Resolve configPath first so cwd can be derived from it.
  const configPath = resolve(values.config as string);
  return {
    configPath,
    // --reset implies --full: a fresh store always needs a full rebuild.
    mode: reset || values.full ? 'full' : 'incremental',
    segment: values.segment as string | undefined,
    // Use the config file's directory as cwd so relative segment roots in the
    // config resolve against the project, not the shell's working directory.
    cwd: dirname(configPath),
    reset,
  };
}

function fmt(n: number): string {
  return n.toLocaleString('en');
}

function elapsed(startMs: number): string {
  const ms = Date.now() - startMs;
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

export async function run(args: CliArgs): Promise<void> {
  const config = loadConfig(args.configPath);

  // Resolve store.path relative to the config file's directory (shared with the
  // MCP server) so the same config always points at the same database.
  const resolvedStorePath = resolveStorePath(args.configPath, config);
  const resolvedConfig = {
    ...config,
    store: { ...config.store, path: resolvedStorePath },
  };

  // Validate before any destructive action so a bad model name never leaves the
  // user with a deleted store and no new index.
  if (args.reset && args.segment !== undefined) {
    throw new ConfigError(
      `--reset deletes the entire vector store and cannot be scoped to one segment. ` +
        `Omit --segment to reset and rebuild all segments, or use --full --segment ` +
        `${args.segment} to force-reindex one segment without touching the others.`,
    );
  }

  // Create the embedder before any destructive work: it validates the model name
  // synchronously, so a typo in embedder.model fails here — not after the store
  // has already been deleted.
  const embedder = createEmbedder(resolvedConfig.embedder);

  if (args.reset) {
    for (const suffix of ['', '-wal', '-shm']) {
      rmSync(resolvedStorePath + suffix, { force: true });
    }
    process.stderr.write(
      `rag-index: reset — store deleted (${resolvedStorePath})\n`,
    );
  }

  const segmentDesc = args.segment
    ? `segment "${args.segment}"`
    : 'all segments';
  process.stderr.write(
    `rag-index: ${args.mode} — ${segmentDesc} — model ${embedder.modelId}\n`,
  );
  process.stderr.write(`           config: ${args.configPath}\n`);
  process.stderr.write(`           store:  ${resolvedStorePath}\n`);

  const t0 = Date.now();

  const reindexOpts: Parameters<typeof reindex>[0] = {
    config: resolvedConfig,
    embedder,
    mode: args.mode,
    cwd: args.cwd,
  };
  if (args.segment !== undefined) reindexOpts.segment = args.segment;

  const result = await reindex(reindexOpts);

  const summary = [
    `added=${fmt(result.added)}`,
    `skipped=${fmt(result.skipped)}`,
    `removed=${fmt(result.removed)}`,
    `total-chunks=${fmt(result.totalChunks)}`,
    `time=${elapsed(t0)}`,
  ].join('  ');

  process.stderr.write(`rag-index: done — ${summary}\n`);
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // process.argv = [node, script, ...userArgs]
  const argv = process.argv.slice(2);

  let args: CliArgs | null;
  try {
    args = parseCliArgs(argv);
  } catch (e) {
    process.stderr.write(
      `rag-index: argument error — ${(e as Error).message}\n`,
    );
    process.stderr.write(`Run with --help for usage.\n`);
    process.exit(1);
  }

  if (args === null) {
    process.exit(0);
  }

  try {
    await run(args);
  } catch (e) {
    const msg =
      e instanceof ConfigError
        ? (e as Error).message
        : `unexpected error: ${(e as Error).message ?? String(e)}`;
    process.stderr.write(`rag-index: ${msg}\n`);
    process.exit(1);
  }
}

// Only run when invoked directly (not when imported by tests or other modules).
// ESM equivalent of `if (require.main === module)`.
if (process.argv[1]) {
  let calledFile: string;
  try {
    calledFile = realpathSync(process.argv[1]);
  } catch {
    calledFile = process.argv[1];
  }
  if (fileURLToPath(import.meta.url) === calledFile) main();
}
