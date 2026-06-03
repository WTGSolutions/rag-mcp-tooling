// Pooling strategy depends on the model: BGE uses the CLS token, MiniLM/MPNet
// use mean pooling. Picking the wrong one silently degrades vector quality.
export type Pooling = 'mean' | 'cls';

export type Embedder = {
  /** HF model id actually in use (after alias resolution). */
  readonly modelId: string;
  /** Vector length — known up front so VectorStore (TASK-007) can build its schema. */
  readonly dimensions: number;
  /** Embeds texts into L2-normalized vectors, one per input, in order. */
  embed(texts: string[]): Promise<Float32Array[]>;
};
