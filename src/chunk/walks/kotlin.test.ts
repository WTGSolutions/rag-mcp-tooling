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

function ktFile(relativePath = 'sample.kt'): WalkedFile {
  return { absolutePath: join(FIXTURES, relativePath), relativePath, segment: 'test', language: 'kotlin' };
}
function chunk(text: string, file = ktFile()): Promise<Chunk[]> {
  return chunkTreeSitter(text, file, CONFIG, sha1(text));
}
const bySymbol = (chunks: Chunk[], symbol: string) => chunks.find((c) => c.symbol === symbol);

describe('Kotlin walk (generic tree-sitter chunker)', () => {
  const text = readFileSync(join(FIXTURES, 'sample.kt'), 'utf-8');

  it('emits a data class as kind=class with a 1-based line range', async () => {
    const c = bySymbol(await chunk(text), 'Point');
    expect(c).toBeDefined();
    expect(c!.kind).toBe('class');
    expect(c!.startLine).toBeGreaterThan(0);
    expect(c!.endLine).toBeGreaterThanOrEqual(c!.startLine);
  });

  it('emits class methods as Class.method', async () => {
    const chunks = await chunk(text);
    const find = bySymbol(chunks, 'Repository.findById');
    const save = bySymbol(chunks, 'Repository.save');
    expect(find).toBeDefined();
    expect(find!.kind).toBe('method');
    expect(save).toBeDefined();
    expect(save!.kind).toBe('method');
  });

  it('emits a member function of a data class as Class.method', async () => {
    const dist = bySymbol(await chunk(text), 'Point.dist');
    expect(dist).toBeDefined();
    expect(dist!.kind).toBe('method');
  });

  it('emits an interface as kind=interface', async () => {
    const i = bySymbol(await chunk(text), 'Service');
    expect(i).toBeDefined();
    expect(i!.kind).toBe('interface');
  });

  it('emits an object declaration as kind=class', async () => {
    const o = bySymbol(await chunk(text), 'Singleton');
    expect(o).toBeDefined();
    expect(o!.kind).toBe('class');
  });

  it('emits an enum class as kind=type', async () => {
    const e = bySymbol(await chunk(text), 'Color');
    expect(e).toBeDefined();
    expect(e!.kind).toBe('type');
  });

  it('emits a top-level function as kind=function', async () => {
    const fn = bySymbol(await chunk(text), 'topLevel');
    expect(fn).toBeDefined();
    expect(fn!.kind).toBe('function');
  });

  it('includes the leading doc comment in the chunk', async () => {
    const repo = bySymbol(await chunk(text), 'Repository')!;
    expect(repo.text).toContain('// Repository over a backing store.');
  });

  it('captures package/import as block gap chunks', async () => {
    const chunks = await chunk(text);
    expect(chunks.some((c) => c.kind === 'block' && c.text.includes('package com.example.geo'))).toBe(true);
  });

  it('does not throw on broken syntax (tree-sitter is error-tolerant)', async () => {
    await expect(chunk('fun broken( {')).resolves.toBeDefined();
  });
});
