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
  const server = createMcpServer({ config: makeConfig(storePath), store, embedder: fakeEmbedder() });

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

  it('stub handlers return a graceful "not implemented" error result', async () => {
    // Arrange
    const { client, cleanup } = await connectClient();

    try {
      // Act
      const result = await client.callTool({ name: 'index_status', arguments: {} });

      // Assert — error flagged, but the call itself does not throw
      expect(result.isError).toBe(true);
      const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
      expect(text).toContain('not implemented');
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
    const server = createMcpServer({ config: makeConfig(storePath), store, embedder: fakeEmbedder() });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '1.0.0' });

    // Act + Assert — full start/stop cycle is clean
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    await expect(client.close()).resolves.toBeUndefined();
    await expect(server.close()).resolves.toBeUndefined();
    store.close();
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
