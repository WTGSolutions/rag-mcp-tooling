import { describe, it, expect } from 'vitest';
import { LocalEmbedder, type PipelineFactory } from './local-embedder.js';

const DIM = 384;

/**
 * Builds a fake pipeline factory that records calls. Each returned vector
 * encodes the first char code of its input in position 0, so order can be
 * verified. Captures the batch sizes and the last options passed.
 */
function fakeFactory() {
  const calls: { batchSizes: number[]; lastOptions?: { pooling: string; normalize: boolean }; factoryInvocations: number } = {
    batchSizes: [],
    factoryInvocations: 0,
  };
  const factory: PipelineFactory = async () => {
    calls.factoryInvocations++;
    return async (texts, options) => {
      calls.batchSizes.push(texts.length);
      calls.lastOptions = options;
      return {
        tolist: () =>
          texts.map((t) => {
            const v = new Array<number>(DIM).fill(0);
            v[0] = t.charCodeAt(0) || 0;
            return v;
          }),
      };
    };
  };
  return { factory, calls };
}

describe('LocalEmbedder', () => {
  describe('model resolution', () => {
    it('exposes dimensions and resolved modelId from the registry', () => {
      // Arrange + Act
      const e = new LocalEmbedder({ model: 'Xenova/bge-small-en-v1.5', pipelineFactory: fakeFactory().factory });

      // Assert
      expect(e.dimensions).toBe(384);
      expect(e.modelId).toBe('Xenova/bge-small-en-v1.5');
    });

    it('resolves a short alias to the full HF model id', () => {
      // Arrange + Act
      const e = new LocalEmbedder({ model: 'bge-small', pipelineFactory: fakeFactory().factory });

      // Assert
      expect(e.modelId).toBe('Xenova/bge-small-en-v1.5');
    });

    it('throws a clear error for an unknown model, listing supported ones', () => {
      // Act + Assert
      expect(() => new LocalEmbedder({ model: 'gpt-9000' })).toThrow('Unknown embedder model');
      expect(() => new LocalEmbedder({ model: 'gpt-9000' })).toThrow('Xenova/bge-small-en-v1.5');
    });
  });

  describe('pooling per model', () => {
    it('uses CLS pooling for BGE and normalizes', async () => {
      // Arrange
      const { factory, calls } = fakeFactory();
      const e = new LocalEmbedder({ model: 'Xenova/bge-small-en-v1.5', pipelineFactory: factory });

      // Act
      await e.embed(['x']);

      // Assert
      expect(calls.lastOptions).toEqual({ pooling: 'cls', normalize: true });
    });

    it('uses mean pooling for all-MiniLM', async () => {
      // Arrange
      const { factory, calls } = fakeFactory();
      const e = new LocalEmbedder({ model: 'all-minilm', pipelineFactory: factory });

      // Act
      await e.embed(['x']);

      // Assert
      expect(calls.lastOptions?.pooling).toBe('mean');
    });
  });

  describe('embedding', () => {
    it('returns one Float32Array of the right length per input', async () => {
      // Arrange
      const e = new LocalEmbedder({ model: 'bge-small', pipelineFactory: fakeFactory().factory });

      // Act
      const vectors = await e.embed(['alpha', 'beta']);

      // Assert
      expect(vectors).toHaveLength(2);
      expect(vectors[0]).toBeInstanceOf(Float32Array);
      expect(vectors[0]!.length).toBe(384);
    });

    it('returns an empty array for empty input without loading the model', async () => {
      // Arrange
      const { factory, calls } = fakeFactory();
      const e = new LocalEmbedder({ model: 'bge-small', pipelineFactory: factory });

      // Act
      const vectors = await e.embed([]);

      // Assert
      expect(vectors).toEqual([]);
      expect(calls.factoryInvocations).toBe(0); // model never loaded
    });

    it('preserves input order across batches', async () => {
      // Arrange — encode first char code in position 0
      const { factory } = fakeFactory();
      const e = new LocalEmbedder({ model: 'bge-small', batchSize: 2, pipelineFactory: factory });
      const inputs = ['Apple', 'Banana', 'Cherry', 'Date', 'Elder'];

      // Act
      const vectors = await e.embed(inputs);

      // Assert
      for (let i = 0; i < inputs.length; i++) {
        expect(vectors[i]![0]).toBe(inputs[i]!.charCodeAt(0));
      }
    });
  });

  describe('batching', () => {
    it('splits inputs into batches of batchSize', async () => {
      // Arrange
      const { factory, calls } = fakeFactory();
      const e = new LocalEmbedder({ model: 'bge-small', batchSize: 2, pipelineFactory: factory });

      // Act
      await e.embed(['a', 'b', 'c', 'd', 'e']);

      // Assert — 2 + 2 + 1
      expect(calls.batchSizes).toEqual([2, 2, 1]);
    });
  });

  describe('model loading', () => {
    it('loads the model only once across multiple embed calls', async () => {
      // Arrange
      const { factory, calls } = fakeFactory();
      const e = new LocalEmbedder({ model: 'bge-small', pipelineFactory: factory });

      // Act
      await e.embed(['a']);
      await e.embed(['b']);
      await e.embed(['c']);

      // Assert
      expect(calls.factoryInvocations).toBe(1);
    });

    it('shares a single load between concurrent embed calls', async () => {
      // Arrange
      const { factory, calls } = fakeFactory();
      const e = new LocalEmbedder({ model: 'bge-small', pipelineFactory: factory });

      // Act — fire two embeds before the first load resolves
      await Promise.all([e.embed(['a']), e.embed(['b'])]);

      // Assert
      expect(calls.factoryInvocations).toBe(1);
    });
  });

  describe('dimension guard', () => {
    it('throws if the model produces vectors of an unexpected length', async () => {
      // Arrange — fake returns wrong-length vectors
      const factory: PipelineFactory = async () => async (texts) => ({
        tolist: () => texts.map(() => new Array<number>(128).fill(0)),
      });
      const e = new LocalEmbedder({ model: 'bge-small', pipelineFactory: factory });

      // Act + Assert
      await expect(e.embed(['x'])).rejects.toThrow('dimension mismatch');
    });
  });
});

// Opt-in real-model test: downloads ~30MB on first run and runs ONNX inference.
// Run with: RAG_RUN_MODEL_TESTS=1 npm test
describe.skipIf(process.env['RAG_RUN_MODEL_TESTS'] !== '1')('LocalEmbedder (real model)', () => {
  it('embeds with the real bge-small model — normalized 384-dim vectors, semantic ordering', async () => {
    // Arrange
    const e = new LocalEmbedder({ model: 'Xenova/bge-small-en-v1.5' });

    // Act
    const [cat, kitten, physics] = await e.embed(['a small cat', 'a little kitten', 'quantum field theory']);

    // Assert — shape + normalization
    expect(cat!.length).toBe(384);
    const norm = Math.sqrt(cat!.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 1);

    // Semantic sanity: cat~kitten should be closer than cat~physics
    const dot = (a: Float32Array, b: Float32Array) => a.reduce((s, x, i) => s + x * b[i]!, 0);
    expect(dot(cat!, kitten!)).toBeGreaterThan(dot(cat!, physics!));
  }, 120_000);
});
