#!/usr/bin/env bash
# Smoke-tests the published tarball on a clean install.
#
# What it does:
#   1. npm pack  (fires prepack → build:publish → lean dist/)
#   2. Install the .tgz into an isolated tmp project
#   3. Verify binaries are present and native deps installed from prebuilds
#   4. rag-init --dry --no-index  → assert no files written
#   5. rag-init --no-index        → assert config + .mcp.json + .gitignore created
#   6. Re-run to assert idempotency
#   7. (opt) RAG_SMOKE_FULL=1: rag-index + rag-mcp server + index_status MCP call
#   8. Restore the full dev build (dist/eval, tests) on exit
#
# Usage:
#   npm run smoke:pack
#   RAG_SMOKE_FULL=1 npm run smoke:pack    # includes model-download + server test
set -euo pipefail

PKG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# ── Restore full dev build on exit ────────────────────────────────────────────
restore_dev_build() {
  echo "=== smoke-pack: restoring dev build ==="
  cd "$PKG_DIR"
  npm run build > /dev/null 2>&1 && echo "=== smoke-pack: dev build restored ===" || echo "WARN: dev build restore failed"
}
trap restore_dev_build EXIT

# ── 1. Pack (triggers prepack → lean build) ───────────────────────────────────
echo "=== smoke-pack: packing ==="
cd "$PKG_DIR"
TGZ_NAME="$(npm pack 2>/dev/null | tail -1)"
TGZ_ABS="$PKG_DIR/$TGZ_NAME"
echo "=== smoke-pack: tarball → $TGZ_ABS ==="

# ── 2. Isolated tmp project ───────────────────────────────────────────────────
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"; restore_dev_build' EXIT

echo "=== smoke-pack: installing in $TMP_DIR ==="
cd "$TMP_DIR"
npm init --yes --quiet > /dev/null 2>&1
npm install --no-save "$TGZ_ABS" 2>&1 | grep -E '(added|error|warn)' || true

# ── 3. Binaries present ───────────────────────────────────────────────────────
RAG_INIT="./node_modules/.bin/rag-init"
RAG_MCP="./node_modules/.bin/rag-mcp"
RAG_INDEX="./node_modules/.bin/rag-index"

[ -f "$RAG_INIT"  ] || { echo "ERROR: rag-init binary missing" >&2; exit 1; }
[ -f "$RAG_MCP"   ] || { echo "ERROR: rag-mcp binary missing" >&2; exit 1; }
[ -f "$RAG_INDEX" ] || { echo "ERROR: rag-index binary missing" >&2; exit 1; }

# Bins must be executable AND runnable directly (not just via `node`). tsc emits
# 0644, which drops the shebang's +x bit → "Permission denied" on install methods
# where npm doesn't force +x. Invoke through .bin/ with no `node` prefix to catch it.
"$RAG_INDEX" --help >/dev/null 2>&1 || { echo "ERROR: rag-index not directly executable (exec bit / shebang)" >&2; exit 1; }
echo "  bins are directly executable (exec bit OK)"

# better-sqlite3 must have loaded its native prebuild (no build toolchain needed)
node -e "
  const db = require('./node_modules/better-sqlite3')(':memory:');
  db.close();
  console.log('  better-sqlite3: prebuild OK');
"

echo "=== smoke-pack: binaries + native deps OK ==="

# ── 4. --dry writes nothing ───────────────────────────────────────────────────
echo "=== smoke-pack: rag-init --dry --no-index ==="
node "$RAG_INIT" --dry --no-index

[ ! -f rag.config.json ] || { echo "ERROR: --dry wrote rag.config.json" >&2; exit 1; }
[ ! -f .mcp.json       ] || { echo "ERROR: --dry wrote .mcp.json" >&2; exit 1; }
[ ! -f .gitignore      ] || { echo "ERROR: --dry wrote .gitignore" >&2; exit 1; }
echo "=== smoke-pack: dry mode OK (no files written) ==="

# ── 5. Real run creates expected files ───────────────────────────────────────
echo "=== smoke-pack: rag-init --no-index ==="
node "$RAG_INIT" --no-index

[ -f rag.config.json ] || { echo "ERROR: rag.config.json missing" >&2; exit 1; }
[ -f .mcp.json       ] || { echo "ERROR: .mcp.json missing" >&2; exit 1; }
[ -f .gitignore      ] || { echo "ERROR: .gitignore missing" >&2; exit 1; }

node -e "
  const m = JSON.parse(require('fs').readFileSync('.mcp.json', 'utf8'));
  if (!m.mcpServers?.rag?.command) {
    console.error('ERROR: .mcp.json missing mcpServers.rag.command');
    process.exit(1);
  }
  console.log('  .mcp.json OK — command:', m.mcpServers.rag.command);
"

grep -q '\.rag/'   .gitignore || { echo "ERROR: .gitignore missing .rag/" >&2;   exit 1; }
grep -q '\.cache/' .gitignore || { echo "ERROR: .gitignore missing .cache/" >&2; exit 1; }

echo "=== smoke-pack: rag.config.json + .mcp.json + .gitignore OK ==="

# ── 6. Idempotency ───────────────────────────────────────────────────────────
echo "=== smoke-pack: re-run (idempotency) ==="
CONFIG_BEFORE="$(cat rag.config.json)"
MCP_BEFORE="$(cat .mcp.json)"
node "$RAG_INIT" --no-index > /dev/null
CONFIG_AFTER="$(cat rag.config.json)"
MCP_AFTER="$(cat .mcp.json)"
[ "$CONFIG_BEFORE" = "$CONFIG_AFTER" ] || { echo "ERROR: re-run changed rag.config.json" >&2; exit 1; }
[ "$MCP_BEFORE"    = "$MCP_AFTER"    ] || { echo "ERROR: re-run changed .mcp.json" >&2;    exit 1; }
echo "=== smoke-pack: idempotency OK ==="

# ── 7. Full flow (optional, requires RAG_ALLOW_DOWNLOAD=1 or cached model) ───
if [ "${RAG_SMOKE_FULL:-0}" = "1" ]; then
  echo "=== smoke-pack: FULL — rag-index + rag-mcp server + index_status ==="

  # Write a tiny fixture for indexing
  mkdir -p src
  cat > src/auth.ts <<'EOF'
export function authenticate(user: { token: string }): string {
  return user.token;
}
EOF

  echo "=== smoke-pack: indexing (RAG_ALLOW_DOWNLOAD=1) ==="
  RAG_ALLOW_DOWNLOAD=1 node "$RAG_INDEX" --config rag.config.json --full

  echo "=== smoke-pack: index_status via MCP client ==="
  node - <<'EOF'
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAG_MCP = join(process.cwd(), 'node_modules', '.bin', 'rag-mcp');
const transport = new StdioClientTransport({
  command: 'node',
  args: [RAG_MCP, '--config', 'rag.config.json'],
  stderr: 'pipe',
});
const client = new Client({ name: 'smoke-test', version: '1.0.0' });
await client.connect(transport);

const result = await client.callTool({ name: 'index_status', arguments: {} });
if (result.isError) {
  const text = (result.content)[0]?.text ?? '';
  console.error('ERROR: index_status returned isError:', text);
  process.exit(1);
}
const s = result.structuredContent;
console.log('  index_status OK:', JSON.stringify(s));
if (!s || typeof s.chunks !== 'number' || s.chunks === 0) {
  console.error('ERROR: index_status returned 0 chunks');
  process.exit(1);
}
await client.close();
console.log('=== smoke-pack: FULL — server test OK ===');
EOF

fi

echo "=== smoke-pack: ALL CHECKS PASSED ==="
