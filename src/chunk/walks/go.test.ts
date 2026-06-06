import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { chunkTreeSitter } from '../tree-sitter.js';
import { sha1 } from '../../hash.js';
import type { WalkedFile } from '../../walker.js';
import type { Chunk } from '../types.js';
import type { RagChunkConfig } from '../../config.js';

// Hermetic grammar cache — ensureGrammar copies tree-sitter-go.wasm here.
process.env['RAG_GRAMMAR_CACHE'] = mkdtempSync(join(tmpdir(), 'rag-go-test-grammars-'));

const FIXTURES = join(import.meta.dirname, '../../__fixtures__');
const CONFIG: RagChunkConfig = { maxTokens: 512, overlapLines: 4 };

function goFile(relativePath = 'sample.go'): WalkedFile {
  return { absolutePath: join(FIXTURES, relativePath), relativePath, segment: 'test', language: 'go' };
}
function chunk(text: string, file = goFile()): Promise<Chunk[]> {
  return chunkTreeSitter(text, file, CONFIG, sha1(text));
}
const bySymbol = (chunks: Chunk[], symbol: string) => chunks.find((c) => c.symbol === symbol);

describe('Go walk (generic tree-sitter chunker)', () => {
  const text = readFileSync(join(FIXTURES, 'sample.go'), 'utf-8');

  it('emits a function chunk with name and 1-based line range', async () => {
    const fn = bySymbol(await chunk(text), 'Greet');
    expect(fn).toBeDefined();
    expect(fn!.kind).toBe('function');
    expect(fn!.startLine).toBeGreaterThan(0);
    expect(fn!.endLine).toBeGreaterThanOrEqual(fn!.startLine);
  });

  it('emits a struct type as kind=type', async () => {
    const t = bySymbol(await chunk(text), 'Animal');
    expect(t).toBeDefined();
    expect(t!.kind).toBe('type');
  });

  it('emits an interface type as kind=interface', async () => {
    const i = bySymbol(await chunk(text), 'Speaker');
    expect(i).toBeDefined();
    expect(i!.kind).toBe('interface');
  });

  it('emits methods as Receiver.method (value and pointer receivers)', async () => {
    const chunks = await chunk(text);
    const speak = bySymbol(chunks, 'Animal.Speak');
    const setName = bySymbol(chunks, 'Animal.SetName');
    expect(speak).toBeDefined();
    expect(speak!.kind).toBe('method');
    expect(setName).toBeDefined(); // pointer receiver (*Animal) → still "Animal"
    expect(setName!.kind).toBe('method');
  });

  it('includes the leading doc comment in the chunk', async () => {
    const fn = bySymbol(await chunk(text), 'Greet')!;
    expect(fn.text).toContain('// Greet returns a greeting.');
  });

  it('captures package/import/const as block gap chunks', async () => {
    const chunks = await chunk(text);
    const block = chunks.find((c) => c.kind === 'block' && c.text.includes('package sample'));
    expect(block).toBeDefined();
    expect(chunks.some((c) => c.kind === 'block' && c.text.includes('const Version'))).toBe(true);
  });

  it('does not throw on broken syntax (tree-sitter is error-tolerant)', async () => {
    await expect(chunk('package x\nfunc broken( {')).resolves.toBeDefined();
  });
});
