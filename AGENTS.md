# AGENTS.md — 小熊猫 · Red Panda

## 项目定位

自托管、离线优先的「旅程记录」应用，包含三个部分：

- `web/`：共享前端（纯原生 HTML / CSS / JS，无打包器、无第三方依赖），同时服务于 HTML5 版（`/app/`）和 Android WebView（`file:///android_asset/www/index.html`）。
- `server/`：零依赖 Node.js 服务端（Node >= 22.5，使用内置 `node:http`、`node:sqlite`、`node:crypto`），只负责邮箱认证、发邮件、AI 代理、高德/Google 地图代理与服务看板；**不保存任何个人旅行数据、媒体文件或偏好资料**。
- `android/`：极薄的 Android WebView 外壳（`MainActivity.java`），构建时复制 `web/` 到 assets。

## 核心约束

1. **零依赖、零构建**：
   - 服务端仅使用 Node.js 内置模块，不引入 `npm` 第三方包。
   - 前端必须同时兼容 HTTP（`/app/`）与 Android WebView 的 `file://` 协议；拆分脚本时使用顺序加载的普通 `<script>` + 共享命名空间（`window.RedPanda`），不要在 `file://` 下依赖跨文件 ES Module `import`。
2. **数据边界**：
   - 行程、回忆、照片/视频、昵称、语言、常用地址全部保存在客户端 IndexedDB（按账号隔离）。
   - 服务端不得存储用户个人旅行数据或上传媒体。
3. **安全与密钥**：
   - 禁止把 `.env`、API Key、`amap_api_key.txt`、`google_maps_api_key.txt`、管理员令牌或签名密钥提交到 Git。
   - 地图浏览器端 Key 与服务端 Key 支持独立配置（未配置浏览器端 Key 时兼容回退）。
   - Android `WebView.setWebContentsDebuggingEnabled` 仅在 debug 构建下开启。
4. **多语言一致**：
   - 应用支持 `zh` / `en` / `de` 三语；前端文案、邮件模板与 AI 提示词均应遵循 `locale`。

## 目录约定

- `server/src/`：服务端模块（`config.js`、`auth.js`、`db.js`、`rate-limit.js`、`http-utils.js`、`static.js`、`ai.js`、`mailer.js`、`emails.js`、`routes/*`、`app.js`、`server.js`）。
- `server/test/`：自动化测试，使用 `cd server && node --test` 运行。
- `web/`：共享前端入口（`index.html`、`sw.js`、`manifest.webmanifest`、`config.js`、`connection.js`、`app.js`）以及按职责拆分的脚本与样式。
- `docs/`：服务端、Android、HTTP API 与授权文档。

## 验证命令

- 全部测试：`cd server && node --test`
- 前端静态语法检查：`node --check web/*.js web/js/*.js`（视实际文件而定）
- Android 构建（需本地安装 Android SDK 与 JDK 17+）：`./scripts/build-android.sh`

## 协作与进度

- 项目真实进度以根目录 `ROADMAP.md` 为准；每次完成开发、修复或文档补齐并验证后同步更新。
- 涉及删除文件、修改 `.env`/密钥/CI 配置、数据库破坏性变更等高风险操作前必须先确认。
