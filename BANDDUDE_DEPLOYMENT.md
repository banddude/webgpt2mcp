# Banddude deployment notes

This repository is a portable, private packaging of `maoulee/webgpt2mcp` with the fixes used in production on Oracle.

## What this version adds

- ChatGPT cloud conversation history through `chatgpt_sessions history`.
- Correct continuation response selection so a continued chat cannot return the prior assistant answer.
- Conversation-ID capture hardening so unrelated sidebar/project network traffic cannot switch the active conversation.
- Atomic live steering through `chatgpt_steer`: target the exact conversation, acquire the browser control lock, wait for any one already-running Oracle browser request to finish, click **Stop answering**, confirm the idle composer, then reuse the normal exact-send path and verify the replacement response started. Queued work cannot steal the browser mid-steer.
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

- `chatgpt`: start, continue, and model-select conversations; exact URL continuations also use the guarded control path when the target is live.
- `chatgpt_steer`: one-command Stop -> wait -> exact send for a currently streaming conversation.
- `chatgpt_sessions`: list, sync, history, clear local cache, delete optionally from cloud.
- `chatgpt_browse`: ask the logged-in ChatGPT web session to read a URL.

## Upstream

Original project: `maoulee/webgpt2mcp`.

The original MIT license and copyright notice are preserved in `LICENSE`.

## AIVA / mcporter exact-chat dispatch

The `chatgpt` MCP tool supports `dispatch_only=true` when `conversation_url` is supplied. This submits the prompt into that exact existing ChatGPT conversation, verifies ChatGPT accepted the turn, and returns immediately instead of waiting for the assistant's final response. An explicit conversation URL is a hard target: the dispatch path will error rather than silently create a different chat.

For an AIVA-style CLI, generate the mcporter binary and put the included wrapper in front of it:

```bash
mcporter generate-cli --server chatgpt-web --compile ~/bin/chatgpt-web-mcporter
install -m 0755 scripts/chatgpt-web-aiva ~/bin/chatgpt-web
```

Then existing exact-chat commands are fast-dispatch by default:

```bash
chatgpt-web chatgpt --prompt 'Continue the task.' \
  --conversation-url 'https://chatgpt.com/c/<conversation-id>'
```

To deliberately wait for the final assistant response instead:

```bash
chatgpt-web chatgpt --prompt 'Answer this now.' \
  --conversation-url 'https://chatgpt.com/c/<conversation-id>' \
  --dispatch-only false
```

### Live steering from AIVA

Use one command. AIVA does not issue separate Stop and Send operations:

```bash
chatgpt-web chatgpt-steer \
  --conversation-url 'https://chatgpt.com/c/<conversation-id>' \
  --prompt 'Change course and do this instead.'
```

Under the hood the command takes exclusive control of the single ChatGPT browser, waits for any request that was already using it, clicks **Stop answering**, confirms the normal message composer has returned, types the prompt through the same exact-send machinery used for idle chats, clicks Send, and verifies a replacement response started. New normal requests remain queued until the steer releases the browser lock.

A failed checkpoint returns an error and does **not** silently fall back to appending a message or creating a new conversation. The AIVA wrapper gives steer and exact-chat dispatch a 150-second client timeout because browser attach/navigation can legitimately exceed mcporter's shorter default.
