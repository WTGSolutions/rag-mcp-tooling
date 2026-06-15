# Vendored tree-sitter grammars

Every tree-sitter grammar this tool uses is shipped here as a prebuilt `.wasm`
and committed to the repo. This directory is published in the package
(`package.json` "files"); at runtime the chunker resolves grammars from here only
— no `optionalDependencies`, no install-time native build, no per-user cache. See
[`src/lang/ensure-grammars.ts`](../src/lang/ensure-grammars.ts).

## Why vendored (one model)

The grammar npm packages ship ~150 MB of source + generated C + per-platform
native node bindings that we never use — the chunker only loads the `.wasm` via
`web-tree-sitter`. Vendoring just the wasm (~16 MB total) is ~10× lighter for
users, fully offline/deterministic, and a single code path. It also removes the
divergence where one language (Swift) was a special case: now all grammars are
resolved identically.

## How these files are produced

Most come from dev-only npm packages, copied by
[`scripts/sync-grammars.mjs`](../scripts/sync-grammars.mjs). Swift has no
ABI-compatible npm package, so its wasm is the grammar author's GitHub **release
asset**, committed directly.

| wasm | Source | License |
|---|---|---|
| `tree-sitter-python.wasm` | npm `tree-sitter-python` | MIT |
| `tree-sitter-typescript.wasm`, `tree-sitter-tsx.wasm` | npm `tree-sitter-typescript` | MIT |
| `tree-sitter-go.wasm` | npm `tree-sitter-go` | MIT |
| `tree-sitter-rust.wasm` | npm `tree-sitter-rust` | MIT |
| `tree-sitter-java.wasm` | npm `tree-sitter-java` | MIT |
| `tree-sitter-cpp.wasm` | npm `tree-sitter-cpp` (also parses C) | MIT |
| `tree-sitter-kotlin.wasm` | npm `@tree-sitter-grammars/tree-sitter-kotlin` | MIT |
| `tree-sitter-swift.wasm` | GitHub release `alex-pinkus/tree-sitter-swift` 0.7.3 (not on npm) | MIT |

All grammars target tree-sitter ABI ≥ 14 (loads under `web-tree-sitter` 0.26.x).

## Updating

```bash
npm update tree-sitter-python tree-sitter-typescript tree-sitter-go \
  tree-sitter-rust tree-sitter-java tree-sitter-cpp \
  @tree-sitter-grammars/tree-sitter-kotlin   # bump the dev grammar packages
npm run sync-grammars      # copy their wasm into grammars/
npm run check-grammars     # assert every wasm still loads (ABI gate)
git add grammars && git commit
```

For Swift (not on npm):

```bash
gh release download <tag> --repo alex-pinkus/tree-sitter-swift \
  --pattern 'tree-sitter-swift.wasm' --dir grammars --clobber
npm run check-grammars
```
