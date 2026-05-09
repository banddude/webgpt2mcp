# MCP 与 GitHub Connector 工作流

本工作流让本地编码代理通过 OpenAI 兼容接口调用 ChatGPT，同时 ChatGPT 通过网页端已授权的 GitHub Connector 访问代码仓库。

## 架构

```text
本地编码代理 / MCP 客户端
  → 本地 MCP Server 或 OpenAI 兼容客户端
  → http://127.0.0.1:3000/v1/chat/completions
  → WebAI2API ChatGPT 文本适配器
  → 已登录的 ChatGPT 浏览器会话
  → ChatGPT GitHub Connector
  → GitHub 仓库 / PR / 文件
```

GitHub Connector 运行在 ChatGPT 网页产品内部，本地 API 仅驱动浏览器会话并传输 prompt 和响应。

## 手动配置步骤

1. 启动 ChatGPT Web Gateway 服务
2. 在 WebAI2API 使用的浏览器 profile 中登录 ChatGPT
3. 打开 ChatGPT 网页，授权 GitHub Connector
4. 确保 Connector 有目标 GitHub 组织/仓库的访问权限
5. 复用一个已开启 Connector 的 `conversation_url`，或在每次 prompt 中明确要求使用

无需上传浏览器 Cookie、session token 或本地 MCP 配置到 GitHub。

## MCP 客户端配置

将实际密钥放在 git 之外：

```json
{
  "base_url": "http://127.0.0.1:3000/v1",
  "api_key": "YOUR_API_KEY",
  "default_model": "gpt-thinking"
}
```

如支持会话元数据，传入：

```json
{
  "conversation_url": "https://chatgpt.com/c/your-conversation-id"
}
```

## 提示词规则

prompt 中**必须**明确要求 ChatGPT 使用 GitHub Connector 读取内容，仅发送 URL 不够。

好的做法：

```text
Use the GitHub connector enabled in this ChatGPT session to open this PR and
read changed files/diff before reviewing:
https://github.com/owner/repo/pull/123
```

不好的做法：

```text
Review https://github.com/owner/repo/pull/123
```

后者可能导致 ChatGPT 仅根据 URL 文本推测，而不实际读取 GitHub 内容。

## 审核请求示例

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

## 失败信号

如出现以下情况，说明 Connector 未正确工作：

- ChatGPT 仅重复 URL
- 声称无法浏览或无法访问 GitHub
- 仅根据 PR 标题/描述审核
- 对非简单 PR 未给出文件路径或代码引用

解决方式：检查 GitHub Connector 授权、仓库权限，或换一个已知可用的 `conversation_url`。
