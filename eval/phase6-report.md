# Phase 6 — symbol-level retrieval: what the file-level metric hid

**TASK-027** · measured 2026-06-06 · model `Xenova/bge-small-en-v1.5` · k=5 ·
polyglot corpus (Python/Go/Rust, 13 queries, ground truth VALIDATED PO)

## TL;DR

The Phase-5 file-level gate said line-chunker and tree-sitter were near-equal
(both ~100% hit@5; line even edged MRR). **The symbol-level metric shows the gap
that metric was blind to:**

| Metric | line-chunker | tree-sitter |
|---|---|---|
| **file** hit@5 | 100% | 100% |
| **file** MRR | 0.962 | 0.897 |
| **symbol** hit@5 | **0%** | **100%** |
| **symbol** MRR | **0.000** | **0.821** |

At the file level they tie. At the **symbol** level tree-sitter retrieves the
right *symbol/region* for **13/13** queries (MRR 0.82) while the line-chunker
scores **0** — its whole-file blocks carry no symbol, so they can never point the
agent at the answering function/method. This is the precision (and the ~30% token
saving from Phase 5) that justifies tree-sitter, now **measurable**.

## Method

- Same A/B as Phase 5 ([phase5-report.md](phase5-report.md)): line-chunker
  (`RAG_FORCE_LINE_CHUNKER=1`) vs tree-sitter, identical corpus/queries/model.
- New **symbol-level** metric (`evaluateSymbol`): a hit is a top-k chunk **in an
  expected file** whose `symbol` satisfies an `expectedSymbols` entry.
  **Container-aware** — a class chunk credits a query for its method and vice
  versa (tree-sitter emits overlapping class+method chunks); siblings do not match.
- Ground truth: `expectedSymbols` in `eval/queries.polyglot.json`, **VALIDATED
  2026-06-06 PO** (anti-bias: derived from the fixtures' implementation, not search
  output). Frozen results: `eval/results-phase6-{line,treesitter}.json`.

## Per-query (tree-sitter)

Symbol-level first-hit rank — 9× #1, 2× #2, 2× #3 (all within k=5):

| Query | file | symbol | note |
|---|---|---|---|
| q04-normalize-tokens | #1 | #2 | a sibling chunk in tokens.py ranked above the target fn |
| q11-quadtree-insert | #1 | #2 | sibling `QuadTree` method/chunk ranked above `insert` |
| q07-stale-device | #3 | #3 | short method, file already #3 (Phase-5 churn) |
| q10-route-distance | #3 | #3 | short method, file already #3 |
| *(other 9)* | #1 | #1 | exact symbol at the top |

Line-chunker: **0/13** at symbol level — every chunk is a symbol-less block.

## Analysis

- **Line-chunker symbol score is 0 by construction**, not by accident: a whole-file
  block has no `symbol`, so it cannot satisfy a symbol query however well the file
  ranks. The file-level metric rewarded it (the block "is" the file); the
  symbol-level metric correctly withholds credit for precision it does not provide.
- **Tree-sitter is near-perfect at symbol level** (MRR 0.82): the answering symbol
  is the top hit for 9/13 and within top-3 for all. The 2× #2 cases are queries
  where another (sibling) chunk from the *right file* outranked the target symbol —
  a genuine, small precision gap, not a miss.
- **This reconciles the Phase-5 paradox.** Phase 5 found line ≥ tree-sitter on
  file-level MRR and read it (honestly) as "no recall win". The symbol metric shows
  *why that was the wrong lens*: the two are equivalent at picking the file, but
  only tree-sitter picks the right region inside it — exactly the agent-facing
  benefit (precise, token-lean context).

## Verdict

- **Retaining tree-sitter for code is justified on a measurable axis now:**
  symbol-level retrieval (100% vs 0%) and the Phase-5 token saving (~30%). The
  file-level tie was never the whole story.
- **TASK-024 (code-specialized embedder) stays dropped.** `bge-small-en` reaches
  100% at *both* file and symbol level here — the model is not the limiter.
- **Limitation (unchanged from Phase 5):** small corpus; every fixture fits in one
  line-window, so this isolates the *precision* axis cleanly but still under-tests
  large multi-chunk files. The symbol metric is now in place to evaluate those when
  a larger corpus exists (and to grade TASK-028 oversized-symbol windowing).
