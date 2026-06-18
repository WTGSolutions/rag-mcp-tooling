import { beforeAll, describe, expect, it } from 'vitest';
import type { RagChunkConfig } from '../config.js';
import { sha1 } from '../hash.js';
import type { WalkedFile } from '../walker.js';
import { chunkTreeSitter } from './tree-sitter.js';
import type { Chunk } from './types.js';

// TASK-045: language walks attach file-level `imports` and per-symbol `callees`
// to chunks. Other chunkers (line/markdown/other languages) leave them undefined.

beforeAll(() => {
  // grammars are resolved lazily by chunkTreeSitter; nothing to pre-warm here.
});

const CONFIG: RagChunkConfig = { maxTokens: 512, overlapLines: 4 };

function file(relativePath: string, language: WalkedFile['language']): WalkedFile {
  return {
    absolutePath: `/proj/${relativePath}`,
    relativePath,
    segment: 'test',
    language,
  };
}

function chunk(text: string, f: WalkedFile): Promise<Chunk[]> {
  return chunkTreeSitter(text, f, CONFIG, sha1(text));
}

function bySymbol(chunks: Chunk[], symbol: string): Chunk | undefined {
  return chunks.find((c) => c.symbol === symbol);
}

describe('TypeScript metadata extraction', () => {
  const SRC = [
    "import { readFile } from 'node:fs';",
    "import { helper } from './util.js';",
    '',
    'export function run(): void {',
    '  helper();',
    '  console.log(readFile);',
    '}',
    '',
    'export const noop = () => {};',
  ].join('\n');

  it('attaches file-level imports to symbol chunks', async () => {
    const chunks = await chunk(SRC, file('src/main.ts', 'typescript'));
    const run = bySymbol(chunks, 'run');
    expect(run?.imports).toEqual(['node:fs', './util.js']);
  });

  it('attaches per-symbol callees (bare call names, incl. member calls)', async () => {
    const chunks = await chunk(SRC, file('src/main.ts', 'typescript'));
    const run = bySymbol(chunks, 'run');
    expect(run?.callees).toContain('helper');
    expect(run?.callees).toContain('log'); // console.log → member property name
  });

  it('a symbol with no calls has no callees field', async () => {
    const chunks = await chunk(SRC, file('src/main.ts', 'typescript'));
    const noop = bySymbol(chunks, 'noop');
    expect(noop?.callees).toBeUndefined();
    // but it still carries the file imports
    expect(noop?.imports).toEqual(['node:fs', './util.js']);
  });
});

describe('Python metadata extraction', () => {
  const SRC = [
    'import os',
    'from mymod import thing',
    '',
    'def run():',
    '    thing()',
    "    os.path.join('a', 'b')",
    '',
    'def empty():',
    '    pass',
  ].join('\n');

  it('attaches file-level imports', async () => {
    const chunks = await chunk(SRC, file('src/main.py', 'python'));
    const run = bySymbol(chunks, 'run');
    expect(run?.imports).toEqual(['os', 'mymod']);
  });

  it('attaches per-symbol callees (function + attribute calls)', async () => {
    const chunks = await chunk(SRC, file('src/main.py', 'python'));
    const run = bySymbol(chunks, 'run');
    expect(run?.callees).toContain('thing');
    expect(run?.callees).toContain('join'); // os.path.join → attribute name
  });

  it('a symbol with no calls has no callees field', async () => {
    const chunks = await chunk(SRC, file('src/main.py', 'python'));
    expect(bySymbol(chunks, 'empty')?.callees).toBeUndefined();
  });
});

describe('non-TS/Python chunkers leave metadata empty', () => {
  it('line-chunked (unknown language) chunks carry no imports/callees', async () => {
    const chunks = await chunk('plain text\nno grammar here\n', file('notes.txt', 'unknown'));
    expect(chunks.length).toBeGreaterThan(0);
    for (const c of chunks) {
      expect(c.imports).toBeUndefined();
      expect(c.callees).toBeUndefined();
    }
  });
});
