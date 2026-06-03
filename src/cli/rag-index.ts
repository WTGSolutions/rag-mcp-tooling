#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, ConfigError } from '../config.js';
import { createEmbedder } from '../embedder/local-embedder.js';
import { reindex } from '../indexer/reindex.js';
import type { ReindexMode } from '../indexer/reindex.js';

const USAGE = `
rag-index — semantic code indexer

Usage:
  rag-index [options]

Options:
  -c, --config <path>   Path to rag.config.json (default: rag.config.json)
  --full                Re-index everything, ignoring stored hashes
  --changed             Only re-index changed files (default)
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
};

export function parseCliArgs(argv: string[]): CliArgs | null {
  const { values } = parseArgs({
    args: argv,
    options: {
      config:  { type: 'string',  short: 'c', default: 'rag.config.json' },
      full:    { type: 'boolean',              default: false },
      changed: { type: 'boolean',              default: false },
      segment: { type: 'string',  short: 's' },
      help:    { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
  });

  if (values.help) {
    process.stdout.write(USAGE + '\n');
    return null;
  }

  // Resolve configPath first so cwd can be derived from it.
  const configPath = resolve(values.config as string);
  return {
    configPath,
    mode: values.full ? 'full' : 'incremental',
    segment: values.segment as string | undefined,
    // Use the config file's directory as cwd so relative segment roots in the
    // config resolve against the project, not the shell's working directory.
    cwd: dirname(configPath),
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

  // Resolve store.path relative to the config file's directory so that
  // `rag-index -c /project/rag.config.json` from any shell directory always
  // writes to /project/.rag/index.db, not to wherever the shell is.
  const resolvedStorePath = resolve(args.cwd, config.store.path);
  const resolvedConfig = { ...config, store: { ...config.store, path: resolvedStorePath } };

  const embedder = createEmbedder(resolvedConfig.embedder);

  const segmentDesc = args.segment ? `segment "${args.segment}"` : 'all segments';
  process.stderr.write(`rag-index: ${args.mode} — ${segmentDesc} — model ${embedder.modelId}\n`);
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
    process.stderr.write(`rag-index: argument error — ${(e as Error).message}\n`);
    process.stderr.write(`Run with --help for usage.\n`);
    process.exit(1);
  }

  if (args === null) {
    process.exit(0);
  }

  try {
    await run(args);
  } catch (e) {
    const msg = e instanceof ConfigError
      ? (e as Error).message
      : `unexpected error: ${(e as Error).message ?? String(e)}`;
    process.stderr.write(`rag-index: ${msg}\n`);
    process.exit(1);
  }
}

// Only run when invoked directly (not when imported by tests or other modules).
// ESM equivalent of `if (require.main === module)`.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
