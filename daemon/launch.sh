#!/usr/bin/env bash
# The mod runs this: finds a Node >= 20 even when the session's PATH lacks nvm, then runs launch.js.
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
  echo '{"ok":false,"error":"no node binary found; set ASK_USER_RICH_NODE"}'
  exit 1
fi
exec "$NODE" "$DIR/launch.js"
