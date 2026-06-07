# Phase 6b — oversized-symbol windowing: making the tail retrievable

**TASK-030** · measured 2026-06-07 · model `Xenova/bge-small-en-v1.5` · k=5 ·
oversized corpus (Python + TypeScript, 7 queries, ground truth **VALIDATED 2026-06-07 PO**)

## TL;DR

TASK-028 splits an oversized symbol (body > 512 tokens) into sub-windows instead
of letting the embedder silently truncate it. The question Phase 6b answers: **does
that make the symbol's _tail_ — the code beyond the first 512 tokens — actually
retrievable?** The A/B says **yes, decisively**, and only the **span-level** lens
(TASK-029) can grade it:

| span-level (k=5) | truncate (pre-028) | window (post-028) |
|---|---|---|
| **tail** queries hit@5 | **0%** (0/4) | **100%** (4/4) |
| **head** queries hit@5 (control) | 100% (3/3) | 100% (3/3) |
| overall hit@5 | 43% | **100%** |
| overall MRR | 0.429 | **0.762** |

Windowing lifts tail retrieval **0% → 100% at head parity**: the head (always
embedded) is unaffected, the tail goes from invisible to found. The hypothesis is
**confirmed, not null**.

## Method

- **A/B**, same shape as Phase 5/6: one corpus, one query set, one model; the only
  variable is the **`RAG_DISABLE_SYMBOL_WINDOWING`** flag (TASK-029).
  - **truncate** = `RAG_DISABLE_SYMBOL_WINDOWING=1` — the "before TASK-028" index:
    each oversized symbol is **one** chunk; the embedder truncates it at 512 tokens,
    so the tail never reaches the vector.
  - **window** = default — the oversized symbol is split into disjoint sub-windows
    (TASK-028), so the tail gets its own embedded chunk.
  - The line-chunker is the **wrong** baseline (it also windows, never truncates);
    the flag is the only faithful "before".
- **Corpus** (`src/__fixtures__/oversized/`, segment `oversized`): 3 deliberately
  oversized **single functions** (Python + TS) + 2 distractor files (15 diverse
  utilities). Each oversized function: a dense **head** concept, then — beyond the
  first 512 tokens — a **tail** concept from an unrelated domain. Windowing fires on
  all three (3–4 disjoint windows each, verified in `.rag/oversized/index.db`);
  truncate mode stores them as one chunk each (full line range, head-only vector).
  - A **single function**, not a class: the walk emits a class's methods as their
    own chunks, which would make the tail retrievable in *both* modes (delta = 0).
    A monolithic function has no sub-symbols, so the tail exists only inside the
    windowed chunk.

| file | symbol | head | tail (lives > 512 tok in) |
|---|---|---|---|
| sensor_pipeline.py | `normalize_sensor_batch` | sensor validation / normalization | polygon area (shoelace formula) |
| shift_roster.ts | `assignShiftRoster` | shift scheduling / conflict resolution | HSL→RGB colour conversion |
| digest_report.ts | `renderDigestReport` | fixed-width report formatting | Levenshtein edit distance |

- **Span-level metric** (`evaluateSpan`, TASK-029): a hit is a top-k chunk in the
  expected file whose **line range overlaps the golden span** (the region that
  answers the query). This is the only lens that can grade windowing — file-level
  and symbol-level cannot tell *which window* of a multi-window symbol was retrieved.
- **Ground truth**: `expectedFiles` + `expectedSymbols` + `expectedSpans` in
  `eval/queries.oversized.json`, **VALIDATED 2026-06-07 PO**. Anti-bias: spans were
  derived from **reading the fixtures** (the `SECTION` markers delimit head vs tail),
  never from search output, and frozen after PO acceptance. Frozen results:
  `eval/results-phase6b-{truncate,window}.json`.

### Anti-bias disclosure — two confounds found and removed before the result settled

The preliminary run **exposed two confounds**, both fixed by correcting the
*corpus*, never the ground truth (which lines answer a query never changed to chase
a number):

1. **Docstring leakage.** The first fixtures described the tail concept in the head
   docstring (e.g. "exponential-backoff retry with jitter"). That text lands inside
   the truncated head vector, so truncate mode "found" the tail via the head. Fixed
   by scrubbing tail vocabulary from every head docstring/comment — the tail concept
   now appears **only inside the tail**.
2. **Domain-adjacent tail.** The original sensor tail was *exponential-backoff
   retry* — a networking concept **domain-adjacent** to the telemetry head (sending
   data to a server is a natural part of a telemetry pipeline). The truncated head
   scored cosine 0.583 to a backoff query and ranked #3 — a partial false parity,
   exactly the failure mode TASK-030 anticipated ("the tail concept must be distant
   from the head, or the delta vanishes"). Fixed by replacing the tail with a
   **domain-orthogonal** concept (polygon area / shoelace) plus two geometry
   neighbour distractors — mirroring the clean separation the colour and
   edit-distance tails already had.

## Per-query (first-hit rank, file / symbol / span)

| query | type | truncate | window |
|---|---|---|---|
| t1-sensor-shoelace | tail | — / — / — | #2 / #2 / #2 |
| t2-shift-hsl-rgb | tail | — / — / — | #3 / #3 / #3 |
| t3-digest-levenshtein | tail | — / — / — | #1 / #1 / #1 |
| t4-sensor-ring-area | tail | — / — / — | #2 / #2 / #2 |
| h1-sensor-validate | head | #1 / #1 / #1 | #1 / #1 / #1 |
| h2-shift-schedule | head | #1 / #1 / #1 | #1 / #1 / #1 |
| h3-digest-format | head | #1 / #1 / #1 | #1 / #1 / #1 |

## Analysis

- **The tail is invisible under truncation.** For every tail query, the single
  truncated chunk does not rank — its vector is the head, and the head is
  orthogonal to the tail concept. Worked example (t1 "shoelace polygon area"):
  - **truncate** top-5 = `triangle_area` 0.755, `bounding_box` 0.642,
    `relativeLuminance` 0.635, … — the geometry neighbours fill the top; the
    sensor chunk (head-only vector) is **not in the top-8** (< 0.55). Miss.
  - **window** top-5 = `triangle_area` 0.755, **`sensor_pipeline.py [97-128]`
    0.689** (the tail window, span 103–122 ⊂ it), `bounding_box` 0.642, … — the
    tail window carries the shoelace vector and ranks **#2**. Span hit.
  Windowing surfaces a vector (0.689) that truncation buried (< 0.55).
- **The head is untouched.** All three head controls hit #1 in both modes — window
  1 always carries the head, so windowing adds tail reach without costing head
  precision. The delta is **tail-specific**, not "window mode is better at
  everything".
- **Why span-level is the right gate.** Here file/symbol/span move together because
  the corpus separates head and tail cleanly. But span-level is the only lens whose
  **definition** is correct for windowing: it credits a hit only when the retrieved
  chunk's range covers the answer region, so it cannot be fooled by a same-symbol
  head window or a same-file gap chunk ranking for a tail query. It certifies the
  window-mode hits are genuine **tail** retrievals (e.g. t1 → window [97-128], not
  the head window). Symbol-level would credit *any* window of the right symbol;
  file-level, any chunk of the right file.
- **The truncate "full-range" subtlety (TASK-029), confirmed empirically.** In
  truncate mode the single chunk's line range spans the *whole* symbol, so it
  overlaps the tail span — span-level *would* credit it **if it ranked**. It does
  not, because the head-only vector is too far from the tail query. The
  discrimination is **retrieval-driven**, which is why corpus design (tail distant
  from head) is the load-bearing requirement — see the confound disclosure above.

## Verdict

- **TASK-028 windowing delivers a measurable benefit**: tail span hit@5 **0% →
  100%** at head parity (overall MRR 0.429 → 0.762). The oversized-symbol tail,
  invisible to a truncating index, is reliably retrievable once windowed.
- **TASK-029's span-level metric is the lens that grades it** — file- and
  symbol-level are blind to *which* region of a multi-window symbol is retrieved.
- **Honesty about scope.** This isolates the windowing effect on a small, purpose
  built corpus; it does not re-measure the production 50q/polyglot sets (there every
  fixture fits one window, so windowing never fires — confirmed unchanged). The
  result is the *existence proof* that windowing rescues the tail, graded on the
  only metric that can see it.

## Threats to validity

- **Small corpus** (26 chunks truncate / 32 window): top-5 is ~20% of the corpus, so
  the truncate misses depend on enough distractors out-ranking the head. Mitigated by
  topical-neighbour distractors per tail; the heads land well outside top-5 (< 0.55),
  not marginally.
- **Domain distance is the load-bearing assumption.** As the backoff confound showed,
  a tail concept adjacent to the head domain shrinks the delta. The frozen corpus uses
  orthogonal tails (geometry, colour, string-edit) — chosen by reading, validated PO.
- **bge-small-en mid-range geometry**: loosely-related technical text sits at
  cosine ~0.5–0.6, so absolute scores are not separations — the *ranking* (k=5 cut)
  is what the metric reads.
