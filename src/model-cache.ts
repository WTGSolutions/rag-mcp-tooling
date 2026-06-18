import { homedir } from 'node:os';
import { resolve } from 'node:path';

// Shared model-cache location and download policy for every transformers.js
// consumer (embedder, reranker), so the two can never drift apart on either.

/**
 * Stable, cwd-independent model cache. The model is identical across every
 * project and invocation, so a single shared user cache means it downloads once
 * and then works fully offline everywhere — unlike a cwd-relative path, which
 * re-downloads whenever the tool is run from a different directory. Override
 * with RAG_MODEL_CACHE for sandboxed/CI environments.
 */
export function modelCacheDir(): string {
  return (
    process.env['RAG_MODEL_CACHE'] ??
    resolve(homedir(), '.cache', 'rag-mcp', 'models')
  );
}

/**
 * Offline by default (PO constraint: code never leaves the machine — and nothing
 * is silently fetched onto it either). Downloading model weights from the
 * Hugging Face Hub is an explicit, one-time opt-in; once cached, every run is
 * fully offline again. Without the gate, any cache miss (wiped ~/.cache, changed
 * RAG_MODEL_CACHE, new machine) would trigger a silent network fetch of
 * unpinned artifacts at an arbitrary later time.
 */
export function remoteModelsAllowed(): boolean {
  return process.env['RAG_ALLOW_DOWNLOAD'] === '1';
}

/**
 * Actionable error for a model load that failed while downloads were disabled —
 * the by-far most likely cause is a cold cache, and the fix is the opt-in flag.
 */
export function offlineLoadError(modelId: string, cause: unknown): Error {
  const reason = (cause as Error)?.message ?? String(cause);
  return new Error(
    `[rag-mcp] model ${modelId} could not be loaded from the local cache and ` +
      `downloads are disabled. If it was never downloaded, run once with ` +
      `RAG_ALLOW_DOWNLOAD=1 to fetch it; afterwards everything is offline again. (${reason})`,
  );
}
