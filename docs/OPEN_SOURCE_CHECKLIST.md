# Open Source Release Checklist

Suggested public repository name:

```text
chatgpt-web-gateway
```

## Files To Keep

- `src/`
- `scripts/`
- `patches/`
- `webui/` source files
- `package.json`
- lockfiles
- `config.example.yaml`
- `config.chatgpt.example.yaml`
- `README.md` and `README_EN.md` from upstream
- `LICENSE`
- `NOTICE.md`
- `docs/`
- `skills/gpt-code.md`

## Files To Exclude

- `data/`
- `camoufox/`
- `runtime-libs/`
- `node_modules/`
- `webui/node_modules/`
- `webui/dist/`
- `.omc/state/`
- `.mcp.json`
- `.env*`
- `*.db`, `*.sqlite`, `*.sqlite3`
- logs, screenshots, debug dumps, prompt histories
- local scripts containing absolute paths or real proxy settings

## Secret Scan Before Push

Run this from the release directory:

```bash
rg -n "(__Secure|session-token|eyJhbGci|sk-[A-Za-z0-9_-]{10,}|Bearer [A-Za-z0-9._-]+|/zhaoshu|127\\.0\\.0\\.1:4444|CHATGPT_SESSION_TOKEN|api[_-]?key|password|passwd)" .
```

Review every hit. Placeholder examples are acceptable; real values are not.

## Git Init

Create a clean repository from the sanitized export, not from the live runtime
directory:

```bash
git init
git add .
git status --short
git commit -m "Initial open source release"
```

Then add your GitHub remote and push.

## Attribution

Keep `LICENSE` and `NOTICE.md`. Do not remove upstream author or license
information from copied source files or package metadata without checking the
license obligations.
