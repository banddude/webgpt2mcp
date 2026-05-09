# 配置说明

本文档详细说明 ChatGPT Web Gateway 的配置流程。网关基于 WebAI2API，聚焦 ChatGPT 文本生成，通过 OpenAI 兼容接口暴露服务：

```text
POST /v1/chat/completions
```

## 1. 安装

需要 Node.js 20 或更新版本。

```bash
pnpm install
npm run init
```

如需代理：

```bash
npm run init -- -proxy=http://127.0.0.1:7890
```

不要提交运行时生成的目录：`camoufox/`、`runtime-libs/`、`node_modules/`、`data/`。

## 2. 创建配置

首次启动时会自动从 `config.example.yaml` 复制到 `data/config.yaml`。ChatGPT 专用最小配置：

```bash
cp config.chatgpt.example.yaml data/config.yaml
```

然后编辑：

- `server.auth`：API 鉴权密钥，使用私密值（可通过 `npm run genkey` 生成）
- `server.port`：服务端口，通常为 `3000`
- `backend.pool.instances[].workers[].type`：保持 `chatgpt_text`
- `browser.proxy`：需要代理访问 ChatGPT 时开启并填写
- `browser.headless`：首次登录和调试时设为 `false`，稳定后可改为 `true`

## 3. 登录

```bash
npm start -- -login
```

打开 WebUI 或虚拟显示器，完成 ChatGPT 登录，确保页面能正常发送一条消息。

无图形界面的服务器通过 SSH 隧道访问：

```bash
ssh -L 3000:127.0.0.1:3000 user@server
# 本地访问 http://localhost:3000
```

## 4. 启动

```bash
npm start
```

Linux 无图形环境：

```bash
npm start -- -xvfb -vnc
```

如服务器需要额外的 Camoufox 原生库路径，创建本地启动脚本（不提交到 git）：

```bash
#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
export LD_LIBRARY_PATH="$ROOT/camoufox:$ROOT/runtime-libs/root/usr/lib/x86_64-linux-gnu:${LD_LIBRARY_PATH:-}"
exec npm start
```

## 5. 调用 API

非流式：

```bash
curl http://127.0.0.1:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{
    "model": "gpt-instant",
    "messages": [{"role": "user", "content": "用一句话说明你是否可用"}],
    "stream": false
  }'
```

流式（推荐，含心跳保活）：

```bash
curl -N http://127.0.0.1:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{
    "model": "gpt-instant",
    "messages": [{"role": "user", "content": "写一个三点清单"}],
    "stream": true
  }'
```

## 6. 会话复用

通过 `conversation_url` 复用已有会话，保持上下文连续：

```bash
curl http://127.0.0.1:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{
    "model": "gpt-instant",
    "conversation_url": "https://chatgpt.com/c/your-conversation-id",
    "messages": [{"role": "user", "content": "继续上一轮的讨论"}],
    "stream": true
  }'
```

API 响应中包含 `conversation_url`，保存后可用于后续请求继续同一会话。

## 7. Thinking 模型

使用 `"model": "gpt-thinking"` 调用 ChatGPT 的 Thinking 模型，适用于复杂推理。

调试响应解析问题时可开启 debug dump（仅本地使用，输出含 prompt 和截图，切勿公开）：

```yaml
backend:
  adapter:
    chatgpt_text:
      debugDump: true    # 输出到 data/debug-chatgpt/
```

## 8. GitHub Connector

参见 [MCP 与 GitHub Connector 工作流](MCP_GITHUB_CONNECTOR_WORKFLOW.md)。
