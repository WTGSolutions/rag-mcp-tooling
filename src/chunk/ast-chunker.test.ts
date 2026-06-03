import { describe, it, expect, vi } from 'vitest';
import { join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { Project } from 'ts-morph';
import { chunkAst } from './ast-chunker.js';
import { sha1 } from '../hash.js';
import type { WalkedFile } from '../walker.js';
import type { Chunk } from './types.js';
import type { RagChunkConfig } from '../config.js';

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

function chunk(text: string, file = makeFile()): Chunk[] {
  return chunkAst(text, file, CONFIG, sha1(text));
}

function bySymbol(chunks: Chunk[], symbol: string): Chunk | undefined {
  return chunks.find((c) => c.symbol === symbol);
}

describe('chunkAst', () => {
  describe('top-level symbols', () => {
    it('extracts a function declaration with symbol, kind and 1-based line range', () => {
      // Arrange
      const text = [
        'export function add(a: number, b: number): number {',
        '  return a + b;',
        '}',
      ].join('\n');

      // Act
      const chunks = chunk(text);

      // Assert
      const fn = bySymbol(chunks, 'add');
      expect(fn).toBeDefined();
      expect(fn!.kind).toBe('function');
      expect(fn!.startLine).toBe(1);
      expect(fn!.endLine).toBe(3);
      expect(fn!.text).toContain('return a + b;');
    });

    it('treats an exported arrow-function const as a function chunk', () => {
      // Arrange
      const text = [
        'export const greet = (name: string): string => {',
        '  return `hi ${name}`;',
        '};',
      ].join('\n');

      // Act
      const chunks = chunk(text);

      // Assert
      const fn = bySymbol(chunks, 'greet');
      expect(fn).toBeDefined();
      expect(fn!.kind).toBe('function');
    });

    it('extracts an interface as an interface chunk', () => {
      // Arrange
      const text = ['export interface User {', '  id: string;', '  name: string;', '}'].join('\n');

      // Act
      const chunks = chunk(text);

      // Assert
      const iface = bySymbol(chunks, 'User');
      expect(iface).toBeDefined();
      expect(iface!.kind).toBe('interface');
    });

    it('extracts a type alias as a type chunk', () => {
      // Arrange
      const text = "export type Status = 'on' | 'off';";

      // Act
      const chunks = chunk(text);

      // Assert
      const ta = bySymbol(chunks, 'Status');
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

    it('emits a class chunk for the whole class', () => {
      // Act
      const chunks = chunk(text);

      // Assert
      const cls = bySymbol(chunks, 'Calc');
      expect(cls).toBeDefined();
      expect(cls!.kind).toBe('class');
      expect(cls!.startLine).toBe(1);
      expect(cls!.endLine).toBe(12);
    });

    it('emits a separate method chunk per method, namespaced by class', () => {
      // Act
      const chunks = chunk(text);

      // Assert
      const add = bySymbol(chunks, 'Calc.add');
      const zero = bySymbol(chunks, 'Calc.zero');
      expect(add).toBeDefined();
      expect(add!.kind).toBe('method');
      expect(zero).toBeDefined();
      expect(zero!.kind).toBe('method');
    });

    it('method chunks overlap the class chunk by design', () => {
      // Act
      const chunks = chunk(text);
      const cls = bySymbol(chunks, 'Calc')!;
      const add = bySymbol(chunks, 'Calc.add')!;

      // Assert — the method lives inside the class range
      expect(add.startLine).toBeGreaterThanOrEqual(cls.startLine);
      expect(add.endLine).toBeLessThanOrEqual(cls.endLine);
    });

    it('emits a constructor chunk named ClassName.constructor', () => {
      // Arrange
      const ctorText = [
        'export class Service {',
        '  constructor(private readonly url: string) {}',
        '}',
      ].join('\n');

      // Act
      const chunks = chunk(ctorText);

      // Assert
      expect(bySymbol(chunks, 'Service.constructor')).toBeDefined();
    });
  });

  describe('JSDoc / leading comments', () => {
    it('includes the preceding JSDoc block in the chunk and starts at the JSDoc line', () => {
      // Arrange
      const text = [
        '/**',
        ' * Adds two numbers.',
        ' * @returns the sum',
        ' */',
        'export function add(a: number, b: number): number {',
        '  return a + b;',
        '}',
      ].join('\n');

      // Act
      const chunks = chunk(text);

      // Assert
      const fn = bySymbol(chunks, 'add')!;
      expect(fn.startLine).toBe(1); // JSDoc line, not the function signature
      expect(fn.text).toContain('Adds two numbers.');
      expect(fn.text).toContain('export function add');
    });
  });

  describe('module-level loose code', () => {
    it('captures imports and top-level constants as block chunks in the gaps', () => {
      // Arrange
      const text = [
        "import { x } from './x';",
        '',
        'const TABLE = 42;',
        '',
        'export function use(): number {',
        '  return TABLE + x;',
        '}',
      ].join('\n');

      // Act
      const chunks = chunk(text);

      // Assert — the function is a symbol chunk; imports+const land in a block chunk
      expect(bySymbol(chunks, 'use')).toBeDefined();
      const block = chunks.find((c) => c.kind === 'block');
      expect(block).toBeDefined();
      expect(block!.text).toContain("import { x }");
      expect(block!.text).toContain('const TABLE = 42;');
    });

    it('does not emit a chunk for a file that is only blank lines around symbols', () => {
      // Arrange — trailing blank lines must not create phantom block chunks
      const text = ['export function f() {}', '', '', ''].join('\n');

      // Act
      const chunks = chunk(text);

      // Assert
      expect(chunks.every((c) => c.text.trim() !== '')).toBe(true);
    });
  });

  describe('ordering', () => {
    it('returns chunks sorted by start line', () => {
      // Arrange
      const text = [
        'export function a() {}',
        'export function b() {}',
        'export function c() {}',
      ].join('\n');

      // Act
      const chunks = chunk(text);

      // Assert
      for (let i = 1; i < chunks.length; i++) {
        expect(chunks[i]!.startLine).toBeGreaterThanOrEqual(chunks[i - 1]!.startLine);
      }
    });
  });

  describe('JSX / file extensions', () => {
    it('parses a .tsx file with JSX (would fail to parse as .ts)', () => {
      // Arrange — relativePath ends in .tsx so scriptKindExtension keeps JSX parseable
      const file = makeFile({ relativePath: 'src/Button.tsx', absolutePath: '/proj/web/src/Button.tsx' });
      const text = [
        'export const Button = (): JSX.Element => {',
        '  return <button>click</button>;',
        '};',
      ].join('\n');

      // Act
      const chunks = chunkAst(text, file, CONFIG, sha1(text));

      // Assert — semantic chunk, not a line-chunker fallback
      const fn = bySymbol(chunks, 'Button');
      expect(fn).toBeDefined();
      expect(fn!.kind).toBe('function');
    });
  });

  describe('overloads', () => {
    it('emits a single chunk for an overloaded function (implementation only)', () => {
      // Arrange — two overload signatures + one implementation
      const text = [
        'export function parse(x: string): number;',
        'export function parse(x: number): string;',
        'export function parse(x: string | number): string | number {',
        '  return x;',
        '}',
      ].join('\n');

      // Act
      const chunks = chunkAst(text, makeFile(), CONFIG, sha1(text));

      // Assert — exactly one 'parse' chunk, and it has a body
      const parseChunks = chunks.filter((c) => c.symbol === 'parse');
      expect(parseChunks).toHaveLength(1);
      expect(parseChunks[0]!.text).toContain('return x;');
    });
  });

  describe('class arrow-function fields', () => {
    it('emits a method chunk for an arrow-function class field', () => {
      // Arrange
      const text = [
        'export class Widget {',
        '  handleClick = (e: Event): void => {',
        '    e.preventDefault();',
        '  };',
        '}',
      ].join('\n');

      // Act
      const chunks = chunkAst(text, makeFile(), CONFIG, sha1(text));

      // Assert
      const field = bySymbol(chunks, 'Widget.handleClick');
      expect(field).toBeDefined();
      expect(field!.kind).toBe('method');
    });
  });

  describe('non-exported and constants-only files', () => {
    it('chunks non-exported top-level functions', () => {
      // Arrange — no export keyword
      const text = ['function internalHelper(): number {', '  return 42;', '}'].join('\n');

      // Act
      const chunks = chunkAst(text, makeFile(), CONFIG, sha1(text));

      // Assert
      const fn = bySymbol(chunks, 'internalHelper');
      expect(fn).toBeDefined();
      expect(fn!.kind).toBe('function');
    });

    it('produces block chunks for a file that is pure module code (zero symbols)', () => {
      // Arrange — only imports and a non-function const
      const text = [
        "import { a } from './a';",
        "import { b } from './b';",
        'const CONFIG_TABLE = { a, b };',
      ].join('\n');

      // Act
      const chunks = chunkAst(text, makeFile(), CONFIG, sha1(text));

      // Assert — everything captured as block chunk(s), nothing dropped
      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks.every((c) => c.kind === 'block')).toBe(true);
      const joined = chunks.map((c) => c.text).join('\n');
      expect(joined).toContain('import { a }');
      expect(joined).toContain('const CONFIG_TABLE');
    });
  });

  describe('fallback', () => {
    it('falls back to the line chunker when ts-morph throws', () => {
      // Arrange — force a parse failure
      const spy = vi
        .spyOn(Project.prototype, 'createSourceFile')
        .mockImplementation(() => {
          throw new Error('boom');
        });

      try {
        const text = 'export function f() {\n  return 1;\n}';

        // Act
        const chunks = chunk(text);

        // Assert — line chunker produces block chunks, never throws
        expect(chunks.length).toBeGreaterThan(0);
        expect(chunks.every((c) => c.kind === 'block')).toBe(true);
      } finally {
        spy.mockRestore();
      }
    });

    it('falls back to the line chunker for an empty file', () => {
      // Act
      const chunks = chunk('');

      // Assert
      expect(chunks).toHaveLength(1);
      expect(chunks[0]!.kind).toBe('block');
    });
  });

  describe('real file (acceptance: web/src/lib/location/index.ts)', () => {
    const realPath = join(import.meta.dirname, '../../../../web/src/lib/location/index.ts');

    it.skipIf(!existsSync(realPath))('extracts the Location class, its methods, and module-level constants', () => {
      // Arrange
      const text = readFileSync(realPath, 'utf-8');
      const file: WalkedFile = {
        absolutePath: realPath,
        relativePath: 'src/lib/location/index.ts',
        segment: 'web',
        language: 'typescript',
      };

      // Act
      const chunks = chunkAst(text, file, CONFIG, sha1(text));

      // Assert — class + key methods (from EPIC-040 we know these exist)
      const cls = bySymbol(chunks, 'Location');
      expect(cls).toBeDefined();
      expect(cls!.kind).toBe('class');
      expect(cls!.text).toContain('Location utility class'); // JSDoc included

      expect(bySymbol(chunks, 'Location.isLost')).toBeDefined();
      expect(bySymbol(chunks, 'Location.parseLocation')).toBeDefined();
      expect(bySymbol(chunks, 'Location.constructor')).toBeDefined();

      // Module-level TOUR_SENSITIVITY const lands in a block chunk
      const block = chunks.find((c) => c.kind === 'block' && c.text.includes('TOUR_SENSITIVITY'));
      expect(block).toBeDefined();

      // All chunks have valid 1-based line ranges
      for (const c of chunks) {
        expect(c.startLine).toBeGreaterThanOrEqual(1);
        expect(c.endLine).toBeGreaterThanOrEqual(c.startLine);
      }
    });
  });
});
