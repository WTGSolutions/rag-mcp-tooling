import type { RagEmbedderConfig } from '../config.js';
import {
  modelCacheDir,
  offlineLoadError,
  remoteModelsAllowed,
} from '../model-cache.js';
import type { Embedder, EmbedKind, Pooling } from './types.js';

// A loaded feature-extraction pipeline: callable, returns a tensor with tolist().
export type FeatureExtractor = (
  texts: string[],
  options: { pooling: Pooling; normalize: boolean },
) => Promise<{ tolist(): number[][] }>;

// Loads (and caches/downloads) a model and returns its extractor. Injectable so
// unit tests run offline with a fake; the default uses transformers.js.
export type PipelineLoadOptions = { dtype?: 'fp32' | 'fp16' | 'q8' | 'q4' };
export type PipelineFactory = (
  modelId: string,
  loadOptions?: PipelineLoadOptions,
) => Promise<FeatureExtractor>;

// Some models (E5 family) are trained with asymmetric instruction prefixes — the
// query and the document must be prefixed differently or retrieval quality drops.
// Empty/absent for symmetric models (BGE, MiniLM, paraphrase-multilingual).
// `dtype` picks the ONNX weight variant (fp32 when absent); large models set 'q8'
// so the resident process stays in the hundreds of MB, not GB.
type ModelInfo = {
  dimensions: number;
  pooling: Pooling;
  queryPrefix?: string;
  passagePrefix?: string;
  dtype?: PipelineLoadOptions['dtype'];
};

// Known local models. dimensions + pooling cannot be auto-detected reliably
// (pooling is a modeling choice), so they live here as the source of truth.
const MODEL_REGISTRY: Record<string, ModelInfo> = {
  'Xenova/bge-small-en-v1.5': { dimensions: 384, pooling: 'cls' },
  'Xenova/all-MiniLM-L6-v2': { dimensions: 384, pooling: 'mean' },
  // Multilingual (TASK-034): the cross-lingual analog of all-MiniLM — same 384d /
  // mean pooling / no query-vs-passage prefix, but trained on 50+ languages incl.
  // Polish. A paraphrase model (not retrieval-tuned) — the weak multilingual baseline.
  'Xenova/paraphrase-multilingual-MiniLM-L12-v2': {
    dimensions: 384,
    pooling: 'mean',
  },
  // Retrieval-grade multilingual (TASK-034): E5-small, 384d/mean, 100+ languages.
  // Requires the asymmetric "query:" / "passage:" prefixes (omitting them degrades it).
  'Xenova/multilingual-e5-small': {
    dimensions: 384,
    pooling: 'mean',
    queryPrefix: 'query: ',
    passagePrefix: 'passage: ',
  },
  // Large multilingual retriever (TASK-034, gated bge-m3 A/B): dense head of BGE-M3,
  // 1024d/cls, 100+ languages, no instruction prefixes. ~568M params — loaded q8
  // (the realistic production variant; fp32 is ~2.3 GB resident).
  'Xenova/bge-m3': { dimensions: 1024, pooling: 'cls', dtype: 'q8' },
};

const ALIASES: Record<string, string> = {
  'bge-small': 'Xenova/bge-small-en-v1.5',
  'bge-small-en-v1.5': 'Xenova/bge-small-en-v1.5',
  'all-minilm': 'Xenova/all-MiniLM-L6-v2',
  'all-MiniLM-L6-v2': 'Xenova/all-MiniLM-L6-v2',
  'multilingual-minilm': 'Xenova/paraphrase-multilingual-MiniLM-L12-v2',
  'paraphrase-multilingual-MiniLM-L12-v2':
    'Xenova/paraphrase-multilingual-MiniLM-L12-v2',
  'multilingual-e5-small': 'Xenova/multilingual-e5-small',
  'e5-small': 'Xenova/multilingual-e5-small',
  'bge-m3': 'Xenova/bge-m3',
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
const defaultPipelineFactory: PipelineFactory = async (
  modelId,
  loadOptions,
) => {
  const { pipeline, env } = await import('@huggingface/transformers');
  env.cacheDir = modelCacheDir();
  env.allowLocalModels = true;
  env.allowRemoteModels = remoteModelsAllowed(); // offline by default; download is an explicit opt-in

  let extractor: Awaited<ReturnType<typeof pipeline>>;
  try {
    extractor = await pipeline(
      'feature-extraction',
      modelId,
      loadOptions?.dtype ? { dtype: loadOptions.dtype } : undefined,
    );
  } catch (e) {
    if (!env.allowRemoteModels) throw offlineLoadError(modelId, e);
    throw e;
  }
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
  private readonly queryPrefix: string;
  private readonly passagePrefix: string;
  private readonly dtype: PipelineLoadOptions['dtype'];
  private readonly batchSize: number;
  private readonly createPipeline: PipelineFactory;
  private extractor: FeatureExtractor | undefined;
  private loading: Promise<FeatureExtractor> | undefined;

  constructor(options: LocalEmbedderOptions) {
    const resolved = resolveModel(options.model);
    this.modelId = resolved.id;
    this.dimensions = options.dimensions ?? resolved.dimensions;
    this.pooling = options.pooling ?? resolved.pooling;
    this.queryPrefix = resolved.queryPrefix ?? '';
    this.passagePrefix = resolved.passagePrefix ?? '';
    this.dtype = resolved.dtype;

    const batchSize = options.batchSize ?? 32;
    if (!Number.isInteger(batchSize) || batchSize < 1) {
      // A non-positive batchSize would make embed()'s `i += batchSize` loop forever.
      throw new Error(
        `[rag-mcp] batchSize must be a positive integer, got ${batchSize}`,
      );
    }
    this.batchSize = batchSize;
    this.createPipeline = options.pipelineFactory ?? defaultPipelineFactory;
  }

  // Loads the model once; concurrent callers share the same in-flight load.
  private async ready(): Promise<FeatureExtractor> {
    if (this.extractor) return this.extractor;
    if (!this.loading)
      this.loading = this.createPipeline(
        this.modelId,
        this.dtype ? { dtype: this.dtype } : undefined,
      );
    try {
      this.extractor = await this.loading;
    } catch (e) {
      // Don't cache a rejected load — a transient failure (e.g. network blip on
      // first download) must not poison the instance; let a later call retry.
      this.loading = undefined;
      throw e;
    }
    return this.extractor;
  }

  async embed(
    texts: string[],
    kind: EmbedKind = 'passage',
  ): Promise<Float32Array[]> {
    if (texts.length === 0) return [];

    // Instruction prefix (E5): query vs passage embed differently. Empty for
    // symmetric models, so this is a no-op for BGE/MiniLM/paraphrase-multilingual.
    const prefix = kind === 'query' ? this.queryPrefix : this.passagePrefix;
    const inputs = prefix ? texts.map((t) => prefix + t) : texts;

    const extractor = await this.ready();
    const vectors: Float32Array[] = [];

    for (let i = 0; i < inputs.length; i += this.batchSize) {
      const batch = inputs.slice(i, i + this.batchSize);
      const result = await extractor(batch, {
        pooling: this.pooling,
        normalize: true,
      });
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

/**
 * Constructs an Embedder from the parsed config. Switches on `provider` so the
 * CLI (TASK-009) and MCP server have a single config-driven entry point; only
 * `local` is implemented in the MVP (cloud providers are out of scope).
 */
export function createEmbedder(config: RagEmbedderConfig): Embedder {
  switch (config.provider) {
    case 'local':
      return new LocalEmbedder({ model: config.model });
    default:
      throw new Error(
        `[rag-mcp] Unsupported embedder provider: ${(config as { provider: string }).provider}`,
      );
  }
}
