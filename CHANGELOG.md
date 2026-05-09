# Changelog

本文件记录 webgpt2mcp 项目的变更。上游 WebAI2API 的完整版本历史请参见上游仓库的 CHANGELOG。

格式基于 [Keep a Changelog](https://keepachangelog.com/en/1.0.0/)。

## [1.0.0] - 2025-05-09

### Added

- **MCP Server** (`mcp-server/`): 独立 MCP server，暴露 `chatgpt`、`chatgpt_sessions`、`chatgpt_browse` 三个工具
  - `chatgpt`: 向 ChatGPT 发送消息并获取回复，支持会话路由和 `system_prompt` 注入
  - `chatgpt_sessions`: 会话管理（列表、历史查看、删除、云端同步）
  - `chatgpt_browse`: 让 ChatGPT 访问 URL 并回答问题
- **Skill 注入机制**: CLI Agent 通过 `system_prompt` 参数将任意技能注入 ChatGPT 会话，即时转变为类智能体
- **会话路由**: 支持 `topic` 自动匹配已有会话、`conversation_url` 精确继续、无匹配时自动新建
- **会话持久化**: 本地 JSON 存储会话记录（最近 50 个），自动截断长消息防止膨胀
- **云端同步**: `chatgpt_sessions` 工具的 `sync` 操作，以云端 ChatGPT 为准同步到本地
- **GitHub Connector 工作流**: 支持 ChatGPT 网页端 GitHub Connector 进行代码审核
- **Admin API**: 云端会话查询 (`GET /admin/chatgpt/conversations`) 和 Skill 执行接口

### Security

- MCP server 通过环境变量 `CHATGPT_API_KEY` 传入密钥，不硬编码
- 会话存储自动截断消息内容，避免敏感信息积累
