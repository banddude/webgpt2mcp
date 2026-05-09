# ChatGPT Web Gateway Configuration

This guide documents the ChatGPT-focused setup used by this fork. The base
project remains WebAI2API; this workflow narrows the deployment to ChatGPT text
generation and exposes it through the OpenAI-compatible endpoint:

```text
POST /v1/chat/completions
```

## 1. Install

Use Node.js 20 or newer. In the local environment used during development,
Node.js 24 worked.

```bash
pnpm install
npm run init
```

If GitHub or npm access requires a proxy:

```bash
npm run init -- -proxy=http://127.0.0.1:7890
```

Do not commit downloaded runtime output. `camoufox/`, `runtime-libs/`,
`node_modules/`, and `data/` are generated or private.

## 2. Create Config

On first start, WebAI2API copies `config.example.yaml` to `data/config.yaml`.
For a minimal ChatGPT-only service, use `config.chatgpt.example.yaml` as the
starting point:

```bash
cp config.chatgpt.example.yaml data/config.yaml
```

Then edit:

- `server.auth`: your local API bearer token. Use a private value.
- `server.port`: API/WebUI port, usually `3000`.
- `backend.pool.instances[].workers[].type`: keep `chatgpt_text`.
- `browser.proxy`: enable and fill in only if ChatGPT access requires a proxy.
- `browser.headless`: use `false` for initial login and debugging; use `true`
  only after the browser profile is stable.

## 3. Login

Recommended login path:

```bash
npm start -- -login
```

Open the WebUI or the virtual display, finish ChatGPT login, and make sure the
ChatGPT page can send one normal message.

For servers without direct browser access, map the WebUI port through SSH:

```bash
ssh -L 3000:127.0.0.1:3000 user@server
```

Then open:

```text
http://127.0.0.1:3000
```

Session-token injection scripts are intentionally not included as the default
public workflow because they handle highly sensitive cookies. If you create one
locally, keep it outside git or use a `.example.sh` file with placeholders only.

## 4. Start

```bash
npm start
```

If your server needs extra native libraries for Camoufox, configure
`LD_LIBRARY_PATH` in a local script. Do not commit machine-specific absolute
paths.

Example local-only script shape:

```bash
#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
export LD_LIBRARY_PATH="$ROOT/camoufox:$ROOT/runtime-libs/root/usr/lib/x86_64-linux-gnu:$ROOT/runtime-libs/root/lib/x86_64-linux-gnu:${LD_LIBRARY_PATH:-}"
exec npm start
```

## 5. Call API

Non-streaming:

```bash
curl http://127.0.0.1:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-your-webai2api-key" \
  -d '{
    "model": "gpt-instant",
    "messages": [
      {"role": "user", "content": "用一句话说明你是否可用"}
    ],
    "stream": false
  }'
```

Streaming:

```bash
curl -N http://127.0.0.1:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-your-webai2api-key" \
  -d '{
    "model": "gpt-instant",
    "messages": [
      {"role": "user", "content": "写一个三点清单"}
    ],
    "stream": true
  }'
```

## 6. Conversation Reuse

The fork supports reusing an existing ChatGPT conversation by passing
`conversation_url`:

```json
{
  "model": "gpt-instant",
  "conversation_url": "https://chatgpt.com/c/your-conversation-id",
  "messages": [
    {
      "role": "user",
      "content": "继续上一轮上下文。"
    }
  ],
  "stream": true
}
```

The API response may include `conversation_url`. Store it in your client if you
want follow-up requests to continue the same browser conversation.

## 7. Thinking Model

Use:

```json
"model": "gpt-thinking"
```

This selects the ChatGPT UI's Thinking model. The adapter includes debug dump
support for diagnosing response parsing issues:

```yaml
backend:
  adapter:
    chatgpt_text:
      debugDump: false
```

Set `debugDump: true` only locally. It can write prompts, page text, DOM
snapshots, and screenshots under `data/debug-chatgpt/`; never publish those
files.

## 8. GitHub Connector Workflow

To make ChatGPT review GitHub code through the ChatGPT web connector, use the
skill in `skills/gpt-code.md`.

The key rule is that the prompt must explicitly ask ChatGPT to use the GitHub
connector to read PR diffs, changed files, commits, or file contents. Sending a
URL alone is not enough.
