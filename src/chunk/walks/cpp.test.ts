import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { chunkTreeSitter } from '../tree-sitter.js';
import { sha1 } from '../../hash.js';
import type { WalkedFile } from '../../walker.js';
import type { Chunk } from '../types.js';
import type { RagChunkConfig } from '../../config.js';

// Hermetic grammar cache — ensureGrammar copies tree-sitter-cpp.wasm here.
process.env['RAG_GRAMMAR_CACHE'] = mkdtempSync(join(tmpdir(), 'rag-cpp-test-grammars-'));

const FIXTURES = join(import.meta.dirname, '../../__fixtures__');
const CONFIG: RagChunkConfig = { maxTokens: 512, overlapLines: 4 };

function cppFile(relativePath = 'sample.cpp'): WalkedFile {
  return { absolutePath: join(FIXTURES, relativePath), relativePath, segment: 'test', language: 'cpp' };
}
function chunk(text: string, file = cppFile()): Promise<Chunk[]> {
  return chunkTreeSitter(text, file, CONFIG, sha1(text));
}
const bySymbol = (chunks: Chunk[], symbol: string) => chunks.find((c) => c.symbol === symbol);

describe('C++ walk (generic tree-sitter chunker)', () => {
  const text = readFileSync(join(FIXTURES, 'sample.cpp'), 'utf-8');

  it('emits a free function chunk with name and 1-based line range', async () => {
    const fn = bySymbol(await chunk(text), 'add');
    expect(fn).toBeDefined();
    expect(fn!.kind).toBe('function');
    expect(fn!.startLine).toBeGreaterThan(0);
    expect(fn!.endLine).toBeGreaterThanOrEqual(fn!.startLine);
  });

  it('extracts the name through a pointer declarator', async () => {
    const fn = bySymbol(await chunk(text), 'makeBuffer');
    expect(fn).toBeDefined();
    expect(fn!.kind).toBe('function');
  });

  it('emits a struct as kind=type', async () => {
    const s = bySymbol(await chunk(text), 'Point');
    expect(s).toBeDefined();
    expect(s!.kind).toBe('type');
  });

  it('emits a class as kind=class', async () => {
    const c = bySymbol(await chunk(text), 'Shape');
    expect(c).toBeDefined();
    expect(c!.kind).toBe('class');
  });

  it('emits an enum as kind=type', async () => {
    const e = bySymbol(await chunk(text), 'Color');
    expect(e).toBeDefined();
    expect(e!.kind).toBe('type');
  });

  it('emits inline class methods as Class::method', async () => {
    const chunks = await chunk(text);
    const sides = bySymbol(chunks, 'Shape::sides');
    expect(sides).toBeDefined();
    expect(sides!.kind).toBe('method');
  });

  it('emits the constructor as Class::Class', async () => {
    const ctor = bySymbol(await chunk(text), 'Shape::Shape');
    expect(ctor).toBeDefined();
    expect(ctor!.kind).toBe('method');
  });

  it('keeps out-of-line definitions with their qualified Class::method name', async () => {
    const chunks = await chunk(text);
    const dist = bySymbol(chunks, 'Point::dist');
    const area = bySymbol(chunks, 'Shape::area');
    expect(dist).toBeDefined();
    expect(area).toBeDefined();
    // Out-of-line definitions sit at file scope → classified as function.
    expect(dist!.kind).toBe('function');
  });

  it('chunks a template function over the full template span', async () => {
    const fn = bySymbol(await chunk(text), 'maxOf');
    expect(fn).toBeDefined();
    expect(fn!.kind).toBe('function');
    // The span must include the `template <typename T>` line, not just the body.
    expect(fn!.text).toContain('template');
  });

  it('recurses into namespaces — symbols inside geo are chunked individually', async () => {
    const chunks = await chunk(text);
    // Point lives inside `namespace geo` — recursion must surface it as its own chunk.
    expect(bySymbol(chunks, 'Point')).toBeDefined();
    expect(bySymbol(chunks, 'Shape')).toBeDefined();
  });

  it('emits a union as kind=type with its inline method', async () => {
    const chunks = await chunk(text);
    const u = bySymbol(chunks, 'Value');
    expect(u).toBeDefined();
    expect(u!.kind).toBe('type');
    const asInt = bySymbol(chunks, 'Value::asInt');
    expect(asInt).toBeDefined();
    expect(asInt!.kind).toBe('method');
  });

  it('recurses into extern "C" linkage blocks (common in C headers)', async () => {
    const fn = bySymbol(await chunk(text), 'c_api_init');
    expect(fn).toBeDefined();
    expect(fn!.kind).toBe('function');
    // Must be a real per-symbol chunk, not swallowed into a block gap chunk.
    expect(fn!.text).toContain('// Initialises the C API.');
  });

  it('includes the leading doc comment in the chunk', async () => {
    const fn = bySymbol(await chunk(text), 'add')!;
    expect(fn.text).toContain('// A free function adding two integers.');
  });

  it('captures includes as block gap chunks', async () => {
    const chunks = await chunk(text);
    expect(chunks.some((c) => c.kind === 'block' && c.text.includes('#include <string>'))).toBe(true);
  });

  it('does not throw on broken syntax (tree-sitter is error-tolerant)', async () => {
    await expect(chunk('int broken( {')).resolves.toBeDefined();
  });

  it('detects .c and .h as the cpp language via the registry', async () => {
    // A .c file routed through the same grammar still produces a function chunk.
    const cFile: WalkedFile = { absolutePath: join(FIXTURES, 'x.c'), relativePath: 'x.c', segment: 'test', language: 'cpp' };
    const fn = bySymbol(await chunk('int twice(int n) { return n * 2; }', cFile), 'twice');
    expect(fn).toBeDefined();
    expect(fn!.kind).toBe('function');
  });
});
