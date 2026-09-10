# Rollout of explicit website controls

Review the tested commit and checks before merging or deploying. This change removes model endpoints and completion observers; it does not migrate authentication or runtime state. The existing manual Docker-publish workflow remains manual. The new PR workflow runs only fixture tests and a WebUI build.

Use the maintained `banddude/webgpt2mcp` fork and the `chatgpt-web-management-wip` branch. This fork is public. Do not push deployment secrets, local task artifacts, sessions, or host-specific configuration. The `origin` remote may still point at the upstream project; inspect the configured remotes before pushing.

Before updating, record the live checkout status and checksums of locally modified session files. Confirm the approved diff does not touch runtime/auth files. Preserve the existing data directory, browser profile, storage-state backup, OAuth stores, gateway configuration, environment, and local session/history files. Do not replace the checkout, stash/reset unrelated work, or clean runtime directories. A nonoverlapping dirty `mcp-server/sessions.json` can remain during a normal fast-forward.

After approval:

1. Fast-forward the maintained live branch to the reviewed merge. If Git refuses because of overlapping changes, resolve them with the owner; do not overwrite them.
2. Build the WebUI with the locked dependencies: `pnpm --dir webui install --frozen-lockfile --ignore-scripts`, then `npm --prefix webui run build`. This PR changes no application dependencies. Avoid browser-downloader postinstall hooks.
3. Point the installed `chatgpt` launcher at the repository's `bin/chatgpt`. If the old `chatgpt-web` launcher executes a generated mcporter binary, back up that launcher and replace it with a symlink to the repository's `bin/chatgpt-web`. Retain the old binary as inactive history. The alias uses the maintained CLI syntax; old generated flags fail locally rather than being guessed or translated into sends.
4. Under the deployment owner's approval, restart/start only this service's backend, MCP gateway, and OAuth wrapper using the existing owned units and dependencies. Inspect their actual state first. Do not restart shared routing, egress, unrelated services, or agent sessions.
5. Recheck session-file checksums and service readiness. Use authenticated inert requests to verify that retired model routes return 404, and use explicit session status/tool-discovery commands. Do not create website chats for tests, run completion watchers, replay queued jobs, or reauthenticate as a fallback. Preserve any denial and return it to the owner.

All automated verification uses fake browser/HTTP fixtures. A green build does not prove current live website compatibility. Existing persisted browser state remains the recovery source. If rollout fails, report the exact failure rather than automatically restoring the retired model bridge.
