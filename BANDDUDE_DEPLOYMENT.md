# Banddude deployment notes

This repository is a portable, private packaging of `maoulee/webgpt2mcp` with the fixes used in production on Oracle.

## What this version adds

- Exact ChatGPT conversation list/read/search with cloud metadata and status.
- Correct continuation response selection so a continued chat cannot return the prior assistant answer.
- Conversation-ID capture hardening so unrelated sidebar/project network traffic cannot switch the active conversation.
- Exact `send` behavior: idle chats send normally; streaming chats atomically Stop → wait → exact send under the hood.
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

- `conversations_list`: list recent chats with exact IDs/URLs and status.
- `conversation_read`: read one exact chat and include its current status.
- `conversations_search`: search recent titles and return exact IDs/URLs; discovery only.
- `send`: send to one exact existing chat. If it is streaming, Stop → wait → send automatically.
- `create`: explicitly create a new chat. No other tool may create one.
- `stop`: stop one exact active chat without sending a replacement.
- `delete`: delete one exact chat and require `confirm=true`.

Targeting rule: discovery may use text, but read/send/stop/delete require an exact conversation UUID or exact ChatGPT conversation URL. There is no topic routing, fuzzy target selection, separate steer tool, browse tool, or `dispatch_only` mode in the public MCP.

## Upstream

Original project: `maoulee/webgpt2mcp`.

The original MIT license and copyright notice are preserved in `LICENSE`.

## AIVA / mcporter CLI

Generate the mcporter binary and install the thin wrapper:

```bash
mcporter generate-cli --server chatgpt-web --compile ~/bin/chatgpt-web-mcporter
install -m 0755 scripts/chatgpt-web-aiva ~/bin/chatgpt-web
```

Examples:

```bash
# Discover chats
chatgpt-web conversations-list --limit 10
chatgpt-web conversations-search --query 'CI Dispatcher'

# Read an exact chat
chatgpt-web conversation-read \
  --conversation 'https://chatgpt.com/c/<conversation-id>'

# Send to an exact existing chat. Active responses are stopped automatically.
chatgpt-web send \
  --conversation 'https://chatgpt.com/c/<conversation-id>' \
  --message 'Continue the task.'

# Explicitly create a new chat
chatgpt-web create --message 'Start a new task.' --model gpt-instant
```

The wrapper does not add routing behavior. It simply executes the generated CLI. The MCP itself enforces exact identifiers for specific-chat operations and fails closed on ambiguous targets.
