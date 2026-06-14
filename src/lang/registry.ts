// Single source of truth for tree-sitter languages: extension → language, and how
// each language is chunked (its walk, comment prefixes, and grammar). Adding a
// language = one entry here + a walk module + a GRAMMAR_SPECS entry — the generic
// chunker, core, and router are never touched (criterion #1 of TASK-021).
// FileLanguage is derived from this registry — never edit the union by hand.

import { extname } from 'node:path';
import type { WalkedFile } from '../walker.js';
import type { WalkFn } from '../chunk/tree-sitter-core.js';
import { pythonWalk, PYTHON_COMMENT_PREFIXES } from '../chunk/walks/python.js';
import { typescriptWalk, TS_COMMENT_PREFIXES } from '../chunk/walks/typescript.js';
import { goWalk, GO_COMMENT_PREFIXES } from '../chunk/walks/go.js';
import { rustWalk, RUST_COMMENT_PREFIXES } from '../chunk/walks/rust.js';
import { javaWalk, JAVA_COMMENT_PREFIXES } from '../chunk/walks/java.js';
import { cppWalk, CPP_COMMENT_PREFIXES } from '../chunk/walks/cpp.js';

export type LangEntry = {
  /** Lowercase file extensions (with leading dot) that map to this language. */
  readonly extensions: readonly string[];
  /** Comment line markers for leading-comment capture (e.g. ['#'] or ['//','*','/*']). */
  readonly commentPrefixes: readonly string[];
  /** The top-level AST walk that emits chunks for this language. */
  readonly walk: WalkFn;
  /** Grammar id (→ GRAMMAR_SPECS) for a given file; lets one language pick a grammar
   *  per extension, e.g. .tsx → 'tsx'. */
  readonly grammarFor: (file: WalkedFile) => string;
};

function tsGrammarFor(file: WalkedFile): string {
  const ext = extname(file.relativePath).toLowerCase();
  return ext === '.tsx' || ext === '.jsx' ? 'tsx' : 'typescript';
}

// All tree-sitter-backed languages. Adding a language = one entry here.
export const TREE_SITTER_LANGS = {
  python: {
    extensions: ['.py', '.pyw'],
    commentPrefixes: PYTHON_COMMENT_PREFIXES,
    walk: pythonWalk,
    grammarFor: () => 'python',
  },
  typescript: {
    extensions: ['.ts', '.tsx'],
    commentPrefixes: TS_COMMENT_PREFIXES,
    walk: typescriptWalk,
    grammarFor: tsGrammarFor,
  },
  javascript: {
    // The typescript grammar parses JS; the tsx grammar parses JSX (.jsx).
    extensions: ['.js', '.jsx', '.mjs', '.cjs'],
    commentPrefixes: TS_COMMENT_PREFIXES,
    walk: typescriptWalk,
    grammarFor: tsGrammarFor,
  },
  go: {
    extensions: ['.go'],
    commentPrefixes: GO_COMMENT_PREFIXES,
    walk: goWalk,
    grammarFor: () => 'go',
  },
  rust: {
    extensions: ['.rs'],
    commentPrefixes: RUST_COMMENT_PREFIXES,
    walk: rustWalk,
    grammarFor: () => 'rust',
  },
  java: {
    extensions: ['.java'],
    commentPrefixes: JAVA_COMMENT_PREFIXES,
    walk: javaWalk,
    grammarFor: () => 'java',
  },
  cpp: {
    // One grammar (tree-sitter-cpp) parses both C and C++; the C++ grammar is a
    // superset, so .c/.h files chunk through it too.
    extensions: ['.cpp', '.cc', '.cxx', '.c', '.h', '.hpp', '.hh', '.inl'],
    commentPrefixes: CPP_COMMENT_PREFIXES,
    walk: cppWalk,
    grammarFor: () => 'cpp',
  },
} as const satisfies Record<string, LangEntry>;

export type TreeSitterLanguage = keyof typeof TREE_SITTER_LANGS;

// Non-tree-sitter languages handled by dedicated chunkers.
type StaticLanguage = 'markdown' | 'yaml';

// FileLanguage is the union of all handled languages, derived from the registry.
export type FileLanguage = StaticLanguage | TreeSitterLanguage | 'unknown';

// Build extension → language from the registry + the static (markdown) chunker.
const extMap: Record<string, FileLanguage> = {
  '.md':   'markdown',
  '.mdx':  'markdown',
  '.yml':  'yaml',
  '.yaml': 'yaml',
};

for (const [lang, entry] of Object.entries(TREE_SITTER_LANGS) as Array<[TreeSitterLanguage, LangEntry]>) {
  for (const ext of entry.extensions) {
    extMap[ext] = lang;
  }
}

export const EXT_TO_LANGUAGE: Readonly<Record<string, FileLanguage>> = extMap;
