# chatgpt-web-gateway Notice

This repository is a customized workflow and configuration layer built on top of
the upstream **WebAI2API** project.

## Upstream Attribution

- Upstream project name: WebAI2API
- Upstream author in package metadata and license: foxhui
- Upstream license: MIT
- The original `README.md`, `README_EN.md`, `CHANGELOG.md`, `Dockerfile`,
  source tree, and `LICENSE` are preserved unless a future commit explicitly
  documents otherwise.

The custom additions in this fork focus on using the existing ChatGPT web
adapter as an OpenAI-compatible local gateway, including conversation reuse,
GitHub connector workflows, deployment notes, and privacy-safe configuration
examples.

## Third-Party Components

This project depends on the same third-party runtime stack as WebAI2API,
including Node.js, Playwright, Camoufox, and the npm dependencies declared in
`package.json` and lockfiles. Downloaded browser binaries, local browser
profiles, generated SQLite databases, logs, and debug dumps are intentionally
excluded from the public repository.

## Privacy Boundary

Do not publish:

- `data/`
- `camoufox/`
- `runtime-libs/`
- `node_modules/`
- `.mcp.json`
- `.env*`
- local start scripts containing absolute paths
- ChatGPT session tokens, cookies, browser profiles, prompts, responses, or
  debug screenshots
