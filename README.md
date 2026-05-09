# webgpt2mcp

> 将 ChatGPT 网页能力转化为 MCP 工具，让 CLI 编码代理（Claude Code、Cursor 等）
> 直接调用 ChatGPT 进行代码审核、文档生成、学术写作等任务。

## 核心能力

- **MCP Server** — 暴露 `chatgpt`、`chatgpt_sessions`、`chatgpt_browse` 三个 MCP 工具
- **GitHub 代码审核** — 通过 ChatGPT 的 GitHub Connector 审核 PR、阅读代码，
  无需本地 API Key，直接复用网页登录态
- **Skill 注入** — 本地模型指定 skill 模板上传给 ChatGPT，ChatGPT 做"思考"，
  本地模型做"执行"
- **云端会话管理** — 获取线上历史、topic 路由、双向同步

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

本地模型（Claude Code 等）负责代码执行和文件操作，ChatGPT 负责推理和审核——
零额外 API 费用，复用已有的 ChatGPT 网页订阅。

## 文档

- [配置说明](docs/CONFIGURATION.md)
- [MCP 与 GitHub connector 工作流](docs/MCP_GITHUB_CONNECTOR_WORKFLOW.md)
- [开源发布清单](docs/OPEN_SOURCE_CHECKLIST.md)
- [上游与第三方声明](NOTICE.md)
- [GPT Code skill](skills/gpt-code.md)

---

## MCP Server

`mcp-server/` 提供一个独立的 MCP server，将 ChatGPT 网页能力暴露为可被 Claude Code、Cursor 等 MCP 客户端调用的工具。

### 工具列表

| 工具 | 说明 |
| :--- | :--- |
| `chatgpt` | 向 ChatGPT 发送消息并获取回复，支持会话路由（topic 匹配 / conversation_url 精确继续） |
| `chatgpt_sessions` | 管理会话：列表、查看历史、删除（本地+云端）、云端同步 |
| `chatgpt_browse` | 让 ChatGPT 访问一个 URL 并回答关于页面内容的问题 |

### 配置

MCP server 通过环境变量配置：

```bash
CHATGPT_API_URL=http://127.0.0.1:3000   # WebAI2API 服务地址
CHATGPT_API_KEY=sk-your-key              # API 密钥（必填）
```

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

### 会话路由规则

1. 传 `conversation_url` → 精确继续指定会话
2. 不传 `conversation_url` 但传 `topic` → 自动匹配同 topic 的最近会话，无匹配则新建
3. 都不传 → 创建新会话

### 云端同步

`chatgpt_sessions` 工具支持 `sync` 操作，以云端 ChatGPT 信息为准同步到本地：
- 从云端拉取新会话
- 更新已有会话的标题
- 不会删除本地有但云端没有的会话

---

## Skill 系统

`skills/` 目录存放 YAML 格式的 skill 模板。本地模型（如 Claude Code）可以加载 skill 并将 `system_prompt` + 文件内容 + 任务指令注入到新的 ChatGPT 会话中，利用 ChatGPT 的推理能力后，本地模型负责执行。

这种架构让 ChatGPT 成为零成本的"思考层"，本地模型负责实际代码执行。

### 内置 Skills

| Skill | 说明 | 模型 |
| :--- | :--- | :--- |
| `code_reviewer` | 代码审查专家，深度审查上传的代码文件 | gpt-thinking |
| `paper_section_writer` | 学术论文章节撰写，生成 LaTeX 正文 | gpt-thinking |
| `kgqa_prompt_audit` | KGQA 提示语审查优化 | gpt-thinking |

### Admin API

通过 Admin API 执行 skill：

```bash
# 列出所有 skills
curl http://localhost:3000/admin/skills \
  -H "Authorization: Bearer YOUR_API_KEY"

# 执行 skill
curl -X POST http://localhost:3000/admin/chatgpt/skill/execute \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "skill": "code_reviewer",
    "files": ["/path/to/code.py"],
    "task": "Review this file for bugs and security issues"
  }'
```

### 云端会话 Admin API

```bash
# 获取云端会话列表
curl http://localhost:3000/admin/chatgpt/conversations?limit=20 \
  -H "Authorization: Bearer YOUR_API_KEY"

# 获取指定会话完整历史
curl http://localhost:3000/admin/chatgpt/conversation/CONVERSATION_ID \
  -H "Authorization: Bearer YOUR_API_KEY"
```

以下为上游 WebAI2API 原项目说明。

# WebAI2API

简体中文 | [English](README_EN.md)

<p align="center">
  <img src="https://github.com/user-attachments/assets/296a518e-c42b-4e39-8ff6-9b4381ed4f6e" width="49%" />
  <img src="https://github.com/user-attachments/assets/bfa30ece-6947-4f18-b2c9-ccc8087b7e89" width="49%" />
</p>
<p align="center">
  <img src="https://github.com/user-attachments/assets/5b15ebd2-7593-4f0e-8561-83d6ba5d88ab" width="49%" />
  <img src="https://github.com/user-attachments/assets/53deea29-4071-4a07-8a61-211761c5f2f7" width="49%" />
</p>

## 📑 目录

- [快速部署](#-快速部署)
- [快速开始](#-快速开始)
- [使用方法](#-使用方法)
- [API 接口](#-api-接口)
- [设备配置参考](#-设备配置参考)

---

## 📝 项目简介

**WebAI2API** 是一个基于 **Camoufox (Playwright)** 的网页版 AI 服务转通用 API 的工具。通过模拟人类操作与 LMArena、Gemini 等网站交互, 提供兼容 **OpenAI 格式** 的接口服务, 同时支持 **多窗口并发** 与 **多账号管理**(浏览器实例数据隔离)。

### ✨ 主要特性

- 🤖 **拟人交互**: 模拟人类打字与鼠标轨迹, 通过特征伪装规避自动化检测
- 🔄 **接口兼容**: 提供标准 OpenAI 格式接口, 支持流式响应与心跳保活
- 🚀 **并发隔离**: 支持多窗口并发执行, 可配置独立代理,实现多账号浏览器实例级数据隔离
- 🛡️ **稳定防护**: 内置任务队列、负载均衡、故障转移、错误重试等基础功能
- 🎨 **网页管理**: 提供可视化管理界面, 支持实时日志查看、VNC 连接、适配器管理等

### 📋 支持列表

| 网站名称 | 文本生成 | 图片生成 | 视频生成 |
| :--- | :---: | :---: | :---: | 
| [**LMArena**](https://lmarena.ai/) | ✅ | ✅ | 🚫 |
| [**Gemini Enterprise Business**](https://business.gemini.google/) | ✅ | ✅ | ✅ |
| [**Nano Banana Free**](https://nanobananafree.ai/) | 🚫 | ✅ | 🚫 |
| [**zAI**](https://zai.is/) | ✅ | ✅ | 🚫 |
| [**Google Gemini**](https://gemini.google.com/) | ✅ | ✅💧 | ✅💧 | 
| [**ZenMux**](https://zenmux.ai/) | ✅ | ❌ | 🚫 | 
| [**ChatGPT**](https://chatgpt.com/) | ✅ | ✅ | 🚫 | 
| [**DeepSeek**](https://chat.deepseek.com/) | ✅ | 🚫 | 🚫 | 
| [**Sora**](https://sora.chatgpt.com/) | 🚫 | 🚫 | ✅💧 | 
| [**Google Flow**](https://labs.google/fx/zh/tools/flow) | 🚫 | ✅ | ❌ | 
| [**豆包**](https://www.doubao.com/) | ✅ | ✅ | ❌ | 
| 待续... | - | - | - | 

> [!NOTE]
> **获取完整模型列表**: 通过 `GET /v1/models` 接口查看当前配置下所有可用模型及其详细信息。
> 
> ✅目前支持；❌目前不支持，但未来可能会支持；🚫网站不支持, 未来是否在支持看网站具体情况；💧结果带水印且无法去除；

---

## 🚀 快速部署

本项目支持 **源码直接运行** 和 **Docker 容器化部署** 两种方式。

### 📋 环境要求

- **Node.js**: v20.0.0+ (ABI 115+)
- **操作系统**: Windows / Linux / macOS
- **核心依赖**: Camoufox (安装过程中自动获取)

### 🛠️ 方式一:手动部署

1. **安装与配置**
   ```bash
   # 1. 安装 NPM 依赖
   pnpm install

   # 2. 安装浏览器等预编译依赖
   # ⚠️ 该脚本需连接 GitHub 下载资源。若网络受限，请使用代理
   npm run init 
   # 使用代理
   # 直接使用 -proxy 可交互式输入代理配置
   npm run init -- -proxy=http://username:passwd@host:port

   # 3. Linux 依赖安装
   # 其他发行版请前往文档中心查找或者自行搜索
   apt install -y xvfb x11vnc libgtk-3-0 libx11-xcb1 libasound2
   
   ```

2. **启动服务**
   ```bash
   # 标准启动
   npm start

   # Linux 系统 - 虚拟显示启动
   npm start -- -xvfb -vnc

   # 登录模式 (会临时强行禁用无头模式和自动化)
   npm start -- -login (-xvfb -vnc)
   ```

### 🐳 方式二:Docker 部署

> [!WARNING]
> **安全提醒**: 
> - Docker 镜像默认开启虚拟显示器 (Xvfb) 和 VNC 服务
> - 可通过 WebUI 的虚拟显示器板块连接
> - **WebUI 传输过程未加密, 公网环境请使用 SSH 隧道或 HTTPS**

**Docker CLI 启动**
```bash
docker build -t chatgpt-web-gateway:latest .
docker run -d --name chatgpt-web-gateway \
  -p 3000:3000 \
  -v "$(pwd)/data:/app/data" \
  --shm-size=2gb \
  chatgpt-web-gateway:latest
```

**Docker Compose 启动**
```bash
docker-compose up -d
```

---

## ⚡ 快速开始

### 1. 调整配置文件

程序初次运行会从`config.example.yaml`复制配置文件到`data/config.yaml`

**配置文件的生效需要重启程序！**

```yaml
server:
  # 监听端口
  port: 3000
  # 鉴权 API Token (可使用 npm run genkey 生成)
  # 该配置会对 API 接口和 WebUI 生效
  auth: sk-change-me-to-your-secure-key
```

> [!TIP]
> **完整配置说明**: 请参考 [config.example.yaml](config.example.yaml) 文件中的详细注释,或访问 [WebAI2API 文档中心](https://foxhui.github.io/WebAI2API/) 查看完整配置指南。

### 2. 访问 Web 管理界面

服务启动后, 打开浏览器访问:
```
http://localhost:3000
```

> [!TIP]
> **远程访问**: 将 `localhost` 替换为服务器 IP 地址即可远程访问。
> **API Token**: 配置文件中的`auth`所配置的鉴权密钥。
> **安全建议**: 公网环境建议使用 Nginx/Caddy 配置 HTTPS 或通过 SSH 隧道访问。

### 3. 初始化账号登录

> [!IMPORTANT]
> **首次使用必须完成以下初始化步骤**:

1. **连接虚拟显示器**:
   - Linux/Docker: 在 WebUI 的"虚拟显示器"板块连接
   - Windows: 直接在弹出的浏览器窗口中操作

2. **完成账号登录**:
   - 手动登录所需的 AI 网站账号 (账号要求可进入 WebUI 的适配器管理中查看)
   - 在输入框发送任意消息, 触发并完成人机验证 (如需要)
   - 同意服务条款或者新手指引 (如需要)
   - 确保不再有初次使用相关内容的阻拦

3. **SSH 隧道连接示例**(公网服务器推荐):
   ```bash
   # 在本地终端运行,将服务器的 WebUI 映射到本地
   ssh -L 3000:127.0.0.1:3000 root@服务器IP
   
   # 然后在本地访问
   # WebUI: http://localhost:3000
   ```

---

## 📖 使用方法

### 运行模式说明

> [!NOTE]
> **关于有头/无头模式**:
> - **有头模式**(默认): 显示浏览器窗口, 便于调试和人工干预
> - **无头模式**: 后台运行, 节省资源但无法查看浏览器界面, 且可能会被网站检测
> 
> **建议**: 为降低风控, **强烈建议长期保持非无头模式运行**(或使用虚拟显示器 Xvfb)。

---

## 🔌 API 接口

> [!TIP]
> **详细文档**: 请访问 [WebAI2API 文档中心](https://foxhui.github.io/WebAI2API/) 获取更全面的配置指南与接口说明。

### 1. OpenAI 兼容接口

> [!WARNING]
> **并发限制与流式保活建议**
> 
> 本项目通过模拟真实浏览器操作实现, 处理过程根据实际情况时间可能有所变化, 当积压的任务超过设置的数量时会直接拒绝非流式模式的请求。
> 
> **💡 强烈建议开启流式模式**: 服务器将发送保活心跳包, 可无限排队避免超时。

#### 文本对话

**端点**: `POST /v1/chat/completions`

**请求示例**:
```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{
    "model": "gemini-3-pro",
    "messages": [
      {"role": "user", "content": "你好,请介绍一下你自己"}
    ],
    "stream": true
  }'
```

#### 多模态请求(文生图/图生图)

**支持的图片格式**:
- **格式**: PNG, JPEG, GIF, WebP
- **数量**: 最大 10 张(具体限制因网站而异)
- **数据格式**: 必须使用 Base64 Data URL 格式
- **自动转换**: 服务器会自动将所有图片转换为 JPG 格式以保证兼容性

#### 参数说明

| 参数 | 类型 | 必填 | 说明 |
| :--- | :--- | :---: | :--- |
| `model` | string | ✅ | 模型名称, 可通过 `/v1/models` 获取可用列表 |
| `stream` | boolean | 推荐 | 是否开启流式响应, 包含心跳保活机制 |

> [!NOTE]
> **关于流式保活 (Heartbeat)**
>
> 为防止长连接超时, 系统提供两种保活模式 (可在配置中切换):
> 1. **Comment 模式 (默认/推荐)**: 发送 `:keepalive` 注释, 符合 SSE 标准,兼容性最好
> 2. **Content 模式**: 发送空内容的 data 包, 仅用于必须收到 JSON 数据才重置超时的特殊客户端

### 2. 获取模型列表

**端点**: `GET /v1/models`

**请求示例**:
```bash
curl http://localhost:3000/v1/models \
  -H "Authorization: Bearer YOUR_API_KEY"
```

### 3. 获取 Cookies

**功能说明**: 利用本项目的自动续登功能获取最新 Cookie 供其他工具使用。

**端点**: `GET /v1/cookies`

**参数**:
- `name` (可选): 浏览器实例名称,默认为 `default`
- `domain` (可选): 过滤指定域名的 Cookie

**请求示例**:
```bash
# 获取指定实例和域名的 Cookie
curl "http://localhost:3000/v1/cookies?name=browser_default&domain=lmarena.ai" \
  -H "Authorization: Bearer YOUR_API_KEY"
```

---

## 📊 设备配置参考

| 资源 | 最低配置 | 推荐配置 (单实例) | 推荐配置 (多实例) |
| :--- | :--- | :--- | :--- |
| **CPU** | 1 核 | 2 核及以上 | 2 核及以上 |
| **内存** | 1 GB | 2 GB 及以上 | 4 GB 及以上 |
| **磁盘** | 2 GB 可用空间 | 5 GB 及以上 | 7 GB 及以上 |

**实测环境表现** (均为单浏览器实例):
- **Oracle 免费机** (1C1G, Debian 12): 资源紧张, 比较卡顿, 仅供尝鲜或轻度使用
- **阿里云轻量云** (2C2G, Debian 11): 运行流畅但实例也会卡顿, 项目开发测试所用机型

---

## 📄 许可证和免责声明

本项目采用 [MIT License](LICENSE) 开源。

> [!CAUTION]
> **免责声明**
> 
> 本项目仅供学习交流使用。如果因使用该项目造成的任何后果 (包括但不限于账号被禁用),作者和项目均不承担任何责任。请遵守相关网站和服务的使用条款 (ToS),并做好相关数据的备份工作。

---

## 📋 更新日志

查看完整的版本历史和更新内容, 请访问 [CHANGELOG.md](CHANGELOG.md)。

### 🕰️ 历史版本说明

本项目已从 Puppeteer 迁移至 Camoufox, 以应对日益复杂的反机器人检测机制。基于 Puppeteer 的旧版本代码已归档至 `puppeteer-edition` 分支, 仅作留存, **不再提供更新与维护**。

---

**感谢 LMArena、Gemini 等网站提供 AI 服务!** 🎉
