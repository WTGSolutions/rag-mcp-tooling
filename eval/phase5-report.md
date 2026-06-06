# Phase 5 quality gate — line-chunker vs tree-sitter (polyglot: Python / Go / Rust)

**TASK-023** · measured 2026-06-06 · model `Xenova/bge-small-en-v1.5` · k=5

## TL;DR / recommendation

**Keep tree-sitter for Python/Go/Rust — but the win is token precision, not file recall.**

- **hit@5: parity** — 100% for both chunkers. AST-awareness does **not** improve top-5 file recall on this corpus.
- **MRR: line slightly ahead** (0.962 vs 0.897). On small files, a whole-file (line) vector is a robust "concept bag"; tree-sitter's fine chunks can be out-ranked.
- **Tokens: tree-sitter ~30% leaner** (3188 vs 4550 for the 13-query top-5). Same files, tighter context — this is tree-sitter's real, measurable benefit.
- **TASK-024 NOT triggered:** `bge-small-en` hit 100%@5 with both chunkers → the embedder is not the bottleneck for these concepts. No need to evaluate a code-specialized model on this evidence.

## Method (anti-bias, mirrors Phase 3 / TASK-016)

- **Corpus:** 9 polyglot fixtures in `src/__fixtures__/polyglot/` (Python 3, Go 3, Rust 3), several multi-symbol files.
- **Queries:** 13, English (to match the embedder), `eval/queries.polyglot.json` — **VALIDATED 2026-06-06 PO**. Ground truth derived by **reading the fixtures**, not from search output; frozen only after PO review.
- **A/B:** identical corpus, queries and model. Baseline = **line-chunker** (`RAG_FORCE_LINE_CHUNKER=1`, the "before AST-awareness" index); treatment = **tree-sitter**. Same harness (`src/eval/run-eval.ts`), no contract change.
- **Frozen results:** `eval/results-phase5-line.json`, `eval/results-phase5-treesitter.json`.

## Results

| Metric | line-chunker | tree-sitter |
|---|---|---|
| hit@5 | **100%** (13/13) | **100%** (13/13) |
| MRR | **0.962** | 0.897 |
| chunks for the corpus | 9 (≈1/file) | 54 |
| retrieved tokens (Σ top-5, 13 q) | 4550 | **3188 (−30%)** |

Per-query first-hit position (10/13 identical at #1):

| Query | line | tree-sitter | |
|---|---|---|---|
| q-poly-01-haversine | #2 | **#1** | tree-sitter better (isolated the fn in a 4-fn file) |
| q-poly-07-stale-device | #1 | #3 | tree-sitter worse (short method, diluted) |
| q-poly-10-route-distance | #1 | #3 | tree-sitter worse (short method, diluted) |
| *(other 10)* | #1 | #1 | tie |

## Analysis — why line is competitive here

1. **Files fit in one line-window.** Each fixture is ≤ ~512 tokens, so the line-chunker emits **one chunk per file** = a whole-file embedding. That vector is a robust "bag of all the file's concepts", so the file is reliably retrieved for *any* concept it contains → high MRR.
2. **Tree-sitter trades recall-robustness for precision.** It splits each file into per-symbol chunks (54 total). A short method (`Tracker.IsStale`, ~6 lines) carries little text → a weaker, more ambiguous vector that competes in a larger pool and can be out-ranked by other files' chunks (hence stale-device / route-distance slipping to #3).
3. **Where files hold many distinct functions, tree-sitter wins** (`geo.py`, 4 functions): isolating `haversine` lifted it #2→#1.
4. **The real payoff is tokens, not rank.** Tree-sitter returns the *same files* via tighter chunks → **30% fewer tokens** in the top-5. The file-level metric cannot see this; for an agent on a token budget it is the decisive benefit (it gets the relevant function, not the whole file).

## Honest limitation

The corpus is small — every fixture fits in a single line-window, so this **under-tests the large-file regime**, which is exactly where chunking strategy matters most (a 300-line module cannot be represented by one vector; line-chunking then splits it arbitrarily and the right region must be found). The cross-check is the **TS/JS migration** (TASK-021/022) on the *real* repo (large files): it measured **parity at hit@5 84%** — consistent with the verdict here (tree-sitter ≈ line on recall, wins on precision). A firmer gate would add a few >1-chunk multi-symbol files per language and re-measure.

## Verdict

- **Retain tree-sitter for Python/Go/Rust.** Justification: equal recall + **~30% leaner, symbol-precise context** for the agent — not a hit@5 improvement (there is none on this metric; line is marginally ahead on MRR for small files).
- For **pure file-level recall on small-file corpora**, the line-chunker is a strong, cheaper baseline. If a future project is dominated by tiny single-concept files, line-chunking is defensible.
- **TASK-024 (code-specialized embedder): do not trigger.** Both chunkers reached 100% hit@5 with `bge-small-en`; the model is not the limiting factor for these concepts. Revisit only if a larger or non-English corpus later shows embedder-attributable misses.
