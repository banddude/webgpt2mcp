# webgpt2mcp

Turn ChatGPT web capabilities into MCP tools, enabling CLI coding agents like Claude Code and Cursor to call ChatGPT directly for code review, document generation, academic writing, and more — zero extra API costs by reusing your existing ChatGPT web subscription.

## How It Works

```text
CLI Agent (Claude Code / Cursor)
  → MCP tool call (chatgpt / chatgpt_sessions / chatgpt_browse)
  → webgpt2mcp MCP Server
  → WebAI2API (OpenAI-compatible endpoint)
  → Logged-in ChatGPT browser session
  → ChatGPT (with GitHub Connector / Skill system_prompt)
  → Returns result to CLI Agent for execution
```

The local model handles code execution and file operations; ChatGPT handles reasoning and review.

## Key Features

- **MCP Server** — Exposes `chatgpt`, `chatgpt_sessions`, and `chatgpt_browse` as MCP tools
- **Skill Injection** — CLI Agent injects arbitrary skills into ChatGPT sessions via `system_prompt`, instantly turning them into agent-like entities
- **Session Management** — Auto-save, smart routing (topic matching / conversation_url exact continuation), cloud sync
- **GitHub Code Review** — Review PRs and read code through ChatGPT's GitHub Connector — no local API key needed
- **Multi-Platform Gateway** — Built on WebAI2API, providing OpenAI-compatible endpoints for ChatGPT, Gemini, LMArena, and more

## Quick Start

### Prerequisites

- Node.js v20.0.0+
- pnpm

### 1. Install & Initialize

```bash
pnpm install
npm run init          # Download browser and prebuilt dependencies (requires GitHub access)
```

Use a proxy if network is restricted:

```bash
npm run init -- -proxy=http://username:passwd@host:port
```

### 2. Configuration

On first run, `config.example.yaml` is automatically copied to `data/config.yaml`. For a minimal ChatGPT-only setup:

```bash
cp config.chatgpt.example.yaml data/config.yaml
```

Edit the key fields:

```yaml
server:
  port: 3000
  auth: sk-change-me-to-your-secure-key   # API auth key (generate with npm run genkey)

backend:
  pool:
    instances:
      - name: "browser_chatgpt"
        workers:
          - name: "chatgpt_text_worker"
            type: chatgpt_text

browser:
  headless: false          # Set to false for initial login; true once stable
  proxy:
    enable: false           # Enable if ChatGPT requires a proxy
    type: http
    host: 127.0.0.1
    port: 7890
```

> See [config.example.yaml](config.example.yaml) for full configuration annotations.

#### Linux Server Local Start Script

If your server needs extra Camoufox native library paths, create a local start script (do not commit to git):

```bash
#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
export LD_LIBRARY_PATH="$ROOT/camoufox:$ROOT/runtime-libs/root/usr/lib/x86_64-linux-gnu:${LD_LIBRARY_PATH:-}"
exec npm start
```

### 3. Start the Service

```bash
# Standard start
npm start

# Linux headless environment
npm start -- -xvfb -vnc

# First-time login mode (disables headless, manually log into ChatGPT)
npm start -- -login
```

On first use, complete ChatGPT login via the Web UI (`http://localhost:3000`) — connect to the virtual display, log into ChatGPT in the browser, and send a test message to confirm it works.

For public servers, use an SSH tunnel:

```bash
ssh -L 3000:127.0.0.1:3000 user@server
# Then access http://localhost:3000 locally
```

> Session-token injection scripts handle sensitive cookies and are not included in the public repo. Keep them outside git or use placeholder-only examples.

### 4. Docker Deployment

```bash
docker build -t webgpt2mcp .
docker run -d --name webgpt2mcp \
  -p 3000:3000 \
  -v "$(pwd)/data:/app/data" \
  --shm-size=2gb \
  webgpt2mcp
```

Or with Docker Compose:

```bash
docker-compose up -d
```

> The Docker image enables Xvfb virtual display and VNC by default. Connect via the WebUI virtual display panel. Use SSH tunneling or HTTPS for public networks.

## MCP Server

### Client Configuration

Add to your Claude Code MCP config:

```json
{
  "mcpServers": {
    "webgpt2mcp": {
      "command": "node",
      "args": ["/path/to/webgpt2mcp/mcp-server/index.mjs"],
      "env": {
        "CHATGPT_API_URL": "http://127.0.0.1:3000",
        "CHATGPT_API_KEY": "sk-your-key"
      }
    }
  }
}
```

### Tools

| Tool | Description |
| :--- | :--- |
| `chatgpt` | Send a message to ChatGPT and get a reply; supports session routing and system_prompt injection |
| `chatgpt_sessions` | Manage sessions: list, view history, delete (local + cloud), cloud sync |
| `chatgpt_browse` | Have ChatGPT visit a URL and answer questions about the page content |

### Session Routing Rules

1. Pass `conversation_url` → Exactly continue the specified session
2. No `conversation_url` but pass `topic` → Auto-match the most recent session with the same topic; create new if no match
3. Pass neither → Create a new session

### Model Selection

| Model | Use Case |
| :--- | :--- |
| `gpt-instant` | Fast response (default) |
| `gpt-thinking` | Complex reasoning, deep analysis |
| `gpt-pro` | High-quality output |

## Skill Injection

A local CLI Agent (Claude Code, etc.) can inject a custom `system_prompt` through the MCP tool's parameter, giving the ChatGPT session a specific role and capability — effectively turning a plain ChatGPT conversation into a skilled agent on demand.

Workflow:

1. CLI Agent defines a skill (e.g., a code reviewer or academic writer system_prompt)
2. Calls the `chatgpt` tool with `system_prompt` + task content
3. ChatGPT reasons according to the injected role and returns results
4. CLI Agent handles actual code execution and file operations locally

ChatGPT acts as a zero-cost "thinking layer"; the local model handles execution — each does what it does best.

## GitHub Connector Workflow

Through the ChatGPT web GitHub Connector, ChatGPT can directly read GitHub repos, PRs, and code files — enabling zero-API-key code review.

### Prerequisites

1. Start this gateway service and complete ChatGPT login
2. Authorize the GitHub Connector in the ChatGPT web UI, ensuring access to target repos
3. Reuse a conversation URL where the Connector is active, or explicitly request its use in each prompt

### Prompt Rule

The prompt **must explicitly ask** ChatGPT to use the GitHub Connector to read content — sending a URL alone is not enough:

```text
# Good
Use the GitHub connector in this session to open this PR and read changed
files/diff before reviewing:
https://github.com/owner/repo/pull/123

# Bad (ChatGPT may reason from the URL text alone without actually reading code)
Review https://github.com/owner/repo/pull/123
```

### Review Request Example

```bash
curl http://127.0.0.1:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{
    "model": "gpt-thinking",
    "conversation_url": "https://chatgpt.com/c/your-conversation-id",
    "messages": [
      {
        "role": "user",
        "content": "Use the GitHub connector in this session to open https://github.com/owner/repo/pull/123 and read changed files/diff. Focus on bugs, regressions, security risks. Cite file paths and line numbers."
      }
    ],
    "stream": true
  }'
```

### Failure Signals

The Connector is not working correctly if ChatGPT: only repeats the URL, claims it cannot browse or access GitHub, reviews from the title/description only, or gives no file paths or code references for a non-trivial PR. Fix by checking Connector authorization or switching to a known-working `conversation_url`.

## Conversation Reuse

The gateway supports reusing an existing ChatGPT session via `conversation_url` to maintain context continuity:

```bash
curl http://127.0.0.1:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{
    "model": "gpt-instant",
    "conversation_url": "https://chatgpt.com/c/your-conversation-id",
    "messages": [{"role": "user", "content": "Continue the previous discussion"}],
    "stream": true
  }'
```

API responses include `conversation_url` — save it for follow-up requests to continue the same session.

## Thinking Model

Use `"model": "gpt-thinking"` to invoke ChatGPT's Thinking model for complex reasoning tasks.

If you encounter response parsing issues, enable debug dump for diagnostics (local use only — output contains prompts and screenshots, never publish):

```yaml
backend:
  adapter:
    chatgpt_text:
      debugDump: true    # Outputs to data/debug-chatgpt/
```

## API Reference

The gateway provides standard OpenAI-compatible endpoints usable by any OpenAI API client.

### Chat Completions

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{
    "model": "gpt-instant",
    "messages": [{"role": "user", "content": "Hello"}],
    "stream": true
  }'
```

> It is recommended to enable `stream: true` — the server sends keepalive heartbeat packets to prevent long-wait timeouts.

### Other Endpoints

| Endpoint | Description |
| :--- | :--- |
| `GET /v1/models` | List currently available models |
| `GET /v1/cookies` | Get browser cookies (filterable by instance name and domain) |
| `GET /admin/chatgpt/conversations` | List ChatGPT cloud conversations |
| `GET /admin/chatgpt/conversation/:id` | Get full history of a specific conversation |

## Local `chatgpt` CLI

The AIVA installation includes a `chatgpt` command on `PATH`. It reads the
bearer token from `data/config.yaml` and talks to the local server, so callers
never need to paste an API key.

```bash
chatgpt conversations list
chatgpt conversations search "takeoff"
chatgpt read <conversation-id-or-exact-url>
chatgpt send <conversation-id-or-exact-url> "Continue this conversation"
chatgpt new "Start a new conversation"
chatgpt rename <conversation-id-or-exact-url> "New title"
chatgpt archive <conversation-id-or-exact-url>
chatgpt unarchive <conversation-id-or-exact-url>
chatgpt projects list
chatgpt projects conversations <project-id-or-exact-url>
chatgpt move <conversation-id-or-exact-url> <project-id-or-exact-url>
chatgpt move <conversation-id-or-exact-url> none
chatgpt projects create "Project name"
```

Mutating conversation commands require an exact UUID or exact
`https://chatgpt.com/c/...` URL. Project operations require an exact `g-p-...`
ID or exact project URL; titles and fuzzy names are rejected. Add `--json`
before or after a command for the raw API response.

### Automatic ChatGPT project routing

The bridge can organize new completion conversations and `/admin/chatgpt/dispatch`
requests using the top-level `projects` map in `data/config.yaml`:

```yaml
projects:
  default: "g-p-your-default-project-id"
  byAgent:
    dev: "g-p-your-dev-project-id"
    aiva: "g-p-your-aiva-project-id"
```

An exact request `project` hint takes precedence, followed by the `agent` map
and then `default`. Requests may provide these hints as JSON fields or through
`X-AIVA-Agent` and `X-AIVA-Project` headers. The bridge validates configured
IDs against the live project list, falls back to `default` when a mapped project
is missing, and never creates a project automatically. A failed move is logged
and does not fail the conversation request.

## Hardware Requirements

| Resource | Minimum | Recommended |
| :--- | :--- | :--- |
| CPU | 1 core | 2+ cores |
| RAM | 1 GB | 2+ GB |
| Disk | 2 GB free | 5+ GB |

## Documentation

- [Configuration Guide](docs/CONFIGURATION.md)
- [MCP & GitHub Connector Workflow](docs/MCP_GITHUB_CONNECTOR_WORKFLOW.md)
- [Open Source Checklist](docs/OPEN_SOURCE_CHECKLIST.md)
- [GPT Code Skill](skills/gpt-code.md)

## License

[MIT License](LICENSE)

> **Disclaimer**: This project is for educational purposes only. The authors bear no responsibility for any consequences arising from its use (including but not limited to account suspension). Please comply with the Terms of Service of relevant websites.

---

Built on the WebAI2API open source project. See [NOTICE.md](NOTICE.md) for details.
