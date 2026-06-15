# Vendored tree-sitter grammars

This directory holds tree-sitter grammar `.wasm` files that are **shipped with the
package** because no npm package provides an ABI-compatible build. Every other
grammar (TS/JS, Python, Go, Rust, Java, C/C++, Kotlin) comes from an
`optionalDependency` and is copied to the user cache at runtime — see
[`src/lang/ensure-grammars.ts`](../src/lang/ensure-grammars.ts). Files here are the
exception, resolved directly from the installed package (a `{ vendored }` spec).

## tree-sitter-swift.wasm

| | |
|---|---|
| Source | https://github.com/alex-pinkus/tree-sitter-swift (the grammar's author) |
| Release | **0.7.3** (release asset, not the npm package — npm `tree-sitter-swift` ships no wasm) |
| tree-sitter ABI | **15** (loads under `web-tree-sitter` ≥ 0.25; verified against 0.26.9) |
| License | MIT (alex-pinkus/tree-sitter-swift) |

### Why vendored (TASK-042)

No npm package ships an ABI-14/15 Swift grammar wasm: `tree-sitter-swift@0.7.x`
is native-only, and the prebuilt collections (`tree-sitter-wasms`,
`@sourcegraph/tree-sitter-wasms`) ship an **old-ABI** swift wasm that fails to load
under our runtime (`getDylinkMetadata`/dylink error). The only ABI-15 build is the
grammar author's GitHub **release asset**, which is not on npm — so we vendor it.
This keeps Swift support **offline by default** (no install-time download), matching
the model used for embedding models and the other grammars.

### Updating

```bash
gh release download <tag> --repo alex-pinkus/tree-sitter-swift \
  --pattern 'tree-sitter-swift.wasm' --dir grammars --clobber
```

Then confirm it still loads under the pinned `web-tree-sitter` (ABI must be ≥ 14):
`Language.load('grammars/tree-sitter-swift.wasm')` → check `lang.abiVersion`.
