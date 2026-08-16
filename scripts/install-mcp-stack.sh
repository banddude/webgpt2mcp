#!/bin/sh
set -eu
ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
RUN_USER=${SUDO_USER:-${USER:-ubuntu}}
RUN_GROUP=$(id -gn "$RUN_USER")
ENV_FILE=${WEBGPT2MCP_ENV_FILE:-/etc/webgpt2mcp.env}

command -v node >/dev/null || { echo 'Node.js is required'; exit 1; }
command -v npm >/dev/null || { echo 'npm is required'; exit 1; }
command -v pnpm >/dev/null || { echo 'pnpm is required'; exit 1; }
command -v sudo >/dev/null || { echo 'sudo is required to install systemd units'; exit 1; }

cd "$ROOT_DIR"
pnpm install
npm run init
npm --prefix mcp-server ci
npm --prefix gateway ci
mkdir -p data
chmod 700 data
if [ ! -f data/oauth-admin-token ]; then
  umask 077
  node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64url'))" > data/oauth-admin-token
fi

if [ ! -f "$ENV_FILE" ]; then
  echo "Creating $ENV_FILE from deploy/webgpt2mcp.env.example"
  sudo cp deploy/webgpt2mcp.env.example "$ENV_FILE"
  echo "EDIT $ENV_FILE and set PUBLIC_BASE before starting chatgpt-mcp-oauth.service."
fi

TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT
for unit in webgpt2mcp.service webgpt2mcp-gateway.service chatgpt-mcp-oauth.service; do
  sed \
    -e "s|__RUN_USER__|$RUN_USER|g" \
    -e "s|__RUN_GROUP__|$RUN_GROUP|g" \
    -e "s|__INSTALL_DIR__|$ROOT_DIR|g" \
    -e "s|__ENV_FILE__|$ENV_FILE|g" \
    "deploy/systemd/$unit" > "$TMPDIR/$unit"
  sudo cp "$TMPDIR/$unit" "/etc/systemd/system/$unit"
done
sudo systemctl daemon-reload
sudo systemctl enable webgpt2mcp.service webgpt2mcp-gateway.service chatgpt-mcp-oauth.service

echo
echo 'Installed. Next:'
echo '  1. Authenticate ChatGPT: npm start -- -login'
echo '     or import Playwright state: node import-storage-state.mjs /path/to/storage-state.json'
echo "  2. Edit $ENV_FILE and set PUBLIC_BASE."
echo '  3. sudo systemctl restart webgpt2mcp.service'
echo '  4. Check: curl http://127.0.0.1:17842/healthz'
echo '  5. Expose 127.0.0.1:17843 through your existing HTTPS ingress.'
