# ROADMAP.md — 小熊猫 · Red Panda

## 当前阶段

已完成 **第 1、2、3 阶段（安全加固、模块化拆分、离线优先与媒体存储优化）** 的代码开发与服务端 / 前端模块自动化验证；等待确认是否补齐 CI/CD 配置与开启第 4 阶段产品功能。

## 已完成

### 基线能力
- 零依赖 Node.js 22.5+ 服务端：邮箱注册/验证/登录/登出/改邮箱/改密码/重置密码、滑动会话、服务看板。
- 本地优先客户端（IndexedDB 按账号隔离）：行程管理、草稿箱、回忆图文视频记录、`.rpd` 压缩备份导入导出、中/英/德三语、浅色/深色主题。
- AI 代理（OpenAI 兼容 + mock）与高德 / Google 地图代理。

### 第 1 阶段：安全与稳定性加固（已验证）
- 拆分高德 / Google 地图的服务端 Key 与浏览器端 Key（`AMAP_BROWSER_KEY` / `GOOGLE_MAPS_BROWSER_KEY`，向下兼容回退）。
- 抽离统一限流器 `server/src/rate-limit.js`（支持 `RED_PANDA_TRUST_PROXY=1` 读取真实客户端 IP、小时级定时清理过期条目），新增 AI 与地图按用户限流。
- 密码哈希与校验升级为异步 `crypto.scrypt`（`hashPasswordAsync` / `verifyPasswordAsync`），兼容旧同步接口。

### 第 2 阶段：模块化拆分、AI 多语言与测试覆盖（已验证）
- 建立项目规范文档 `AGENTS.md` 与 `ROADMAP.md` 。
- 拆分 `server/src/app.js`（1482 → 366 行）为 `http-utils.js`、`rate-limit.js`、`static.js`、`routes/auth.js`、`routes/maps.js`、`routes/ai.js`。
- 拆分 `web/app.js`（6531 → 4925 行）与 `web/styles.css`（2872 → 1581 + 985 + 363 行），拆出 `web/js/i18n.js`、`storage.js`、`media.js`、`backup.js`、`sw-register.js` 与 `web/css/*`（保持零构建、兼容 `file://` WebView）。
- 让 AI 行程简介、行程计划、回忆生成提示词及 `mockRecap` 跟随 `zh / en / de` 三语设置，前端 AI 调用透传 `locale`。
- 新增 `server/test/security-and-i18n.test.js` 与 `server/test/web-modules.test.js`，自动化测试增至 62 个并全部通过。
- 新增 GitHub Actions 自动测试工作流 `.github/workflows/test.yml`（push / PR 自动执行前端语法检查与 `node --test`）。

### 第 3 阶段：离线优先与媒体存储优化（HTML5 / 模块层已验证）
- 新增 HTML5 Service Worker（`web/sw.js`）与注册脚本（`web/js/sw-register.js`），静态资源 Network-First 离线回退，`/api/*` 永不缓存，`file://` WebView 自动跳过。
- 回忆页新增默认开启的「压缩照片」选项与本地压缩模块（`web/js/media.js`），视频 / GIF / 小图原样保留。
- 数据与备份页接入 `navigator.storage.estimate()` 展示设备存储空间占用及 80%+ 警告提示。
- 前端与 Android 桥接层支持分块 Base64 流式备份写入，兼容旧 APK 单次 `saveBackup`。

## 进行中 / 待验证

- [ ] Android 端改动编译验证（[MainActivity.java](file:///Users/aideihua/project/red-panda/android/app/src/main/java/com/redpanda/app/MainActivity.java) ：仅 debug 构建开启 WebView 调试 + 分块流式备份写入）：代码已改，因本机未安装 Android SDK，待有 SDK 环境执行 `./scripts/build-android.sh` 验证。

## 待办（后续排期）

- [ ] 第 4 阶段：行程页「文件」收纳（门票 / 车票本地归档）。
- [ ] 第 4 阶段：回忆页生成社交分享卡片。
- [ ] 第 4 阶段：行程页「行程信息（天气 / 交通）」与「发现」页。

## 阻塞

- 本机缺少 `~/Android/Sdk`，暂无法现场编译 APK 验证 Android Java 代码。

## 最近验证

- 2026-11-26：`node --check web/*.js web/js/*.js` 通过；`cd server && node --test` 通过（62/62，耗时 674ms）。
