import { describe, it, expect } from 'vitest';
import { EXT_TO_LANGUAGE, TREE_SITTER_LANGS, type TreeSitterLanguage } from './registry.js';
import type { WalkedFile } from '../walker.js';

function fileWith(relativePath: string): WalkedFile {
  return { absolutePath: `/proj/${relativePath}`, relativePath, segment: 'web', language: 'unknown' };
}

describe('EXT_TO_LANGUAGE', () => {
  it('maps TypeScript extensions', () => {
    expect(EXT_TO_LANGUAGE['.ts']).toBe('typescript');
    expect(EXT_TO_LANGUAGE['.tsx']).toBe('typescript');
  });

  it('maps JavaScript extensions', () => {
    expect(EXT_TO_LANGUAGE['.js']).toBe('javascript');
    expect(EXT_TO_LANGUAGE['.mjs']).toBe('javascript');
    expect(EXT_TO_LANGUAGE['.cjs']).toBe('javascript');
  });

  it('maps Markdown extensions', () => {
    expect(EXT_TO_LANGUAGE['.md']).toBe('markdown');
    expect(EXT_TO_LANGUAGE['.mdx']).toBe('markdown');
  });

  it('maps Python extensions', () => {
    expect(EXT_TO_LANGUAGE['.py']).toBe('python');
    expect(EXT_TO_LANGUAGE['.pyw']).toBe('python');
  });

  it('maps Go, Rust and Java extensions', () => {
    expect(EXT_TO_LANGUAGE['.go']).toBe('go');
    expect(EXT_TO_LANGUAGE['.rs']).toBe('rust');
    expect(EXT_TO_LANGUAGE['.java']).toBe('java');
  });

  it('returns undefined for unknown extensions', () => {
    expect(EXT_TO_LANGUAGE['.json']).toBeUndefined();
    expect(EXT_TO_LANGUAGE['.css']).toBeUndefined();
    expect(EXT_TO_LANGUAGE['']).toBeUndefined();
  });
});

describe('TREE_SITTER_LANGS registry', () => {
  it('contains python, typescript, javascript, go, rust and java entries', () => {
    for (const lang of ['python', 'typescript', 'javascript', 'go', 'rust', 'java']) {
      expect(lang in TREE_SITTER_LANGS).toBe(true);
    }
  });

  it('every entry carries the data the generic chunker needs (walk, prefixes, grammarFor)', () => {
    for (const entry of Object.values(TREE_SITTER_LANGS)) {
      expect(typeof entry.walk).toBe('function');
      expect(Array.isArray(entry.commentPrefixes)).toBe(true);
      expect(entry.commentPrefixes.length).toBeGreaterThan(0);
      expect(typeof entry.grammarFor).toBe('function');
      expect(entry.extensions.length).toBeGreaterThan(0);
    }
  });

  it('grammarFor picks the grammar by file extension', () => {
    expect(TREE_SITTER_LANGS.python.grammarFor()).toBe('python'); // python grammar is file-independent
    expect(TREE_SITTER_LANGS.typescript.grammarFor(fileWith('a.ts'))).toBe('typescript');
    expect(TREE_SITTER_LANGS.typescript.grammarFor(fileWith('a.tsx'))).toBe('tsx');
    expect(TREE_SITTER_LANGS.javascript.grammarFor(fileWith('a.js'))).toBe('typescript');
    expect(TREE_SITTER_LANGS.javascript.grammarFor(fileWith('a.jsx'))).toBe('tsx');
  });

  it('all TREE_SITTER_LANGS entries appear in EXT_TO_LANGUAGE', () => {
    for (const [lang, entry] of Object.entries(TREE_SITTER_LANGS) as Array<[TreeSitterLanguage, typeof TREE_SITTER_LANGS[TreeSitterLanguage]]>) {
      for (const ext of entry.extensions) {
        expect(EXT_TO_LANGUAGE[ext]).toBe(lang);
      }
    }
  });
});
