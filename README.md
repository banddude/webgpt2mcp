# Explicit ChatGPT website commands

This service exposes bounded website controls through the maintained `bin/chatgpt` CLI and the MCP server. A send places the exact supplied text into ChatGPT once and returns the conversation URL after submission is confirmed. The website can keep generating after the caller exits. Replies are read only by a later explicit command.

```bash
chatgpt new 'Your exact message' --model gpt-thinking
chatgpt send 'https://chatgpt.com/c/<conversation-id>' 'Your next exact message'
chatgpt read 'https://chatgpt.com/c/<conversation-id>' --json
```

Quote message text as one argument to preserve spacing and newlines. `dispatch` aliases new-chat submission and can add local journal attribution. `bin/chatgpt-web` aliases the same maintained CLI; the old generated mcporter CLI is retired. Its old flags are not translated automatically.

MCP `create`, `dispatch`, `chatgpt`, and `send` each perform one send command and return a URL. `conversation_read` reads one current snapshot, which may still be partial. Exact conversation IDs and URLs are required for existing-chat operations. `system_prompt`, instructions, tool/model-turn envelopes, implicit agent/project routing, streaming, and completion-wait options are rejected. Project moves use the explicit `move` command separately.

No OpenAI-compatible model endpoints are implemented. `/v1/*`, `/responses`, `/chat/completions`, and model listings return 404 after the existing API authentication check. The skill runner, model task queue, generation/failover code for ChatGPT, response streaming, completion poller, and WebUI send/replay actions have been removed from executable source. Historical backups, journals, sessions, and saved request history are retained.

If the browser is busy, a send returns 409 with no retained job. A click failure can mean the website received the message; the result reports uncertainty and never retries the click or sends Enter afterwards. Callers must not schedule retries, completion polling, check-ins, or resubmit a tool/model turn. Inspect a known URL only after an explicit request.

The sender still verifies the exact conversation and composer before typing. An active existing response is stopped and that stop is confirmed before an explicit replacement message is sent. Requested new-chat models must be selected successfully in the website UI before submission. There is no completion or response-start wait. Textareas normalize CR/CRLF to LF; all other input whitespace is checked before sending. Raw image/file uploads through the retired model API are no longer supported. The website may generate images from a text request; explicit reads retain image references and the existing download control.

Authentication, browser/session recovery, exact stop/delete/rename/archive controls, project management, VNC, and saved history remain. Delete confirmations and sender refusals remain enforced. Session recovery is on demand. The login command opens the login page and returns one current auth snapshot; waiting options are rejected. Dashboard and logs load once when opened and refresh only on an explicit action. Service restart returns command acceptance; readiness is checked separately. Model queue, generation timeout, load balancing, failover, and SSE settings are retired. Existing browser-instance, proxy, and authentication configuration is preserved; legacy model fields in local configuration are inactive. Reads may perform bounded metadata and image-link lookups; they do not wait for a final answer. All of these website capabilities depend on the current website UI and existing authenticated browser session.

Run verification without a browser or a website chat:

```bash
npm test
python3 -m unittest discover -s tests -p 'test_*.py'
npm --prefix webui run build
```

See [DEPLOYMENT.md](DEPLOYMENT.md) for the staged rollout. The MIT license and upstream attribution are unchanged.
