# MCP And GitHub Connector Workflow

This workflow lets a local coding agent call ChatGPT through the
OpenAI-compatible WebAI2API endpoint, while ChatGPT itself uses the GitHub
connector authorized in the ChatGPT web session.

## Architecture

```text
Local coding agent / MCP client
  -> local MCP wrapper or OpenAI-compatible client
  -> http://127.0.0.1:3000/v1/chat/completions
  -> WebAI2API ChatGPT text adapter
  -> logged-in ChatGPT browser session
  -> ChatGPT GitHub connector
  -> GitHub repository / PR / files
```

The GitHub connector runs inside ChatGPT's web product. The local API only
drives the browser session and transports prompts/responses.

## What Must Be Configured Manually

1. Start the ChatGPT Web Gateway service.
2. Log in to ChatGPT in the browser profile used by WebAI2API.
3. Open ChatGPT web UI and authorize the GitHub connector.
4. Make sure the connector has access to the target GitHub org/repo.
5. Reuse a `conversation_url` where the connector is available, or explicitly
   ask ChatGPT to use the connector in every prompt.

You do not need to upload browser cookies, session tokens, or local MCP config
to GitHub.

## MCP Client Configuration Shape

Keep actual keys outside git. A generic local MCP wrapper can point to:

```json
{
  "base_url": "http://127.0.0.1:3000/v1",
  "api_key": "sk-your-webai2api-key",
  "default_model": "gpt-thinking"
}
```

If your MCP wrapper supports conversation metadata, pass:

```json
{
  "conversation_url": "https://chatgpt.com/c/your-conversation-id"
}
```

## Prompt Rule

The prompt must instruct ChatGPT to use the GitHub connector. A URL by itself is
not enough.

Good:

```text
Use the GitHub connector enabled in this ChatGPT session to open this PR and
read changed files/diff before reviewing:
https://github.com/owner/repo/pull/123
```

Bad:

```text
Review https://github.com/owner/repo/pull/123
```

The bad version may cause ChatGPT to reason from the URL text instead of
reading GitHub content.

## Review Request Example

```json
{
  "model": "gpt-thinking",
  "conversation_url": "https://chatgpt.com/c/your-conversation-id",
  "messages": [
    {
      "role": "user",
      "content": "Use the GitHub connector enabled in this ChatGPT session to open https://github.com/owner/repo/pull/123 and read changed files/diff before reviewing. Focus on bugs, regressions, security risks, and missing tests. Cite file paths and line numbers when possible."
    }
  ],
  "stream": true
}
```

## Failure Signals

Treat the connector call as failed if ChatGPT:

- only repeats the URL,
- says it cannot browse or cannot access GitHub,
- reviews from the PR title/description only,
- gives no file paths or code-grounded findings for a non-trivial PR.

Fix by authorizing the GitHub connector in ChatGPT, checking repo permissions,
or reusing a known-good `conversation_url`.
