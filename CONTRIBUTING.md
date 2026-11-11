# 贡献指南

感谢你愿意为「山海经 · Odyssey」贡献代码、文档或想法！

## 行为准则

- 尊重不同背景和经验的贡献者；
- 就事论事，避免人身攻击；
- 欢迎新手提问，耐心解答。

## 开始之前

1. 先搜索 [Issues](https://github.com/jhello/odyssey/issues)，避免重复；
2. 较大的改动建议先开 Issue 讨论方向，再动手；
3. 提交代码前请阅读并签署 [CLA](CLA.md)（首次 PR 时机器人会提示）。

> 为什么需要 CLA：本项目采用 AGPL-3.0 + 商业授权双许可，CLA 让维护者能够把
> 社区贡献纳入商业授权。你仍然保留自己贡献的版权。

## 开发环境

- Node.js 22.5+（服务端）
- JDK 17+、Android SDK（Android 端，可选）
- 无需 `npm install`，服务端零依赖

```bash
# 启动服务端（前台，便于看日志）
cd server
npm run dev

# 运行测试
node --test

# 构建 Android APK
./scripts/build-android.sh
```

## 项目结构

| 目录 | 说明 |
| --- | --- |
| `web/` | 共享前端（HTML/CSS/JS），Android 与 HTML5 共用，**改界面改这里** |
| `server/src/` | HTTP 路由、SQLite、鉴权、AI 代理 |
| `server/public/dashboard/` | 服务看板 |
| `server/test/` | 接口测试 |
| `android/` | WebView 外壳与 Gradle 配置 |
| `scripts/` | 启动、构建、安装脚本 |
| `docs/` | 详细文档 |

## 提交 Pull Request

1. Fork 仓库并从 `main` 创建分支：

   ```bash
   git checkout -b feat/your-feature
   ```

2. 修改代码，保持改动聚焦；
3. 运行测试，确保 `node --test` 全绿；
4. 提交，提交信息建议使用简洁的祈使句：

   ```
   feat: 支持旅程标签
   fix: 修复看板刷新时的时间显示
   docs: 补充 Wi-Fi ADB 配对说明
   ```

5. Push 并创建 PR，描述清楚：
   - 改了什么、为什么；
   - 如何测试；
   - 关联的 Issue（如有）。

6. 按机器人提示签署 CLA，等待 review。

## 代码风格

- 服务端：ES Module，2 空格缩进，单引号，保持现有风格；
- 前端：原生 HTML/CSS/JS，不引入构建工具和框架；
- 注释用中文或英文均可，解释「为什么」而不是「是什么」；
- 不要提交 `data/`、`build/`、`.env` 或任何密钥。

## 报告问题

提交 Issue 时请附上：

- 操作系统与版本；
- Node.js / Android 版本；
- 复现步骤；
- 期望结果与实际结果；
- 相关日志（`data/server.log`、`adb logcat`），并先隐去敏感信息。

## 许可证

提交贡献即表示你同意你的贡献按 [AGPL-3.0](LICENSE) 发布，并已签署
[CLA](CLA.md)。详见 [docs/LICENSING.md](docs/LICENSING.md)。
