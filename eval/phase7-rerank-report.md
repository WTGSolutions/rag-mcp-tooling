# Phase 7 — reranking A/B: the standard cross-encoder regresses this corpus

**TASK-033** · measured 2026-06-11 · base model `Xenova/bge-small-en-v1.5` ·
reranker `Xenova/ms-marco-MiniLM-L-6-v2` (top-20 → top-5) · k=5 ·
TASK-031 headroom set (15 hard queries, real index, GT VALIDATED 2026-06-11 PO)

## TL;DR — documented null, reject (default off)

A cross-encoder re-scores the (query, chunk) pairs of the cheap retriever's top-N and
reorders them. TASK-031 routed reranking as the **highest-headroom** lever (8/15
answers sat below #1). The A/B says the standard local cross-encoder **does not
deliver it — it regresses retrieval and costs ~16× the latency**:

| lens | baseline | + rerank | Δ |
|---|---|---|---|
| **file** hit@5 | 87% | **67%** | **−20pp** |
| **file** MRR | 0.582 | 0.572 | −0.010 |
| **symbol** hit@5 | 85% | 77% | −8pp |
| **span** hit@5 | 83% | 75% | −8pp |
| **span** MRR | 0.621 | 0.576 | −0.045 |
| latency (15 q, warm) | 0.85 s | **14.1 s** | **+~880 ms/query** |

Per Phase-3 discipline (reranking rejected once already, on data): **rejected — the
toggle stays default-off.** The infrastructure is kept (a future code-aware model is a
one-line `RAG_RERANK_MODEL` swap), but no win = no adoption.

## Per-query (file-level, baseline → rerank)

| query | base → rerank | effect |
|---|---|---|
| h07-mobile-push-reload | #2 → **#1** | better |
| h11-cross-device-token | #2 → **#1** | better |
| h03-web-paginated-cursor | #2 → #4 | worse |
| h04-web-image-dedupe | #5 → **—** | **dropped out of top-5** |
| h12-wiki-tour-status | #2 → **—** | **dropped** |
| h13-wiki-gsi-design | #5 → **—** | **dropped** |
| *(9 others)* | unchanged | = |

**2 promoted, 4 demoted, 9 unchanged.** The reranker is not broken — its promotions
(h07, h11 → #1) are correct. It loses because it **demotes more right answers than it
rescues**.

## Why — domain mismatch, and it reinforces the TASK-031 diagnosis

`ms-marco-MiniLM-L-6-v2` is trained on **MS MARCO**: English web-search passages
(prose Q&A). Its relevance judgments do not transfer to this corpus:

- **Terse code** loses (h04 `findByHash`, a 4-line function) — little prose for the
  model to latch onto.
- **Markdown docs** lose hard (h12, h13 both **dropped out of top-5**) — heading/bullet
  structure scores poorly as a "passage".
- **Bilingual content** is exactly the gap TASK-031 flagged: an English cross-encoder
  cannot rescue Polish-commented code, and demotes it further.

So the headroom TASK-031 measured (answers at #2–#5) is **real**, but a generic English
reranker is the wrong tool to claim it. This *strengthens* the TASK-031 routing: the
gaps are **code/cross-lingual**, which points at the embedding representation
(TASK-034, multilingual/code-aware) rather than a prose reranker.

## Verdict

- **Reject `ms-marco-MiniLM-L-6-v2` reranking on this corpus** — regression on every
  lens + ~880 ms/query. Default off; not adopted.
- **Revisit reranking only with a code-aware / multilingual cross-encoder** (e.g. a
  jina/mxbai-style multilingual reranker), which would be a **model swap, no code
  change** (`RAG_RERANK_MODEL`). That overlaps TASK-034's multilingual thesis — so the
  evidence says **do TASK-034 next**, not more prose-reranking.
- **Kept:** the reranking infrastructure — `Reranker` (offline cross-encoder loader,
  injectable scorer), the `RAG_RERANK` toggle, and integration in `search_codebase` +
  `run-eval`. Validated (13 unit tests + a gated live check); inert at default.

## Reproduce

```
# baseline (default)
node dist/eval/run-eval.js -c ../../rag.config.json --queries eval/queries.hard.json --out eval/results-phase7-baseline.json
# + reranking
RAG_RERANK=1 node dist/eval/run-eval.js -c ../../rag.config.json --queries eval/queries.hard.json --out eval/results-phase7-rerank.json
# try another cross-encoder without code changes
RAG_RERANK=1 RAG_RERANK_MODEL=ms-marco-MiniLM-L-12-v2 node dist/eval/run-eval.js -c ../../rag.config.json --queries eval/queries.hard.json --out /tmp/r12.json
```

Frozen: `eval/results-phase7-baseline.json`, `eval/results-phase7-rerank.json`.

## Threats to validity

- **One reranker model.** The null is specific to `ms-marco-MiniLM-L-6-v2` (and its
  MS-MARCO family). A code/multilingual cross-encoder is untested here — deliberately,
  as it overlaps TASK-034 and would need its own gated A/B.
- **15 queries** — directional. The −20pp file drop is well outside noise (4 demotions
  vs 2 promotions), but lever *sizing* would want a larger set.
- **Latency measured per-process** (includes in-process model load). The marginal
  per-query rerank cost is the dominant term and already disqualifying given no quality win.
