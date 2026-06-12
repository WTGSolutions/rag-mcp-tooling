# Phase 7 — embedder A/B: multilingual fixes Polish, wrecks English → keep bge-small

**TASK-034** · measured 2026-06-11 · k=5 · real index (web/mobile/wiki/tools) ·
EN set = TASK-031 hard set (15 q, GT VALIDATED 2026-06-11 PO) · PL subgroup = 7 Polish
translations of those targets (GT inherited) · all models **local/offline**

## TL;DR — documented null for a wholesale swap; `bge-small-en` stays default

The Phase-7 diagnosis (TASK-031) flagged two **cross-lingual** misses — an English query
cannot reach Polish-commented code — and routed them here, to the embedding model
(reranking, TASK-033, confirmed it is not a ranking problem). Two **local multilingual**
candidates were A/B'd against `bge-small-en`:

| model | EN hard set (15 q) file / sym / span hit@5 | PL subgroup (7 q) file / sym / span |
|---|---|---|
| **`bge-small-en-v1.5`** (current) | **87% / 85% / 83%** | 14% / 14% / 14% |
| `paraphrase-multilingual-MiniLM-L12-v2` | 40% / 23% / 25% | 43% / 14% / 14% |
| `multilingual-e5-small` | 60% / 69% / 75% | 29% / 29% / 29% |

**The cross-lingual gap is real and model-fixable** — but **no small multilingual model
pays for itself here.** Both fix the Polish-commented target (h01: bge **miss → #1**) and
lift Polish queries (14% → 29–43%), but both **regress the dominant English case hard**
(87% → 40–60%). In an English-dominant codebase (English identifiers, mostly English
queries) that trade is net-negative. **Verdict: keep `bge-small-en`.** Like the dropped
TASK-024 and the rejected TASK-033, this is a null **on data**.

## Entry condition (the hard gate) — satisfied

TASK-034 may only run once **model-attributable** misses are shown that the cheaper
levers do not fix. They are: TASK-031 isolated h01 (retry — Polish comments) and the h02
NIP twins (English-commented ranks #1, Polish unreachable) as cross-lingual; TASK-033
(reranking) regressed rather than fixed them (reordering cannot bridge language); hybrid
(TASK-032, lexical) cannot bridge a paraphrase with no shared tokens either. So the gap
is in the **embedding representation** — the only thing this task changes.

## Method

- **Candidates, offline only** (PO): added to the embedder registry, selected by
  `embedder.model` (config swap) — no new retrieval code.
  - `paraphrase-multilingual-MiniLM-L12-v2` (384d, mean) — the multilingual analog of
    all-MiniLM; a *paraphrase* model, not retrieval-tuned (the weak baseline).
  - `multilingual-e5-small` (384d, mean) — a *retrieval-grade* multilingual model. E5
    needs asymmetric `query:` / `passage:` prefixes; **prefix support was added** to the
    embedder (`EmbedKind`, default `passage` so the indexer is correct; query call
    sites pass `query`). No-op for symmetric models (bge/MiniLM).
- **A/B**: full reindex of the real corpus per model into its own store
  (`.rag/{multilingual,e5}/index.db`; `--full --reset`), then the same eval/lenses/k.
- **PL subgroup**: 7 Polish paraphrases of validated EN targets (same files/symbols/
  spans) — the non-English measurement the task requires.

## Per-query, EN set (file-level, bge → paraphrase-ML → e5)

| query | bge → ml → e5 | note |
|---|---|---|
| **h01-retry-backoff** | **— → #1 → #1** | the smoking gun: Polish-commented `withServiceRetry`, unreachable by bge, found by both multilingual |
| h02-nip-validate | #1 → #1 → #1 | hit via the English-commented twin under every model |
| h09-mobile-gtfetch | #1 → — → #1 | e5 keeps it; paraphrase-ML loses it |
| h14-tools-windowing-flag | #1 → — → #1 | e5 keeps it; paraphrase-ML loses it |
| h03, h07, h11 | #2 → —/— → — | **regressed to miss** under both multilingual |
| h13-wiki-gsi-design | #5 → — → — | wiki doc lost under both |
| h15-tools-span-metric | #1 → #2 → #4 | demoted but kept |
| *(h05 miss; h08/h10 #1 all; h04/h06 vary)* | | |

Outside the one cross-lingual win (h01), the multilingual models **lose ground almost
everywhere** — `bge-small-en` is simply a much stronger English retriever than either
small multilingual model.

## Analysis

- **The gap is genuine and representation-bound.** h01 is the clean proof: identical
  concept, only Polish comments, invisible to the English model, #1 under both
  multilingual models. The PL subgroup confirms it at the query side — bge scores 14% on
  Polish queries, the multilingual models 29–43%.
- **But the cure costs more than the disease, here.** This corpus and its queries are
  English-dominant (identifiers are English; the hard set is English). `bge-small-en`'s
  87% on that majority case dwarfs its 14% on the Polish minority. Swapping to a small
  multilingual model inverts that: it rescues a few Polish cases while dropping ~30–45pp
  of English retrieval. Net loss.
- **e5 > paraphrase-ML**, as expected (retrieval-tuned vs paraphrase), and is the most
  *balanced* (60/29 vs bge 87/14). But "balanced lower" is not a win when the workload
  is English-heavy.
- **Even on Polish, the multilingual models are only modest** (sym/span 14–29%) — Polish
  queries against terse code are doubly hard; a small model does not close it.

## Verdict

- **Keep `bge-small-en-v1.5` as the default embedder.** Both local multilingual
  candidates are a **documented null**: they regress the dominant English case more than
  they help the cross-lingual minority.
- **Revisit only if PO prioritizes Polish-language querying**, and then with a bigger
  lever, each its own gated A/B:
  - a **stronger/larger multilingual retriever** (e.g. `bge-m3`, 1024d) that may keep
    English *and* add Polish — untested here (heavier: ~4× storage, slower reindex);
  - or a **dual-index / language-routed** setup (English model + multilingual model,
    pick by detected query language) — more infrastructure.
- **The cheapest mitigation is non-technical** and was discussed with PO: most of the
  gap is Polish *comments* reached by English queries; identifiers are already English.
  Dropping Polish docs is **not** advised (it only moves the gap onto Polish-speaking
  developers); a multilingual model is the right fix *if* the cost is ever justified.

## What's kept

- The two multilingual models + the **E5 instruction-prefix mechanism** stay in the
  registry — a future `bge-m3`/E5 experiment, or adoption, is a config swap, no code
  change. **Default unchanged → zero production impact.**
- Cost noted: candidate reindex ≈ 8–9 min for the full corpus (vs bge baseline);
  both candidates are 384d (same storage as bge); query latency comparable.

## Reproduce

```
# configs at the monorepo root (segment roots resolve there)
node dist/cli/rag-index.js -c ../../rag.config.multilingual.json --full --reset
node dist/cli/rag-index.js -c ../../rag.config.e5.json --full --reset
node dist/eval/run-eval.js -c ../../rag.config.multilingual.json --queries eval/queries.hard.json --out eval/results-phase7-multilingual.json
node dist/eval/run-eval.js -c ../../rag.config.e5.json          --queries eval/queries.hard.json --out eval/results-phase7-e5.json
# Polish subgroup (per model config)
node dist/eval/run-eval.js -c ../../rag.config.json --queries eval/queries.hard.pl.json --out eval/results-phase7-pl-bge.json
```

Frozen: `eval/results-phase7-{multilingual,e5}.json`, `eval/results-phase7-pl-{bge,multilingual,e5}.json`.

## Threats to validity

- **EN-dominant benchmark.** The hard set is English by construction; that is also the
  realistic workload, but it structurally favors the English model. The PL subgroup is
  the counterweight, and even there the multilingual models are only modest.
- **Two small candidates.** A larger multilingual retriever (bge-m3) is untested — the
  null is for *small* multilingual models, the natural drop-ins. Flagged as the next
  gated step.
- **PL subgroup GT is inherited** (translations of validated targets) — not separately
  PO-validated, as it reuses the same code regions; it supports, not gates, the verdict.
