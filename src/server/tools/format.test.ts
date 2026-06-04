import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { chunkBaseShape, chunkRef, chunkToStructured } from './format.js';
import type { Chunk } from '../../chunk/types.js';

function makeChunk(overrides: Partial<Chunk> = {}): Chunk {
  return {
    id: 'id1',
    segment: 'web',
    filePath: 'src/a.ts',
    startLine: 10,
    endLine: 20,
    language: 'typescript',
    symbol: 'doThing',
    kind: 'function',
    text: 'body',
    fileHash: 'h',
    ...overrides,
  };
}

describe('chunkRef', () => {
  it('renders path:startLine, label, segment, the variant, and the line range', () => {
    const ref = chunkRef(makeChunk(), 'score 0.82');
    expect(ref).toBe('src/a.ts:10  [function doThing · web · score 0.82]  (lines 10-20)');
  });

  it('uses kind alone when the chunk has no symbol', () => {
    const ref = chunkRef(makeChunk({ symbol: undefined, kind: 'block' }), 'typescript');
    expect(ref).toBe('src/a.ts:10  [block · web · typescript]  (lines 10-20)');
  });
});

describe('chunkToStructured', () => {
  it('maps the common fields including symbol when present', () => {
    expect(chunkToStructured(makeChunk())).toEqual({
      id: 'id1', filePath: 'src/a.ts', startLine: 10, endLine: 20,
      segment: 'web', kind: 'function', symbol: 'doThing',
    });
  });

  it('omits symbol when the chunk has none', () => {
    const structured = chunkToStructured(makeChunk({ symbol: undefined }));
    expect('symbol' in structured).toBe(false);
  });
});

describe('chunkBaseShape ↔ chunkToStructured contract', () => {
  // The output schema (chunkBaseShape) and the runtime mapping
  // (chunkToStructured) must stay in lock-step: the MCP SDK silently strips
  // any structured field absent from the declared schema, so a drift would
  // drop data without an error. These tests fail fast if they diverge.
  const base = z.object(chunkBaseShape);

  it('validates a structured chunk with a symbol', () => {
    expect(() => base.parse(chunkToStructured(makeChunk()))).not.toThrow();
  });

  it('validates a structured chunk without a symbol', () => {
    const structured = chunkToStructured(makeChunk({ symbol: undefined }));
    expect(() => base.parse(structured)).not.toThrow();
  });
});
