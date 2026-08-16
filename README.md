# webgpt2mcp

> **Banddude private deployment:** this branch includes production fixes for cloud history, continuation, mid-stream steering, OAuth, and systemd deployment. See [`BANDDUDE_DEPLOYMENT.md`](BANDDUDE_DEPLOYMENT.md) for the portable install path.

将 ChatGPT 网页能力转化为 MCP 工具，让 Claude Code、Cursor 等 CLI 编码代理直接调用 ChatGPT 进行代码审核、文档生成、学术写作等任务——零额外 API 费用，复用已有的 ChatGPT 网页订阅。

## 工作原理

```text
CLI Agent (Claude Code / Cursor)
  → MCP 工具调用 (chatgpt / chatgpt_sessions / chatgpt_browse)
  → webgpt2mcp MCP Server
  → WebAI2API (OpenAI 兼容接口)
  → 已登录的 ChatGPT 浏览器会话
  → ChatGPT (含 GitHub Connector / Skill system_prompt)
  → 返回结果给 CLI Agent 执行
```

本地模型负责代码执行和文件操作，ChatGPT 负责推理和审核。

## 核心能力

- **MCP Server** — 暴露 `chatgpt`、`chatgpt_sessions`、`chatgpt_browse` 三个 MCP 工具
- **Skill 注入** — CLI Agent 通过 system_prompt 将任意技能注入 ChatGPT 会话，即时将其转变为类智能体
- **会话管理** — 自动保存、智能路由（topic 匹配 / conversation_url 精确继续）、云端同步
- **GitHub 代码审核** — 通过 ChatGPT 的 GitHub Connector 审核 PR、阅读代码，无需本地 API Key
- **多平台网关** — 底层基于 WebAI2API，支持 ChatGPT、Gemini、LMArena 等多个 AI 网站的 OpenAI 兼容接口

## 快速开始

### 环境要求

- Node.js v20.0.0+
- pnpm

### 1. 安装与初始化

```bash
pnpm install
npm run init          # 下载浏览器等预编译依赖（需连接 GitHub）
```

网络受限时使用代理：

```bash
npm run init -- -proxy=http://username:passwd@host:port
```

### 2. 配置

首次运行会自动从 `config.example.yaml` 复制到 `data/config.yaml`。如需 ChatGPT 专用最小配置，可直接使用：

```bash
cp config.chatgpt.example.yaml data/config.yaml
```

然后编辑以下关键项：

```yaml
server:
  port: 3000
  auth: sk-change-me-to-your-secure-key   # API 鉴权密钥（可通过 npm run genkey 生成）

backend:
  pool:
    instances:
      - name: "browser_chatgpt"
        workers:
          - name: "chatgpt_text_worker"
            type: chatgpt_text

browser:
  headless: false          # 首次登录设为 false；登录稳定后可改为 true
  proxy:
    enable: false           # ChatGPT 需要代理时开启
    type: http
    host: 127.0.0.1
    port: 7890
```

> 完整配置说明见 [config.example.yaml](config.example.yaml) 中的注释。

#### Linux 服务器本地启动脚本

如服务器需要额外的 Camoufox 原生库路径，可创建本地启动脚本（不要提交到 git）：

```bash
#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
export LD_LIBRARY_PATH="$ROOT/camoufox:$ROOT/runtime-libs/root/usr/lib/x86_64-linux-gnu:${LD_LIBRARY_PATH:-}"
exec npm start
```

### 3. 启动服务

```bash
# 标准启动
npm start

# Linux 无图形环境
npm start -- -xvfb -vnc

# 首次登录模式（禁用无头模式，手动登录 ChatGPT 账号）
npm start -- -login
```

首次使用需完成 ChatGPT 账号登录：通过 Web 管理界面（`http://localhost:3000`）连接虚拟显示器，在浏览器窗口中登录 ChatGPT，发送一条测试消息确认可用。

公网服务器建议使用 SSH 隧道：

```bash
ssh -L 3000:127.0.0.1:3000 user@server
# 然后本地访问 http://localhost:3000
```

> Session-token 注入脚本涉及敏感 Cookie，未包含在公开仓库中。如需本地使用，请放在 git 之外或仅保留占位符示例。

### 4. Docker 部署

```bash
docker build -t webgpt2mcp .
docker run -d --name webgpt2mcp \
  -p 3000:3000 \
  -v "$(pwd)/data:/app/data" \
  --shm-size=2gb \
  webgpt2mcp
```

或使用 Docker Compose：

```bash
docker-compose up -d
```

> Docker 镜像默认开启 Xvfb 虚拟显示器和 VNC 服务，可通过 WebUI 的虚拟显示器板块连接。公网环境请使用 SSH 隧道或 HTTPS。

## MCP Server

### 配置接入

在 Claude Code 的 MCP 配置中添加：

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

### 工具列表

| 工具 | 说明 |
| :--- | :--- |
| `chatgpt` | 向 ChatGPT 发送消息并获取回复，支持会话路由和 system_prompt 注入 |
| `chatgpt_sessions` | 管理会话：列表、查看历史、删除（本地+云端）、云端同步 |
| `chatgpt_browse` | 让 ChatGPT 访问 URL 并回答关于页面内容的问题 |

### 会话路由规则

1. 传 `conversation_url` → 精确继续指定会话
2. 不传 `conversation_url` 但传 `topic` → 自动匹配同 topic 的最近会话，无匹配则新建
3. 都不传 → 创建新会话

### 模型选择

| 模型 | 用途 |
| :--- | :--- |
| `gpt-instant` | 快速响应（默认） |
| `gpt-thinking` | 复杂推理、深度分析 |
| `gpt-pro` | 高质量输出 |

## Skill 注入机制

本地 CLI Agent（Claude Code 等）可以将自定义的 `system_prompt` 通过 MCP 工具的 `system_prompt` 参数注入到 ChatGPT 会话中，使该会话具备特定角色和能力——相当于将一个普通 ChatGPT 会话即时转变为拥有指定 skill 的类智能体。

工作流程：

1. CLI Agent 定义 skill（如代码审查、学术写作等角色的 system_prompt）
2. 调用 `chatgpt` 工具时传入 `system_prompt` + 任务内容
3. ChatGPT 按照注入的角色执行推理，返回结果
4. CLI Agent 在本地负责实际的代码执行和文件操作

这种架构让 ChatGPT 成为零成本的"思考层"，本地模型负责执行——两者各司其职。

## GitHub Connector 工作流

通过 ChatGPT 网页端的 GitHub Connector，可以让 ChatGPT 直接读取 GitHub 仓库、PR、代码文件，实现零 API Key 的代码审核。

### 前置条件

1. 启动本网关服务并完成 ChatGPT 登录
2. 在 ChatGPT 网页中授权 GitHub Connector，确保有目标仓库的访问权限
3. 复用一个已开启 Connector 的会话 URL，或在每次 prompt 中明确要求使用 Connector

### 提示词规则

prompt 中**必须明确要求** ChatGPT 使用 GitHub Connector 读取内容，仅发送 URL 是不够的：

```text
# 好的做法
Use the GitHub connector in this session to open this PR and read changed
files/diff before reviewing:
https://github.com/owner/repo/pull/123

# 不好的做法（ChatGPT 可能仅根据 URL 文本推测，不实际读取代码）
Review https://github.com/owner/repo/pull/123
```

### 审核请求示例

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

### 失败信号

如 ChatGPT 仅重复 URL、声称无法浏览/访问 GitHub、仅根据标题描述审核、或未给出文件路径和代码引用，说明 Connector 未正确工作——需检查 Connector 授权或换一个已知可用的 `conversation_url`。

## 会话复用

网关支持通过 `conversation_url` 复用已有 ChatGPT 会话，保持上下文连续：

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

API 响应中会包含 `conversation_url`，客户端可保存用于后续请求继续同一会话。

## Thinking 模型

使用 `"model": "gpt-thinking"` 可调用 ChatGPT 的 Thinking 模型，适用于复杂推理任务。

如遇响应解析问题，可开启 debug dump 诊断（仅本地使用，输出包含 prompt 和截图，切勿公开）：

```yaml
backend:
  adapter:
    chatgpt_text:
      debugDump: true    # 输出到 data/debug-chatgpt/
```

## API 接口

网关提供标准 OpenAI 兼容接口，可被任何支持 OpenAI API 的客户端使用。

### 文本对话

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{
    "model": "gpt-instant",
    "messages": [{"role": "user", "content": "你好"}],
    "stream": true
  }'
```

> 建议开启 `stream: true`，服务器会发送保活心跳包，避免长等待超时。

### 其他接口

| 端点 | 说明 |
| :--- | :--- |
| `GET /v1/models` | 获取当前可用模型列表 |
| `GET /v1/cookies` | 获取浏览器 Cookie（可指定实例名和域名过滤） |
| `GET /admin/chatgpt/conversations` | 获取 ChatGPT 云端会话列表 |
| `GET /admin/chatgpt/conversation/:id` | 获取指定会话完整历史 |

## 设备配置参考

| 资源 | 最低配置 | 推荐配置 |
| :--- | :--- | :--- |
| CPU | 1 核 | 2 核及以上 |
| 内存 | 1 GB | 2 GB 及以上 |
| 磁盘 | 2 GB | 5 GB 及以上 |

## 文档

- [配置说明](docs/CONFIGURATION.md)
- [MCP 与 GitHub Connector 工作流](docs/MCP_GITHUB_CONNECTOR_WORKFLOW.md)
- [开源发布清单](docs/OPEN_SOURCE_CHECKLIST.md)
- [GPT Code Skill](skills/gpt-code.md)

## 许可证

[MIT License](LICENSE)

> **免责声明**：本项目仅供学习交流使用。因使用该项目造成的任何后果（包括但不限于账号被禁用），作者和项目均不承担任何责任。请遵守相关网站和服务的使用条款。

---

本项目基于 WebAI2API 开源项目构建，详见 [NOTICE.md](NOTICE.md)。
