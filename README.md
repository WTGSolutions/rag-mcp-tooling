# rag-mcp

Semantic code index (RAG) + MCP server for any codebase. Lets an AI agent
(e.g. Claude Code) search a repository **semantically** — by meaning — instead of
only by text (`grep`/`find`), cutting context tokens and missed matches on large
projects.

It is **project-agnostic**: point it at any repo via a config file. Vectorization
runs **fully offline** on a local model — your code never leaves the machine.

> Part of the GuideTrackee monorepo. Design and rationale: `wiki/.epics/EPIC-041-mcp-rag-semantic-code-index.md`.

## How it works

```
INDEXING (CLI)                          QUERY (MCP server)
  walk repo                               "fix the auth bug"
   → chunk (AST / markdown / lines)         → embed query (same model)
   → embed (local, offline)                 → kNN search in the vector store
   → store in SQLite + sqlite-vec           → top-K chunks (path + line range)
```

The embedding model only **finds** relevant chunks; the agent then reads the
**original source text** of those chunks. Vectors never reach the agent.

> For the concepts behind this — embeddings, the two-model relationship, what the
>384-d vector actually is, and how to support other languages — see [THEORY.md](THEORY.md).

## Status

**Complete and in use.** Indexing, the MCP server, the eval harness, auto-reindex
git hooks, usage logging, and multi-language (tree-sitter) chunking are all built
and tested.

| Component | Status |
|---|---|
| Config loader (`rag.config.json`) | ✅ |
| File walker (`.gitignore`, segments, binaries) | ✅ |
| Chunkers: line (fallback), TS/JS + Python + Go + Rust + Java (AST via tree-sitter), Markdown (headings) | ✅ |
| Local embedder (transformers.js, offline) | ✅ |
| Vector store (SQLite + sqlite-vec, kNN) | ✅ |
| Incremental reindex (file-hash change detection) | ✅ |
| `rag-index` CLI + auto-reindex git hooks | ✅ |
| MCP server (`search_codebase`, `get_chunk`, `index_status`, `reindex`) | ✅ |
| Eval harness (file + symbol-level hit@5 / MRR, anti-bias ground truth) + usage logging | ✅ |

Acceptance: a full index of GuideTrackee (`web` + `mobile` + `wiki` + `tools`)
processes **~1,150 files → ~5,500 chunks** offline with no errors; the PO-validated
50-query acceptance set scores **hit@5 84% / MRR 0.69** with `bge-small-en`.

## Install & build

Requires Node ≥ 20.

```bash
cd tools/rag-mcp
npm install
npm run build      # → dist/
npm test           # fast unit tests (offline, no model download)
```

## Configuration

Create a `rag.config.json` in the project you want to index:

```json
{
  "segments": [
    { "name": "web", "root": "web/src", "include": ["**/*.{ts,tsx}"] },
    { "name": "mobile", "root": "mobile/src", "include": ["**/*.{ts,tsx}"] },
    { "name": "wiki", "root": "wiki", "include": ["**/*.md"] }
  ],
  "exclude": ["**/node_modules/**", "**/*.test.ts", "**/dist/**"],
  "embedder": { "provider": "local", "model": "Xenova/bge-small-en-v1.5" },
  "chunk": { "maxTokens": 512, "overlapLines": 8 },
  "store": { "path": ".rag/index.db" }
}
```

| Field | Meaning |
|---|---|
| `segments[]` | Independent index areas (e.g. separate gits in a monorepo). `root` is the directory; `include` are globs relative to it. `name` tags each chunk so queries can filter by segment. |
| `exclude` | Globs dropped from every segment (on top of built-in binary/lockfile exclusions). `.gitignore` is always respected. |
| `embedder.provider` | `local` only in the MVP (offline). |
| `embedder.model` | Model id or short alias (see below). |
| `chunk.maxTokens` | Target chunk size (approx. tokens). |
| `chunk.overlapLines` | Lines of overlap between adjacent line-windowed chunks. |
| `store.path` | Where the vector DB is written. Keep it under `.rag/` and gitignored. |

All optional fields have defaults; only `segments` is required.

## Embedder (offline)

Vectorization uses [`@huggingface/transformers`](https://github.com/huggingface/transformers.js)
(ONNX, CPU). The model is downloaded **once** on first use, then cached and run
fully offline — no API keys, no network, no code leaving the machine.

Supported models (each 384-dim):

| Config value (or alias) | Pooling | Notes |
|---|---|---|
| `Xenova/bge-small-en-v1.5` (`bge-small`) | CLS | Default. |
| `Xenova/all-MiniLM-L6-v2` (`all-minilm`) | mean | Alternative. |

Pooling is pinned per model (it's a modeling choice and can't be auto-detected);
picking the wrong one silently degrades quality.

**Model cache.** Models are cached in `~/.cache/rag-mcp/models/` — a single
user-wide location, so the model downloads once and is shared across every
project and invocation (the model is identical everywhere). After the first
download the tool works with no network — verify with
`HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1`. Override the location with the
`RAG_MODEL_CACHE` env var (useful in CI or sandboxes).

> The model has a hard 512-token input limit. Every chunker keeps chunks within
> `chunk.maxTokens` (default 512): the line and markdown chunkers window by
> budget, and oversized AST symbols are split into sub-windows that repeat the
> symbol signature (TASK-028) instead of being truncated. Chunk size is
> *estimated* (`chars/4`), so a window can still occasionally graze the model's
> exact tokenizer count.

## Usage — indexing

### From the monorepo root (primary path)

```bash
npm run rag:build                         # build dist/ once, or after changing rag-mcp source
npm run rag:index                         # incremental reindex (skips unchanged files)
npm run rag:index -- --full              # full reindex, ignoring stored hashes
npm run rag:index -- --segment mobile    # one segment only
npm run rag:reset                         # delete store and rebuild from scratch (after model change)
npm run rag:server                        # start MCP server manually (debug / without Claude Code)
```

The scripts hard-wire the config path (`rag.config.json` in the monorepo root) and the
`dist/` location, so there is nothing to remember or type. Requires `dist/` to be built
first (`rag:build`); there is no auto-rebuild on index to keep the loop fast.

> **`npm link` alternative.** Running `npm link` inside `tools/rag-mcp/` installs
> `rag-index` and `rag-mcp` as global commands, removing the need for the root scripts.
> Useful if you work across multiple projects with different configs.

### Direct invocation (reference)

From the monorepo root, or with a non-default config path:

```bash
node tools/rag-mcp/dist/cli/rag-index.js --config rag.config.json
node tools/rag-mcp/dist/cli/rag-index.js --config rag.config.json --full
node tools/rag-mcp/dist/cli/rag-index.js --config /path/to/other-project/rag.config.json
```

After `npm link` inside `tools/rag-mcp/`, the `rag-index` binary is available globally:

```bash
rag-index --config rag.config.json --full
rag-index --config /path/to/other-project/rag.config.json
```

| Flag | Meaning |
|---|---|
| `-c, --config <path>` | Config file (default `rag.config.json`). Relative `segment.root` and `store.path` resolve against the config file's directory, not the shell's cwd. |
| `--changed` | Only re-index files whose content hash changed (default). |
| `--full` | Re-index everything, ignoring stored hashes. Use after changing chunking settings (`chunk.maxTokens`, `include` globs, etc.) to ensure all files are re-chunked. |
| `--reset` | Delete the vector store and re-index from scratch. Use after changing `embedder.model` to avoid dimension mismatches (implies `--full`). |
| `-s, --segment <name>` | Process only the named segment. |
| `-h, --help` | Usage. |

Progress and the summary (`added / skipped / removed / total-chunks / time`) go to
**stderr**; exit code is `0` on success, `1` on error — suitable for CI or a
git hook. Incremental runs after a small edit re-embed only the changed files.

## Auto-reindex on commit, checkout, and merge (git hooks)

Keep the index fresh automatically: three hooks run `rag-index --changed` in the
**background** after the most common events that change working-tree content.
All are **non-fatal** — commits/checkouts/merges never wait for embeddings and
never fail because of a hook.

| Hook | When git fires it | Reindex condition |
|---|---|---|
| `post-commit` | after every local commit | always |
| `post-checkout` | after `git checkout` / `git switch` | only on **branch switch** (`$3=1`); file restores are skipped |
| `post-merge` | after `git pull` / `git merge` | always |

```bash
npm run rag:install-hooks      # install into every repo backing the config
npm run rag:install-hooks -- --dry      # preview which repos would get the hooks
npm run rag:uninstall-hooks    # remove the managed blocks again
```

The installer reads the segments in `rag.config.json`, asks git which repository
each segment lives in (`git -C <root> rev-parse --show-toplevel`), and writes
**three hooks per distinct repo**. This makes it topology-agnostic with no flags:

| Topology | `.git` | Hooks installed |
|---|---|---|
| Single project | one, at the repo root | 3 |
| Monorepo (many packages) | one, at the repo root | 3 |
| Separate repos under a shared root | one per sub-repo; root is **not** a repo | 3×N (three per sub-repo) |

How it behaves:

- **Idempotent.** Re-running replaces the managed block in place (fenced by
  `# >>> rag-mcp auto-reindex (managed) >>>` markers). It never duplicates.
- **Coexists with other hooks.** If any of the three hook files already exist
  (Husky, lint-staged), the block is **appended** and the rest is left untouched;
  `--uninstall` strips only the managed block from each file.
- **Background + locked.** Each hook detaches `scripts/reindex-bg.sh`, which takes
  a single-writer lock (`.rag/reindex.lock`) so concurrent triggers (e.g. a
  commit arriving while a checkout reindex is still running) don't stack, and
  logs to `.rag/reindex.log`. Build `dist/` first (`rag:build`); if it's missing
  or `node` isn't on `PATH`, the run is skipped with a note in the log — the
  triggering git operation still succeeds.

- **Safe alongside foreign hooks.** A hook written in a non-sh language
  (a Python or Node shebang) is **skipped with a warning** rather than corrupted.
- **Requires a POSIX shell** (`sh`). On Windows use Git Bash / the shell git ships.

> The hooks bake in absolute paths to the runner and the config at install time,
> so moving the checkout means re-running `rag:install-hooks`. Logic lives in
> `reindex-bg.sh`, so changing *behaviour* needs no reinstall.

## Usage — programmatic (Phase 2 building blocks)

The package exposes its pipeline as a library (the MCP server will consume the
same API):

```ts
import { loadConfig, createEmbedder, reindex, VectorStore } from '@guidetrackee/rag-mcp';

const config = loadConfig('rag.config.json');
const embedder = createEmbedder(config.embedder);
await reindex({ config, embedder, mode: 'incremental' });

const store = VectorStore.open(config.store.path, embedder.dimensions, embedder.modelId);
const [queryVec] = await embedder.embed(['where is auth handled?']);
const hits = store.search(queryVec, 8);          // [{ chunk, score }]
store.close();
```

## MCP server

After building the index, wire the server into Claude Code via `.mcp.json` at
the repository root:

```jsonc
// .mcp.json (place alongside rag.config.json)
{
  "mcpServers": {
    "rag": {
      "command": "node",
      "args": [
        "tools/rag-mcp/dist/server/server.js",
        "--config", "rag.config.json"
      ]
    }
  }
}
```

The server flag:

| Flag | Meaning |
|---|---|
| `-c, --config <path>` | Config file (same `rag.config.json` used by `rag-index`). Relative paths inside it resolve from the config file's directory. |

On startup the server reads `store_meta` from the database to verify that
the configured embedding model matches the one the index was built with. A
mismatch produces a clear `Dimension mismatch → rebuild` error.

### Tools

The server exposes four tools over the MCP protocol:

---

#### `search_codebase`

Semantic search: embeds the query with the same model the index was built
with, runs kNN in the vector store, and returns the most relevant chunks.

```jsonc
{ "query": "lost participant detection",   // required
  "k": 8,                                   // optional, default 8, max 100
  "segment": "mobile"                       // optional, restrict to one segment
}
```

**Returns** (structuredContent):
```jsonc
{ "results": [
    { "id": "<sha1>", "filePath": "...", "startLine": 5, "endLine": 42,
      "segment": "web", "kind": "function", "symbol": "isLost",
      "score": 0.83 }
  ]
}
```

Each result also appears as a clickable `path:line` reference in the text
content. `score` is cosine similarity (0–1; higher is more relevant). `id`
can be passed directly to `get_chunk`.

---

#### `get_chunk`

Fetches the **full, untruncated** text of a single chunk by its id. Use it
to expand a `search_codebase` hit when the snippet is not enough.

```jsonc
{ "id": "<sha1 from search_codebase>" }   // required
```

**Returns** (structuredContent):
```jsonc
{ "id": "...", "filePath": "...", "startLine": 5, "endLine": 42,
  "segment": "web", "kind": "function", "symbol": "isLost",
  "language": "typescript", "fileHash": "...", "text": "<full source>" }
```

Unknown `id` → `isError: true` with a clear message.

---

#### `index_status`

Reports index health without requiring any arguments.

```jsonc
{}
```

**Returns** (structuredContent):
```jsonc
{ "chunks": 5713, "files": 1238, "modelId": "Xenova/bge-small-en-v1.5",
  "dimensions": 384, "lastIndexed": "2026-06-04T12:00:00.000Z",
  "segments": [
    { "segment": "mobile", "chunks": 773,  "files": 304 },
    { "segment": "web",    "chunks": 3421, "files": 894 },
    { "segment": "wiki",   "chunks": 1519, "files": 51  }
  ]
}
```

Use this to check whether the index is built and roughly current before
starting a session.

---

#### `reindex`

Refreshes the index without leaving the agent session. Runs incrementally
(only changed/deleted files) unless the underlying files have all been
re-written.

```jsonc
{ "paths": ["/abs/or/rel/path/to/file.ts"],  // optional — restrict to files
  "segment": "mobile"                          // optional — restrict to segment
}
```

Without arguments, re-indexes **all segments** incrementally (unchanged files
are skipped by content hash).

**Returns** (structuredContent):
```jsonc
{ "added": 1, "skipped": 4, "removed": 0,
  "totalChunks": 5714, "durationMs": 320,
  "unmatchedPaths": []   // paths that matched no indexed file
}
```

Only one `reindex` call runs at a time; a concurrent call is rejected with
`already in progress`.

> ⚠️ **Model change requires a full rebuild.** The vector dimensions are
> fixed in the database schema at index creation time. After switching
> `embedder.model` in the config, run `rag-index --reset` (or `npm run rag:reset`)
> — it deletes the old store (including WAL sidecars) and rebuilds from scratch.
> Then **restart the MCP server** so it opens the new store (the running server
> holds an open file handle to the old database).

---

### Typical session flow

```
1. npm run rag:index -- --full              # first-time index (one-off; from the monorepo root)
2. Start Claude Code with .mcp.json pointing at this server
3. Agent calls search_codebase("your question") → gets ids
4. Agent calls get_chunk(id) for the most promising hits
5. Agent calls reindex() after you edit files → index stays current
```

## Monitoring usage

The MCP server logs every tool call (query, result count, top score, latency) to
`.rag/usage.jsonl` — one JSON line per call, appended in the background.
Logging is always non-fatal: an I/O error is printed to stderr but never
propagates to the caller. Disable it with `RAG_USAGE_LOG=0` in the server's
environment.

Print a summary report from the monorepo root:

```bash
npm run rag:usage
```

Or directly:

```bash
node tools/rag-mcp/dist/cli/rag-usage.js --config rag.config.json
```

Example output:

```
RAG-MCP Usage Report
====================

search_codebase: 24 call(s)
  Top score:  min 0.61  median 0.79  max 0.94
  Latency:    avg 38ms  p95 87ms
  Follow-up:  67% of searches followed by get_chunk (≤5 min)

get_chunk: 18 call(s)  (found 17, not-found 1)

reindex: 2 call(s)

Top queries:
    4×  "lost participant detection"
    3×  "auth token validation"

Top segments:
   14×  mobile
   10×  web
```

The follow-up rate — fraction of searches where `get_chunk` is called within
5 minutes — is the primary usefulness signal: a high rate means the agent
frequently digs deeper after finding relevant hits.

The log is in `.rag/` which is already gitignored. Reset it by deleting
`.rag/usage.jsonl`.

## Limitations & future directions

**Known limitations (honest scope).**

- **Symbol-level ground truth is partial.** A symbol-level metric exists
  (`evaluateSymbol`, TASK-027) and the polyglot set carries `expectedSymbols`,
  but the 50-query acceptance set is still file-level (`hit@5`/`MRR` on files).
  A firmer multi-language verdict needs symbol GT on a larger corpus.
- **Symbol windowing is not yet eval-validated at scale.** Oversized AST symbols
  are now sub-windowed rather than truncated (TASK-028), but every current
  fixture fits in a single window, so the large multi-chunk regime — where
  windowing matters most — is still under-tested.
- **English-centric embedder.** `bge-small-en` is trained on English; heavily
  non-English identifiers/comments may retrieve worse (not stress-tested).
- **Brute-force kNN.** `sqlite-vec` scans all vectors per query — excellent at
  repo scale, unproven on very large (100k-file) monorepos.

**Recently addressed.** Oversized-symbol windowing (TASK-028) and a symbol-level
eval metric (TASK-027) — formerly the top two directions — are implemented and
measured; see [`eval/phase6-report.md`](eval/phase6-report.md) (tree-sitter 100%
vs line 0% at symbol level, reconciling the Phase-5 file-level tie).

**Directions, roughly in value order.**

1. **More languages — pure data.** A language is a walk module + two registry
   entries (proven across Python/Go/Rust/Java; the core never changes). Natural
   next: C#, C/C++, Ruby, PHP, Kotlin, Swift; config formats (YAML/JSON) for infra.
2. **Hybrid retrieval** — fuse semantic kNN with a lexical signal; the eval
   harness already carries a `grep` baseline to measure any lift.
3. **Optional reranking** — a small cross-encoder over the top-K to sharpen
   ambiguous queries; adopt only behind an eval win (kept out so far by design).
4. **Code- / multilingual embedder** — revisit a code-specialized or multilingual
   model if a non-English or very large repo shows embedder-attributable misses.
5. **Scale & sharing** — benchmark very large monorepos (ANN tuning, per-segment
   stores) and a shared / CI-built index cache so developers don't each rebuild.
6. **Richer chunk metadata** — surface imports, callers and doc links via
   `get_chunk` to give the agent structured context beyond raw text.

## Development

- Tests use **Vitest** with the AAA pattern; unit tests run offline.
- E2E and real-model integration tests are opt-in:

  ```bash
  RAG_RUN_MODEL_TESTS=1 npm test
  ```

- After changing `embedder.model`, run `rag-index --reset` to delete the old
  store and rebuild with the new dimensions (vector dimensions are fixed in
  the store schema at creation time).
- The e2e test (`src/server/server.e2e.test.ts`) spawns the real server binary
  via `StdioClientTransport` to catch stdout leaks and protocol issues that
  unit tests cannot detect.

Tasks live in `tools/rag-mcp/.tasks/`.
