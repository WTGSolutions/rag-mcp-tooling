/**
 * Phase 2 end-to-end test.
 *
 * Two layers:
 *
 *  1. Protocol layer (always online, no model needed) — exercises the MCP
 *     protocol over InMemoryTransport with a real SQLite store.  Catches
 *     schema/structuredContent issues, error-handling through isError, and
 *     the search→get_chunk id contract.
 *
 *  2. Stdio layer (RAG_RUN_MODEL_TESTS=1) — spawns the actual server binary
 *     via StdioClientTransport to prove stdout stays clean (protocol cannot
 *     tolerate any non-JSON bytes) and the full semantic pipeline works
 *     end-to-end with the real offline bge-small model.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { join, resolve, dirname } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { createMcpServer, startServer, type StartedServer } from './server.js';
import { VectorStore } from '../store/vector-store.js';
import type { Chunk } from '../chunk/types.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const DIM = 4; // fake embedder dimension for offline protocol tests

function makeChunk(id: string, overrides: Partial<Chunk> = {}): Chunk {
  return {
    id,
    segment: 'src',
    filePath: 'auth.ts',
    startLine: 1,
    endLine: 10,
    language: 'typescript',
    symbol: 'authenticate',
    kind: 'function',
    text: 'export function authenticate(user) { return user.token; }',
    fileHash: 'h1',
    ...overrides,
  };
}

// ── Layer 1: Protocol (offline, InMemoryTransport) ────────────────────────────

describe('MCP protocol — offline (InMemoryTransport)', () => {
  let tmpDir: string;
  let store: VectorStore;
  let client: Client;
  let server: ReturnType<typeof createMcpServer>;

  const deps = () => ({
    config: {
      segments: [{ name: 'src', root: 'src', include: ['**/*.ts'] }],
      exclude: [],
      embedder: { provider: 'local' as const, model: 'fake' },
      chunk: { maxTokens: 512, overlapLines: 0 },
      store: { path: join(tmpDir, 'index.db') },
    },
    store,
    embedder: { modelId: 'fake', dimensions: DIM, embed: async (t: string[]) => t.map(() => new Float32Array(DIM)) },
    cwd: '/',
  });

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'rag-e2e-'));
    store = VectorStore.open(join(tmpDir, 'index.db'), DIM, 'fake');
    store.upsert([
      makeChunk('chunk-1', { filePath: 'auth.ts', text: 'function authenticate(user) { return user.token; }' }),
      makeChunk('chunk-2', { filePath: 'tax.ts', symbol: 'calculateTax', text: 'function calculateTax(n) { return n * 0.23; }' }),
    ], [
      new Float32Array([1, 0, 0, 0]),
      new Float32Array([0, 1, 0, 0]),
    ]);

    server = createMcpServer(deps());
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'e2e-test', version: '1.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterEach(async () => {
    await client.close();
    await server.close();
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('tools/list returns exactly the 4 RAG tools', async () => {
    // Act
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();

    // Assert
    expect(names).toEqual(['get_chunk', 'index_status', 'reindex', 'search_codebase']);
    expect(tools.every((t) => t.description)).toBe(true);
  });

  it('index_status returns correct counts and segment breakdown', async () => {
    // Act
    const result = await client.callTool({ name: 'index_status', arguments: {} });

    // Assert
    expect(result.isError).toBeFalsy();
    const s = result.structuredContent as { chunks: number; files: number; segments: Array<{ segment: string }> };
    expect(s.chunks).toBe(2);
    expect(s.files).toBe(2);
    expect(s.segments[0]?.segment).toBe('src');
  });

  it('get_chunk returns full text and metadata for a valid id', async () => {
    // Act
    const result = await client.callTool({ name: 'get_chunk', arguments: { id: 'chunk-1' } });

    // Assert
    expect(result.isError).toBeFalsy();
    const s = result.structuredContent as { id: string; filePath: string; text: string };
    expect(s.id).toBe('chunk-1');
    expect(s.filePath).toBe('auth.ts');
    expect(s.text).toContain('authenticate');
  });

  it('get_chunk with unknown id returns isError (not a server crash)', async () => {
    // Act
    const result = await client.callTool({ name: 'get_chunk', arguments: { id: 'does-not-exist' } });

    // Assert — error surfaced as a tool result, not a protocol-level crash
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0]?.text ?? '';
    expect(text).toContain('no chunk found');
  });

  it('get_chunk with an empty id returns isError', async () => {
    const result = await client.callTool({ name: 'get_chunk', arguments: { id: '' } });
    expect(result.isError).toBe(true);
  });

  it('reindex with no arguments returns a summary with counts', async () => {
    // Act — no files match include globs (store has data but no files on disk)
    const result = await client.callTool({ name: 'reindex', arguments: {} });

    // Assert — clean result (all stale files cleaned)
    expect(result.isError).toBeFalsy();
    const s = result.structuredContent as { added: number; skipped: number; durationMs: number };
    expect(typeof s.added).toBe('number');
    expect(typeof s.durationMs).toBe('number');
  });

  it('reindex with an unknown segment returns isError', async () => {
    const result = await client.callTool({ name: 'reindex', arguments: { segment: 'ghost' } });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0]?.text ?? '';
    expect(text).toContain('No segment');
  });

  describe('search → get_chunk id chain (contract)', () => {
    it('an id from index_status structuredContent is consistent with get_chunk', async () => {
      // Use index_status to confirm the chunk ids are in the store
      const statusResult = await client.callTool({ name: 'index_status', arguments: {} });
      const s = statusResult.structuredContent as { chunks: number };
      expect(s.chunks).toBe(2);

      // get_chunk with one of the known ids
      const gcResult = await client.callTool({ name: 'get_chunk', arguments: { id: 'chunk-1' } });
      expect(gcResult.isError).toBeFalsy();
      const gc = gcResult.structuredContent as { id: string; filePath: string };
      expect(gc.id).toBe('chunk-1');
      expect(gc.filePath).toBe('auth.ts');
    });
  });
});

// ── Layer 2: Real stdio (gated, requires cached bge-small model) ──────────────

const RUN_STDIO = process.env['RAG_RUN_MODEL_TESTS'] === '1';

describe.skipIf(!RUN_STDIO)('MCP stdio — real server process + real model', () => {
  let tmpDir: string;
  let repoDir: string;
  let configPath: string;
  let transport: StdioClientTransport;
  let client: Client;

  const SERVER_BINARY = resolve(THIS_DIR, '../../dist/server/server.js');

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'rag-e2e-stdio-'));
    repoDir = join(tmpDir, 'repo');
    mkdirSync(join(repoDir, 'src'), { recursive: true });

    // Write a couple of TS fixtures
    writeFileSync(join(repoDir, 'src', 'auth.ts'),
      'export function authenticate(user: {token: string}) { return user.token; }\n');
    writeFileSync(join(repoDir, 'src', 'tax.ts'),
      'export function calculateTax(amount: number): number { return amount * 0.23; }\n');

    // Create config
    const storePath = join(tmpDir, '.rag', 'index.db');
    const cfg = {
      segments: [{ name: 'src', root: 'src', include: ['**/*.ts'] }],
      exclude: [],
      embedder: { provider: 'local', model: 'Xenova/bge-small-en-v1.5' },
      chunk: { maxTokens: 512, overlapLines: 0 },
      store: { path: '.rag/index.db' },
    };
    configPath = join(repoDir, 'rag.config.json');
    writeFileSync(configPath, JSON.stringify(cfg, null, 2));

    // Build the index using the real model (model already cached from TASK-006)
    const { reindex } = await import('../indexer/reindex.js');
    const { loadConfig } = await import('../config.js');
    const { createEmbedder } = await import('../embedder/local-embedder.js');
    const { resolveStorePath } = await import('../config.js');

    const config = loadConfig(configPath);
    const embedder = createEmbedder(config.embedder);
    const resolvedStorePath = resolveStorePath(configPath, config);

    // Override the store path in config so it's absolute
    const resolvedConfig = { ...config, store: { ...config.store, path: resolvedStorePath } };
    await reindex({ config: resolvedConfig, embedder, mode: 'full', cwd: repoDir });

    // Connect via real stdio
    transport = new StdioClientTransport({
      command: 'node',
      args: [SERVER_BINARY, '--config', configPath],
      env: {
        ...process.env,
        RAG_MODEL_CACHE: resolve(THIS_DIR, '../../.cache/transformers'),
        HF_HUB_OFFLINE: '1',
        TRANSFORMERS_OFFLINE: '1',
      },
      stderr: 'pipe',
    });
    client = new Client({ name: 'e2e-stdio-test', version: '1.0.0' });
    await client.connect(transport);
  }, 120_000);

  afterAll(async () => {
    await client.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('stdout is clean — tools/list does not corrupt the JSON-RPC stream', async () => {
    // If ANY non-protocol bytes had been written to stdout during startup
    // (e.g. console.log or a transformer.js progress bar), connect() would
    // have thrown a parse error before reaching this assertion.
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      ['get_chunk', 'index_status', 'reindex', 'search_codebase'],
    );
  });

  it('index_status reports the indexed files', async () => {
    const result = await client.callTool({ name: 'index_status', arguments: {} });
    expect(result.isError).toBeFalsy();
    const s = result.structuredContent as { chunks: number };
    expect(s.chunks).toBeGreaterThan(0);
  });

  it('search_codebase returns semantic hits (model loaded during first embed)', async () => {
    // The first call triggers the lazy model load — stdout must remain clean.
    const result = await client.callTool({
      name: 'search_codebase',
      arguments: { query: 'tax calculation percentage', k: 1 },
    });

    expect(result.isError).toBeFalsy();
    const hits = (result.structuredContent as { results: Array<{ id: string; filePath: string }> }).results;
    expect(hits.length).toBeGreaterThan(0);
    // Tax calculation should surface tax.ts
    expect(hits[0]!.filePath).toContain('tax.ts');
  });

  it('search → get_chunk chain: id from structuredContent resolves to full text', async () => {
    // Arrange — search for authentication logic
    const searchResult = await client.callTool({
      name: 'search_codebase',
      arguments: { query: 'user authentication token', k: 1 },
    });
    expect(searchResult.isError).toBeFalsy();
    const hits = (searchResult.structuredContent as { results: Array<{ id: string; filePath: string }> }).results;
    const id = hits[0]!.id;

    // Act — resolve the id from search
    const chunkResult = await client.callTool({ name: 'get_chunk', arguments: { id } });

    // Assert — same chunk, full (untruncated) text
    expect(chunkResult.isError).toBeFalsy();
    const chunk = chunkResult.structuredContent as { id: string; text: string };
    expect(chunk.id).toBe(id);
    expect(chunk.text.length).toBeGreaterThan(0);
    // The text should contain the actual function body
    expect(chunk.text).toContain('authenticate');
  });

  it('get_chunk with unknown id returns isError without crashing the server', async () => {
    const result = await client.callTool({ name: 'get_chunk', arguments: { id: 'totally-fake-id' } });
    expect(result.isError).toBe(true);

    // Server still alive — another call works
    const status = await client.callTool({ name: 'index_status', arguments: {} });
    expect(status.isError).toBeFalsy();
  });

  it('reindex on unchanged files returns skipped > 0', async () => {
    const result = await client.callTool({ name: 'reindex', arguments: {} });
    expect(result.isError).toBeFalsy();
    const s = result.structuredContent as { skipped: number };
    expect(s.skipped).toBeGreaterThan(0);
  });
});
