import { describe, it, expect } from 'vitest';
import { chunkYaml } from './yaml-chunker.js';
import { sha1 } from '../hash.js';
import type { WalkedFile } from '../walker.js';
import type { RagChunkConfig } from '../config.js';
import type { Chunk } from './types.js';

const CONFIG: RagChunkConfig = { maxTokens: 512, overlapLines: 4 };

function yamlFile(relativePath = 'config.yml'): WalkedFile {
  return { absolutePath: `/proj/${relativePath}`, relativePath, segment: 'test', language: 'yaml' };
}
function chunk(text: string): Chunk[] {
  return chunkYaml(text, yamlFile(), CONFIG, sha1(text));
}
const bySymbol = (chunks: Chunk[], symbol: string) => chunks.find((c) => c.symbol === symbol);

describe('chunkYaml', () => {
  it('emits one chunk per top-level key with the key as symbol', () => {
    const text = [
      'version: "3.8"',
      'services:',
      '  web:',
      '    image: nginx',
      '  db:',
      '    image: postgres',
    ].join('\n');

    const chunks = chunk(text);
    const version = bySymbol(chunks, 'version');
    const services = bySymbol(chunks, 'services');
    expect(version).toBeDefined();
    expect(version!.kind).toBe('block');
    expect(services).toBeDefined();
    // Nested keys (web/db) must NOT split the services block.
    expect(services!.text).toContain('web:');
    expect(services!.text).toContain('db:');
  });

  it('does not treat indented keys as top-level anchors', () => {
    const text = ['jobs:', '  build:', '    runs-on: ubuntu'].join('\n');
    const chunks = chunk(text);
    expect(bySymbol(chunks, 'jobs')).toBeDefined();
    expect(bySymbol(chunks, 'build')).toBeUndefined(); // indented → part of jobs
  });

  it('keys on the name, not on a URL scheme in the value', () => {
    const chunks = chunk('homepage: http://example.com\n');
    expect(bySymbol(chunks, 'homepage')).toBeDefined();
    expect(bySymbol(chunks, 'http')).toBeUndefined();
  });

  it('attaches a leading comment directly above a key to its block', () => {
    const text = ['# the application port', 'port: 8080', 'host: localhost'].join('\n');
    const port = bySymbol(chunk(text), 'port');
    expect(port).toBeDefined();
    expect(port!.text).toContain('# the application port');
    expect(port!.startLine).toBe(1); // block extends up to include the comment
  });

  it('indexes each document of a multi-document stream separately', () => {
    const text = [
      'kind: ConfigMap',
      'name: first',
      '---',
      'kind: Secret',
      'name: second',
    ].join('\n');

    const chunks = chunk(text);
    // Both documents share key names; each top-level key still yields chunks.
    const kinds = chunks.filter((c) => c.symbol === 'kind');
    const names = chunks.filter((c) => c.symbol === 'name');
    expect(kinds.length).toBe(2);
    expect(names.length).toBe(2);
  });

  it('puts a leading document marker / comment in a preamble block', () => {
    const text = ['---', 'name: app'].join('\n');
    const chunks = chunk(text);
    expect(chunks.some((c) => c.text.includes('---'))).toBe(true);
    expect(bySymbol(chunks, 'name')).toBeDefined();
  });

  it('returns a single empty chunk for an empty file', () => {
    const chunks = chunk('');
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.text).toBe('');
  });

  it('line-chunks a comments-only file (no top-level keys)', () => {
    const chunks = chunk('# just a note\n# and another\n');
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    expect(chunks[0]!.text).toContain('# just a note');
  });

  it('windows an oversized block into multiple chunks keeping the key symbol', () => {
    const big = ['data:', ...Array.from({ length: 600 }, (_, i) => `  item${i}: value${i}`)].join('\n');
    const chunks = chunk(big);
    const dataChunks = chunks.filter((c) => c.symbol === 'data');
    expect(dataChunks.length).toBeGreaterThan(1);
    // Disjoint, ascending ranges (stable incremental-reindex ids).
    expect(dataChunks[0]!.startLine).toBe(1);
  });

  it('produces deterministic ids via createChunk (stable across runs)', () => {
    const text = 'a: 1\nb: 2\n';
    expect(chunk(text).map((c) => c.id)).toEqual(chunk(text).map((c) => c.id));
  });
});
