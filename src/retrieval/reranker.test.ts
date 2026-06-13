import { describe, it, expect, afterEach, vi } from 'vitest';
import { Reranker, createReranker, DEFAULT_RERANK_MODEL, DEFAULT_RERANK_CANDIDATES, type RerankScorer } from './reranker.js';
import type { SearchResult } from '../store/vector-store.js';

// Minimal SearchResult fake: only chunk.text and score matter to the reranker.
function sr(id: string, text: string, score = 0.5): SearchResult {
  return {
    chunk: {
      id, segment: 'web', filePath: `${id}.ts`, startLine: 1, endLine: 1,
      language: 'typescript', symbol: id, kind: 'function', text, fileHash: 'h',
    },
    score,
  };
}

// Fake scorer: relevance = count of shared lowercase words (deterministic, offline).
const overlapScorer: RerankScorer = async (query, passages) => {
  const q = new Set(query.toLowerCase().split(/\W+/).filter(Boolean));
  return passages.map((p) => p.toLowerCase().split(/\W+/).filter((w) => q.has(w)).length);
};

const factory = (scorer: RerankScorer) => () => Promise.resolve(scorer);

describe('Reranker.rerank', () => {
  it('reorders candidates by cross-encoder relevance, not the input order', async () => {
    const r = new Reranker({ scorerFactory: factory(overlapScorer) });
    // Input order puts the weak match first; the reranker should surface "alpha beta gamma".
    const input = [sr('a', 'zzz'), sr('b', 'alpha beta gamma'), sr('c', 'alpha zzz')];
    const out = await r.rerank('alpha beta gamma', input, 3);
    expect(out.map((o) => o.chunk.id)).toEqual(['b', 'c', 'a']);
  });

  it('returns only the top-K after reordering', async () => {
    const r = new Reranker({ scorerFactory: factory(overlapScorer) });
    const input = [sr('a', 'one'), sr('b', 'one two three'), sr('c', 'one two'), sr('d', 'x')];
    const out = await r.rerank('one two three', input, 2);
    expect(out.map((o) => o.chunk.id)).toEqual(['b', 'c']);
  });

  it('is stable on ties: equal scores keep input (base-retriever) order', async () => {
    const r = new Reranker({ scorerFactory: factory(async (_q, ps) => ps.map(() => 1)) });
    const input = [sr('a', 'x'), sr('b', 'x'), sr('c', 'x')];
    const out = await r.rerank('q', input, 3);
    expect(out.map((o) => o.chunk.id)).toEqual(['a', 'b', 'c']);
  });

  it('replaces score with the rerank relevance (sigmoid → 0..1, monotonic with order)', async () => {
    const r = new Reranker({ scorerFactory: factory(overlapScorer) });
    const out = await r.rerank('alpha beta', [sr('a', 'zzz', 0.99), sr('b', 'alpha beta', 0.01)], 2);
    expect(out[0]!.chunk.id).toBe('b');
    expect(out[0]!.score).toBeGreaterThan(out[1]!.score); // monotonic with new order
    for (const o of out) expect(o.score).toBeGreaterThanOrEqual(0); // sigmoid range
    for (const o of out) expect(o.score).toBeLessThanOrEqual(1);
  });

  it('returns the input untouched (sliced) for ≤1 candidate — no model call', async () => {
    const scorer = vi.fn(overlapScorer);
    const r = new Reranker({ scorerFactory: factory(scorer) });
    expect(await r.rerank('q', [], 5)).toEqual([]);
    expect((await r.rerank('q', [sr('a', 'x')], 5)).map((o) => o.chunk.id)).toEqual(['a']);
    expect(scorer).not.toHaveBeenCalled();
  });

  it('loads the model once and reuses it across calls (memoised)', async () => {
    const build = vi.fn(() => Promise.resolve(overlapScorer));
    const r = new Reranker({ scorerFactory: build });
    await r.rerank('q', [sr('a', 'q'), sr('b', 'x')], 2);
    await r.rerank('q', [sr('a', 'q'), sr('b', 'x')], 2);
    expect(build).toHaveBeenCalledTimes(1);
  });

  it('does not cache a failed load — a later call retries', async () => {
    let attempt = 0;
    const build = vi.fn(() => {
      attempt++;
      return attempt === 1 ? Promise.reject(new Error('cold cache')) : Promise.resolve(overlapScorer);
    });
    const r = new Reranker({ scorerFactory: build });
    await expect(r.rerank('q', [sr('a', 'q'), sr('b', 'x')], 2)).rejects.toThrow('cold cache');
    const out = await r.rerank('q', [sr('a', 'q'), sr('b', 'x')], 2); // retry succeeds
    expect(out.map((o) => o.chunk.id)).toEqual(['a', 'b']);
    expect(build).toHaveBeenCalledTimes(2);
  });

  it('rejects an unknown model and a non-positive candidate count', () => {
    expect(() => new Reranker({ model: 'not-a-reranker' })).toThrow(/Unknown reranker model/);
    expect(() => new Reranker({ candidates: 0 })).toThrow(/positive integer/);
  });

  it('resolves a bare alias to the canonical model id', () => {
    expect(new Reranker({ model: 'ms-marco-MiniLM-L-6-v2' }).modelId).toBe(DEFAULT_RERANK_MODEL);
  });
});

describe('createReranker (RAG_RERANK toggle)', () => {
  afterEach(() => {
    delete process.env['RAG_RERANK'];
    delete process.env['RAG_RERANK_MODEL'];
    delete process.env['RAG_RERANK_CANDIDATES'];
  });

  it('returns null when RAG_RERANK is unset (default off → prod/eval unchanged)', () => {
    expect(createReranker()).toBeNull();
  });

  it('returns a Reranker with defaults when RAG_RERANK=1', () => {
    process.env['RAG_RERANK'] = '1';
    const r = createReranker();
    expect(r).not.toBeNull();
    expect(r!.modelId).toBe(DEFAULT_RERANK_MODEL);
    expect(r!.candidates).toBe(DEFAULT_RERANK_CANDIDATES);
  });

  it('honors RAG_RERANK_MODEL and RAG_RERANK_CANDIDATES overrides', () => {
    process.env['RAG_RERANK'] = '1';
    process.env['RAG_RERANK_MODEL'] = 'ms-marco-TinyBERT-L-2-v2';
    process.env['RAG_RERANK_CANDIDATES'] = '30';
    const r = createReranker();
    expect(r!.modelId).toBe('Xenova/ms-marco-TinyBERT-L-2-v2');
    expect(r!.candidates).toBe(30);
  });

  it('treats RAG_RERANK=0 / other values as off', () => {
    process.env['RAG_RERANK'] = '0';
    expect(createReranker()).toBeNull();
  });
});

// Gated live check: the real cross-encoder ranks a relevant passage above noise.
describe.skipIf(process.env['RAG_RUN_MODEL_TESTS'] !== '1')('Reranker (real cross-encoder)', () => {
  it('scores a clearly-relevant passage above an irrelevant one', async () => {
    const r = new Reranker(); // default ms-marco-MiniLM, real ONNX model
    const input = [
      sr('noise', 'The quick brown fox jumps over the lazy dog in the garden.'),
      sr('answer', 'Retry a failed request with exponential backoff and random jitter.'),
    ];
    const out = await r.rerank('how to retry with exponential backoff and jitter', input, 2);
    expect(out[0]!.chunk.id).toBe('answer');
  }, 120_000);
});
