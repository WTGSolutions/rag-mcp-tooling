#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { loadConfig, resolveStorePath } from '../config.js';
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
  /** Disconnects the transport and closes the store. Idempotent. */
  close: () => Promise<void>;
};

/**
 * Wires the server to its dependencies and connects it over a transport:
 *   loadConfig → verify index exists → open store (same model → dim check) →
 *   create embedder → register tools → connect transport.
 *
 * Throws a clear error (for a non-zero exit) when the index has not been built.
 * The transport is injectable so tests can drive the full path in-memory.
 */
export async function startServer(
  configPath: string,
  createTransport: () => Transport = () => new StdioServerTransport(),
): Promise<StartedServer> {
  const absConfigPath = resolve(configPath);
  const config = loadConfig(absConfigPath);

  const storePath = resolveStorePath(absConfigPath, config);
  if (!existsSync(storePath)) {
    throw new Error(
      `[rag-mcp] Index not found at ${storePath}. Build it first: rag-index --config ${absConfigPath}`,
    );
  }

  const embedder = createEmbedder(config.embedder);
  // VectorStore.open verifies the stored dimensions match this embedder's model
  // (throws "Dimension mismatch" if the index was built with a different model).
  const store = VectorStore.open(storePath, embedder.dimensions, embedder.modelId);

  // From here the store is open; close it if any wiring step throws so the
  // SQLite handle (and WAL/SHM files) are not leaked on a failed start.
  try {
    // Segment roots resolve relative to the config file's directory (same base
    // the index was built with), so reindex walks the right tree.
    const server = createMcpServer({ config, store, embedder, cwd: dirname(absConfigPath) });

    const stats = store.stats();
    logStderr(
      `[rag-mcp] server ${SERVER_VERSION} ready — model ${embedder.modelId} ` +
        `(${embedder.dimensions}d), ${stats.chunks} chunks across ${stats.files} files`,
    );

    await server.connect(createTransport());

    let closed = false;
    return {
      server,
      close: async () => {
        if (closed) return;
        closed = true;
        // store.close() must run even if the transport disconnect throws.
        try {
          await server.close();
        } finally {
          store.close();
        }
      },
    };
  } catch (e) {
    store.close();
    throw e;
  }
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

  // Single-shot graceful shutdown — re-entrancy guard so a second signal (or
  // stdin EOF arriving alongside SIGTERM) can't call process.exit mid-teardown.
  let shuttingDown = false;
  const shutdown = async (code: number): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await started.close();
    } catch (e) {
      logStderr(`[rag-mcp] error during shutdown — ${(e as Error).message}`);
    } finally {
      process.exit(code);
    }
  };

  process.on('SIGINT', () => void shutdown(0));
  process.on('SIGTERM', () => void shutdown(0));
  // When the parent (Claude Code) dies, stdin reaches EOF. The stdio transport
  // does not react to that, so detect it here and exit instead of lingering as
  // an orphaned process that keeps the index locked open.
  process.stdin.on('close', () => void shutdown(0));
}

// Only run when invoked directly (not when imported by tests). A bare main()
// would drop an unhandled rejection for any throw outside its inner try/catch.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    logStderr(`[rag-mcp] fatal — ${(e as Error)?.message ?? String(e)}`);
    process.exit(1);
  });
}
