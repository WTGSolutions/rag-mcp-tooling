import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { chunkTreeSitter } from '../tree-sitter.js';
import { sha1 } from '../../hash.js';
import type { WalkedFile } from '../../walker.js';
import type { Chunk } from '../types.js';
import type { RagChunkConfig } from '../../config.js';

const FIXTURES = join(import.meta.dirname, '../../__fixtures__');
const CONFIG: RagChunkConfig = { maxTokens: 512, overlapLines: 4 };

function swiftFile(relativePath = 'sample.swift'): WalkedFile {
  return { absolutePath: join(FIXTURES, relativePath), relativePath, segment: 'test', language: 'swift' };
}
function chunk(text: string, file = swiftFile()): Promise<Chunk[]> {
  return chunkTreeSitter(text, file, CONFIG, sha1(text));
}
const bySymbol = (chunks: Chunk[], symbol: string) => chunks.find((c) => c.symbol === symbol);

describe('Swift walk (generic tree-sitter chunker, vendored grammar)', () => {
  const text = readFileSync(join(FIXTURES, 'sample.swift'), 'utf-8');

  it('emits a struct as kind=type with a 1-based line range', async () => {
    const s = bySymbol(await chunk(text), 'Point');
    expect(s).toBeDefined();
    expect(s!.kind).toBe('type');
    expect(s!.startLine).toBeGreaterThan(0);
    expect(s!.endLine).toBeGreaterThanOrEqual(s!.startLine);
  });

  it('emits a struct member function as Struct.method', async () => {
    const dist = bySymbol(await chunk(text), 'Point.dist');
    expect(dist).toBeDefined();
    expect(dist!.kind).toBe('method');
  });

  it('emits a class as kind=class with its methods', async () => {
    const chunks = await chunk(text);
    expect(bySymbol(chunks, 'ViewController')!.kind).toBe('class');
    expect(bySymbol(chunks, 'ViewController.viewDidLoad')!.kind).toBe('method');
    expect(bySymbol(chunks, 'ViewController.setup')!.kind).toBe('method');
  });

  it('emits a protocol as kind=interface with its requirement signatures', async () => {
    const chunks = await chunk(text);
    expect(bySymbol(chunks, 'Service')!.kind).toBe('interface');
    expect(bySymbol(chunks, 'Service.handle')!.kind).toBe('method');
  });

  it('emits an enum as kind=type with its methods', async () => {
    const chunks = await chunk(text);
    expect(bySymbol(chunks, 'Color')!.kind).toBe('type');
    expect(bySymbol(chunks, 'Color.hex')!.kind).toBe('method');
  });

  it('emits an extension as kind=block carrying the extended type name', async () => {
    const chunks = await chunk(text);
    const mag = bySymbol(chunks, 'Point.magnitude');
    expect(mag).toBeDefined();
    expect(mag!.kind).toBe('method');
    // The extension itself is a block chunk keyed by the extended type.
    expect(chunks.some((c) => c.kind === 'block' && c.symbol === 'Point')).toBe(true);
  });

  it('emits init and deinit as methods (distinct node types, not function_declaration)', async () => {
    const chunks = await chunk(text);
    const init = bySymbol(chunks, 'Account.init');
    const deinit = bySymbol(chunks, 'Account.deinit');
    expect(init).toBeDefined();
    expect(init!.kind).toBe('method');
    expect(deinit).toBeDefined();
    expect(deinit!.kind).toBe('method');
  });

  it('classifies an actor as kind=class (reference type) with its methods', async () => {
    const chunks = await chunk(text);
    expect(bySymbol(chunks, 'Counter')!.kind).toBe('class');
    expect(bySymbol(chunks, 'Counter.increment')!.kind).toBe('method');
  });

  it('emits a top-level function as kind=function', async () => {
    const fn = bySymbol(await chunk(text), 'topLevel');
    expect(fn).toBeDefined();
    expect(fn!.kind).toBe('function');
  });

  it('includes the leading doc comment in the chunk', async () => {
    const vc = bySymbol(await chunk(text), 'ViewController')!;
    expect(vc.text).toContain('// A view controller.');
  });

  it('does not throw on broken syntax (tree-sitter is error-tolerant)', async () => {
    await expect(chunk('func broken( {')).resolves.toBeDefined();
  });
});
