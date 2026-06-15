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

function rustFile(relativePath = 'sample.rs'): WalkedFile {
  return { absolutePath: join(FIXTURES, relativePath), relativePath, segment: 'test', language: 'rust' };
}
function chunk(text: string, file = rustFile()): Promise<Chunk[]> {
  return chunkTreeSitter(text, file, CONFIG, sha1(text));
}
const bySymbol = (chunks: Chunk[], symbol: string) => chunks.find((c) => c.symbol === symbol);

describe('Rust walk (generic tree-sitter chunker)', () => {
  const text = readFileSync(join(FIXTURES, 'sample.rs'), 'utf-8');

  it('emits a fn as kind=function with name', async () => {
    const fn = bySymbol(await chunk(text), 'add');
    expect(fn).toBeDefined();
    expect(fn!.kind).toBe('function');
    expect(fn!.startLine).toBeGreaterThan(0);
  });

  it('emits struct and enum as kind=type', async () => {
    const chunks = await chunk(text);
    expect(bySymbol(chunks, 'Point')?.kind).toBe('type');
    expect(bySymbol(chunks, 'Direction')?.kind).toBe('type');
  });

  it('emits a trait as kind=interface', async () => {
    const t = bySymbol(await chunk(text), 'Shape');
    expect(t).toBeDefined();
    expect(t!.kind).toBe('interface');
  });

  it('emits impl methods as Type.method (inherent and trait impls)', async () => {
    const chunks = await chunk(text);
    expect(bySymbol(chunks, 'Point.new')?.kind).toBe('method');       // inherent impl
    expect(bySymbol(chunks, 'Point.magnitude')?.kind).toBe('method'); // private method
    expect(bySymbol(chunks, 'Point.area')?.kind).toBe('method');      // impl Shape for Point
  });

  it('includes the leading /// doc comment in the chunk', async () => {
    const fn = bySymbol(await chunk(text), 'add')!;
    expect(fn.text).toContain('/// Adds two numbers.');
  });

  it('captures the top-level const as a block gap chunk', async () => {
    const chunks = await chunk(text);
    expect(chunks.some((c) => c.kind === 'block' && c.text.includes('const VERSION'))).toBe(true);
  });

  it('does not throw on broken syntax (tree-sitter is error-tolerant)', async () => {
    await expect(chunk('pub fn broken( {')).resolves.toBeDefined();
  });
});
