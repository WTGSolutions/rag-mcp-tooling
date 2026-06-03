#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from '../config.js';
import { createEmbedder } from '../embedder/local-embedder.js';
import { VectorStore } from '../store/vector-store.js';
import { registerTools, type ServerDeps } from './tools/index.js';

const SERVER_NAME = 'rag-mcp';
const SERVER_VERSION = '0.1.0';

// CRITICAL: stdout belongs to the MCP protocol (StdioServerTransport). Anything
// written to stdout corrupts the JSON-RPC stream. All diagnostics go to stderr.
function logStderr(message: string): void {
  process.stderr.write(`${message}\n`);
}

/**
 * Builds the MCP server with the four RAG tools registered. Pure and
 * synchronous — no I/O, no transport — so it is unit-testable by connecting an
 * in-memory client.
 */
export function createMcpServer(deps: ServerDeps): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  registerTools(server, deps);
  return server;
}

export type StartedServer = {
  server: McpServer;
  /** Disconnects the transport and closes the store. Idempotent-safe to await once. */
  close: () => Promise<void>;
};

/**
 * Wires the server to its dependencies and connects it over stdio:
 *   loadConfig → verify index exists → open store (same model → dim check) →
 *   create embedder → register tools → connect transport.
 *
 * Throws a clear error (for a non-zero exit) when the index has not been built.
 */
export async function startServer(configPath: string): Promise<StartedServer> {
  const absConfigPath = resolve(configPath);
  const config = loadConfig(absConfigPath);

  // Resolve store path relative to the config file's directory (matches the CLI).
  const storePath = resolve(dirname(absConfigPath), config.store.path);
  if (!existsSync(storePath)) {
    throw new Error(
      `[rag-mcp] Index not found at ${storePath}. Build it first: rag-index --config ${absConfigPath}`,
    );
  }

  const embedder = createEmbedder(config.embedder);
  // VectorStore.open verifies the stored dimensions match this embedder's model
  // (throws "Dimension mismatch" if the index was built with a different model).
  const store = VectorStore.open(storePath, embedder.dimensions, embedder.modelId);

  const server = createMcpServer({ config, store, embedder });

  const stats = store.stats();
  logStderr(
    `[rag-mcp] server ${SERVER_VERSION} ready — model ${embedder.modelId} ` +
      `(${embedder.dimensions}d), ${stats.chunks} chunks across ${stats.files} files`,
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);

  let closed = false;
  return {
    server,
    close: async () => {
      if (closed) return;
      closed = true;
      await server.close();
      store.close();
    },
  };
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  let configPath: string;
  try {
    const { values } = parseArgs({
      args: process.argv.slice(2),
      options: { config: { type: 'string', short: 'c', default: 'rag.config.json' } },
      strict: true,
    });
    configPath = values.config as string;
  } catch (e) {
    logStderr(`[rag-mcp] argument error — ${(e as Error).message}`);
    process.exit(1);
  }

  let started: StartedServer;
  try {
    started = await startServer(configPath);
  } catch (e) {
    // Internal errors already carry the [rag-mcp] prefix; write verbatim.
    const message = (e as Error).message ?? String(e);
    logStderr(message.startsWith('[rag-mcp]') ? message : `[rag-mcp] ${message}`);
    process.exit(1);
  }

  // Graceful shutdown on signals so the store/transport close cleanly.
  const shutdown = async () => {
    await started.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// Only run when invoked directly (not when imported by tests).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
