#!/bin/sh
# Shared RAG auto-reindex runner, invoked in the background by the post-commit
# hook that `rag-index install-hooks` writes into each repo's .git/hooks/.
#
# Non-fatal by contract: it always exits 0, never blocks the commit, and sends
# every diagnostic to the log. The post-commit hook is a thin stub that only
# detaches this script — so changing the logic here needs no hook reinstall.
#
# Usage: reindex-bg.sh <path-to-rag.config.json> [trigger]
#   trigger — label shown in the log (default: post-commit).  Passed by the
#             hook stub so log entries distinguish checkout/merge/commit runs.

config="$1"
trigger="${2:-post-commit}"
[ -n "$config" ] || exit 0
[ -f "$config" ] || exit 0

# .rag/ lives next to the config — the same anchor the CLI and server resolve
# the store against. Log and lock go there too (already gitignored: .rag/, *.log).
config_dir=$(CDPATH= cd -- "$(dirname -- "$config")" 2>/dev/null && pwd) || exit 0
rag_dir="$config_dir/.rag"
mkdir -p "$rag_dir" 2>/dev/null || exit 0
log="$rag_dir/reindex.log"
lock="$rag_dir/reindex.lock"

# Single-writer lock — mkdir is atomic. If another reindex already holds it, skip
# silently; the next commit reconciles via content hashing. The EXIT trap frees
# it on a normal exit, but cannot fire on SIGKILL / power loss — so a crashed run
# can leave the lock behind. A real reindex finishes in seconds, so reclaim a lock
# older than an hour as stale; otherwise a live reindex holds it, so skip.
if ! mkdir "$lock" 2>/dev/null; then
  if [ -n "$(find "$lock" -prune -mmin +60 2>/dev/null)" ]; then
    rmdir "$lock" 2>/dev/null
    mkdir "$lock" 2>/dev/null || exit 0
  else
    exit 0
  fi
fi
trap 'rmdir "$lock" 2>/dev/null' EXIT INT TERM

# Locate the compiled CLI relative to this script: <tool>/scripts → <tool>/dist.
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" 2>/dev/null && pwd) || exit 0
cli="$script_dir/../dist/cli/rag-index.js"

{
  printf '== %s  %s auto-reindex\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$trigger"
  if ! command -v node >/dev/null 2>&1; then
    echo "skipped: 'node' not found on PATH"
  elif [ ! -f "$cli" ]; then
    echo "skipped: CLI not built at $cli (run: npm run rag:build)"
  else
    node "$cli" --changed --config "$config" || echo "reindex failed (exit $?)"
  fi
} >>"$log" 2>&1

exit 0
