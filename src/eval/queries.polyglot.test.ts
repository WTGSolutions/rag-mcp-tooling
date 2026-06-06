import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadQuerySet } from './queries.js';

const here = dirname(fileURLToPath(import.meta.url));
const queriesPath = resolve(here, '../../eval/queries.polyglot.json');
// expectedFiles are relative to the polyglot config dir (tools/rag-mcp): src/eval → src → rag-mcp.
const ragMcpDir = resolve(here, '../../');

describe('queries.polyglot.json (Phase-5 polyglot acceptance set)', () => {
  // loadQuerySet runs parseQuerySet → throws on empty expectedFiles, missing fields, duplicate ids.
  const set = loadQuerySet(queriesPath);

  it('loads a well-formed, non-empty set', () => {
    expect(set.queries.length).toBeGreaterThan(0);
  });

  it('every ground-truth file exists on disk (self-validation, anti-typo)', () => {
    for (const q of set.queries) {
      for (const f of q.expectedFiles) {
        expect(existsSync(resolve(ragMcpDir, f)), `${q.id} → ${f}`).toBe(true);
      }
    }
  });

  it('covers Python, Go and Rust', () => {
    const exts = new Set(
      set.queries.flatMap((q) => q.expectedFiles.map((f) => f.split('.').pop())),
    );
    expect(exts.has('py')).toBe(true);
    expect(exts.has('go')).toBe(true);
    expect(exts.has('rs')).toBe(true);
  });

  it('every query targets the polyglot segment', () => {
    expect(set.queries.every((q) => q.segment === 'polyglot')).toBe(true);
  });

  it('declares a ground-truth status (PROPOSED until PO-validated)', () => {
    expect(typeof set.groundTruthStatus).toBe('string');
    expect(set.groundTruthStatus.length).toBeGreaterThan(0);
  });
});
