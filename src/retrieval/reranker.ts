// Optional cross-encoder reranker (TASK-033, Phase 7). A bi-encoder (the embedder)
// scores query and chunk independently — fast, but blind to fine query↔chunk
// interaction. A cross-encoder reads the (query, chunk) PAIR together and scores
// relevance directly: more accurate, too costly to run over the whole index, so it
// re-scores only the top-N candidates from the cheap retriever and reorders them.
//
// Off by default (RAG_RERANK=1 enables). Offline only (local model, like the
// embedder — PO constraint: code never leaves the machine). Orthogonal to the base
// retriever: it reorders whatever ranked list it is given, so it composes with the
// hybrid retriever (TASK-032) when that lands.

import {
  modelCacheDir,
  offlineLoadError,
  remoteModelsAllowed,
} from '../model-cache.js';
import type { SearchResult } from '../store/vector-store.js';

/**
 * Scores a batch of passages against one query. Returns one relevance score per
 * passage, in input order (higher = more relevant). Injectable so unit tests run
 * offline with a deterministic fake instead of the ONNX cross-encoder.
 */
export type RerankScorer = (
  query: string,
  passages: readonly string[],
) => Promise<number[]>;

/** Builds (loads/downloads + memoises) a scorer for a cross-encoder model id. */
export type ScorerFactory = (modelId: string) => Promise<RerankScorer>;

// Known local cross-encoders. The MS-MARCO MiniLM cross-encoder is the standard
// reranker; it has a single-logit regression head (higher logit = more relevant).
const MODEL_REGISTRY = new Set<string>([
  'Xenova/ms-marco-MiniLM-L-6-v2',
  'Xenova/ms-marco-MiniLM-L-12-v2',
  'Xenova/ms-marco-TinyBERT-L-2-v2',
]);

const ALIASES: Record<string, string> = {
  'ms-marco-MiniLM-L-6-v2': 'Xenova/ms-marco-MiniLM-L-6-v2',
  'ms-marco-MiniLM-L-12-v2': 'Xenova/ms-marco-MiniLM-L-12-v2',
  'ms-marco-TinyBERT-L-2-v2': 'Xenova/ms-marco-TinyBERT-L-2-v2',
};

export const DEFAULT_RERANK_MODEL = 'Xenova/ms-marco-MiniLM-L-6-v2';
// How many cheap-retriever candidates to re-score. The cross-encoder is O(N) model
// runs per query, so N is a latency knob: large enough to rescue a buried answer,
// small enough to stay cheap. 20 is the common default.
export const DEFAULT_RERANK_CANDIDATES = 20;
// Cap passage length before tokenisation. The cross-encoder truncates at 512 tokens
// anyway; capping chars bounds tokenisation cost for very large chunks.
const MAX_PASSAGE_CHARS = 2000;

function resolveModel(model: string): string {
  const id = ALIASES[model] ?? model;
  if (!MODEL_REGISTRY.has(id)) {
    throw new Error(
      `[rag-mcp] Unknown reranker model "${model}". Supported: ${[...MODEL_REGISTRY].join(', ')}`,
    );
  }
  return id;
}

const sigmoid = (x: number): number => 1 / (1 + Math.exp(-x));

// Default scorer — lazily imports transformers.js so unit tests with a fake never
// pull the ONNX runtime. A cross-encoder is a sequence-classification model fed the
// (query, passage) pair; its single logit is the relevance score.
const defaultScorerFactory: ScorerFactory = async (modelId) => {
  const { AutoTokenizer, AutoModelForSequenceClassification, env } =
    await import('@huggingface/transformers');
  env.cacheDir = modelCacheDir();
  env.allowLocalModels = true;
  env.allowRemoteModels = remoteModelsAllowed(); // offline by default; download is an explicit opt-in

  let tokenizer: Awaited<ReturnType<typeof AutoTokenizer.from_pretrained>>;
  let model: Awaited<
    ReturnType<typeof AutoModelForSequenceClassification.from_pretrained>
  >;
  try {
    tokenizer = await AutoTokenizer.from_pretrained(modelId);
    model = await AutoModelForSequenceClassification.from_pretrained(modelId);
  } catch (e) {
    if (!env.allowRemoteModels) throw offlineLoadError(modelId, e);
    throw e;
  }

  return async (query, passages) => {
    if (passages.length === 0) return [];
    const inputs = await tokenizer(
      passages.map(() => query),
      { text_pair: passages as string[], padding: true, truncation: true },
    );
    const { logits } = await model(inputs);
    // Single-label head → one logit per pair. Squeeze [N,1] → N.
    return (logits.tolist() as number[][]).map((row) => row[0] ?? 0);
  };
};

export type RerankerOptions = {
  model?: string;
  candidates?: number;
  scorerFactory?: ScorerFactory;
};

export class Reranker {
  readonly modelId: string;
  readonly candidates: number;
  private readonly createScorer: ScorerFactory;
  private scorer: RerankScorer | undefined;
  private loading: Promise<RerankScorer> | undefined;

  constructor(options: RerankerOptions = {}) {
    this.modelId = resolveModel(options.model ?? DEFAULT_RERANK_MODEL);
    const n = options.candidates ?? DEFAULT_RERANK_CANDIDATES;
    if (!Number.isInteger(n) || n < 1) {
      throw new Error(
        `[rag-mcp] reranker candidates must be a positive integer, got ${n}`,
      );
    }
    this.candidates = n;
    this.createScorer = options.scorerFactory ?? defaultScorerFactory;
  }

  // Loads the model once; concurrent callers share the in-flight load. A failed
  // load is not cached (a network blip on first download must not poison the instance).
  private async ready(): Promise<RerankScorer> {
    if (this.scorer) return this.scorer;
    if (!this.loading) this.loading = this.createScorer(this.modelId);
    try {
      this.scorer = await this.loading;
    } catch (e) {
      this.loading = undefined;
      throw e;
    }
    return this.scorer;
  }

  /**
   * Re-score the candidates against the query with the cross-encoder and return
   * the top-K reordered. `candidate.score` is replaced with the rerank relevance
   * (sigmoid of the logit, 0..1) so the displayed score is monotonic with the new
   * order. Ties keep the input order (stable) — i.e. the base retriever's ranking.
   * Returns the input untouched (just truncated to topK) when there is ≤1 candidate.
   */
  async rerank(
    query: string,
    candidates: SearchResult[],
    topK: number,
  ): Promise<SearchResult[]> {
    if (candidates.length <= 1 || topK < 1)
      return candidates.slice(0, Math.max(0, topK));

    const scorer = await this.ready();
    const passages = candidates.map((c) =>
      c.chunk.text.slice(0, MAX_PASSAGE_CHARS),
    );
    const scores = await scorer(query, passages);

    return candidates
      .map((c, i) => ({
        result: c,
        score: scores[i] ?? Number.NEGATIVE_INFINITY,
        order: i,
      }))
      .sort((a, b) => b.score - a.score || a.order - b.order) // desc by relevance, stable
      .slice(0, topK)
      .map(({ result, score }) => ({ ...result, score: sigmoid(score) }));
  }
}

/**
 * Constructs a Reranker iff reranking is enabled (`RAG_RERANK=1`), else null —
 * so callers stay branchless (`reranker?.rerank(...) ?? base`). Honors
 * `RAG_RERANK_MODEL` and `RAG_RERANK_CANDIDATES`. Default off → production and the
 * eval baseline are unchanged unless the toggle is set.
 */
export function createReranker(options: RerankerOptions = {}): Reranker | null {
  if (process.env['RAG_RERANK'] !== '1') return null;
  const envModel = process.env['RAG_RERANK_MODEL'];
  const envCandidates = process.env['RAG_RERANK_CANDIDATES'];
  return new Reranker({
    ...options,
    ...(envModel ? { model: envModel } : {}),
    ...(envCandidates ? { candidates: Number(envCandidates) } : {}),
  });
}
