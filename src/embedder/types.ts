// Pooling strategy depends on the model: BGE uses the CLS token, MiniLM/MPNet
// use mean pooling. Picking the wrong one silently degrades vector quality.
export type Pooling = 'mean' | 'cls';

/**
 * Whether a text is a search `query` or an indexed `passage` (document). Matters
 * only for instruction-tuned models (E5) that prefix the two differently; symmetric
 * models (BGE/MiniLM) ignore it. Defaults to `passage` so the indexer (which embeds
 * chunks) is correct without passing it — only query-side call sites need `query`.
 */
export type EmbedKind = 'query' | 'passage';

export type Embedder = {
  /** HF model id actually in use (after alias resolution). */
  readonly modelId: string;
  /** Vector length — known up front so VectorStore (TASK-007) can build its schema. */
  readonly dimensions: number;
  /** Embeds texts into L2-normalized vectors, one per input, in order. */
  embed(texts: string[], kind?: EmbedKind): Promise<Float32Array[]>;
};
