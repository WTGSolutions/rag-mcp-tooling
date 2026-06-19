#!/usr/bin/env node
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { ConfigError, loadConfig } from '../config.js';
import { aggregate, formatReport, parseLog } from '../usage/report.js';

const USAGE = `
rag-usage — print a usage report for the RAG-MCP server

Usage:
  rag-usage [options]

Options:
  -c, --config <path>   Path to rag.config.json (default: rag.config.json)
  -h, --help            Show this help

The report is read from <config-dir>/.rag/usage.jsonl and printed to stdout.
Set RAG_USAGE_LOG=0 in the server's environment to disable logging.
`.trim();

function main(): void {
  let configPath: string;
  try {
    const { values } = parseArgs({
      args: process.argv.slice(2),
      options: {
        config: { type: 'string', short: 'c', default: 'rag.config.json' },
        help: { type: 'boolean', short: 'h', default: false },
      },
      strict: true,
    });
    if (values.help) {
      process.stdout.write(`${USAGE}\n`);
      process.exit(0);
    }
    configPath = values.config as string;
  } catch (e) {
    process.stderr.write(`rag-usage: ${(e as Error).message}\n`);
    process.exit(1);
  }

  let configDir: string;
  try {
    const abs = resolve(configPath);
    loadConfig(abs); // validate the config exists and parses
    configDir = dirname(abs);
  } catch (e) {
    const msg =
      e instanceof ConfigError
        ? e.message
        : `unexpected error: ${(e as Error).message}`;
    process.stderr.write(`rag-usage: ${msg}\n`);
    process.exit(1);
  }

  const logPath = resolve(configDir, '.rag', 'usage.jsonl');
  if (!existsSync(logPath)) {
    process.stdout.write(
      'RAG-MCP Usage Report\n====================\n\nNo usage log found.\n',
    );
    process.stdout.write(
      `(Expected at ${logPath} — start the MCP server to begin recording.)\n`,
    );
    process.exit(0);
  }

  let text: string;
  try {
    text = readFileSync(logPath, 'utf8');
  } catch (e) {
    process.stderr.write(
      `rag-usage: cannot read ${logPath}: ${(e as Error).message}\n`,
    );
    process.exit(1);
  }

  const records = parseLog(text);
  const agg = aggregate(records);
  process.stdout.write(`${formatReport(agg)}\n`);
}

if (process.argv[1]) {
  let calledUrl: string;
  try {
    calledUrl = pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    calledUrl = pathToFileURL(process.argv[1]).href;
  }
  if (import.meta.url === calledUrl) main();
}
