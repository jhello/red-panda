# 山海经 · Odyssey

一个自托管的「旅程记录」应用：Android 客户端 + Linux 服务端。

- **山海经** 是中文名，**Odyssey** 是英文名。
- 旅程目前只有 **名称** 和 **描述** 两个字段。
- 支持 **注册 / 登录 / 登出**，每个用户只能看到自己的旅程。
- 服务端负责账号、数据库、AI 请求，并提供 HTML 服务看板。
- Android 端是一个很薄的 WebView 外壳，复用 `web/` 里的同一套界面。
  同一套界面也由服务端在 `/app/` 提供，可直接用手机或电脑浏览器打开；
  将来上 iOS 时，用 `WKWebView` 包一层即可。

## 目录结构

```
odyssey/
├── web/                  # 共享前端（HTML/CSS/JS），Android 与 HTML5 共用
├── server/               # 零依赖 Node.js 服务端
│   ├── src/              # HTTP 路由、SQLite、鉴权、AI 代理
│   ├── public/dashboard/ # 服务看板
│   └── test/             # node --test 接口测试
├── android/              # Android 工程（Gradle 配置 + WebView 外壳）
├── scripts/              # 启动/停止、构建 APK、安装调试脚本
├── deploy/               # systemd 服务单元模板
├── docs/                 # 详细文档
└── data/                 # 运行时数据（数据库、令牌、日志，已被 git 忽略）
```

## 快速开始

### 1. 启动服务端

需要 **Node.js 22.5+**（使用内置 `node:sqlite`，无需 `npm install`）。

```bash
./scripts/start-server.sh
./scripts/status-server.sh
```

启动后会打印本机地址、管理员令牌和 AI 状态，例如：

```
控制台      http://192.168.10.65:8787/
HTML5 应用  http://192.168.10.65:8787/app/
管理员令牌  xxxxxxxxxxxxxxxxxxxxxxxx
```

- 看板：`http://<本机IP>:8787/`
- HTML5 版：`http://<本机IP>:8787/app/`
- 停止：`./scripts/stop-server.sh`

### 2. 构建并安装 Android 客户端

需要 Android SDK（`~/Android/Sdk`）和 JDK 17+。

```bash
./scripts/build-android.sh          # 生成 build/android/odyssey.apk
./scripts/dev-android.sh            # 构建 + 安装 + adb reverse + 启动
```

APK 默认服务器地址为构建时本机的局域网 IP；也可以在应用内
「服务器设置」中修改。详见 [docs/ANDROID.md](docs/ANDROID.md)。

### 3. 配置 AI（可选）

```bash
export OPENAI_API_KEY=sk-...
export OPENAI_MODEL=gpt-4o-mini
./scripts/start-server.sh
```

未配置时「AI 生成描述」会返回清晰的 503 提示，其他功能不受影响。
也可以设置 `ODYSSEY_AI_MOCK=1` 使用离线假数据。

## 文档

| 文档 | 内容 |
| --- | --- |
| [docs/SERVER.md](docs/SERVER.md) | 服务端启动/停止、环境变量、systemd、防火墙、数据库、AI 配置 |
| [docs/ANDROID.md](docs/ANDROID.md) | 构建 APK、Wi-Fi ADB 配对调试、日志、端口转发、常见问题 |
| [docs/API.md](docs/API.md) | HTTP 接口说明与示例 |
| [docs/LICENSING.md](docs/LICENSING.md) | 许可证、商业授权、CLA 与贡献流程 |
| [CONTRIBUTING.md](CONTRIBUTING.md) | 贡献指南、开发环境、PR 规范 |

## 测试

```bash
cd server
node --test
```

## 设计说明

- **零依赖**：只用 Node 内置模块（`node:http`、`node:sqlite`、`node:crypto`），
  不需要联网安装依赖，方便在任意 Linux 机器上跑。
- **密码安全**：scrypt 加盐哈希；会话令牌只以 SHA-256 哈希存库。
- **单源前端**：`web/` 是唯一前端源码，Android 构建时复制进 assets。
- **本地优先**：数据只保存在这台服务器的 SQLite 文件里。

## 许可证与商业授权

本项目以 **GNU Affero General Public License v3.0 only（AGPL-3.0-only）**
发布，完整条款见 [LICENSE](LICENSE)。

- 在遵守 AGPL-3.0 的前提下，你可以自由使用、修改、分发，**包括商用**；
- 如果你修改后通过网络向用户提供服务，必须以 AGPL-3.0 公开对应源码；
- 如果你的场景无法满足 AGPL（例如闭源集成、商业托管但不愿开源修改），
  可以购买**商业授权**，联系 `jianghang2020@gmail.com`；
- 贡献代码前请阅读并签署 [CLA](CLA.md)，签署方式见
  [docs/LICENSING.md](docs/LICENSING.md)。

「山海经」「Odyssey」名称与 Logo 不包含在许可证授权范围内。
