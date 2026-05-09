# Notice

本项目是基于 WebAI2API 开源项目构建的自定义工作流和配置层。

## 上游引用

- 上游项目：WebAI2API
- 上游许可证：MIT
- 原始 `README.md`、`README_EN.md`、`CHANGELOG.md`、`Dockerfile`、源码目录和 `LICENSE` 均已保留

本项目的自定义部分聚焦于将 ChatGPT 网页适配器作为 OpenAI 兼容的本地网关使用，包括会话复用、GitHub Connector 工作流、部署说明和隐私安全的配置示例。

## 第三方组件

本项目依赖与 WebAI2API 相同的运行时栈，包括 Node.js、Playwright、Camoufox 及 `package.json` 中声明的 npm 依赖。下载的浏览器二进制文件、本地浏览器 profile、生成的 SQLite 数据库、日志和 debug dump 均不包含在公开仓库中。

## 隐私边界

不要发布以下内容：

- `data/`
- `camoufox/`
- `runtime-libs/`
- `node_modules/`
- `.mcp.json`
- `.env*`
- 包含绝对路径的本地启动脚本
- ChatGPT session token、Cookie、浏览器 profile、prompt、响应或 debug 截图
