# 小熊猫 · Red Panda

一个自托管的「旅程记录」应用：Android 客户端 + Linux 服务端。

- **小熊猫** 是中文名，**Red Panda** 是英文名。
- 旅程包含 **名称、描述和结构化行程计划**（目的地、出发与返回时间）。
- **邮箱注册**：使用邮箱注册，点击验证邮件里的链接激活账户后才能登录；邮箱也是唯一登录标识。
- 支持 **登录 / 登出 / 修改密码 / 忘记密码重置**，每个账户在本机只能看到自己的旅程与回忆（按账户隔离）。
- **回忆**：给走过的行程添加照片、视频和文字；行程与回忆（包括媒体文件）保存在当前客户端的 IndexedDB。
- 登录状态会保留在本地，离开应用或重启后仍保持登录，直到手动退出。
- **离线优先**：没有网络或连不上服务器时，应用会立刻打开并使用本机数据，不会卡在空白页。顶部会显示离线提示条，联网后自动恢复 AI、邮件和地点搜索等在线功能。
- 服务端负责邮箱账号认证、邮件、AI 请求，并提供 HTML 服务看板；个人资料与旅行数据全部由客户端保存，服务端不存储也不提供相关接口。
- Android 端是一个很薄的 WebView 外壳，复用 `web/` 里的同一套界面。
  同一套界面也由服务端在 `/app/` 提供，可直接用手机或电脑浏览器打开；
  将来上 iOS 时，用 `WKWebView` 包一层即可。

## 应用结构

底部四个标签页共用同一条历史记录，所以在这四页按返回会**直接退出应用**，
而不是回到上一个标签页。

| 标签 | 作用 |
| --- | --- |
| **行程** | 默认页面：展示正在进行的行程，没有就展示接下来最近的一段；下面还有「行程信息」（天气 / 交通）和「文件」（门票 / 车票），这两块暂时留白，等功能上线。 |
| **回忆** | 给已经走过的行程添加照片、视频和文字，攒成旅行回忆；还能让 AI 把回忆写成一段话（分享到朋友圈 / 小红书 / Instagram 后续再做）。 |
| **＋** | 新建旅程。有草稿时先浮出草稿列表，背景始终是「行程」页。 |
| **发现** | 展示当前或最近行程目的地里的有趣去处，想法还没定，暂时留白。 |
| **我** | 昵称、账户与安全、语言、常用出发地、数据备份与关于。 |

## 应用语言

- 界面支持 **中文 / English / Deutsch** 三种语言，登录、注册、设置、旅程等页面都有语言切换器（`中 / English / Deutsch`）。
- 默认跟随系统语言；系统语言不是中、英文、德文时，默认使用 **English**。
- 登录注册页面上的手动切换会保存在本机，并写入当前账户的本地资料；服务端不再保存语言偏好。
- 注册激活邮件、更换邮箱邮件、重置密码邮件会使用当前操作选择的语言发送。

## 目录结构

```
red-panda/
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

启动后会打印本机地址、管理员令牌、AI 与邮件状态，例如：

```
控制台      http://192.168.10.65:8787/
HTML5 应用  http://192.168.10.65:8787/app/
邮件        log · 邮件写入 /.../data/outbox
管理员令牌  xxxxxxxxxxxxxxxxxxxxxxxx
```

- 看板：`http://<本机IP>:8787/`
- HTML5 版：`http://<本机IP>:8787/app/`
- 停止：`./scripts/stop-server.sh`

默认邮件模式为 `log`：注册/重置邮件只会写入 `data/outbox/`，**不会真的发送**。
要真正收信，在 `.env` 里配置 SMTP（网易 126/163 授权码或 Gmail 应用专用密码）：

```bash
RED_PANDA_MAIL_MODE=smtp
RED_PANDA_SMTP_HOST=smtp.126.com
RED_PANDA_SMTP_PORT=465
RED_PANDA_SMTP_SECURE=1
RED_PANDA_SMTP_USER=you@126.com
RED_PANDA_SMTP_PASS=你的授权码
RED_PANDA_MAIL_FROM="Red Panda <you@126.com>"
```

部署到公网或希望手机直接打开验证链接时，还要设置
`RED_PANDA_PUBLIC_URL=https://你的域名`。详见 [docs/SERVER.md](docs/SERVER.md)。

### 2. 构建并安装 Android 客户端

需要 Android SDK（`~/Android/Sdk`）和 JDK 17+。

```bash
./scripts/build-android.sh          # 生成 build/android/red-panda.apk
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
也可以设置 `RED_PANDA_AI_MOCK=1` 使用离线假数据。

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
- **本地优先**：昵称、语言、常用出发地、行程与回忆全部保存在当前客户端的 IndexedDB；服务端只保存邮箱账号、密码哈希与认证状态，不存储任何个人旅行数据。
- **不阻塞界面**：首屏只读本机数据立即渲染，服务器在后台连接；连接状态机（`web/connection.js`）按指数退避自动重连。

## 许可证与商业授权

本项目以 **GNU Affero General Public License v3.0 only（AGPL-3.0-only）**
发布，完整条款见 [LICENSE](LICENSE)。

- 在遵守 AGPL-3.0 的前提下，你可以自由使用、修改、分发，**包括商用**；
- 如果你修改后通过网络向用户提供服务，必须以 AGPL-3.0 公开对应源码；
- 如果你的场景无法满足 AGPL（例如闭源集成、商业托管但不愿开源修改），
  可以购买**商业授权**，联系 `jianghang2020@gmail.com`；
- 贡献代码前请阅读并签署 [CLA](CLA.md)，签署方式见
  [docs/LICENSING.md](docs/LICENSING.md)。

「小熊猫」「Red Panda」名称与 Logo 不包含在许可证授权范围内。
