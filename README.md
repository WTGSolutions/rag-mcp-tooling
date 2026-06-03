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

## MCP server (Phase 2, forthcoming)

Once built (TASK-010–014), the server is wired into Claude Code via `.mcp.json`:

```jsonc
{
  "mcpServers": {
    "rag": {
      "command": "node",
      "args": ["tools/rag-mcp/dist/server/server.js", "--config", "rag.config.json"]
    }
  }
}
```

It will expose `search_codebase(query, k?, segment?)`, `get_chunk(id)`,
`index_status()` and `reindex(paths?)` — reading the same vector store the CLI
writes.

## Development

- Tests use **Vitest** with the AAA pattern; unit tests run offline.
- Real-model integration tests are opt-in (they download/run the model):

  ```bash
  RAG_RUN_MODEL_TESTS=1 npm test
  ```

- Reindexing after a model change requires rebuilding the index (vector
  dimensions are fixed in the store schema).

Tasks live in `tools/rag-mcp/.tasks/`.
