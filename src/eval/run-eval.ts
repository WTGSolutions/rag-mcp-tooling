import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadConfig, createEmbedder, VectorStore, walkSegments } from '../index.js';
import { resolveStorePath, type RagConfig } from '../config.js';
import {
  toRepoPath,
  evaluate,
  evaluateSymbol,
  aggregate,
  estimateTokens,
  type SegmentRoots,
  type Aggregate,
  type Outcome,
  type RankedChunk,
} from './metrics.js';
import { grepRank, type CorpusFile } from './grep-baseline.js';
import { loadQuerySet, type EvalQuery } from './queries.js';

const K = 5;
const SNIPPET_CHARS = 280; // mirrors search_codebase's snippet length

type RankResult = { top: string[]; outcome: Outcome };
/** RAG ranking also carries token cost and (TASK-027) an optional symbol-level outcome. */
type RagRank = RankResult & { tokens: number; symbolOutcome: Outcome | null };
type PerQuery = {
  id: string;
  concept: string;
  query: string;
  segment: string;
  expectedFiles: string[];
  rag: RagRank | null;
  grep: RankResult & { tokens: number };
};

export type EvalResults = {
  model: string;
  k: number;
  generatedAt: string;
  groundTruthStatus: string;
  rag: Aggregate | null;
  /** Symbol-level aggregate over queries that carry `expectedSymbols` (TASK-027). Null in --dry or when none do. */
  ragSymbol: Aggregate | null;
  grep: Aggregate;
  tokenCost: { ragTotal: number; broadTotal: number; ratio: number } | null;
  perQuery: PerQuery[];
};

/** segment name → repo-relative root, from the config. */
function segmentRoots(config: RagConfig): SegmentRoots {
  return new Map(config.segments.map((s) => [s.name, s.root]));
}

/** Walk + read every indexed file once, keyed by repo-relative path. */
async function buildCorpus(config: RagConfig, cwd: string): Promise<CorpusFile[]> {
  const roots = segmentRoots(config);
  const corpus: CorpusFile[] = [];
  for await (const file of walkSegments(config, cwd)) {
    const path = toRepoPath(roots, file.segment, file.relativePath);
    corpus.push({ path, content: readFileSync(file.absolutePath, 'utf8') });
  }
  return corpus;
}

function tokensFor(paths: string[], byPath: Map<string, string>): number {
  return paths.reduce((sum, p) => sum + estimateTokens(byPath.get(p) ?? ''), 0);
}

type Args = { config: string; model?: string; out?: string; queries?: string; dry: boolean };

function parseArgs(argv: string[]): Args {
  const args: Args = { config: 'rag.config.json', dry: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if ((a === '-c' || a === '--config') && argv[i + 1]) args.config = argv[++i] as string;
    else if (a === '--model' && argv[i + 1]) args.model = argv[++i] as string;
    else if (a === '--out' && argv[i + 1]) args.out = argv[++i] as string;
    else if (a === '--queries' && argv[i + 1]) args.queries = argv[++i] as string;
    else if (a === '--dry') args.dry = true;
  }
  return args;
}

/** Run RAG search for one query and score it against the ground truth. */
function rankRag(
  query: EvalQuery,
  store: VectorStore,
  vector: Float32Array,
  roots: SegmentRoots,
): RagRank {
  const results = store.search(vector, K);
  const ranked: RankedChunk[] = results.map((r) => ({
    repoPath: toRepoPath(roots, r.chunk.segment, r.chunk.filePath),
    symbol: r.chunk.symbol,
  }));
  const top = ranked.map((r) => r.repoPath);
  const tokens = results.reduce((s, r) => s + estimateTokens(r.chunk.text.slice(0, SNIPPET_CHARS)), 0);
  // Symbol-level outcome only when the query carries symbol ground truth.
  const symbolOutcome = query.expectedSymbols && query.expectedSymbols.length > 0
    ? evaluateSymbol(ranked, query.expectedFiles, query.expectedSymbols, K)
    : null;
  return { top, outcome: evaluate(top, query.expectedFiles, K), tokens, symbolOutcome };
}

export async function runEval(args: Args): Promise<EvalResults> {
  const configPath = resolve(args.config);
  const config = loadConfig(configPath);
  if (args.model) config.embedder.model = args.model;
  const cwd = dirname(configPath);
  const roots = segmentRoots(config);

  const querySet = loadQuerySet(
    args.queries ?? resolve(fileURLToPath(import.meta.url), '../../../eval/queries.json'),
  );

  const corpus = await buildCorpus(config, cwd);
  const byPath = new Map(corpus.map((f) => [f.path, f.content]));

  // RAG side (skipped in --dry so the harness runs offline with no model).
  let embedder: ReturnType<typeof createEmbedder> | null = null;
  let store: VectorStore | null = null;
  let vectors: Float32Array[] = [];
  let modelId = args.model ?? config.embedder.model;
  if (!args.dry) {
    embedder = createEmbedder(config.embedder);
    modelId = embedder.modelId;
    store = VectorStore.open(resolveStorePath(configPath, config), embedder.dimensions, embedder.modelId);
    vectors = await embedder.embed(querySet.queries.map((q) => q.query));
  }

  try {
    const perQuery: PerQuery[] = querySet.queries.map((q, i) => {
      const grepTop = grepRank(corpus, q.query, K);
      const grep = { top: grepTop, outcome: evaluate(grepTop, q.expectedFiles, K), tokens: tokensFor(grepTop, byPath) };
      const rag = store ? rankRag(q, store, vectors[i] as Float32Array, roots) : null;
      return { id: q.id, concept: q.concept, query: q.query, segment: q.segment, expectedFiles: q.expectedFiles, rag, grep };
    });

    const ragOutcomes = perQuery.map((p) => p.rag?.outcome).filter((o): o is Outcome => o != null);
    const ragAgg = store ? aggregate(ragOutcomes) : null;
    // Symbol-level aggregate over only the queries that carry symbol ground truth.
    const symbolOutcomes = perQuery
      .map((p) => p.rag?.symbolOutcome)
      .filter((o): o is Outcome => o != null);
    const ragSymbolAgg = store && symbolOutcomes.length > 0 ? aggregate(symbolOutcomes) : null;
    const ragTotal = perQuery.reduce((s, p) => s + (p.rag?.tokens ?? 0), 0);
    const broadTotal = perQuery.reduce((s, p) => s + p.grep.tokens, 0);

    return {
      model: modelId,
      k: K,
      generatedAt: new Date().toISOString(),
      groundTruthStatus: querySet.groundTruthStatus,
      rag: ragAgg,
      ragSymbol: ragSymbolAgg,
      grep: aggregate(perQuery.map((p) => p.grep.outcome)),
      tokenCost: store && ragTotal > 0 ? { ragTotal, broadTotal, ratio: broadTotal / ragTotal } : null,
      perQuery,
    };
  } finally {
    store?.close();
  }
}

function pct(n: number): string {
  return `${(n * 100).toFixed(0)}%`;
}

function printSummary(r: EvalResults): void {
  const lines: string[] = [];
  lines.push(`\nmodel: ${r.model}   k=${r.k}   ground truth: ${r.groundTruthStatus.split(' —')[0]}`);
  lines.push('');
  lines.push('id                         seg     RAG      grep');
  for (const p of r.perQuery) {
    const rag = p.rag ? (p.rag.outcome.hit ? `#${p.rag.outcome.position}` : '—') : 'skip';
    const grep = p.grep.outcome.hit ? `#${p.grep.outcome.position}` : '—';
    lines.push(`${p.id.padEnd(26)} ${p.segment.padEnd(7)} ${rag.padEnd(8)} ${grep}`);
  }
  lines.push('');
  if (r.rag) lines.push(`RAG   hit@${r.k}=${pct(r.rag.hitRate)}  MRR=${r.rag.mrr.toFixed(3)}`);
  if (r.ragSymbol) {
    lines.push(`RAG   symbol-level hit@${r.k}=${pct(r.ragSymbol.hitRate)}  MRR=${r.ragSymbol.mrr.toFixed(3)}  (${r.ragSymbol.count} q with symbol GT)`);
  }
  lines.push(`grep  hit@${r.k}=${pct(r.grep.hitRate)}  MRR=${r.grep.mrr.toFixed(3)}`);
  if (r.tokenCost) {
    lines.push(`tokens  RAG=${r.tokenCost.ragTotal}  broad(grep top-${r.k} files)=${r.tokenCost.broadTotal}  → ${r.tokenCost.ratio.toFixed(1)}× cheaper`);
  }
  // Human-facing report → stdout (this is a CLI, not the MCP server).
  process.stdout.write(lines.join('\n') + '\n');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const results = await runEval(args);

  const safeModel = results.model.replace(/[^a-z0-9._-]+/gi, '-');
  const outPath = args.out ?? resolve(fileURLToPath(import.meta.url), `../../../eval/results-${safeModel}.json`);
  writeFileSync(outPath, JSON.stringify(results, null, 2) + '\n');

  printSummary(results);
  process.stdout.write(`\nresults → ${outPath}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    process.stderr.write(`[rag-mcp] eval failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
