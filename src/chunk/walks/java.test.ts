import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { chunkTreeSitter } from '../tree-sitter.js';
import { sha1 } from '../../hash.js';
import type { WalkedFile } from '../../walker.js';
import type { Chunk } from '../types.js';
import type { RagChunkConfig } from '../../config.js';

// Hermetic grammar cache — ensureGrammar copies tree-sitter-java.wasm here.
process.env['RAG_GRAMMAR_CACHE'] = mkdtempSync(join(tmpdir(), 'rag-java-test-grammars-'));

const FIXTURES = join(import.meta.dirname, '../../__fixtures__');
const CONFIG: RagChunkConfig = { maxTokens: 512, overlapLines: 4 };

function javaFile(relativePath = 'sample.java'): WalkedFile {
  return { absolutePath: join(FIXTURES, relativePath), relativePath, segment: 'test', language: 'java' };
}
function chunk(text: string, file = javaFile()): Promise<Chunk[]> {
  return chunkTreeSitter(text, file, CONFIG, sha1(text));
}
const bySymbol = (chunks: Chunk[], symbol: string) => chunks.find((c) => c.symbol === symbol);

describe('Java walk (generic tree-sitter chunker)', () => {
  const text = readFileSync(join(FIXTURES, 'sample.java'), 'utf-8');

  it('emits a class chunk with name and 1-based line range', async () => {
    const cls = bySymbol(await chunk(text), 'Geofence');
    expect(cls).toBeDefined();
    expect(cls!.kind).toBe('class');
    expect(cls!.startLine).toBeGreaterThan(0);
    expect(cls!.endLine).toBeGreaterThanOrEqual(cls!.startLine);
  });

  it('emits methods and constructor as Class.member', async () => {
    const chunks = await chunk(text);
    expect(bySymbol(chunks, 'Geofence.contains')?.kind).toBe('method');
    expect(bySymbol(chunks, 'Geofence.haversine')?.kind).toBe('method');
    expect(bySymbol(chunks, 'Geofence.constructor')?.kind).toBe('method');
  });

  it('includes the leading Javadoc and a preceding @annotation in the chunk', async () => {
    const chunks = await chunk(text);
    const cls = bySymbol(chunks, 'Geofence')!;
    expect(cls.text).toContain('A circular geofence'); // Javadoc rode along
    const contains = bySymbol(chunks, 'Geofence.contains')!;
    expect(contains.text).toContain('@Override'); // annotation is part of the node span
  });

  it('emits an interface as kind=interface', async () => {
    const i = bySymbol(await chunk(text), 'Region');
    expect(i).toBeDefined();
    expect(i!.kind).toBe('interface');
  });

  it('emits an enum as kind=type', async () => {
    const e = bySymbol(await chunk(text), 'Severity');
    expect(e).toBeDefined();
    expect(e!.kind).toBe('type');
  });

  it('does not throw on broken syntax (tree-sitter is error-tolerant)', async () => {
    await expect(chunk('public class Broken { void m( {')).resolves.toBeDefined();
  });
});
