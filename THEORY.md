# Theory — how semantic code search (RAG) works

Conceptual background for `rag-mcp`. This is the *why* behind the code; the
*how* lives in [README.md](README.md) and the source.

---

## 1. RAG in two phases

RAG = **Retrieval-Augmented Generation**. It uses vector search to find relevant
context *before* an AI agent reasons about it. Two phases, two different times:

```
┌─ INDEXING (CLI, once + incrementally on change) ────────────────────────┐
│  files → chunks (AST / markdown / lines) → embeddings → vector store      │
└──────────────────────────────────────────────────────────────────────────┘

┌─ QUERY (MCP server, on every agent task) ───────────────────────────────┐
│  "fix the auth bug" → embed query → kNN search → top-K chunks            │
│                       (same model)              (path + line range + text) │
└──────────────────────────────────────────────────────────────────────────┘
```

"Vectorizing code" = "generating embeddings" = the core of RAG. Same thing,
different names.

The problem it solves: plain text search (`grep`) fails when the file name
doesn't contain the search word (`token-validator.ts` when you search "auth"),
when a concept is spread across modules, or when the question is conceptual
("payment logic") but the code uses different vocabulary. Semantic search
matches by **meaning**, not by string.

---

## 2. Embedding (vectorization)

An embedding model turns any piece of text into a list of numbers — a vector:

```
"verify JWT token"   →  [0.21, -0.89, 0.38, 0.11, ...]   ┐ similar meaning →
"validate auth token"→  [0.23, -0.87, 0.41, 0.09, ...]   ┘ nearby vectors
"compute VAT tax"    →  [-0.54, 0.12, -0.91, 0.67, ...]   ← far away
```

The model was trained so that **semantically similar text lands near similar
coordinates**, and different text lands far apart. That geometric arrangement is
the entire trick — search becomes "find the nearest points".

---

## 3. The two models — and why they cooperate without speaking the same "language"

There are **two completely different models** in a RAG setup, and the common
confusion is thinking the agent must "read" the vectors the embedder produced.
It does not.

| | Embedding model (e.g. `bge-small`) | The LLM / agent (e.g. Claude) |
|---|---|---|
| Job | text → vector | text → reasoning about code |
| Input | plain text | plain text |
| Output | coordinates | an answer |
| Sees the other's work? | no | no |

### The key insight: the agent never reads vectors

A vector has exactly **one** purpose: it is a *coordinate used for similarity
search*. It is used only to decide *which* chunks are relevant. Once the nearest
chunks are found, the vector is discarded and the agent receives the **original
source text** of those chunks.

```
INDEXING (bge-small works):
  auth.ts → "verify JWT..." → [0.21, -0.89, ...] ─┐
                                                   ▼
                                          vector store
                                          (vector + ORIGINAL text)

QUERY (search_codebase):
  "fix auth" → bge-small → [0.23, -0.87, ...]
                               │
                               ▼  kNN: find nearest vectors
                          top-K hits
                               │
                               ▼  ← HERE the vector disappears
  the agent receives:  auth.ts:45-90 + PLAIN SOURCE TEXT
```

`search_codebase` returns `filePath`, `startLine-endLine`, and the chunk's
**text** — exactly what `grep` returns today. The agent reads code the way it
always has; only *how the relevant chunks were found* is different.

### The shared language is the source text, not vectors

The embedder and the agent communicate only through (a) plain text, which both
read, and (b) the database, which stores the vector *next to* its text. Vectors
are the embedder's private language — used only to measure "what is near what".

**Analogy — the librarian.** The embedder is a librarian who shelves books by
topic similarity and records shelf coordinates in a catalog. When you ask for
"books about JWT", the system computes which coordinates are nearest and hands
you the **physical books**. You read the books (text), not the catalog
coordinates. You never need to understand the cataloging math. The librarian can
even be a weak reader — they only need to *group* well. Understanding the content
is entirely the agent's job.

This is why a **small, cheap** embedding model can serve a **large, capable**
LLM: the embedder answers *"where to look"*, the agent answers *"what to do"*.
They meet on plain text, never on vectors.

---

## 4. Why the SAME model must index and query

The only place model consistency matters — and it has nothing to do with the
agent. The query vector and the chunk vectors must live in the **same space** for
"distance = similarity" to hold. Index with `bge-small`, query with `all-MiniLM`,
and the coordinates come from two different maps → kNN returns garbage.

That is why the tool pins one model per store and enforces a dimension contract
(see §5). Changing the embedding model requires rebuilding the index.

---

## 5. The embedding vector in detail

### It is not a probability vector

A common shorthand, but misleading. The embedder produces a **dense embedding**,
not a probability distribution.

| | Probability vector | Embedding (what we have) |
|---|---|---|
| Components | 0…1, **sum to 1** | any value, **can be negative** |
| Meaning of a component | "chance of class i" | no standalone meaning |
| Example | `[0.7, 0.2, 0.1]` | `[0.23, -0.87, 0.41, ...]` |

### Dimension: 384

For `bge-small-en-v1.5` the vector has **384 dimensions**. Where does that number
come from?

It is the model's **`hidden_size`** — an architectural hyperparameter of the
neural network (a BERT-style transformer), fixed when the model was trained. It
is **not derived from anything semantic**; it is a design trade-off between
capacity and size/speed:

```
bge-small  → 384   (small, fast, ~30 MB)
bge-base   → 768
bge-large  → 1024  (more capacity, slower)
```

More dimensions = more room to encode subtle distinctions, but a bigger and
slower model. 384 is a deliberate "small and good enough" choice.

### What do the 384 numbers describe?

**Crucially: no single dimension has a standalone meaning.** It is not the case
that dimension 17 = "is about authentication".

The 384 numbers **together** are the coordinates of a point in a learned
**semantic space**. Meaning is **distributed** across all dimensions — directions
and regions of the space correspond to concepts, but in an *entangled* way that
is not human-readable. The model learned them so that:

> semantically similar texts land **close together**, and different ones land
> **far apart**.

That is the whole mechanism. "Close" is measured with cosine similarity
(in [src/store/vector-store.ts](src/store/vector-store.ts): `score = 1 - distance²/2`).

### Geometric intuition

The vectors are **L2-normalized** (length = 1), so each lies on the surface of a
**384-dimensional unit hypersphere**. Semantic search = "which indexed point on
that sphere is nearest to the query point". The **sum of squares** of the
components = 1 (not the sum — another difference from probabilities).

### Why a fixed dimension is critical for the tool

The store column is `vec0(embedding float[384])`. To compare two vectors they
must have the **same dimension**, so a `dimensions` contract runs through the
whole codebase:

```
embedder.dimensions (384)  →  VectorStore schema (float[384])
                           →  guard in upsert() / search()
```

This is why switching models (e.g. to `bge-base` = 768) **requires rebuilding the
index** — query vectors from the new model do not live in the old 384-d space.
The store enforces this with a `Dimension mismatch → rebuild` guard at open time.

---

## 6. Chunking — why structure-aware splitting matters

The embedder turns a *chunk* of text into one vector. How you cut the file into
chunks decides retrieval quality:

| File type | Strategy | Chunk boundary |
|---|---|---|
| `*.ts` / `*.tsx` / `*.js` | AST (tree-sitter) | function / class / method / interface / type |
| `*.py` | AST (tree-sitter) | function / class / method |
| `*.go` | AST (tree-sitter) | function / method (`Recv.m`) / type / interface |
| `*.rs` | AST (tree-sitter) | function / type (struct/enum) / interface (trait) / method (`Type.m` in impl) |
| `*.md` | headings | section under `#` / `##` (code fences respected) |
| other text | line window + overlap | N lines with overlap |

A chunk = one semantic unit gives one focused vector. Blind fixed-size slicing
mixes unrelated code into one vector, blurring its position in the space and
hurting search. This is why structure-aware (AST) chunking is the highest-leverage
component for quality.

---

## 7. Supporting other programming languages

The embedder and vector store are **already language-agnostic** — `bge-small`
embeds any text, the store holds any vector. All per-language work is in the
**chunker** (structure extraction).

**Today**, structure-aware chunking runs on a single engine — **tree-sitter**.
TS/JS and Python are parsed by it; any other language can be indexed by adding
include globs to the config and falls through to the line chunker (searchable,
but without structure awareness). ts-morph was replaced by the tree-sitter TS/JS
chunker once an eval spike showed file- and symbol-level parity at hit@5 84%, so
one engine now covers every supported language.

The mechanical work (parser init/memoisation, leading-comment capture, chunk
emission, gap filling, fallback, sort) lives once in
[tree-sitter-core.ts](src/chunk/tree-sitter-core.ts). A language supplies only a
**top-level walk** that classifies node types into chunk kinds, plus its comment
prefixes and grammar:

```
python  → function_definition, class_definition          (#  comments)
typescript → function/class/interface/type_alias…        (// and /* */)
go      → function_declaration, method_declaration, type_declaration
rust    → function_item, struct_item, enum_item, trait_item, impl_item
```

**For first-class support** of a new language add — without touching the core:

1. A `detectLanguage` mapping via the registry ([src/lang/registry.ts](src/lang/registry.ts)).
2. A grammar `.wasm` dependency + `ensureGrammars` resolution.
3. A walk module under [src/chunk/walks/](src/chunk/walks/) (like
   [python.ts](src/chunk/walks/python.ts)) that classifies node types into chunk
   kinds via the shared core. The generic chunker, core, and router are untouched.

**Model caveat:** `bge-small-en` is English-trained. It works well for code
(identifiers are English-ish) but for non-English prose or exotic languages a
multilingual or code-specialized model (e.g. `voyage-code-2`) may retrieve
better. The model registry makes swapping a one-line config change.

---

## In one sentence

RAG uses a small, cheap embedding model as a **semantic search engine** —
answering *"where to look"* — and leaves *"what to do with the code"* to the
capable LLM; the two never exchange vectors, only plain text, which is exactly
why one tiny model can serve any language and any agent.
