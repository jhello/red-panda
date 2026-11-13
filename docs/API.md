# HTTP API

服务端默认监听 `0.0.0.0:8787`。所有接口返回 JSON（`Content-Type:
application/json; charset=utf-8`），`204` 响应无正文。

## 约定

- **认证**：需要登录的接口带请求头
  `Authorization: Bearer <token>`。
- **管理员**：看板接口带 `X-Admin-Token: <token>`。
- **CORS**：API 允许任意来源，支持 `OPTIONS` 预检，方便 WebView 直接调用。
- **错误格式**：

  ```json
  { "error": "人类可读的中文说明", "code": "machine_code" }
  ```

- **登录限流**：同一 IP 10 分钟内最多失败 20 次，超出返回 `429`。
- **邮件限流**：同一 IP 10 分钟内最多触发 20 次注册 / 重发 / 找回操作（可用 `RED_PANDA_EMAIL_RATE_LIMIT` 调整），超出返回 `429`。

## 状态码

| 状态码 | 含义 |
| --- | --- |
| `200` | 成功 |
| `201` | 创建成功 |
| `204` | 成功但无正文（登出、删除、改密码） |
| `302` | 验证链接跳转回应用 |
| `400` | 参数不合法 / 验证或重置令牌无效 |
| `401` | 未登录 / 令牌无效 / 密码不正确 / 管理员令牌无效 |
| `403` | 邮箱尚未验证 |
| `404` | 资源不存在 |
| `409` | 邮箱已注册 |
| `410` | 该数据已迁移到客户端，服务端不再接收写入 |
| `429` | 尝试或邮件操作过多 |
| `502` / `503` / `504` | 邮件发送失败 / AI 未配置 / AI 超时 |
| `500` | 服务器内部错误 |

---

## 健康检查

### `GET /api/health`

无需认证。

```json
{
  "ok": true,
  "service": "red-panda",
  "name": "小熊猫",
  "version": "1.0.0",
  "time": "2026-11-11T13:47:23.392Z"
}
```

---

## 账号

账户以**邮箱**为唯一标识。注册后需要点击验证邮件里的链接激活，才能登录。
旧版本中不含邮箱、只能使用用户名登录的账户会在升级时被删除，服务端不再接受用户名登录。

### `POST /api/auth/register`

请求：

```json
{ "email": "you@example.com", "password": "password123" }
```

- 邮箱：合法的邮箱地址，长度 5–254；
- 密码：8–128 个字符。

响应 `201`（账户已创建，等待验证）：

```json
{
  "status": "pending_verification",
  "email": "you@example.com",
  "message": "验证邮件已发送，请查收并点击链接激活账户"
}
```

如果该邮箱已注册但尚未验证，会更新密码并重新发送验证邮件，返回 `200`，
结构同上。已验证的邮箱再次注册返回 `409`（`email_taken`）。

验证邮件里的链接指向 `GET /api/auth/verify?token=…`。验证成功或失败都会
`302` 跳转到：

- `/app/#/login?verified=1` — 验证成功；
- `/app/#/login?verify=invalid` — 令牌无效或已过期。

### `POST /api/auth/login`

请求：

```json
{ "email": "you@example.com", "password": "password123" }
```

邮箱是唯一登录标识，请求体里带 `username` 不再有效。

响应 `200`：

```json
{
  "token": "…",
  "expiresAt": "2026-12-11T13:47:23.000Z",
  "user": {
    "id": 1,
    "email": "you@example.com",
    "displayName": "",
    "emailVerified": true,
    "locale": "",
    "usualOrigin": [],
    "createdAt": "2026-11-11T13:47:23.000Z"
  }
}
```

`displayName`、`locale`、`usualOrigin` 只可能出现在尚未完成迁移的旧账户上；
客户端迁移完成后会通过 `DELETE /api/me/personal-data` 清除，之后以本机 IndexedDB 为准。

邮箱未验证时返回 `403`（`email_not_verified`），此时可以调用重发接口。

会话采用滑动过期：每次使用令牌都会把有效期续到 `RED_PANDA_SESSION_DAYS` 天之后，
所以只要还在使用就不会被登出；手动登出、修改密码或重置密码会立即失效。

### `POST /api/auth/resend-verification`

请求：

```json
{ "email": "you@example.com" }
```

无论邮箱是否存在都返回 `200`，避免泄露账户信息：

```json
{ "status": "ok", "message": "如果该邮箱存在且尚未验证，验证邮件已发送" }
```

### `POST /api/auth/forgot-password`

请求：

```json
{ "email": "you@example.com" }
```

已注册且已验证的账户会收到重置密码邮件；未验证的账户会收到验证邮件。
无论邮箱是否存在都返回 `200`：

```json
{ "status": "ok", "message": "如果该邮箱已注册，重置邮件已发送" }
```

### `POST /api/auth/reset-password`

请求：

```json
{ "token": "邮件链接里的令牌", "password": "newpassword123" }
```

成功返回 `204`，并让该用户所有现有会话失效。令牌无效、已使用或过期返回
`400`（`invalid_reset_token`）。

### `POST /api/auth/logout`

需要认证。使当前令牌失效，返回 `204`。

### `GET /api/me`

需要认证。返回当前用户：

```json
{
  "user": {
    "id": 1,
    "email": "you@example.com",
    "displayName": "",
    "emailVerified": true,
    "locale": "",
    "usualOrigin": [],
    "createdAt": "…",
    "pendingEmail": null,
    "pendingEmailExpiresAt": null,
    "pendingResetExpiresAt": null
  }
}
```

`pendingEmail` 是等待新邮箱验证的地址；`pendingResetExpiresAt` 是最近一次
密码重置邮件的有效期。

### `PUT /api/me/email`

需要认证。申请更换账户邮箱，会向新地址发送验证邮件。链接 24 小时内有效，
在验证完成前原邮箱仍然有效：

```json
{ "email": "new@example.com", "locale": "zh" }
```

响应 `200`：

```json
{ "pendingEmail": "new@example.com", "pendingEmailExpiresAt": "…" }
```

新邮箱已被其他账户使用返回 `409`（`email_taken`）。重复提交同一地址会重发并
延长有效期；提交当前邮箱会取消待验证的更换。

验证链接指向 `GET /api/auth/verify?token=…`，成功后跳转到
`/app/#/settings/account-security?emailChanged=1`。

### `POST /api/me/password-reset`

需要认证。向当前账户邮箱发送重置密码邮件，返回链接有效期：

```json
{ "pendingResetExpiresAt": "…" }
```

### `DELETE /api/me/personal-data`

需要认证。清除服务端为旧版本保留的个人数据副本：昵称、语言、常用出发地、
旅程、回忆和媒体文件。客户端确认本地写入成功后调用。返回 `204`。

### `PUT /api/me/profile`、`PUT /api/me/locale`、`PUT /api/me/usual-origin`

返回 `410`（`client_storage_only`）。昵称、界面语言和常用出发地现在保存在
客户端 IndexedDB。

### `POST /api/me/usual-origin/parse`

需要认证。把自然语言地点描述交给 AI 解析，请求 `{ "text": "上海市徐汇区天钥桥路88号" }`，返回结构化的 `origin` 对象。

### `POST /api/me/usual-origin/search` 和 `POST /api/me/usual-origin/reverse`

需要认证。通过 Photon（OpenStreetMap 数据）搜索地点候选，或按 `{ "lat": 31.18, "lon": 121.43, "locale": "zh" }` 反查附近地址。搜索请求使用 `{ "query": "上海体育场", "locale": "zh" }`，返回最多 6 个候选。地图图层使用 OpenStreetMap，需保留地图上的署名信息。

### `PUT /api/me/password`

需要认证。修改密码：

```json
{ "currentPassword": "password123", "newPassword": "newpassword123" }
```

- `newPassword`：8–128 个字符；
- 当前密码不正确返回 `401`（`invalid_password`）。

成功返回 `204`。当前会话保持有效，**其他设备上的会话全部失效**。

---

## 旅程（旧数据读取）

旅程、行程计划、出发和返回时间现在保存在客户端 IndexedDB。以下读取接口
只用于把旧版本服务端数据迁移到客户端；迁移完成后客户端会删除服务端副本。

### `GET /api/journeys`

需要认证。返回该账户在旧版本中的旅程：

```json
{
  "journeys": [
    {
      "id": 1,
      "name": "东海之行",
      "description": "…",
      "plan": null,
      "depart_time": "",
      "return_time": "",
      "created_at": "2026-11-11T13:40:00.000Z",
      "updated_at": "2026-11-11T13:41:00.000Z"
    }
  ]
}
```

按 `depart_time` 升序排列。

### `GET /api/journeys/:id`

需要认证。返回 `{ "journey": { … } }`；不存在返回 `404`。

### `POST /api/journeys`、`PUT /api/journeys/:id`、`DELETE /api/journeys/:id`

返回 `410`（`client_storage_only`）。服务端不再保存或删除旅程。

---

## 回忆（旧数据读取）

「回忆」用来给**已经走过的行程**添上照片、视频和文字。文字、照片、视频和
元数据现在保存在客户端 IndexedDB，实际文件以 Blob 形式存放。

### `GET /api/memories`

需要认证。返回旧版本保存的回忆，`?journeyId=` 可以只看某一段行程：

```json
{
  "memories": [
    {
      "id": 1,
      "journeyId": 3,
      "note": "那天风很大，狐狸在墙头看我。",
      "createdAt": "2026-11-12T11:16:00.000Z",
      "media": [
        {
          "id": 1,
          "memoryId": 1,
          "kind": "image",
          "mime": "image/png",
          "size": 104180,
          "url": "/api/media/d85a5dcf6d9b98b265450299046d45de",
          "createdAt": "2026-11-12T11:16:00.000Z"
        }
      ]
    }
  ],
  "counts": { "3": 1 }
}
```

### `GET /api/media/:key`

按访问密钥取回旧版本保存的照片 / 视频，**不需要登录**。迁移时客户端会把
文件下载成 Blob，完成后再删除服务端文件。新上传不会写入这里。

### `POST /api/memories`、`DELETE /api/memories/:id`、`POST /api/memories/:id/media`

返回 `410`（`client_storage_only`）。回忆和媒体现在由客户端管理。

### `POST /api/ai/memory-recap`

需要认证。根据客户端提供的临时上下文生成旅行回忆文字，服务端不会保存这些内容：

```json
{
  "journeyId": 3,
  "context": {
    "journeyName": "东海之行",
    "destination": "东海",
    "departTime": "2026-11-01T09:00",
    "returnTime": "2026-11-03T18:00",
    "photos": 2,
    "videos": 0,
    "notes": ["海面有光"]
  }
}
```

`journeyId` 仍需是整数；传入 `context` 时不会再读取服务端旅程表。

响应 `200`：

```json
{
  "recap": "「雅典卫城」这一路，你留下了 1 张照片、1 句写给这趟行程的话……",
  "model": "gpt-4o-mini",
  "mock": false
}
```

AI 未配置时返回 `503`（`ai_not_configured`）。

---

## AI

需要认证。AI 未配置时返回 `503`（`ai_not_configured`）；
配置了 `RED_PANDA_AI_MOCK=1` 时返回离线假数据。

### `POST /api/ai/journey-description`

根据旅程名称生成一段中文简介。

```json
{ "name": "东海之行", "hint": "写得更神秘一些" }
```

- `name`：1–80 字符，必填；
- `hint`：最多 300 字符，可选。

响应 `200`：

```json
{
  "description": "自东海启程，……",
  "model": "gpt-4o-mini",
  "mock": false
}
```

### `POST /api/ai/journey-plan`

把一段旅行想法交给大模型，由它分析提取「目的地」「出发时间」「返回时间」，
供「创建旅程」页面渲染成可编辑的表格。

```json
{ "prompt": "想去卢浮宫，雅典卫城还是新天鹅堡？" }
```

- `prompt`：1–500 字符，必填。

响应 `200`：

```json
{
  "items": [
    {
      "destination": "卢浮宫",
      "departTime": "2026-12-01T09:30",
      "returnTime": "2026-12-03T19:00"
    }
  ],
  "model": "gpt-4o-mini",
  "mock": false
}
```

- `items`：按行程顺序排列，每项包含 `destination`、`departTime`、`returnTime`；
  时间形如 `YYYY-MM-DDTHH:mm`，模型无法确定时为空字符串；
- `mock`：`true` 表示服务端处于 `RED_PANDA_AI_MOCK=1` 离线模式。

### `POST /api/ai/chat`

通用对话代理。

```json
{
  "system": "你是「小熊猫」旅程应用的向导。",
  "messages": [
    { "role": "user", "content": "给我讲讲青丘之狐。" }
  ]
}
```

- `messages`：1–20 条；`role` 为 `system` / `user` / `assistant`；
  单条内容 1–4000 字符；
- `system`：可选，最多 2000 字符，会作为第一条消息插入。

响应 `200`：

```json
{
  "content": "……",
  "model": "gpt-4o-mini",
  "usage": { "prompt_tokens": 30, "completion_tokens": 80, "total_tokens": 110 },
  "mock": false
}
```

---

## 管理员看板

### `GET /api/admin/status`

请求头：`X-Admin-Token: <data/admin-token 的内容>`。

响应 `200`（节选）：

```json
{
  "server": {
    "name": "Red Panda",
    "version": "1.0.0",
    "startedAt": "2026-11-11T13:47:21.582Z",
    "uptimeSeconds": 12,
    "hostname": "jhello-archlinux",
    "platform": "Linux 6.18.60-1-lts",
    "arch": "x64",
    "node": "v26.13.0",
    "pid": 24446,
    "host": "0.0.0.0",
    "port": 8787,
    "urls": [
      { "name": "localhost", "url": "http://127.0.0.1:8787" },
      { "name": "wlan0", "url": "http://192.168.10.65:8787" }
    ],
    "memory": { "rss": 68411392, "heapUsed": 8795912, "heapTotal": 12582912 },
    "loadavg": [1.71, 1.68, 1.57],
    "cpuCount": 8,
    "dbPath": "/…/data/red-panda.db",
    "dbSizeBytes": 40960
  },
  "ai": { "configured": false, "mock": false, "model": "gpt-4o-mini", "baseUrl": "https://api.openai.com/v1" },
  "stats": {
    "users": 2,
    "journeys": 1,
    "activeSessions": 2,
    "requestsTotal": 12,
    "requestsByStatus": { "200": 10, "401": 2 },
    "aiCalls": 0
  },
  "users": [
    {
      "id": 1,
      "username": "you@example.com",
      "email": "you@example.com",
      "displayName": "you",
      "emailVerified": true,
      "createdAt": "…",
      "lastLoginAt": "…",
      "lastSeenAt": "…",
      "journeyCount": 1,
      "online": true
    }
  ],
  "requests": [
    { "time": "…", "method": "GET", "path": "/api/journeys", "status": 200, "ms": 3, "ip": "::1" }
  ]
}
```

`online` 表示最近 5 分钟内有活动。`requests` 为最近请求（最多 60 条，
倒序）。

---

## 静态页面

| 路径 | 内容 |
| --- | --- |
| `GET /` | 服务看板（需在页面输入管理员令牌） |
| `GET /dashboard/*` | 看板静态资源 |
| `GET /app/` | HTML5 客户端（与 Android 共用） |
| `GET /app/*` | 前端静态资源 |
| `GET /favicon.ico` | 图标 |
| `GET /api/*` | 未匹配的 API 返回 `404` |

## curl 示例

```bash
BASE=http://127.0.0.1:8787

# 注册（之后去收件箱点击验证链接）
curl -s -X POST "$BASE/api/auth/register" \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com","password":"password123"}'

# 登录并保存令牌
TOKEN=$(curl -s -X POST "$BASE/api/auth/login" \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com","password":"password123"}' | jq -r .token)

# 修改密码
curl -s -X PUT "$BASE/api/me/password" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"currentPassword":"password123","newPassword":"newpassword123"}'

# 忘记密码（邮件会写入 data/outbox 或通过配置的渠道发送）
curl -s -X POST "$BASE/api/auth/forgot-password" \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com"}'

# 申请更换账户邮箱（去新邮箱点击验证链接）
curl -s -X PUT "$BASE/api/me/email" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"email":"new@example.com"}'

# 迁移完成、确认客户端已写入后，清除服务端旧副本
curl -s -X DELETE "$BASE/api/me/personal-data" -H "Authorization: Bearer $TOKEN"

# 读取旧版本旅程（只读，供客户端迁移）
curl -s "$BASE/api/journeys" -H "Authorization: Bearer $TOKEN"

# 生成描述（需配置 AI 或 mock）
curl -s -X POST "$BASE/api/ai/journey-description" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"东海之行"}'

# 让大模型分析旅行想法，提取目的地与时间
curl -s -X POST "$BASE/api/ai/journey-plan" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"想去卢浮宫，雅典卫城还是新天鹅堡？"}'

# 让 AI 把本机回忆写成一段话（内容只作为一次性上下文发送）
curl -s -X POST "$BASE/api/ai/memory-recap" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"journeyId":1,"context":{"journeyName":"东海之行","photos":1,"videos":0,"notes":["那天风很大。"]}}'

# 看板状态
curl -s "$BASE/api/admin/status" -H "X-Admin-Token: $(cat data/admin-token)"
```
