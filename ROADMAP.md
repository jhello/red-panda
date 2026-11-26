# ROADMAP.md — 小熊猫 · Red Panda

## 当前阶段

已完成 **第 1、2、3 阶段（安全加固、模块化拆分、离线优先与媒体存储优化）** 的代码开发、自动化验证与 Android 真机回归；PR #2 复核中发现的问题已修复并提交，CI/CD 配置已补齐。下一步可确认是否开启第 4 阶段产品功能。

## 已完成

### 基线能力
- 零依赖 Node.js 22.5+ 服务端：邮箱注册/验证/登录/登出/改邮箱/改密码/重置密码、滑动会话、服务看板。
- 本地优先客户端（IndexedDB 按账号隔离）：行程管理、草稿箱、回忆图文视频记录、`.rpd` 压缩备份导入导出、中/英/德三语、浅色/深色主题。
- AI 代理（OpenAI 兼容 + mock）与高德 / Google 地图代理。

### 第 1 阶段：安全与稳定性加固（已验证）
- 拆分高德 / Google 地图的服务端 Key 与浏览器端 Key（`AMAP_BROWSER_KEY` / `GOOGLE_MAPS_BROWSER_KEY`，向下兼容回退）。
- 抽离统一限流器 `server/src/rate-limit.js`（支持 `RED_PANDA_TRUST_PROXY=1` 按可信代理跳数读取真实客户端 IP、小时级定时清理过期条目），新增 AI 与地图按用户限流。
- 密码哈希与校验升级为异步 `crypto.scrypt`（`hashPasswordAsync` / `verifyPasswordAsync`），兼容旧同步接口。

### 第 2 阶段：模块化拆分、AI 多语言与测试覆盖（已验证）
- 建立项目规范文档 `AGENTS.md` 与 `ROADMAP.md` 。
- 拆分 `server/src/app.js`（1482 → 366 行）为 `http-utils.js`、`rate-limit.js`、`static.js`、`routes/auth.js`、`routes/maps.js`、`routes/ai.js`。
- 拆分 `web/app.js`（6531 → 4925 行）与 `web/styles.css`（2872 → 1581 + 985 + 363 行），拆出 `web/js/i18n.js`、`storage.js`、`media.js`、`backup.js`、`sw-register.js` 与 `web/css/*`（保持零构建、兼容 `file://` WebView）。
- 让 AI 行程简介、行程计划、回忆生成提示词及 `mockRecap` 跟随 `zh / en / de` 三语设置，前端 AI 调用透传 `locale`。
- 新增 `server/test/security-and-i18n.test.js` 与 `server/test/web-modules.test.js`，自动化测试增至 65 个并全部通过。
- 新增 GitHub Actions 自动测试工作流 `.github/workflows/test.yml`（push / PR 自动执行前端语法检查与 `node --test`）。

### 第 3 阶段：离线优先与媒体存储优化（HTML5 / 模块层已验证）
- 新增 HTML5 Service Worker（`web/sw.js`）与注册脚本（`web/js/sw-register.js`），静态资源 Network-First 离线回退，`/api/*` 永不缓存，`file://` WebView 自动跳过。
- 回忆页新增默认开启的「压缩照片」选项与本地压缩模块（`web/js/media.js`），视频 / GIF / 小图原样保留。
- 数据与备份页接入 `navigator.storage.estimate()` 展示设备存储空间占用及 80%+ 警告提示。
- 前端与 Android 桥接层支持分块 Base64 流式备份写入，兼容旧 APK 单次 `saveBackup`。

### PR #2 复核修复（已验证）
- 反向代理下仅按 `RED_PANDA_TRUST_PROXY_HOPS` 从右向左采信 `X-Forwarded-For`，校验 IP 并忽略客户端可伪造的 `X-Real-IP`。
- 登录限流改为原子消费，避免并发请求绕过失败次数限制；新增并发登录测试。
- 地图浏览器 Key 不再在路由层回退到服务端 Key；未单独配置时启动告警，可用 `RED_PANDA_MAP_BROWSER_KEY_FALLBACK=0` 禁止回退。
- 修复导入备份 ID 注入、行程卡片属性未转义、导出按钮重入与 Android 备份桥并发竞态；导入选择器兼容 `.rpd` 的 `application/octet-stream` MIME。
- PNG / WebP 压缩保留透明通道；GitHub Actions 固定到具体 commit；`android:allowBackup` 设为 `false`。
- 修复 CSS 拆分后创建旅程背景图被解析到 `css/paintings/` 的回归：背景路径改为按 `document.baseURI` 解析，HTTP 与 `file://` WebView 均正常。
- 地图 Key 提示更明确：启动日志说明「未配置独立浏览器 Key」时已回退到服务端 Key；前端地图配置请求失败时透传真实错误，不再误报「未配置 Key」。
- 扩充文档（`.env.example`、`docs/API.md`）与测试，测试总数 65/65 通过。

### 备份导入导出体验修复（已验证）
- 导入 / 导出文件选择器限定 `.rpd`、`.json` 后缀与对应 MIME，Android 选择器中 `.apk`、`.jpg`、`.docx` 等无关文件不可选；Bridge 错误改为稳定错误码，前端统一通过 `t()` 本地化，消除 `导出失败：Save cancelled` 一类中英混杂文案。
- 移除导入前的系统 `confirm()`：选择文件后仅读取并比对，在按钮下方展示圆角确认卡片（文件、导入详情、取消 / 确认按钮），确认后才写入 IndexedDB；卡片文案与待导入统计随语言切换实时更新。
- 状态栏改为保存文案生成函数而非已渲染字符串，避免切换语言后残留 `Import cancelled` 等旧语言状态；导出取消、导入取消、导入完成状态均验证可随 zh/en/de 切换更新。
- `node --check`、66/66 自动化测试、`./scripts/build-android.sh` 与 `ELI AN00`（`192.168.10.51`）真机回归全部通过。

## 进行中 / 待验证

- [x] Android 端改动编译与真机验证：`./scripts/build-android.sh` 构建通过；手机完成登录、建行程、存回忆、AI 回忆、三语切换、数据页、导出 / 导入与备份桥并发测试，无崩溃或控制台错误。

## 待办（后续排期）

- [ ] 第 4 阶段：行程页「文件」收纳（门票 / 车票本地归档）。
- [ ] 第 4 阶段：回忆页生成社交分享卡片。
- [ ] 第 4 阶段：行程页「行程信息（天气 / 交通）」与「发现」页。

## 阻塞

- 无。CLA 检查由仓库所有者豁免，不作为阻塞项。

## 最近验证

- 2026-11-26：`node --check web/app.js web/js/i18n.js web/js/backup.js` 通过；`cd server && node --test` 通过（66/66）；`./scripts/build-android.sh` 构建通过。真机 `ELI AN00`（`192.168.10.51`）验证：Android 选择器过滤 `.apk` / `.jpg` / `.docx` 并允许 `.rpd`；导入确认卡片展示详情，取消不写库、确认后计数更新；zh/en/de 导出取消、导入取消、导入完成状态与确认卡片在切换语言后均无混语残留。
- 2026-11-26：`node --check web/*.js web/js/*.js` 通过；`cd server && node --test` 通过（65/65）；`./scripts/build-android.sh` 构建通过并在 `ELI AN00`（`192.168.10.51`）完成真机回归：登录、行程、回忆、AI mock、zh/en/de 切换、数据页、分块导出、文件导入、备份桥并发均正常，导出 `.rpd` 通过 `gzip -t`，创建旅程背景图在 `file://` WebView 中解析到 `file:///android_asset/www/paintings/athens.jpg` 且图片加载成功。
- 2026-11-26：用 `./scripts/start-server.sh` 恢复真实服务后 `/api/health` 返回 200；确认 `.env` 与 Key 文件仍可加载高德 / Google 服务端 Key，`/api/map/config` 在已登录用户下返回两把浏览器可用 Key。真机验证地图选择器：服务在线时高德地图加载成功且无「未配置 Key」提示；服务离线时显示「当前连不上服务器，请检查网络后重试」，恢复服务后再次加载正常。
