#!/usr/bin/env bash
# Entry point Claude Code launches (stdio). Finds a Node >= 20 even when the caller's PATH lacks nvm.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE="${ASK_USER_RICH_NODE:-}"
if [[ -z "$NODE" ]]; then
  if command -v node >/dev/null 2>&1; then
    NODE="$(command -v node)"
  else
    NODE="$(ls -d "$HOME"/.nvm/versions/node/v*/bin/node 2>/dev/null | sort -V | tail -1)"
  fi
fi
if [[ -z "$NODE" || ! -x "$NODE" ]]; then
  echo "[ask-user-rich] no node binary found; set ASK_USER_RICH_NODE" >&2
  exit 1
fi
exec "$NODE" "$DIR/src/server.js" "$@"
