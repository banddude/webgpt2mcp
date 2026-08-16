# Banddude deployment notes

This repository is a portable, private packaging of `maoulee/webgpt2mcp` with the fixes used in production on Oracle.

## What this version adds

- ChatGPT cloud conversation history through `chatgpt_sessions history`.
- Correct continuation response selection so a continued chat cannot return the prior assistant answer.
- Conversation-ID capture hardening so unrelated sidebar/project network traffic cannot switch the active conversation.
- Mid-stream steering. A message sent to a currently streaming conversation bypasses the normal generation queue and uses ChatGPT's live steering behavior. It falls back to Stop + immediate resubmit when native steering is unavailable.
- OAuth wrapper suitable for ChatGPT custom MCP/plugin connections.
- Streamable HTTP MCP gateway.
- systemd templates with correct dependency/restart chaining.
- Playwright storage-state import helper for moving an already-authenticated ChatGPT session to this browser profile.

## Security model

Never commit runtime state. `.gitignore` excludes `data/`, browser profiles, API keys, OAuth token stores, local MCP session caches, databases, logs, and backup files.

The OAuth proxy requires an admin approval token stored on the host. ChatGPT/browser session cookies stay in the local `data/` browser profile and are not part of this repository.

## Install on a new Linux host

Requirements: Node.js, npm, pnpm, systemd, and an HTTPS ingress capable of forwarding to localhost.

```bash
git clone git@github.com:banddude/webgpt2mcp.git
cd webgpt2mcp
./scripts/install-mcp-stack.sh
```

Then:

1. Edit `/etc/webgpt2mcp.env` and set `PUBLIC_BASE` to the HTTPS hostname that will expose the OAuth wrapper.
2. Authenticate ChatGPT once:
   ```bash
   npm start -- -login
   ```
   Or import a Playwright storage-state file you already own:
   ```bash
   node import-storage-state.mjs /path/to/storage-state.json
   ```
3. Restart the stack:
   ```bash
   sudo systemctl restart webgpt2mcp.service
   ```
   The gateway and OAuth wrapper are `PartOf=` the backend and restart with it.
4. Point the existing HTTPS ingress at `127.0.0.1:17843`.
5. Add `<PUBLIC_BASE>/mcp` as the custom MCP server in ChatGPT/Claude. The OAuth wrapper supports dynamic client registration + PKCE.

## Local ports

- `17841`: ChatGPT web backend / OpenAI-compatible endpoint.
- `17842`: local Streamable HTTP MCP gateway.
- `17843`: OAuth-protected MCP front door. Expose this through HTTPS ingress.

## MCP tools

- `chatgpt`: start, continue, model-select, and steer conversations.
- `chatgpt_sessions`: list, sync, history, clear local cache, delete optionally from cloud.
- `chatgpt_browse`: ask the logged-in ChatGPT web session to read a URL.

## Upstream

Original project: `maoulee/webgpt2mcp`.

The original MIT license and copyright notice are preserved in `LICENSE`.
