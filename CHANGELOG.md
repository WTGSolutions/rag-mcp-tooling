# Changelog

All notable changes to `@wtgsolutions/rag-mcp` are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/), and the
project adheres to [Semantic Versioning](https://semver.org/).

## [1.0.0] - 2026-06-19

Initial public release. A project-agnostic semantic code index (RAG) plus an MCP
server that lets an AI agent search a codebase by meaning instead of only by text.
Everything runs locally and offline.

### Added

- **MCP server** (stdio) exposing four tools: `search_codebase`, `get_chunk`,
  `index_status`, `reindex`.
- **Indexing CLI** (`rag-index`): full and incremental (`--changed`) runs, content
  hashing to skip unchanged files, and `--reset` for a clean rebuild.
- **Language-aware chunking** via tree-sitter AST for TypeScript/JavaScript,
  Python, Go, Rust, Java, C/C++, Kotlin and Swift; heading-based chunking for
  Markdown and key-based chunking for YAML. Unknown types fall back to line
  windows so nothing is unsearchable.
- **Oversized-symbol windowing**: symbols larger than the token budget are split
  into disjoint sub-windows so their tail stays searchable (no silent truncation).
- **Structural metadata**: `get_chunk` surfaces a chunk's `imports`, `callers`
  (who calls the symbol) and `docLinks` (docs mentioning it). Stored in sidecar
  columns — no impact on embeddings.
- **Local offline embedder** (`bge-small-en` by default) — code never leaves the
  machine. Model download is opt-in via `RAG_ALLOW_DOWNLOAD=1`; a cold cache
  fails with an actionable error rather than fetching silently.
- **Vector store** on SQLite + `sqlite-vec`: a single portable file, segment-aware
  (`web`/`mobile`/`wiki`/…), measured to scale linearly to 150k+ chunks.
- **`rag-init`** self-config CLI: detects the repo layout and writes
  `rag.config.json`, merges `.mcp.json`, updates `.gitignore`, installs hooks.
- **Git hooks** for background auto-reindex on commit/checkout/merge.
- **Usage logging** (`.rag/usage.jsonl`, opt-out via `RAG_USAGE_LOG=0`) with a
  `rag-usage` adoption report; the log rotates at ~5 MB.
- **Evaluation harness** with file-, symbol- and span-level retrieval metrics and
  a `grep` baseline.

### Notes

- Requires Node.js >= 20.
- Tree-sitter grammars ship as bundled `.wasm` assets (offline, no `node-gyp`).
- See `README.md` for setup and `THEORY.md` for design rationale.
