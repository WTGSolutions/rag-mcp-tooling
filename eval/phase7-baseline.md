# Phase 7 — retrieval headroom benchmark + diagnosis that routes the levers

**TASK-031** · measured 2026-06-11 · model `Xenova/bge-small-en-v1.5` · k=5 ·
**real index** (web/mobile/wiki/tools, 6161 chunks) · 15 hard queries ·
ground truth **VALIDATED 2026-06-11 PO**

## TL;DR

Phase 7's levers (hybrid, reranking, embedder) are **eval-gated** — adopted only
behind a proven win. But you cannot prove a win against a ceiling. This benchmark
establishes the **headroom** and, more importantly, **diagnoses where current
retrieval is weak so the data — not assumption — routes which lever to try first.**

| lens | hit@5 | MRR | grep hit@5 |
|---|---|---|---|
| **file** | 87% (13/15) | **0.582** | 40% |
| **symbol** | 85% (11/13) | **0.612** | — |
| **span** | 83% (10/12) | **0.621** | — |

**The headroom is in ranking, not recall.** RAG finds the right answer inside the
top-5 most of the time, but it lands at **#2–#5, not #1** (MRR ≈ 0.6), plus **two
hard misses** beyond top-5. The shape of the misses **reorders the assumed lever
priority**:

1. **Reranking (TASK-033) — highest headroom.** 8/15 queries land below #1 because a
   sibling, a caller, a return-type, or a doc chunk outranks the canonical answer. A
   cross-encoder that reads (query, chunk) together is built to reorder exactly these.
2. **Multilingual embedder (TASK-034) — model-attributable headroom.** The two hard
   misses are **cross-lingual**: an English query cannot reach a function whose
   comments are Polish, even when an English-commented twin of the same logic ranks #1.
3. **Hybrid (TASK-032) — least headroom here.** The literal-identifier queries
   (`gtFetch`, WMO code, the env flag) already hit **#1** under pure semantics — the
   embedder handles literal tokens embedded in chunk text well. The gaps in this
   codebase are paraphrase/cross-lingual (semantic-side), not lexical drift.

This **inverts the naive "cheapest first" order (032→033→034)**: the data says
**033 + 034 first, 032 last** (pending literal-hard cases it doesn't yet contain).

## Method

- **Corpus = the real production index** (not a synthetic fixture set): web (Next.js),
  mobile (Ionic), wiki (Markdown), tools (rag-mcp). Headroom must be real.
- **15 hard queries**, four deliberately difficult categories: low-lexical-overlap
  paraphrase, literal identifier/abbreviation, synonym/ambiguity, cross-cutting.
- **Three lenses** (TASK-016/027/029): file / symbol / span, plus the `grep` lexical
  baseline. Measured with the standard harness, k=5.
- **Anti-bias:** ground truth (files/symbols/spans) derived from **reading the code**,
  never from search output. Status **PROPOSED** — frozen only after PO validation.

### Ground-truth fairness corrections (disclosed)

The baseline run surfaced **parallel implementations** — multiple genuinely-correct
answers the initial GT under-enumerated. Corrected from **reading** (a hit on any
correct implementation is correct), never to convert a miss into a hit opportunistically:

- **h02 (NIP validation):** two real validators — `isValidNipFormat` (`tax/nip-format.ts`,
  **Polish** comments) and `validateNIP` (`ksef-invoice-builder/validators/nip.validator.ts`,
  **English** comments). Both validate a Polish NIP with checksum → both are GT.
- **h03 (paginated query):** the delegation chain `queryPaginated → findPaginated →
  _paginatedPartiQL` — all three implement "page from a GSI with an opaque cursor" → all GT.
- **h14 (windowing flag):** the flag is **declared+documented** on `EmitCtx`
  (`disableSymbolWindowing`) and **read** in `runTreeSitterChunk` → both are GT.

These corrections do **not** manufacture the headroom: the two hard misses (h01, h05),
the #5-rank hits (h04, h13), and the MRR ≈ 0.6 ranking gap are untouched.

## Per-query

| id | cat | file | sym | span | cause | lever |
|---|---|---|---|---|---|---|
| h01-web-retry-backoff | paraphrase | — | — | — | **cross-lingual**: `withServiceRetry` has Polish comments; English UI/config outrank it | **034** + 033 |
| h02-web-nip-validate | synonym | #1 | #1 | #1 | hit via the **English**-commented `validateNIP`; the Polish twin ranked far lower | (hit) → 034 evidence |
| h03-web-paginated-cursor | paraphrase | #2 | #2 | #2 | `PaginatedResult` **return type** ranks #1; the pagination methods land #2 | **033** |
| h04-web-image-dedupe | paraphrase | #5 | #5 | #5 | terse fn; "content fingerprint" ↔ "hash" synonym; barely in top-5 | **033** |
| h05-web-assistant-ratelimit | synonym | — | — | — | impl `checkRateLimit` outranked by its **caller** (`chat/route.ts`) + feature **docs** | **033** |
| h06-mobile-motion-change | paraphrase | #3 | #4 | #4 | **sibling** geolocation handlers (`on-activity`, `on-location`…) outrank | **033** |
| h07-mobile-push-reload | paraphrase | #2 | #2 | #2 | near-#1; a sibling push handler edges ahead | 033 (margin) |
| h08-mobile-notification-time | paraphrase | #1 | #1 | #1 | hit | — |
| h09-mobile-gtfetch | literal | #1 | #1 | #1 | hit (literal token in chunk → semantic fine) | — |
| h10-mobile-wmo-weather | literal | #1 | #1 | #1 | hit | — |
| h11-cross-device-token | cross-cutting | #2 | #2 | · | cross-web↔mobile concept; ranks #2 | 033 (margin) |
| h12-wiki-tour-status | paraphrase | #2 | · | · | a sibling tour doc edges ahead | 033 (margin) |
| h13-wiki-gsi-design | paraphrase | #5 | · | · | architecture doc barely in top-5; epics outrank it | **033** |
| h14-tools-windowing-flag | literal | #1 | #1 | #1 | hit (via the `EmitCtx` flag declaration) | — |
| h15-tools-span-metric | paraphrase | #1 | #1 | #1 | hit | — |

## Diagnosis — cause clusters → lever routing

- **Ranking, not recall, is the gap (→ reranking, TASK-033).** 8 queries (h03, h04, h05,
  h06, h07, h11, h12, h13) put the right answer in the top-5 but below #1 — outranked by
  a return type, a caller, a sibling, or a doc. This is precisely the cross-encoder's job
  (re-score (query, chunk) pairs in the top-N). **Largest, cheapest, most-direct headroom.**
- **Cross-lingual gap is real and model-attributable (→ multilingual embedder, TASK-034).**
  This codebase mixes English and Polish comments/docs. h01 misses outright because the
  only implementation is Polish-commented; h02 proves it sharply — two functionally
  identical NIP validators, the English-commented one ranks #1, the Polish one is
  unreachable by an English query. `bge-small-en` is the limiter here, not chunking or
  fusion — exactly the precondition the dropped TASK-024 lacked.
- **Hybrid has little to fix in this set (→ TASK-032, deprioritized).** Every literal
  query already hits #1 under pure semantics; no miss is attributable to literal-token
  drift. A fair hybrid evaluation would need literal-identifier queries that semantics
  *misses* — uncommon here. **Provisional: lower priority pending such cases.**

## Verdict (routing for Phase 7)

- **Run order by evidence: TASK-033 (reranking) → TASK-034 (multilingual embedder) →
  TASK-032 (hybrid).** This **inverts** the planned cheap-first order; the keystone's
  whole point is that the data routes the levers.
- Each lever is still **eval-gated on this frozen set**: a win on these queries
  (MRR ↑, the two misses rescued) → adopt; no win → documented null + reject.
- **Headroom confirmed:** hit@5 < 100% on every lens, MRR ≈ 0.6 (answers cluster at
  #2–#5), two cross-lingual misses beyond top-5, grep at 40% (lexical alone is weak).

## Threats to validity

- **15 queries is small** — directional routing, not precise lever sizing. Enough to
  prioritize; each lever's task re-measures on the same frozen set.
- **GT fairness depends on enumerating parallel implementations.** Three were found and
  corrected from reading; others may remain. PO validation is the backstop.
- **hit@5 is already high (83–87%)** — the headroom is mostly in MRR (ranking). A lever
  that only improves recall would show little; reranking (which improves ranking) is
  matched to where the gap actually is.
- **Hybrid's low headroom is corpus-shaped**, not a verdict on hybrid in general — it
  reflects that this codebase's hard cases are semantic/cross-lingual, not lexical.
