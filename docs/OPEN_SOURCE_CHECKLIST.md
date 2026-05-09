# 开源发布清单

## 保留文件

- `src/`
- `scripts/`
- `patches/`
- `webui/` 源码
- `package.json`、lockfiles
- `config.example.yaml`、`config.chatgpt.example.yaml`
- `README.md`、`docs/`
- `LICENSE`、`NOTICE.md`
- `mcp-server/`
- `skills/gpt-code.md`
- `Dockerfile`、`docker-compose.yaml`
- `supervisor.js`

## 排除文件

- `data/`
- `camoufox/`
- `runtime-libs/`
- `node_modules/`
- `webui/node_modules/`、`webui/dist/`
- `.omc/`
- `.mcp.json`
- `.env*`
- `*.db`、`*.sqlite`、`*.sqlite3`
- 日志、截图、debug dump、prompt 历史
- 包含绝对路径或真实代理配置的本地脚本

## 发布前密钥扫描

在发布目录中运行：

```bash
rg -n "(eyJhbGci|sk-[A-Za-z0-9_-]{10,}|Bearer [A-Za-z0-9._-]+|api[_-]?key|password|passwd)" .
```

逐一检查命中项。占位符示例可保留，真实值必须移除。

## Git 初始化

从清理后的目录创建新仓库（不要从运行时目录）：

```bash
git init
git add .
git status --short
git commit -m "Initial release: webgpt2mcp — ChatGPT Web to MCP bridge"
```

## 引用声明

保留 `LICENSE` 和 `NOTICE.md`。不要在未确认许可证义务的情况下移除源文件或 package.json 中的上游作者及许可信息。
