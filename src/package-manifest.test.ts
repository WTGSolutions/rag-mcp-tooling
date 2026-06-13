import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

// Fast, offline guard on the publishable shape of package.json. The real tarball
// is verified end-to-end by scripts/verify-pack.mjs (npm pack --dry-run); this
// keeps the manifest invariants from regressing without paying for a build.
const pkgPath = resolve(dirname(fileURLToPath(import.meta.url)), '../package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as Record<string, unknown>;

const TREE_SITTER = [
  'tree-sitter-go',
  'tree-sitter-java',
  'tree-sitter-python',
  'tree-sitter-rust',
  'tree-sitter-typescript',
] as const;

describe('package.json — publish hygiene (TASK-036)', () => {
  it('ships only the dist whitelist (no src/, fixtures, tests)', () => {
    expect(pkg['files']).toEqual(['dist', 'scripts', 'README.md', 'THEORY.md']);
  });

  it('declares engines, publishConfig=public and a prepack build', () => {
    expect((pkg['engines'] as Record<string, string>)?.['node']).toBe('>=20');
    expect((pkg['publishConfig'] as Record<string, string>)?.['access']).toBe('public');
    const scripts = pkg['scripts'] as Record<string, string>;
    expect(scripts['prepack']).toBe('npm run build:publish');
    expect(scripts['build:publish']).toContain('tsconfig.build.json');
  });

  it('moves tree-sitter grammars to optionalDependencies (npx-safe fallback)', () => {
    const optional = pkg['optionalDependencies'] as Record<string, string>;
    const deps = pkg['dependencies'] as Record<string, string>;
    for (const g of TREE_SITTER) {
      expect(optional, `${g} must be optional`).toHaveProperty(g);
      expect(deps, `${g} must not be a hard dep`).not.toHaveProperty(g);
    }
    // The WASM runtime itself stays a hard dependency — grammars load through it.
    expect(deps).toHaveProperty('web-tree-sitter');
    expect(optional).not.toHaveProperty('web-tree-sitter');
  });

  it('exposes bins that point at compiled dist entry points', () => {
    const bin = pkg['bin'] as Record<string, string>;
    expect(bin['rag-index']).toBe('./dist/cli/rag-index.js');
    expect(bin['rag-init']).toBe('./dist/cli/rag-init.js');
    expect(bin['rag-mcp']).toBe('./dist/server/server.js');
    expect(bin['rag-usage']).toBe('./dist/cli/rag-usage.js');
  });

  it('carries the metadata a public package needs', () => {
    expect(pkg['license']).toBeTruthy();
    expect(pkg['main']).toBe('./dist/index.js');
    expect(pkg['types']).toBe('./dist/index.d.ts');
    expect(pkg['repository']).toBeTruthy();
    expect(typeof pkg['version']).toBe('string');
  });
});
