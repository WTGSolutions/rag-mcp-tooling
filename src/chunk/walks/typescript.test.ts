import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { readFileSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
// Generic registry-driven chunker; aliased to keep the TS-focused test body intact.
import { chunkTreeSitter as chunkTreeSitterTS } from '../tree-sitter.js';
import { sha1 } from '../../hash.js';
import type { WalkedFile } from '../../walker.js';
import type { Chunk } from '../types.js';
import type { RagChunkConfig } from '../../config.js';

// Hermetic grammar cache so ensureGrammar copies the TS/TSX wasm to a temp dir
// instead of the user's real ~/.cache (read at call time by grammarCacheDir).
process.env['RAG_GRAMMAR_CACHE'] = mkdtempSync(join(tmpdir(), 'rag-ts-walk-grammars-'));

// Ports the ts-morph AST chunker's validated contract (84% hit@5) to the
// tree-sitter TS walk that replaced it. Behaviours must hold node-for-node.

function makeFile(overrides: Partial<WalkedFile> = {}): WalkedFile {
  return {
    absolutePath: '/proj/web/src/sample.ts',
    relativePath: 'src/sample.ts',
    segment: 'web',
    language: 'typescript',
    ...overrides,
  };
}

const CONFIG: RagChunkConfig = { maxTokens: 512, overlapLines: 4 };

function chunk(text: string, file = makeFile()): Promise<Chunk[]> {
  return chunkTreeSitterTS(text, file, CONFIG, sha1(text));
}

function bySymbol(chunks: Chunk[], symbol: string): Chunk | undefined {
  return chunks.find((c) => c.symbol === symbol);
}

describe('TypeScript walk (generic tree-sitter chunker)', () => {
  describe('top-level symbols', () => {
    it('extracts a function declaration with symbol, kind and 1-based line range', async () => {
      const text = [
        'export function add(a: number, b: number): number {',
        '  return a + b;',
        '}',
      ].join('\n');

      const chunks = await chunk(text);

      const fn = bySymbol(chunks, 'add');
      expect(fn).toBeDefined();
      expect(fn!.kind).toBe('function');
      expect(fn!.startLine).toBe(1);
      expect(fn!.endLine).toBe(3);
      expect(fn!.text).toContain('return a + b;');
    });

    it('treats an exported arrow-function const as a function chunk', async () => {
      const text = [
        'export const greet = (name: string): string => {',
        '  return `hi ${name}`;',
        '};',
      ].join('\n');

      const fn = bySymbol(await chunk(text), 'greet');
      expect(fn).toBeDefined();
      expect(fn!.kind).toBe('function');
    });

    it('extracts an interface as an interface chunk', async () => {
      const text = ['export interface User {', '  id: string;', '  name: string;', '}'].join('\n');
      const iface = bySymbol(await chunk(text), 'User');
      expect(iface).toBeDefined();
      expect(iface!.kind).toBe('interface');
    });

    it('extracts a type alias as a type chunk', async () => {
      const ta = bySymbol(await chunk("export type Status = 'on' | 'off';"), 'Status');
      expect(ta).toBeDefined();
      expect(ta!.kind).toBe('type');
    });
  });

  describe('classes', () => {
    const text = [
      'export class Calc {',
      '  private total = 0;',
      '',
      '  add(n: number): number {',
      '    this.total += n;',
      '    return this.total;',
      '  }',
      '',
      '  static zero(): number {',
      '    return 0;',
      '  }',
      '}',
    ].join('\n');

    it('emits a class chunk for the whole class', async () => {
      const cls = bySymbol(await chunk(text), 'Calc');
      expect(cls).toBeDefined();
      expect(cls!.kind).toBe('class');
      expect(cls!.startLine).toBe(1);
      expect(cls!.endLine).toBe(12);
    });

    it('emits a separate method chunk per method, namespaced by class', async () => {
      const chunks = await chunk(text);
      const add = bySymbol(chunks, 'Calc.add');
      const zero = bySymbol(chunks, 'Calc.zero');
      expect(add).toBeDefined();
      expect(add!.kind).toBe('method');
      expect(zero).toBeDefined();
      expect(zero!.kind).toBe('method');
    });

    it('method chunks overlap the class chunk by design', async () => {
      const chunks = await chunk(text);
      const cls = bySymbol(chunks, 'Calc')!;
      const add = bySymbol(chunks, 'Calc.add')!;
      expect(add.startLine).toBeGreaterThanOrEqual(cls.startLine);
      expect(add.endLine).toBeLessThanOrEqual(cls.endLine);
    });

    it('emits a constructor chunk named ClassName.constructor', async () => {
      const ctorText = [
        'export class Service {',
        '  constructor(private readonly url: string) {}',
        '}',
      ].join('\n');
      expect(bySymbol(await chunk(ctorText), 'Service.constructor')).toBeDefined();
    });
  });

  describe('JSDoc / leading comments', () => {
    it('includes the preceding JSDoc block in the chunk and starts at the JSDoc line', async () => {
      const text = [
        '/**',
        ' * Adds two numbers.',
        ' * @returns the sum',
        ' */',
        'export function add(a: number, b: number): number {',
        '  return a + b;',
        '}',
      ].join('\n');

      const fn = bySymbol(await chunk(text), 'add')!;
      expect(fn.startLine).toBe(1); // JSDoc line, not the function signature
      expect(fn.text).toContain('Adds two numbers.');
      expect(fn.text).toContain('export function add');
    });
  });

  describe('module-level loose code', () => {
    it('captures imports and top-level constants as block chunks in the gaps', async () => {
      const text = [
        "import { x } from './x';",
        '',
        'const TABLE = 42;',
        '',
        'export function use(): number {',
        '  return TABLE + x;',
        '}',
      ].join('\n');

      const chunks = await chunk(text);
      expect(bySymbol(chunks, 'use')).toBeDefined();
      const block = chunks.find((c) => c.kind === 'block');
      expect(block).toBeDefined();
      expect(block!.text).toContain("import { x }");
      expect(block!.text).toContain('const TABLE = 42;');
    });

    it('does not emit a chunk for trailing blank lines around symbols', async () => {
      const text = ['export function f() {}', '', '', ''].join('\n');
      const chunks = await chunk(text);
      expect(chunks.every((c) => c.text.trim() !== '')).toBe(true);
    });
  });

  describe('ordering', () => {
    it('returns chunks sorted by start line', async () => {
      const text = ['export function a() {}', 'export function b() {}', 'export function c() {}'].join('\n');
      const chunks = await chunk(text);
      for (let i = 1; i < chunks.length; i++) {
        expect(chunks[i]!.startLine).toBeGreaterThanOrEqual(chunks[i - 1]!.startLine);
      }
    });
  });

  describe('JSX / file extensions', () => {
    it('parses a .tsx file with JSX via the tsx grammar', async () => {
      const file = makeFile({ relativePath: 'src/Button.tsx', absolutePath: '/proj/web/src/Button.tsx' });
      const text = [
        'export const Button = (): JSX.Element => {',
        '  return <button>click</button>;',
        '};',
      ].join('\n');

      const fn = bySymbol(await chunk(text, file), 'Button');
      expect(fn).toBeDefined();
      expect(fn!.kind).toBe('function');
    });
  });

  describe('overloads', () => {
    it('emits a single chunk for an overloaded function (implementation only)', async () => {
      const text = [
        'export function parse(x: string): number;',
        'export function parse(x: number): string;',
        'export function parse(x: string | number): string | number {',
        '  return x;',
        '}',
      ].join('\n');

      const chunks = await chunk(text);
      const parseChunks = chunks.filter((c) => c.symbol === 'parse');
      expect(parseChunks).toHaveLength(1);
      expect(parseChunks[0]!.text).toContain('return x;');
    });
  });

  describe('class arrow-function fields', () => {
    it('emits a method chunk for an arrow-function class field', async () => {
      const text = [
        'export class Widget {',
        '  handleClick = (e: Event): void => {',
        '    e.preventDefault();',
        '  };',
        '}',
      ].join('\n');

      const field = bySymbol(await chunk(text), 'Widget.handleClick');
      expect(field).toBeDefined();
      expect(field!.kind).toBe('method');
    });
  });

  describe('non-exported and constants-only files', () => {
    it('chunks non-exported top-level functions', async () => {
      const text = ['function internalHelper(): number {', '  return 42;', '}'].join('\n');
      const fn = bySymbol(await chunk(text), 'internalHelper');
      expect(fn).toBeDefined();
      expect(fn!.kind).toBe('function');
    });

    it('produces block chunks for a file that is pure module code (zero symbols)', async () => {
      const text = [
        "import { a } from './a';",
        "import { b } from './b';",
        'const CONFIG_TABLE = { a, b };',
      ].join('\n');

      const chunks = await chunk(text);
      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks.every((c) => c.kind === 'block')).toBe(true);
      const joined = chunks.map((c) => c.text).join('\n');
      expect(joined).toContain('import { a }');
      expect(joined).toContain('const CONFIG_TABLE');
    });
  });

  describe('fallback', () => {
    it('does not throw on broken syntax — returns chunks (tree-sitter is error-tolerant)', async () => {
      const broken = 'export function f(\n  // unterminated\n';
      await expect(chunk(broken)).resolves.toBeDefined();
    });

    it('falls back to a single block chunk for an empty file', async () => {
      const chunks = await chunk('');
      expect(chunks).toHaveLength(1);
      expect(chunks[0]!.kind).toBe('block');
    });
  });

  describe('real file (acceptance: web/src/lib/location/index.ts)', () => {
    const realPath = join(import.meta.dirname, '../../../../../web/src/lib/location/index.ts');

    it.skipIf(!existsSync(realPath))('extracts the Location class, its methods, and module-level constants', async () => {
      const text = readFileSync(realPath, 'utf-8');
      const file: WalkedFile = {
        absolutePath: realPath,
        relativePath: 'src/lib/location/index.ts',
        segment: 'web',
        language: 'typescript',
      };

      const chunks = await chunkTreeSitterTS(text, file, CONFIG, sha1(text));

      const cls = bySymbol(chunks, 'Location');
      expect(cls).toBeDefined();
      expect(cls!.kind).toBe('class');
      expect(cls!.text).toContain('Location utility class'); // JSDoc included

      expect(bySymbol(chunks, 'Location.isLost')).toBeDefined();
      expect(bySymbol(chunks, 'Location.parseLocation')).toBeDefined();
      expect(bySymbol(chunks, 'Location.constructor')).toBeDefined();

      const block = chunks.find((c) => c.kind === 'block' && c.text.includes('TOUR_SENSITIVITY'));
      expect(block).toBeDefined();

      for (const c of chunks) {
        expect(c.startLine).toBeGreaterThanOrEqual(1);
        expect(c.endLine).toBeGreaterThanOrEqual(c.startLine);
      }
    });
  });
});
