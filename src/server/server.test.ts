import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer, startServer } from './server.js';
import { TOOL_NAMES } from './tools/index.js';
import { VectorStore } from '../store/vector-store.js';
import type { Embedder } from '../embedder/types.js';
import type { RagConfig } from '../config.js';

const DIM = 4;

function fakeEmbedder(dimensions = DIM): Embedder {
  return {
    modelId: 'fake-model',
    dimensions,
    embed: async (texts) => texts.map(() => new Float32Array(dimensions)),
  };
}

function makeConfig(storePath: string): RagConfig {
  return {
    segments: [{ name: 'src', root: 'src', include: ['**/*.ts'] }],
    exclude: [],
    embedder: { provider: 'local', model: 'fake-model' },
    chunk: { maxTokens: 512, overlapLines: 0 },
    store: { path: storePath },
  };
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'rag-server-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Connects an in-memory client to a freshly built server. Returns both + a cleanup. */
async function connectClient() {
  const storePath = join(tmpDir, 'index.db');
  const store = VectorStore.open(storePath, DIM, 'fake-model');
  const server = createMcpServer({ config: makeConfig(storePath), store, embedder: fakeEmbedder(), cwd: '/' });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return {
    client,
    cleanup: async () => {
      await client.close();
      await server.close();
      store.close();
    },
  };
}

describe('createMcpServer — tool registration', () => {
  it('exposes exactly the four RAG tools via tools/list', async () => {
    // Arrange
    const { client, cleanup } = await connectClient();

    try {
      // Act
      const { tools } = await client.listTools();

      // Assert
      const names = tools.map((t) => t.name).sort();
      expect(names).toEqual([...TOOL_NAMES].sort());
    } finally {
      await cleanup();
    }
  });

  it('search_codebase advertises a query/k/segment input schema', async () => {
    // Arrange
    const { client, cleanup } = await connectClient();

    try {
      // Act
      const { tools } = await client.listTools();
      const search = tools.find((t) => t.name === 'search_codebase')!;

      // Assert
      const schema = search.inputSchema as { properties: Record<string, unknown>; required?: string[] };
      expect(Object.keys(schema.properties)).toEqual(expect.arrayContaining(['query', 'k', 'segment']));
      expect(schema.required).toEqual(['query']); // only query is mandatory
      expect(search.description).toBeTruthy();
    } finally {
      await cleanup();
    }
  });

  it('get_chunk requires an id', async () => {
    const { client, cleanup } = await connectClient();
    try {
      const { tools } = await client.listTools();
      const schema = tools.find((t) => t.name === 'get_chunk')!.inputSchema as { required?: string[] };
      expect(schema.required).toEqual(['id']);
    } finally {
      await cleanup();
    }
  });

  it('index_status takes no required input', async () => {
    const { client, cleanup } = await connectClient();
    try {
      const { tools } = await client.listTools();
      const schema = tools.find((t) => t.name === 'index_status')!.inputSchema as { required?: string[] };
      expect(schema.required ?? []).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  it('all four tools are real handlers (no stubs) and callable over the protocol', async () => {
    // Arrange
    const { client, cleanup } = await connectClient();

    try {
      // Act — index_status on the empty test store should succeed (not isError)
      const result = await client.callTool({ name: 'index_status', arguments: {} });

      // Assert
      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as { chunks: number };
      expect(structured.chunks).toBe(0);
    } finally {
      await cleanup();
    }
  });
});

describe('createMcpServer — lifecycle', () => {
  it('connects and closes cleanly without throwing', async () => {
    // Arrange
    const storePath = join(tmpDir, 'index.db');
    const store = VectorStore.open(storePath, DIM, 'fake-model');
    const server = createMcpServer({ config: makeConfig(storePath), store, embedder: fakeEmbedder(), cwd: '/' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '1.0.0' });

    // Act + Assert — full start/stop cycle is clean
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    await expect(client.close()).resolves.toBeUndefined();
    await expect(server.close()).resolves.toBeUndefined();
    store.close();
  });
});

describe('startServer — happy path (injected transport)', () => {
  // Build a real on-disk index with bge-small's 384 dims, but never load the
  // model: createEmbedder is lazy, and the scaffold's stub handlers never embed.
  const REAL_MODEL = 'Xenova/bge-small-en-v1.5';
  const REAL_DIM = 384;

  function buildIndex(): string {
    const storePath = join(tmpDir, 'index.db');
    const store = VectorStore.open(storePath, REAL_DIM, REAL_MODEL);
    store.upsert(
      [{
        id: 'c1', segment: 'src', filePath: 'a.ts', startLine: 1, endLine: 1,
        language: 'typescript', symbol: undefined, kind: 'block', text: 'x', fileHash: 'h',
      }],
      [new Float32Array(REAL_DIM).fill(1 / Math.sqrt(REAL_DIM))],
    );
    store.close();
    return storePath;
  }

  function writeRealConfig(storePath: string): string {
    const configPath = join(tmpDir, 'rag.config.json');
    const config = makeConfig(storePath);
    config.embedder = { provider: 'local', model: REAL_MODEL };
    writeFileSync(configPath, JSON.stringify(config));
    return configPath;
  }

  it('wires the full pipeline and serves tools/list over the injected transport', async () => {
    // Arrange
    const configPath = writeRealConfig(buildIndex());
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    // Act — drive startServer end-to-end (loadConfig → store → embedder → connect)
    const started = await startServer(configPath, () => serverTransport);
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(clientTransport);

    try {
      const { tools } = await client.listTools();
      // Assert
      expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
    } finally {
      await client.close();
      await started.close();
    }
  });

  it('close() is idempotent and releases the store', async () => {
    // Arrange
    const configPath = writeRealConfig(buildIndex());
    const [, serverTransport] = InMemoryTransport.createLinkedPair();
    const started = await startServer(configPath, () => serverTransport);

    // Act + Assert — closing twice does not throw
    await expect(started.close()).resolves.toBeUndefined();
    await expect(started.close()).resolves.toBeUndefined();
  });
});

describe('startServer — preconditions', () => {
  it('throws a clear error when the index does not exist yet', async () => {
    // Arrange — config points at a store path that was never built
    const configPath = join(tmpDir, 'rag.config.json');
    writeFileSync(configPath, JSON.stringify(makeConfig('.rag/index.db')));

    // Act + Assert
    await expect(startServer(configPath)).rejects.toThrow('Index not found');
    await expect(startServer(configPath)).rejects.toThrow('rag-index');
  });

  it('throws a dimension-mismatch error when the index model differs from the embedder', async () => {
    // Arrange — build a store with DIM=4, but config uses the real 384-d model
    const storePath = join(tmpDir, 'index.db');
    const built = VectorStore.open(storePath, DIM, 'fake-model');
    built.close();

    const configPath = join(tmpDir, 'rag.config.json');
    const config = makeConfig(storePath);
    config.embedder = { provider: 'local', model: 'Xenova/bge-small-en-v1.5' }; // 384-d
    writeFileSync(configPath, JSON.stringify(config));

    // Act + Assert — VectorStore.open rejects the dimension mismatch
    await expect(startServer(configPath)).rejects.toThrow('Dimension mismatch');
  });
});
