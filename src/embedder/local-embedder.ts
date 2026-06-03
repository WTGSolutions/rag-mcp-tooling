import { resolve } from 'node:path';
import type { Embedder, Pooling } from './types.js';

// A loaded feature-extraction pipeline: callable, returns a tensor with tolist().
export type FeatureExtractor = (
  texts: string[],
  options: { pooling: Pooling; normalize: boolean },
) => Promise<{ tolist(): number[][] }>;

// Loads (and caches/downloads) a model and returns its extractor. Injectable so
// unit tests run offline with a fake; the default uses transformers.js.
export type PipelineFactory = (modelId: string) => Promise<FeatureExtractor>;

type ModelInfo = { dimensions: number; pooling: Pooling };

// Known local models. dimensions + pooling cannot be auto-detected reliably
// (pooling is a modeling choice), so they live here as the source of truth.
const MODEL_REGISTRY: Record<string, ModelInfo> = {
  'Xenova/bge-small-en-v1.5': { dimensions: 384, pooling: 'cls' },
  'Xenova/all-MiniLM-L6-v2': { dimensions: 384, pooling: 'mean' },
};

const ALIASES: Record<string, string> = {
  'bge-small': 'Xenova/bge-small-en-v1.5',
  'bge-small-en-v1.5': 'Xenova/bge-small-en-v1.5',
  'all-minilm': 'Xenova/all-MiniLM-L6-v2',
  'all-MiniLM-L6-v2': 'Xenova/all-MiniLM-L6-v2',
};

function resolveModel(model: string): { id: string } & ModelInfo {
  const id = ALIASES[model] ?? model;
  const info = MODEL_REGISTRY[id];
  if (!info) {
    throw new Error(
      `[rag-mcp] Unknown embedder model "${model}". Supported: ${Object.keys(MODEL_REGISTRY).join(', ')}`,
    );
  }
  return { id, ...info };
}

// Default factory — lazily imports transformers.js so unit tests that inject a
// fake never pull the heavy ONNX runtime.
const defaultPipelineFactory: PipelineFactory = async (modelId) => {
  const { pipeline, env } = await import('@huggingface/transformers');
  // Project-local, gitignored cache so models persist across reinstalls and the
  // tool works fully offline after the first download.
  env.cacheDir = resolve(process.cwd(), '.cache', 'transformers');
  env.allowLocalModels = true;
  env.allowRemoteModels = true; // needed only for the one-time download

  const extractor = await pipeline('feature-extraction', modelId);
  return (texts, options) =>
    extractor(texts, options) as unknown as Promise<{ tolist(): number[][] }>;
};

export type LocalEmbedderOptions = {
  model: string;
  batchSize?: number;
  pipelineFactory?: PipelineFactory;
  // Overrides for a model not in the registry (advanced/testing).
  pooling?: Pooling;
  dimensions?: number;
};

export class LocalEmbedder implements Embedder {
  readonly modelId: string;
  readonly dimensions: number;
  private readonly pooling: Pooling;
  private readonly batchSize: number;
  private readonly createPipeline: PipelineFactory;
  private extractor: FeatureExtractor | undefined;
  private loading: Promise<FeatureExtractor> | undefined;

  constructor(options: LocalEmbedderOptions) {
    const resolved = resolveModel(options.model);
    this.modelId = resolved.id;
    this.dimensions = options.dimensions ?? resolved.dimensions;
    this.pooling = options.pooling ?? resolved.pooling;
    this.batchSize = options.batchSize ?? 32;
    this.createPipeline = options.pipelineFactory ?? defaultPipelineFactory;
  }

  // Loads the model once; concurrent callers share the same in-flight load.
  private async ready(): Promise<FeatureExtractor> {
    if (this.extractor) return this.extractor;
    if (!this.loading) this.loading = this.createPipeline(this.modelId);
    this.extractor = await this.loading;
    return this.extractor;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];

    const extractor = await this.ready();
    const vectors: Float32Array[] = [];

    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize);
      const result = await extractor(batch, { pooling: this.pooling, normalize: true });
      for (const row of result.tolist()) {
        if (row.length !== this.dimensions) {
          throw new Error(
            `[rag-mcp] Embedder dimension mismatch: model ${this.modelId} produced ${row.length}, expected ${this.dimensions}`,
          );
        }
        vectors.push(Float32Array.from(row));
      }
    }

    return vectors;
  }
}

export function createLocalEmbedder(options: LocalEmbedderOptions): Embedder {
  return new LocalEmbedder(options);
}
