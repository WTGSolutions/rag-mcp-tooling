import { extractKeywords } from './metrics.js';

/** A file in the searchable corpus: repo-relative path + its full text. */
export type CorpusFile = { path: string; content: string };

/**
 * Keyword baseline — what a developer does *without* RAG: rank files by how many
 * distinct query keywords they contain, return the top-k repo-relative paths.
 * This is the honest comparison point for `search_codebase`: same corpus, plain
 * substring matching, no embeddings.
 *
 * Deterministic: ties (equal keyword count) are broken by path ascending.
 */
export function grepRank(corpus: readonly CorpusFile[], query: string, k: number): string[] {
  const keywords = extractKeywords(query);
  if (keywords.length === 0) return [];

  const scored: { path: string; score: number }[] = [];
  for (const file of corpus) {
    const haystack = file.content.toLowerCase();
    let score = 0;
    for (const kw of keywords) {
      if (haystack.includes(kw)) score++;
    }
    if (score > 0) scored.push({ path: file.path, score });
  }

  scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return scored.slice(0, k).map((s) => s.path);
}
