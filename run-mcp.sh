#!/bin/sh
set -eu
cd /home/ubuntu/services/webgpt2mcp
CHATGPT_API_URL=http://127.0.0.1:17841
CHATGPT_API_KEY=$(cat data/api.key)
export CHATGPT_API_URL CHATGPT_API_KEY
exec node mcp-server/index.mjs
