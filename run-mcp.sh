#!/bin/sh
set -eu
ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$ROOT_DIR"
CHATGPT_API_URL=${CHATGPT_API_URL:-http://127.0.0.1:17841}
CHATGPT_API_KEY=${CHATGPT_API_KEY:-$(cat data/api.key)}
export CHATGPT_API_URL CHATGPT_API_KEY
exec node mcp-server/index.mjs
