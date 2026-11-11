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

## 状态码

| 状态码 | 含义 |
| --- | --- |
| `200` | 成功 |
| `201` | 创建成功 |
| `204` | 成功但无正文（登出、删除） |
| `400` | 参数不合法 |
| `401` | 未登录 / 令牌无效 / 管理员令牌无效 |
| `404` | 资源不存在 |
| `409` | 用户名已存在 |
| `429` | 登录尝试过多 |
| `502` / `503` / `504` | AI 上游错误 / 未配置 / 超时 |
| `500` | 服务器内部错误 |

---

## 健康检查

### `GET /api/health`

无需认证。

```json
{
  "ok": true,
  "service": "odyssey",
  "name": "山海经",
  "version": "1.0.0",
  "time": "2026-11-11T13:47:23.392Z"
}
```

---

## 账号

### `POST /api/auth/register`

注册并直接登录。

请求：

```json
{ "username": "旅人", "password": "password123" }
```

- 用户名：2–32 位中文、字母、数字、下划线或短横线；
- 密码：8–128 个字符。

响应 `201`：

```json
{
  "token": "…",
  "expiresAt": "2026-12-11T13:47:23.000Z",
  "user": { "id": 1, "username": "旅人", "createdAt": "2026-11-11T13:47:23.000Z" }
}
```

### `POST /api/auth/login`

请求：

```json
{ "username": "旅人", "password": "password123" }
```

响应 `200`：结构同注册。

### `POST /api/auth/logout`

需要认证。使当前令牌失效，返回 `204`。

### `GET /api/me`

需要认证。返回当前用户：

```json
{ "user": { "id": 1, "username": "旅人", "createdAt": "…" } }
```

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
{ "name": "东海之行", "description": "从青丘出发……" }
```

- `name`：1–80 字符，必填；
- `description`：最多 5000 字符，可省略。

响应 `201`：

```json
{ "journey": { "id": 1, "name": "东海之行", "description": "…", "created_at": "…", "updated_at": "…" } }
```

### `GET /api/journeys/:id`

响应 `200`：`{ "journey": { … } }`；不存在返回 `404`。

### `PUT /api/journeys/:id`

请求体同创建（`name` 必填，`description` 可选）。响应 `200`：
`{ "journey": { … } }`；不存在返回 `404`。

### `DELETE /api/journeys/:id`

成功返回 `204`；不存在返回 `404`。

---

## AI

需要认证。AI 未配置时返回 `503`（`ai_not_configured`）；
配置了 `ODYSSEY_AI_MOCK=1` 时返回离线假数据。

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

### `POST /api/ai/chat`

通用对话代理。

```json
{
  "system": "你是山海经世界的向导。",
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
    "name": "Odyssey",
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
    "dbPath": "/…/data/odyssey.db",
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
      "username": "旅人",
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

# 注册
curl -s -X POST "$BASE/api/auth/register" \
  -H 'Content-Type: application/json' \
  -d '{"username":"旅人","password":"password123"}'

# 登录并保存令牌
TOKEN=$(curl -s -X POST "$BASE/api/auth/login" \
  -H 'Content-Type: application/json' \
  -d '{"username":"旅人","password":"password123"}' | jq -r .token)

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

# 看板状态
curl -s "$BASE/api/admin/status" -H "X-Admin-Token: $(cat data/admin-token)"
```
