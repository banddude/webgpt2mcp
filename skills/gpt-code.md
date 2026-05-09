---
id: gpt-code
name: GPT Code
description: Drive ChatGPT 5.5 through a local ChatGPT Web API and the ChatGPT GitHub connector for code review or code generation.
triggers:
  - "gpt review"
  - "gpt gen"
  - "gpt审查"
  - "gpt优化"
  - "gpt生成"
  - "ask gpt"
  - "让gpt"
tags:
  - chatgpt
  - github-connector
  - code-review
  - code-generation
  - mcp
---

# GPT Code

Use the local ChatGPT Web API to ask ChatGPT 5.5 to read GitHub repositories,
pull requests, diffs, or files through the already-authorized ChatGPT GitHub
connector. Do not send a bare URL and assume ChatGPT will inspect it.

## Requirements

- ChatGPT Web API is running, usually at `http://127.0.0.1:3000/v1`.
- API key is the local bearer token configured in `data/config.yaml`, for
  example `sk-your-webai2api-key`.
- ChatGPT web session is logged in.
- GitHub connector is authorized in ChatGPT and has access to the target repo.
- For generation mode, local changes are pushed to GitHub before asking
  ChatGPT to modify code.

## Request Shape

```json
{
  "model": "gpt-thinking",
  "conversation_url": "https://chatgpt.com/c/optional-existing-conversation",
  "messages": [
    {
      "role": "user",
      "content": "{connector_prompt}"
    }
  ],
  "stream": true
}
```

## Review Prompt

```text
Please use the GitHub connector enabled in this ChatGPT session to read the
following GitHub context and perform a code review.

Requirements:
1. You must read the PR diff / changed files / commits / file contents through
   the GitHub connector before reviewing.
2. Do not infer from the URL, filename, title, or summary alone.
3. If the connector cannot access the repository, say so explicitly.
4. Prioritize bugs, regressions, security issues, concurrency/state issues,
   resource leaks, compatibility problems, and missing tests.
5. Cite file paths and line numbers where possible.

GitHub context:
{github_urls}

User focus:
{requirement}

Output:
- Critical findings
- Other findings
- Test risks
- Suggested fixes
- Summary
```

## Generation Prompt

```text
Please use the GitHub connector enabled in this ChatGPT session to read this
repository and implement the requested change.

Repository / branch:
{repo_url}
Branch: {branch}

Relevant files:
{file_list}

Request:
{requirement}

Rules:
1. Read the relevant code through the GitHub connector first.
2. Keep changes small and consistent with the existing style.
3. Do not modify secrets, environment files, generated files, browser profiles,
   databases, or unrelated files.
4. If you can commit directly on GitHub, commit to the current branch.
5. If you cannot commit, output a clear patch or per-file edit instructions.
6. Report changed files and test recommendations.
```

## Conversation Reuse

Prefer reusing a ChatGPT conversation where the GitHub connector has already
been enabled:

```json
"conversation_url": "https://chatgpt.com/c/..."
```

Use a separate conversation per project or PR when possible.

## Safety

- Never send session tokens, API keys, `.env` files, databases, browser
  profiles, private keys, or internal credentials to ChatGPT.
- Check `git status --short` and `.gitignore` before pushing.
- ChatGPT connector reads GitHub, not unpushed local files.
