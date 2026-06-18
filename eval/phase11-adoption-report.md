# Phase 11 — Adoption loop & miss corpus (TASK-044)

**Date:** 2026-06-18
**Source:** real `.rag/usage.jsonl` from GuideTrackee agent sessions, 2026-06-05 → 2026-06-17 (86 records, not synthetic).
**Status of verdict:** ✅ classification **VALIDATED PO 2026-06-18** (frozen after acceptance; antibias — the model does not self-certify its own miss labels, per TASK-016/031).

## 1. Adoption — confirmed

The MCP server was genuinely used across ~12 days of real tool-building sessions:

| Tool | Calls |
|---|---|
| `search_codebase` | 64 |
| `get_chunk` | 11 (10 found, 1 not-found) |
| `reindex` | 11 |

- **`search_codebase` topScore:** min 0.62 / median 0.74 / max 0.87.
- **Latency:** avg 1368 ms, p95 5252 ms (dominated by query embedding, not the kNN
  scan — cf. TASK-046: pure kNN is ~2 ms at this index size).
- **Follow-up:** 22% of searches followed by `get_chunk` within 5 min — the agent
  mostly acted on the snippet alone, pulling full text only when needed.
- **Segment spread:** tools 27 · web 15 · mobile 7 · wiki 4 — cross-cutting use,
  not one corner of the repo.

→ **Closes the acceptance criterion `[~]`** ("the agent really reaches for
`search_codebase`"). Adoption is real and healthy.

## 2. Miss corpus — classification

The approved reanimation condition for hybrid retrieval (b. TASK-032) is
**documented lexical misses** ("a literal identifier in the query, semantic miss").
Examining every low-signal query:

### 2a. Zero-result searches (3) — NOT misses, timing artifacts

| When | Segment | Query |
|---|---|---|
| 2026-06-05 11:23 | web | "DynamoDB storage query paginated" |
| 2026-06-05 11:28 | web | "Storage class DynamoDB web storage layer" |
| 2026-06-05 12:24 | web | "branch develop test main git workflow" |

All three are from **2026-06-05, before the first reindex (2026-06-07)** — the
`web` segment was not yet populated. The identical concept
("Storage class DynamoDB get save query update delete") returns results (0.74)
once the index exists; 12 later `web` searches succeed. → **empty-segment
artifact, not a retrieval miss.** (Actionable UX nit, §4.)

### 2b. Weakest scored queries (0.62–0.72) — mostly correct, modest score

| score | seg | query | top result | verdict |
|---|---|---|---|---|
| 0.618 | web | "branch test checkout develop git" | `app/.../page.tsx` | **no valid target in segment** — git workflow lives in `wiki`, not `web` code; wrong-segment query |
| 0.667 | web | "Storage class save get query update delete" | `lib/storage/file-storage/index.ts` | **hit** (Storage class) |
| 0.676 | tools | "SQL query construction parameter binding sqlite" | `src/eval/queries.ts` | **soft ranking** — `store/vector-store.ts` (actual SQL) arguably better; weak |
| 0.697 | mobile | "lost participant detection mobile app" | `lib/background-geolocation-service/handlers/on-http.ts` | **hit** |
| 0.711 | tools | "execute shell command spawn child process git hook" | `src/hooks/install-hooks.ts` | **hit** |
| 0.716 | tools | "evaluateSymbol container-aware symbol match…" | `src/eval/metrics.ts` | **hit at #1** — literal symbol query, pure semantics wins |

### 2c. Classification summary

| Class | Count | Notes |
|---|---|---|
| **Lexical miss** (literal id, semantic miss) | **0** | the one literal-identifier query (`evaluateSymbol`) hit #1 |
| **Cross-lingual** (Polish) | **0** real | only **1/64** queries were Polish at all — agents query in English (per tool guidance) |
| **Ranking softness** | 1–2 | "SQL query construction" (#1 plausibly wrong); mild, not a recall miss |
| **Wrong-segment / no valid target** | 1 | git workflow queried inside `web` |
| **Empty-segment artifact** | 3 | pre-first-reindex, §2a |

## 3. Verdict — routing

- **TASK-032 (hybrid retrieval) gate stays CLOSED.** Real usage produced **zero
  lexical misses** — literals already rank #1 under pure semantics, exactly the
  Phase-7 (TASK-031) diagnosis. No A/B hypothesis materialized. Discipline as with
  the struck b. TASK-024: without a documented lexical miss, there is nothing to fuse.
- **TASK-034 (multilingual embedder) not retriggered.** The real workload is
  **English-dominant (1/64 PL)** — the Polish cross-lingual gap is near-theoretical
  for actual agent use. Revisit only if a genuine Polish-query workload appears
  (dual / language-routed index), as TASK-034 already concluded.
- **Practical ceiling holds in real usage.** Median topScore 0.74, healthy
  adoption, no recall misses outside timing artifacts. The Phase-3 configuration
  (bge-small + tree-sitter + pure kNN) remains the practical ceiling — now
  confirmed against *real* sessions, not just the eval sets.

## 4. Bonus finding (actionable, minor)

Querying a segment **before it is indexed** returns silent empty results with no
hint. A one-line guard in `search_codebase` — when a `segment` filter matches a
segment with 0 chunks, return a note ("segment 'web' has no indexed chunks — run
`rag-index`") instead of a bare empty list — would have turned the 3 confusing
2026-06-05 zero-results into an actionable message. Small DX improvement; not a
retrieval-quality issue. (Candidate micro-task, not gating.)

## Method / antibias

- Data is the unaltered production `usage.jsonl`; no queries authored for this report.
- Miss labels above were the model's reading, **VALIDATED PO 2026-06-18** and frozen
  on acceptance (the model does not grade its own homework — same rule as
  TASK-016/030/031).
