import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { chunkMarkdown } from './markdown-chunker.js';
import { sha1 } from '../hash.js';
import type { WalkedFile } from '../walker.js';
import type { Chunk } from './types.js';
import type { RagChunkConfig } from '../config.js';

function makeFile(overrides: Partial<WalkedFile> = {}): WalkedFile {
  return {
    absolutePath: '/proj/wiki/doc.md',
    relativePath: 'doc.md',
    segment: 'wiki',
    language: 'markdown',
    ...overrides,
  };
}

const CONFIG: RagChunkConfig = { maxTokens: 512, overlapLines: 2 };

function chunk(text: string, config: RagChunkConfig = CONFIG): Chunk[] {
  return chunkMarkdown(text, makeFile(), config, sha1(text));
}

function bySymbol(chunks: Chunk[], symbol: string): Chunk | undefined {
  return chunks.find((c) => c.symbol === symbol);
}

describe('chunkMarkdown', () => {
  describe('sections', () => {
    it('emits one section chunk per heading with the title as symbol', () => {
      // Arrange
      const text = ['# Intro', 'hello', '## Setup', 'install steps'].join('\n');

      // Act
      const chunks = chunk(text);

      // Assert
      const intro = bySymbol(chunks, 'Intro');
      expect(intro).toBeDefined();
      expect(intro!.kind).toBe('section');
      expect(intro!.text).toContain('hello');
      expect(intro!.startLine).toBe(1);
      expect(intro!.endLine).toBe(2); // up to the line before '## Setup'
    });

    it('a section runs until the next heading of any level', () => {
      // Arrange
      const text = ['# A', 'a-body', '## B', 'b-body', 'more-b', '# C', 'c-body'].join('\n');

      // Act
      const chunks = chunk(text);

      // Assert
      const b = bySymbol(chunks, 'A > B');
      expect(b).toBeDefined();
      expect(b!.text).toContain('b-body');
      expect(b!.text).toContain('more-b');
      expect(b!.text).not.toContain('c-body');
    });
  });

  describe('breadcrumb (parent heading path)', () => {
    it('builds a breadcrumb from ancestor headings', () => {
      // Arrange
      const text = ['# Top', 'x', '## Middle', 'y', '### Leaf', 'z'].join('\n');

      // Act
      const chunks = chunk(text);

      // Assert
      expect(bySymbol(chunks, 'Top')).toBeDefined();
      expect(bySymbol(chunks, 'Top > Middle')).toBeDefined();
      expect(bySymbol(chunks, 'Top > Middle > Leaf')).toBeDefined();
    });

    it('pops the stack so sibling sections do not inherit each other', () => {
      // Arrange
      const text = ['# Top', '## A', 'a', '## B', 'b'].join('\n');

      // Act
      const chunks = chunk(text);

      // Assert — B is under Top, not under A
      expect(bySymbol(chunks, 'Top > A')).toBeDefined();
      expect(bySymbol(chunks, 'Top > B')).toBeDefined();
      expect(bySymbol(chunks, 'Top > A > B')).toBeUndefined();
    });

    it('resets depth correctly when jumping back to a higher level', () => {
      // Arrange
      const text = ['# One', '## Two', '### Three', '# Four', 'x'].join('\n');

      // Act
      const chunks = chunk(text);

      // Assert — Four is a top-level section again
      expect(bySymbol(chunks, 'Four')).toBeDefined();
      expect(bySymbol(chunks, 'One > Four')).toBeUndefined();
    });
  });

  describe('fenced code blocks', () => {
    it('does not treat a # inside a code fence as a heading', () => {
      // Arrange
      const text = [
        '# Real Heading',
        'intro',
        '```bash',
        '# this is a shell comment, not a heading',
        'echo hi',
        '```',
        '## After',
        'tail',
      ].join('\n');

      // Act
      const chunks = chunk(text);

      // Assert — only the two real headings became sections
      expect(bySymbol(chunks, 'Real Heading')).toBeDefined();
      expect(bySymbol(chunks, 'Real Heading > After')).toBeDefined();
      expect(chunks.find((c) => c.symbol === 'this is a shell comment, not a heading')).toBeUndefined();
      // the fenced comment lives inside the Real Heading section
      expect(bySymbol(chunks, 'Real Heading')!.text).toContain('# this is a shell comment');
    });

    it('handles ~~~ fences as well as backtick fences', () => {
      // Arrange
      const text = ['# H', '~~~', '# not a heading', '~~~', '## Sub'].join('\n');

      // Act
      const chunks = chunk(text);

      // Assert
      expect(bySymbol(chunks, 'H')).toBeDefined();
      expect(bySymbol(chunks, 'H > Sub')).toBeDefined();
      expect(chunks.some((c) => c.symbol === 'not a heading')).toBe(false);
    });
  });

  describe('long section splitting', () => {
    it('splits a long section and repeats the heading in every sub-chunk', () => {
      // Arrange — many body lines, tiny budget forces multiple windows
      const body = Array.from({ length: 40 }, (_, i) => `body line ${i + 1}`.padEnd(20, '.'));
      const text = ['## Big Section', ...body].join('\n');
      const config: RagChunkConfig = { maxTokens: 30, overlapLines: 0 };

      // Act
      const chunks = chunkMarkdown(text, makeFile(), config, sha1(text));

      // Assert
      const sectionChunks = chunks.filter((c) => c.symbol === 'Big Section');
      expect(sectionChunks.length).toBeGreaterThan(1);
      for (const c of sectionChunks) {
        expect(c.kind).toBe('section');
        expect(c.text.startsWith('## Big Section\n')).toBe(true); // heading repeated
      }
    });

    it('sub-chunk line ranges point at the body content', () => {
      // Arrange
      const body = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`.padEnd(16, '.'));
      const text = ['## S', ...body].join('\n'); // heading on line 1, body lines 2..21
      const config: RagChunkConfig = { maxTokens: 20, overlapLines: 0 };

      // Act
      const chunks = chunkMarkdown(text, makeFile(), config, sha1(text));

      // Assert — first sub-chunk's body starts at line 2 (after the heading)
      const first = chunks.find((c) => c.symbol === 'S')!;
      expect(first.startLine).toBe(2);
    });
  });

  describe('preamble and edge cases', () => {
    it('captures content before the first heading as a block chunk', () => {
      // Arrange
      const text = ['some intro text', 'before any heading', '', '# First', 'body'].join('\n');

      // Act
      const chunks = chunk(text);

      // Assert
      const preamble = chunks.find((c) => c.kind === 'block');
      expect(preamble).toBeDefined();
      expect(preamble!.text).toContain('some intro text');
      expect(preamble!.startLine).toBe(1);
      expect(bySymbol(chunks, 'First')).toBeDefined();
    });

    it('falls back to line chunking when there are no headings', () => {
      // Arrange
      const text = ['just', 'plain', 'text', 'no headings here'].join('\n');

      // Act
      const chunks = chunk(text);

      // Assert
      expect(chunks.every((c) => c.kind === 'block')).toBe(true);
    });

    it('returns a single empty chunk for an empty file', () => {
      // Act
      const chunks = chunk('');

      // Assert
      expect(chunks).toHaveLength(1);
      expect(chunks[0]!.text).toBe('');
    });
  });

  describe('real file (acceptance: wiki/.epics/EPIC-041-*.md)', () => {
    const realPath = join(import.meta.dirname, '../../../../wiki/.epics/EPIC-041-mcp-rag-semantic-code-index.md');

    it.skipIf(!existsSync(realPath))('chunks the epic into sections with breadcrumbs, no false headings from code fences', () => {
      // Arrange
      const text = readFileSync(realPath, 'utf-8');
      const file: WalkedFile = {
        absolutePath: realPath,
        relativePath: '.epics/EPIC-041-mcp-rag-semantic-code-index.md',
        segment: 'wiki',
        language: 'markdown',
      };

      // Act
      const chunks = chunkMarkdown(text, file, CONFIG, sha1(text));

      // Assert
      expect(chunks.length).toBeGreaterThan(3);
      // every chunk is a section or preamble block, with valid 1-based ranges
      for (const c of chunks) {
        expect(['section', 'block']).toContain(c.kind);
        expect(c.startLine).toBeGreaterThanOrEqual(1);
        expect(c.endLine).toBeGreaterThanOrEqual(c.startLine);
      }
      // a known top-level heading and a nested breadcrumb both exist
      expect(chunks.some((c) => c.symbol?.endsWith('Cel'))).toBe(true);
      expect(chunks.some((c) => c.symbol?.includes(' > '))).toBe(true);
      // code fences (```json, ```text diagrams) did not create bogus sections:
      // no section symbol should look like a JSON line or a box-drawing line
      expect(chunks.some((c) => c.symbol?.includes('"segments"'))).toBe(false);
    });
  });
});
