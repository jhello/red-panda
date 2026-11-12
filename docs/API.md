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
- **邮件限流**：同一 IP 10 分钟内最多触发 20 次注册 / 重发 / 找回操作，超出返回 `429`。

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
老版本用用户名注册的账户仍然可以用用户名登录。

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

也接受 `{ "username": "老用户名", "password": "…" }`，用于兼容旧账户。

响应 `200`：

```json
{
  "token": "…",
  "expiresAt": "2026-12-11T13:47:23.000Z",
  "user": {
    "id": 1,
    "email": "you@example.com",
    "displayName": "you",
    "username": "you@example.com",
    "emailVerified": true,
    "createdAt": "2026-11-11T13:47:23.000Z"
  }
}
```

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
    "displayName": "you",
    "username": "you@example.com",
    "emailVerified": true,
    "createdAt": "…"
  }
}
```

### `PUT /api/me/usual-origin`

需要认证。保存最多 20 个常用出发地。新客户端发送 `origins` 数组；旧版单地点对象仍可兼容：

```json
{ "origins": [{ "name": "家", "country": "中国", "city": "上海市", "district": "徐汇区", "street": "天钥桥路", "streetNumber": "88号" }] }
```

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

## 旅程

所有旅程接口都需要认证，且只能访问**自己**的旅程。

### `GET /api/journeys`

```json
{
  "journeys": [
    {
      "id": 1,
      "name": "东海之行",
      "description": "…",
      "created_at": "2026-11-11T13:40:00.000Z",
      "updated_at": "2026-11-11T13:41:00.000Z"
    }
  ]
}
```

按 `updated_at` 倒序排列。

### `POST /api/journeys`

```json
{ "name": "东海之行", "description": "从青丘出发……", "plan": { "items": [] } }
```

- `name`：1–80 字符，必填；
- `description`：最多 5000 字符，可省略；
- `plan`：可选，结构化行程（即 `POST /api/ai/journey-plan` 的结果）。

响应 `201`：

```json
{
  "journey": {
    "id": 1,
    "name": "东海之行",
    "description": "…",
    "plan": {
      "items": [{ "destination": "卢浮宫", "departTime": "2026-12-15T09:30", "returnTime": "2026-12-18T19:00" }],
      "departTime": "2026-12-15T09:30",
      "returnTime": "2026-12-18T19:00"
    },
    "depart_time": "2026-12-15T09:30",
    "return_time": "2026-12-18T19:00",
    "created_at": "…",
    "updated_at": "…"
  }
}
```

- `plan`：结构化行程；没有结构化数据时为 `null`；
- `depart_time` / `return_time`：整段行程的最早出发与最晚返回时间；列表按出发时间升序排列。

### `GET /api/journeys/:id`

响应 `200`：`{ "journey": { … } }`；不存在返回 `404`。

### `PUT /api/journeys/:id`

请求体同创建（`name` 必填，`description` 可选）。响应 `200`：
`{ "journey": { … } }`；不存在返回 `404`。

### `DELETE /api/journeys/:id`

成功返回 `204`；不存在返回 `404`。

---

## 回忆

「回忆」用来给**已经走过的行程**添上照片、视频和文字。媒体文件存在服务端
`data/uploads/<用户 id>/` 下，接口只返回元数据和访问链接。

### `GET /api/memories`

需要认证。列出回忆，`?journeyId=` 可以只看某一段行程的回忆。

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

- `counts`：每段行程的回忆数量，键是行程 id；
- `media[].kind`：`image` 或 `video`；
- `media[].url`：访问链接，`/api/media/<访问密钥>`。

### `POST /api/memories`

需要认证。新建一条回忆。

```json
{ "journeyId": 3, "note": "那天风很大。" }
```

- `journeyId`：可选，但必须是自己的一段行程；
- `note`：最多 2000 字符。

`note` 和 `journeyId` 至少要有一项，否则返回 `400`。

响应 `201`：`{ "memory": { … } }`。

### `DELETE /api/memories/:id`

需要认证。删除一条回忆，照片和视频文件会一起删除。成功返回 `204`；
不存在返回 `404`。

### `POST /api/memories/:id/media`

需要认证。上传一张照片或一段视频。**请求体就是文件本身**，
`Content-Type` 说明类型（`image/*` 或 `video/*`），单个文件上限 25 MB。

```bash
curl -s -X POST "$BASE/api/memories/1/media" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: image/png" \
  --data-binary @photo.png
```

响应 `201`：`{ "media": { … } }`。类型不支持返回 `415`，文件过大返回 `413`。

### `GET /api/media/:key`

按访问密钥取回照片 / 视频，**不需要登录**（密钥本身就是凭证，32 位随机十六进制）。
支持 `Range` 请求，视频可以拖动进度。

### `POST /api/ai/memory-recap`

需要认证。根据某段行程和它的回忆，生成一段旅行回忆文字。

```json
{ "journeyId": 3 }
```

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

# 创建旅程
curl -s -X POST "$BASE/api/journeys" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"东海之行","description":"从青丘出发。"}'

# 列出旅程
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

# 给走过的行程写一段回忆
curl -s -X POST "$BASE/api/memories" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"journeyId":1,"note":"那天风很大。"}'

# 上传一张照片
curl -s -X POST "$BASE/api/memories/1/media" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: image/png" \
  --data-binary @photo.png

# 让 AI 把回忆写成一段话
curl -s -X POST "$BASE/api/ai/memory-recap" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"journeyId":1}'

# 看板状态
curl -s "$BASE/api/admin/status" -H "X-Admin-Token: $(cat data/admin-token)"
```
