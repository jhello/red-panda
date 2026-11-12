# 服务端指南

服务端是一个零依赖的 Node.js 程序，负责账号、旅程数据、AI 请求和服务看板。

## 环境要求

- **Node.js 22.5 或更高**（内置 `node:sqlite` 需要该版本）
- 无需 `npm install`，没有第三方依赖
- 数据库为 SQLite，文件保存在 `data/odyssey.db`

检查版本：

```bash
node --version
```

## 启动与停止

项目自带三个脚本，默认在项目根目录执行：

```bash
./scripts/start-server.sh    # 后台启动，写入 data/server.pid 与 data/server.log
./scripts/status-server.sh   # 查看进程与健康检查
./scripts/stop-server.sh     # 优雅停止（5 秒超时后强制结束）
```

启动成功后终端会打印：

```
山海经 · ODYSSEY
控制台      http://192.168.10.65:8787/
HTML5 应用  http://192.168.10.65:8787/app/
健康检查    http://192.168.10.65:8787/api/health
数据库      /.../data/odyssey.db
AI          未配置（设置 OPENAI_API_KEY 后重启）
邮件        log · 邮件写入 /.../data/outbox
公开地址    自动检测（验证邮件中的链接以此为准）
管理员令牌  xxxxxxxxxxxxxxxxxxxxxxxx
```

- **服务看板**：`http://<本机IP>:8787/`
- **HTML5 应用**：`http://<本机IP>:8787/app/`
- **健康检查**：`http://<本机IP>:8787/api/health`
- 日志：`data/server.log`
- 进程号：`data/server.pid`

> 脚本会读取项目根目录的 `.env`（如果存在）。见下方「环境变量」。

### 前台运行（开发时看日志）

```bash
cd server
npm start          # 等价于 node src/server.js
npm run dev        # node --watch，改代码自动重启
```

## 环境变量

可以在命令行 `export`，也可以写进项目根目录的 `.env`（`start-server.sh` 会自动加载）。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | 监听地址；只在本机用可设为 `127.0.0.1` |
| `PORT` | `8787` | 监听端口 |
| `ODYSSEY_DATA_DIR` | `<项目>/data` | 运行时数据目录 |
| `ODYSSEY_DB` | `<data>/odyssey.db` | SQLite 文件路径 |
| `ODYSSEY_ADMIN_TOKEN` | 自动生成 | 看板管理员令牌；不设则生成并保存到 `data/admin-token` |
| `ODYSSEY_SESSION_DAYS` | `30` | 登录会话闲置有效天数；每次使用会自动续期，直到手动登出 |
| `ODYSSEY_VERIFY_HOURS` | `24` | 注册验证链接有效小时数 |
| `ODYSSEY_RESET_MINUTES` | `60` | 重置密码链接有效分钟数 |
| `ODYSSEY_PUBLIC_URL` | 空 | 邮件链接使用的公开地址；留空自动使用局域网地址 |
| `ODYSSEY_MAIL_MODE` | `log` | 邮件发送方式：`log` / `command` / `http` |
| `ODYSSEY_MAIL_FROM` | `Odyssey <no-reply@odyssey.local>` | 发件人 |
| `ODYSSEY_MAIL_COMMAND` | 空 | `command` 模式下执行的命令，如 `msmtp -t` |
| `ODYSSEY_MAIL_API_URL` | 空 | `http` 模式下接收邮件的 API 地址 |
| `ODYSSEY_MAIL_API_KEY` | 空 | `http` 模式下的 Bearer 密钥 |
| `ODYSSEY_WEB_DIR` | `<项目>/web` | HTML5 前端目录 |
| `OPENAI_API_KEY` | 空 | OpenAI（或兼容服务）密钥；为空时 AI 未配置 |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | API 基地址，可指向兼容服务 |
| `OPENAI_MODEL` | `gpt-4o-mini` | 使用的模型 |
| `ODYSSEY_AI_MOCK` | `0` | 设为 `1` 时不调用真实 API，返回假数据 |

示例 `.env`：

```bash
PORT=8787
HOST=0.0.0.0
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4o-mini
# ODYSSEY_AI_MOCK=1
```

修改后重启服务生效：

```bash
./scripts/stop-server.sh && ./scripts/start-server.sh
```

## 邮件与账户验证

注册只接受邮箱。账户创建后处于「待验证」状态，用户需要点击验证邮件里的链接
才会激活；未验证的账户无法登录。忘记密码时也通过邮件发送重置链接。

### 发送方式

| `ODYSSEY_MAIL_MODE` | 行为 |
| --- | --- |
| `log`（默认） | 把完整邮件写入 `data/outbox/*.eml`，并在 `data/server.log` 打印验证/重置链接。无需任何配置。 |
| `command` | 把原始邮件通过管道交给 `ODYSSEY_MAIL_COMMAND`，例如 `msmtp -t`。 |
| `http` | 向 `ODYSSEY_MAIL_API_URL` 发送 JSON：`{from,to,subject,text,html}`；可带 `ODYSSEY_MAIL_API_KEY`。 |

默认的 `log` 模式适合本地开发和自用。想真正收信，可以安装 `msmtp` 并用
`command` 模式，或把邮件交给任意支持 HTTP 的邮件服务。

### 查看验证链接（log 模式）

```bash
ls -t data/outbox | head
tail -n 40 data/server.log | grep -E 'mail:log|链接'
```

日志里会出现类似：

```
[odyssey] [mail:log] → you@example.com · 激活你的山海经账户
[odyssey] [mail:log] 链接: http://192.168.10.65:8787/api/auth/verify?token=…
```

### 公开地址很重要

验证/重置链接里的域名来自 `ODYSSEY_PUBLIC_URL`；没有设置时会自动选择本机的
局域网地址。部署到公网时必须显式设置，例如：

```bash
ODYSSEY_PUBLIC_URL=https://odyssey.example.com
```

否则用户收到的链接会指向内网 IP，在手机上无法打开。

## 管理员令牌与看板

- 首次启动若未设置 `ODYSSEY_ADMIN_TOKEN`，会生成随机令牌并写入
  `data/admin-token`（权限 `600`）。
- 打开看板后输入令牌即可查看服务器状态、用户列表、旅程数量、最近请求等。
- 看板每 5 秒自动刷新。
- 令牌也可以直接用于调用管理接口：

```bash
curl -H "X-Admin-Token: $(cat data/admin-token)" \
  http://127.0.0.1:8787/api/admin/status
```

## 使用 systemd 常驻

`deploy/odyssey.service` 是一个模板。假设项目位于 `/opt/odyssey`，
用户为 `odyssey`：

1. 复制并修改服务单元：

   ```bash
   sudo cp deploy/odyssey.service /etc/systemd/system/odyssey.service
   sudo systemctl edit --full odyssey.service   # 按实际路径/用户修改
   ```

2. 启用并启动：

   ```bash
   sudo systemctl daemon-reload
   sudo systemctl enable --now odyssey
   sudo systemctl status odyssey
   journalctl -u odyssey -f          # 查看日志
   ```

3. 停止 / 重启：

   ```bash
   sudo systemctl stop odyssey
   sudo systemctl restart odyssey
   ```

> 用 systemd 时不要把 `ODYSSEY_ADMIN_TOKEN` 写进服务单元明文；
> 可让程序自动生成 `data/admin-token`，或用 `EnvironmentFile` 指向权限受限的文件。

## 防火墙（Arch Linux）

若手机通过局域网访问，需要放行端口。使用 `ufw`：

```bash
sudo ufw allow 8787/tcp
sudo ufw status
```

使用 `firewalld`：

```bash
sudo firewall-cmd --permanent --add-port=8787/tcp
sudo firewall-cmd --reload
```

只在受信任的家庭网络开放该端口；不要直接暴露到公网。

## 数据库

- 引擎：SQLite，启用 WAL 模式。
- 文件：`data/odyssey.db`（以及运行时的 `-wal` / `-shm` 旁文件）。
- 备份：停止服务后复制 `data/odyssey.db` 即可；运行中可用
  `sqlite3 data/odyssey.db ".backup 'backup.db'"`。
- 看板里的「数据库大小」为主库加 WAL 的实际占用。

数据表：

| 表 | 用途 |
| --- | --- |
| `users` | 用户账号、邮箱、scrypt 密码哈希、验证状态、登录/在线时间 |
| `sessions` | 会话令牌哈希与过期时间 |
| `email_verifications` | 待使用的邮箱验证令牌 |
| `password_resets` | 待使用的密码重置令牌 |
| `journeys` | 旅程（名称、描述、所属用户） |

从旧版本升级时，已有账户会自动补上 `email = NULL`、`email_verified = 1`，
并继续用原来的用户名登录；新账户使用邮箱登录。

AI 调用次数等运行指标保存在内存中，服务重启后归零，不写入数据库。

> 删除 `data/` 会清空所有账号、旅程和管理员令牌。请先备份。

## 常见问题

**启动失败，提示 `node:sqlite` 不存在 / 需要实验特性**
升级到 Node.js 22.5+。检查 `node --version`。

**手机打不开，但电脑能打开**
1. 确认服务监听 `0.0.0.0`（默认就是）。
2. 确认手机与电脑在同一 Wi-Fi。
3. 检查防火墙是否放行 8787。
4. 用手机浏览器直接访问 `http://<电脑IP>:8787/app/` 验证。

**AI 一直提示 503**
说明未配置 `OPENAI_API_KEY`，或密钥/网络有问题。看 `data/server.log`
中的错误；也可先用 `ODYSSEY_AI_MOCK=1` 验证前端流程。

**收不到验证 / 重置邮件**
默认 `ODYSSEY_MAIL_MODE=log` 不会真的发信：链接在 `data/server.log` 和
`data/outbox/*.eml` 里。需要真实收信时配置 `ODYSSEY_MAIL_MODE=command`
（如 `msmtp`）或 `http`。同时确认 `ODYSSEY_PUBLIC_URL` 指向用户能访问的地址。

**登录提示「邮箱尚未验证」**
用注册邮箱调用 `POST /api/auth/resend-verification`，或在应用的待验证页面点
「重新发送验证邮件」，然后点击新邮件里的链接。

**端口被占用**
换端口：`PORT=8788 ./scripts/start-server.sh`，并同步修改 Android 的服务器地址。

**忘记管理员令牌**
查看 `data/admin-token`。若想重置，删除该文件并重启（看板令牌会变，
但用户账号和旅程不受影响）。

## 测试

```bash
cd server
node --test
```

测试使用临时数据目录，不会污染 `data/`。
