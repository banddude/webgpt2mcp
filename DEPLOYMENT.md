# Production deployment notes

This repository packages `maoulee/webgpt2mcp` with additional production hardening for exact ChatGPT conversation control, OAuth-protected MCP access, and systemd deployment.

## What this version adds

- Exact ChatGPT conversation list/read/search with cloud metadata and status.
- Correct continuation response selection so a continued chat cannot return the prior assistant answer.
- Conversation-ID capture hardening so unrelated sidebar/project network traffic cannot switch the active conversation.
- Exact `send` behavior: idle chats send normally; streaming chats atomically Stop → wait → exact send under the hood.
- OAuth wrapper suitable for ChatGPT custom MCP/plugin connections.
- Streamable HTTP MCP gateway.
- systemd templates with correct dependency/restart chaining.
- Playwright storage-state import helper for moving an already-authenticated ChatGPT session to this browser profile.
- Session health/recovery: explicit persisted storage-state backup, cookie restore, token-age status, once-per-outage AIVA alerting, and a one-command login handoff.

## Security model

Never commit runtime state. `.gitignore` excludes `data/`, browser profiles, API keys, OAuth token stores, local MCP session caches, databases, logs, and backup files.

The OAuth proxy requires an admin approval token stored on the host. ChatGPT/browser session cookies stay in the local `data/` browser profile and are not part of this repository.

## Install on a new Linux host

Requirements: Node.js, npm, pnpm, systemd, and an HTTPS ingress capable of forwarding to localhost.

```bash
git clone https://github.com/banddude/webgpt2mcp.git
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

- `status`: report logged-in/logged-out state plus access-token age/expiry metadata without exposing the token.
- `login`: open the bridge browser directly on ChatGPT login; optionally wait up to 300 seconds for authentication.
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
install -m 0755 scripts/chatgpt-web-cli ~/bin/chatgpt-web
```

Examples:

```bash
# Check or restore the browser session
chatgpt-web status
chatgpt-web login --wait-seconds 300

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


## ChatGPT session recovery

Successful ChatGPT bridge calls persist a private Playwright storage-state backup under the ignored runtime `data/` directory. On later checks, the bridge first asks ChatGPT for a fresh `/api/auth/session` token; if the current browser context is missing it, the bridge restores only ChatGPT/OpenAI cookies from that private backup and retries. The access token itself is never written to logs, MCP responses, or repository files.

If ChatGPT has genuinely logged the browser out, the bridge records the outage and calls `notify aiva` once for that outage. Repeated tool calls return a clear `CHATGPT_LOGIN_REQUIRED` error without spamming AIVA. A successful authentication clears the latch so a future distinct logout can alert once again.

Use `chatgpt-web login --wait-seconds 300` to navigate the existing bridge browser directly to the login page and wait for sign-in. After Mike signs in once, `chatgpt-web status` should report `logged-in`, and the refreshed storage state is persisted for later browser restarts.
