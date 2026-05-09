#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Optional: point to a project-local Node.js binary.
# export PATH="/opt/node/bin:$PATH"

# Optional: if Camoufox native dependencies are installed into runtime-libs/.
# export LD_LIBRARY_PATH="$ROOT/camoufox:$ROOT/runtime-libs/root/usr/lib/x86_64-linux-gnu:$ROOT/runtime-libs/root/lib/x86_64-linux-gnu:${LD_LIBRARY_PATH:-}"
# export XDG_DATA_DIRS="$ROOT/runtime-libs/root/usr/share:/usr/local/share:/usr/share"

exec npm start
