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

**Phase 1 (indexing pipeline) is complete and tested.** The `rag-index` CLI
builds a searchable vector store from any repo.

| Component | Status |
|---|---|
| Config loader (`rag.config.json`) | ✅ |
| File walker (`.gitignore`, segments, binaries) | ✅ |
| Chunkers: line (fallback), TS/JS (AST via ts-morph), Markdown (headings) | ✅ |
| Local embedder (transformers.js, offline) | ✅ |
| Vector store (SQLite + sqlite-vec, kNN) | ✅ |
| Incremental reindex (file-hash change detection) | ✅ |
| `rag-index` CLI | ✅ |
| MCP server (`search_codebase`, …) | ⏳ Phase 2 (TASK-010–014) |

Acceptance: a full index of GuideTrackee (`web` + `mobile` + `wiki`) processes
**1,249 files → 5,713 chunks** with no errors. Querying is Phase 2 (MCP server);
the index it produces is already on disk and ready for it.

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

> Inputs longer than the model's 512-token limit are silently truncated. Very
> large chunks (e.g. a big class) embed only their first 512 tokens; method-level
> chunks mitigate this for code.

## Usage — indexing

After `npm run build`, run the indexer against a config:

```bash
node dist/cli/rag-index.js --config rag.config.json            # incremental (default)
node dist/cli/rag-index.js --config rag.config.json --full     # rebuild everything
node dist/cli/rag-index.js --config rag.config.json --segment mobile  # one segment
```

| Flag | Meaning |
|---|---|
| `-c, --config <path>` | Config file (default `rag.config.json`). Relative `segment.root` and `store.path` resolve against the config file's directory, not the shell's cwd. |
| `--changed` | Only re-index files whose content hash changed (default). |
| `--full` | Re-index everything, ignoring stored hashes (e.g. after a model change). |
| `-s, --segment <name>` | Process only the named segment. |
| `-h, --help` | Usage. |

Progress and the summary (`added / skipped / removed / total-chunks / time`) go to
**stderr**; exit code is `0` on success, `1` on error — suitable for CI or a
git hook. Incremental runs after a small edit re-embed only the changed files.

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
> `embedder.model` in the config, delete `.rag/index.db` and run
> `rag-index --full` before restarting the server.

---

### Typical session flow

```
1. rag-index --config rag.config.json --full   # first-time index (one-off)
2. Start Claude Code with .mcp.json pointing at this server
3. Agent calls search_codebase("your question") → gets ids
4. Agent calls get_chunk(id) for the most promising hits
5. Agent calls reindex() after you edit files → index stays current
```

## Development

- Tests use **Vitest** with the AAA pattern; unit tests run offline.
- E2E and real-model integration tests are opt-in:

  ```bash
  RAG_RUN_MODEL_TESTS=1 npm test
  ```

- Reindexing after a model change requires rebuilding the index (vector
  dimensions are fixed in the store schema — see the warning above).
- The e2e test (`src/server/server.e2e.test.ts`) spawns the real server binary
  via `StdioClientTransport` to catch stdout leaks and protocol issues that
  unit tests cannot detect.

Tasks live in `tools/rag-mcp/.tasks/`.
