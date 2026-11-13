# 服务端指南

服务端是一个零依赖的 Node.js 程序，负责邮箱账户认证、邮件、AI 请求和服务看板。昵称、语言、常用出发地、旅程、回忆与媒体保存在客户端 IndexedDB。

## 环境要求

- **Node.js 22.5 或更高**（内置 `node:sqlite` 需要该版本）
- 无需 `npm install`，没有第三方依赖
- 数据库为 SQLite，文件保存在 `data/red-panda.db`

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
小熊猫 · RED PANDA
控制台      http://192.168.10.65:8787/
HTML5 应用  http://192.168.10.65:8787/app/
健康检查    http://192.168.10.65:8787/api/health
数据库      /.../data/red-panda.db
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
| `RED_PANDA_DATA_DIR` | `<项目>/data` | 运行时数据目录 |
| `RED_PANDA_DB` | `<data>/red-panda.db` | SQLite 文件路径 |
| `RED_PANDA_ADMIN_TOKEN` | 自动生成 | 看板管理员令牌；不设则生成并保存到 `data/admin-token` |
| `RED_PANDA_SESSION_DAYS` | `30` | 登录会话闲置有效天数；每次使用会自动续期，直到手动登出 |
| `RED_PANDA_VERIFY_HOURS` | `24` | 注册验证链接有效小时数 |
| `RED_PANDA_RESET_MINUTES` | `1440` | 重置密码链接有效分钟数（24 小时） |
| `RED_PANDA_EMAIL_RATE_LIMIT` | `20` | 同一 IP 十分钟内可触发的注册 / 验证 / 重置邮件次数 |
| `RED_PANDA_PUBLIC_URL` | 空 | 邮件链接使用的公开地址；留空自动使用局域网地址 |
| `RED_PANDA_MAIL_MODE` | `log` | 邮件发送方式：`log` / `smtp` / `command` / `http` |
| `RED_PANDA_MAIL_FROM` | `Red Panda <no-reply@red-panda.local>` | 发件人；留空时自动使用 SMTP 用户名 |
| `RED_PANDA_SMTP_HOST` | 空 | `smtp` 模式的服务器，如 `smtp.126.com` |
| `RED_PANDA_SMTP_PORT` | `465` | SMTP 端口：465（SSL）/ 587（STARTTLS） |
| `RED_PANDA_SMTP_SECURE` | `1` | `1` 直接 TLS（465），`0` 使用 STARTTLS（587） |
| `RED_PANDA_SMTP_USER` | 空 | SMTP 登录名，通常是完整邮箱 |
| `RED_PANDA_SMTP_PASS` | 空 | SMTP 密码：网易「授权码」或 Gmail「应用专用密码」 |
| `RED_PANDA_SMTP_REJECT_UNAUTHORIZED` | `1` | 校验证书；仅自签名服务器才设为 `0` |
| `RED_PANDA_MAIL_COMMAND` | 空 | `command` 模式下执行的命令，如 `msmtp -t` |
| `RED_PANDA_MAIL_API_URL` | 空 | `http` 模式下接收邮件的 API 地址 |
| `RED_PANDA_MAIL_API_KEY` | 空 | `http` 模式下的 Bearer 密钥 |
| `RED_PANDA_WEB_DIR` | `<项目>/web` | HTML5 前端目录 |
| `OPENAI_API_KEY` | 空 | OpenAI（或兼容服务）密钥；为空时 AI 未配置 |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | API 基地址，可指向兼容服务 |
| `OPENAI_MODEL` | `gpt-4o-mini` | 使用的模型 |
| `RED_PANDA_AI_MOCK` | `0` | 设为 `1` 时不调用真实 API，返回假数据 |

示例 `.env`：

```bash
PORT=8787
HOST=0.0.0.0
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4o-mini
# RED_PANDA_AI_MOCK=1
```

修改后重启服务生效：

```bash
./scripts/stop-server.sh && ./scripts/start-server.sh
```

### 选择模型服务商

服务端走 OpenAI 兼容协议，任何兼容服务只要改 `OPENAI_BASE_URL` 与 `OPENAI_MODEL` 即可：

| 服务商 | `OPENAI_BASE_URL` | 模型 | 成本 |
| --- | --- | --- | --- |
| 智谱 BigModel | `https://open.bigmodel.cn/api/paas/v4` | `glm-4-flash-250414` | **输入/输出免费**（另有 `glm-4.7-flash` 等免费模型，高峰可能排队） |
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` | 极低，按量付费 |
| 硅基流动 | `https://api.siliconflow.cn/v1` | `tencent/Hunyuan-MT-7B` | 该模型免费；其它按量付费 |
| 阿里云百炼 | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen3.8-flash` | 新人每模型 100 万 Token / 90 天 |
| 火山方舟 | `https://ark.cn-beijing.volces.com/api/v3` | `doubao-seed-2.0-mini` | 约 ¥0.2/百万输入 Token |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` | 需境外网络与账户余额 |

「创建旅程」页面会调用 `POST /api/ai/journey-plan`，让模型从自然语言里提取
目的地与出发/返回时间；模型返回的字段名或结构有出入时，服务端会自动归一化
（兼容 `items` 数组、单对象、数组形式的目的地，以及 `departure_date` 等常见别名）。

### 需要代理时

部分网络环境无法直连 `api.openai.com`。Node 24+ 的原生 `fetch` 支持环境代理：

```bash
NODE_USE_ENV_PROXY=1
HTTP_PROXY=http://127.0.0.1:8889
HTTPS_PROXY=http://127.0.0.1:8889
NO_PROXY=127.0.0.1,localhost,::1,open.bigmodel.cn,api.deepseek.com
```

`NO_PROXY` 里的域名走直连，即使代理没启动也能用。

## 邮件与账户验证

注册只接受邮箱。账户创建后处于「待验证」状态，用户需要点击验证邮件里的链接
才会激活；未验证的账户无法登录。忘记密码时也通过邮件发送重置链接。

### 发送方式

| `RED_PANDA_MAIL_MODE` | 行为 |
| --- | --- |
| `log`（默认） | 把完整邮件写入 `data/outbox/*.eml`，并在 `data/server.log` 打印验证/重置链接。无需任何配置。 |
| `smtp` | 直接连接 SMTP 服务器发信，推荐用于真正收信。 |
| `command` | 把原始邮件通过管道交给 `RED_PANDA_MAIL_COMMAND`，例如 `msmtp -t`。 |
| `http` | 向 `RED_PANDA_MAIL_API_URL` 发送 JSON：`{from,to,subject,text,html}`；可带 `RED_PANDA_MAIL_API_KEY`。 |

默认的 `log` 模式**不会真的发邮件**，只把邮件写到 `data/outbox/`。
要真正收信，用 `smtp` 模式最简单。

### 用网易 126 / 163 发信

1. 登录网易邮箱网页版 →「设置」→「POP3/SMTP/IMAP」→ 开启 SMTP 服务。
2. 按提示生成一个**授权码**（不是邮箱登录密码）。
3. 写入 `.env`：

```bash
RED_PANDA_MAIL_MODE=smtp
RED_PANDA_SMTP_HOST=smtp.126.com      # 163 邮箱用 smtp.163.com
RED_PANDA_SMTP_PORT=465
RED_PANDA_SMTP_SECURE=1
RED_PANDA_SMTP_USER=you@126.com
RED_PANDA_SMTP_PASS=你的授权码
# 发件人留空时自动使用 SMTP_USER
RED_PANDA_MAIL_FROM="Red Panda <you@126.com>"
```

### 用 Gmail 发信

Gmail 要求**应用专用密码**（App Password），需要先开启两步验证：

```bash
RED_PANDA_MAIL_MODE=smtp
RED_PANDA_SMTP_HOST=smtp.gmail.com
RED_PANDA_SMTP_PORT=465
RED_PANDA_SMTP_SECURE=1
RED_PANDA_SMTP_USER=you@gmail.com
RED_PANDA_SMTP_PASS=16位应用专用密码
RED_PANDA_MAIL_FROM="Red Panda <you@gmail.com>"
```

> 如果邮件进了垃圾箱，请把发件人加入白名单，或配置 SPF/DKIM 后使用自己的域名发信。
> 网易/QQ 邮箱有时会拦截来自家用 IP 的邮件；必要时改用 587 端口 + STARTTLS
> （`RED_PANDA_SMTP_PORT=587`、`RED_PANDA_SMTP_SECURE=0`）。

### 验证 SMTP 配置

先直接发一封测试邮件（不会启动或重启服务）：

```bash
./scripts/test-mail.sh you@example.com
```

成功时会打印「已提交发送」；失败时会打印具体的 SMTP 错误。

再重启服务让注册/重置邮件生效：

```bash
./scripts/stop-server.sh
./scripts/start-server.sh
tail -n 20 data/server.log
```

启动横幅会显示 `邮件  smtp · smtp.126.com:465 · you@126.com`。
注册一个测试邮箱，或在看板里重发验证邮件，然后查看日志：
成功时不会再出现 `[mail:log]`，失败时会打印 `SMTP ... 失败` 的具体原因。

### 查看验证链接（log 模式）

```bash
ls -t data/outbox | head
tail -n 40 data/server.log | grep -E 'mail:log|链接'
```

日志里会出现类似：

```
[red-panda] [mail:log] → you@example.com · 激活你的小熊猫账户
[red-panda] [mail:log] 链接: http://192.168.10.65:8787/api/auth/verify?token=…
```

### 公开地址很重要

验证/重置链接里的域名来自 `RED_PANDA_PUBLIC_URL`；没有设置时会自动选择本机的
局域网地址。部署到公网时必须显式设置，例如：

```bash
RED_PANDA_PUBLIC_URL=https://red-panda.example.com
```

否则用户收到的链接会指向内网 IP，在手机上无法打开。

## 管理员令牌与看板

- 首次启动若未设置 `RED_PANDA_ADMIN_TOKEN`，会生成随机令牌并写入
  `data/admin-token`（权限 `600`）。
- 打开看板后输入令牌即可查看服务器状态、用户列表、旅程数量、最近请求等。
- 看板每 5 秒自动刷新。
- 令牌也可以直接用于调用管理接口：

```bash
curl -H "X-Admin-Token: $(cat data/admin-token)" \
  http://127.0.0.1:8787/api/admin/status
```

## 使用 systemd 常驻

`deploy/red-panda.service` 是一个模板。假设项目位于 `/opt/red-panda`，
用户为 `red-panda`：

1. 复制并修改服务单元：

   ```bash
   sudo cp deploy/red-panda.service /etc/systemd/system/red-panda.service
   sudo systemctl edit --full red-panda.service   # 按实际路径/用户修改
   ```

2. 启用并启动：

   ```bash
   sudo systemctl daemon-reload
   sudo systemctl enable --now red-panda
   sudo systemctl status red-panda
   journalctl -u red-panda -f          # 查看日志
   ```

3. 停止 / 重启：

   ```bash
   sudo systemctl stop red-panda
   sudo systemctl restart red-panda
   ```

> 用 systemd 时不要把 `RED_PANDA_ADMIN_TOKEN` 写进服务单元明文；
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
- 文件：`data/red-panda.db`（以及运行时的 `-wal` / `-shm` 旁文件）。
- 备份：停止服务后复制 `data/red-panda.db` 即可；运行中可用
  `sqlite3 data/red-panda.db ".backup 'backup.db'"`。
- 看板里的「数据库大小」为主库加 WAL 的实际占用。

数据表：

| 表 | 用途 |
| --- | --- |
| `users` | 用户账号、邮箱、scrypt 密码哈希、验证状态、登录/在线时间 |
| `sessions` | 会话令牌哈希与过期时间 |
| `email_verifications` | 待使用的邮箱验证令牌 |
| `password_resets` | 待使用的密码重置令牌 |
| `journeys`、`memories`、`memory_media` | 仅供旧版本数据迁移使用；客户端迁移成功后会删除对应账户的旧副本，新数据不会写入这些表 |

邮箱是唯一账户标识。升级时没有邮箱的旧账户会被删除；有邮箱账户的旧行程、回忆和个人偏好会在客户端登录后迁移到 IndexedDB，确认本地写入成功后清除服务端旧副本。

AI 调用次数等运行指标保存在内存中，服务重启后归零，不写入数据库。

> 删除 `data/` 会清空所有账号和管理员令牌（旅程与回忆保存在客户端，不受影响）。请先备份。

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
中的错误；也可先用 `RED_PANDA_AI_MOCK=1` 验证前端流程。

**收不到验证 / 重置邮件**
默认 `RED_PANDA_MAIL_MODE=log` 不会真的发信：链接在 `data/server.log` 和
`data/outbox/*.eml` 里。需要真实收信时配置 `RED_PANDA_MAIL_MODE=command`
（如 `msmtp`）或 `http`。同时确认 `RED_PANDA_PUBLIC_URL` 指向用户能访问的地址。

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
