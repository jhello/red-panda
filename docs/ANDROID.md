# Android 客户端指南

Android 端是一个很薄的 **WebView 外壳**：原生代码只负责窗口、系统栏、
返回键和调试开关，真正的界面是 `web/` 里的同一套 HTML/CSS/JS。
因此改界面只需要改 `web/`，再重新构建 APK。

- 包名：`com.odyssey.app`
- 应用名：**山海经**
- 最低版本：Android 8.0（API 26）
- 目标版本：Android 16（API 36）

## 一、准备环境（Arch Linux）

1. 安装 JDK 17+、`zip`、`adb`：

   ```bash
   sudo pacman -S jdk21-openjdk zip android-tools
   ```

2. 安装 Android SDK（command-line tools + platform 36 + build-tools 36）：

   ```bash
   ./scripts/install-android-sdk.sh
   ```

   默认装到 `~/Android/Sdk`。如果装在别处，设置：

   ```bash
   export ANDROID_SDK_ROOT=/path/to/Android/Sdk
   ```

3. 把 `adb` 加入 PATH（`android-tools` 通常已处理），确认：

   ```bash
   adb version
   javac -version
   ```

> 构建脚本会自动寻找 JDK 21/17/25；若 `java` 默认不是 17+，脚本会切到
> `/usr/lib/jvm/java-21-openjdk`。也可以显式设置 `JAVA_HOME`。

## 二、构建 APK

```bash
./scripts/build-android.sh
```

产物：`build/android/odyssey.apk`（已用开发证书签名）。

脚本做了什么：

1. 把 `web/` 复制到构建目录的 `assets/www/`；
2. 生成 `config.js`，写入**默认服务器地址**；
3. 用 `aapt2` 编译/链接资源；
4. `javac` 编译 Java，`d8` 生成 `classes.dex`；
5. `zipalign` 对齐，`apksigner` 签名。

### 指定默认服务器地址

默认地址取构建时本机的局域网 IP（`http://<IP>:8787`）。也可以覆盖：

```bash
ODYSSEY_SERVER_URL=http://192.168.10.65:8787 ./scripts/build-android.sh
```

或用 `PORT` 改变端口：

```bash
PORT=9000 ./scripts/build-android.sh
```

> 构建时写死的只是**默认值**。安装后仍可在应用内「服务器设置」里修改，
> 地址保存在手机本地，不需要重新打包。

### 自定义签名

默认使用 `~/.odyssey/odyssey-dev.jks`（首次构建自动生成，密码都是
`odyssey`）。要换证书：

```bash
ODYSSEY_KEYSTORE=/path/to/release.jks ./scripts/build-android.sh
```

生产分发请使用你自己的 release 证书，并妥善保管。

## 三、安装与启动

手机用 USB 或 Wi-Fi ADB 连接后：

```bash
# 只安装
adb install -r build/android/odyssey.apk

# 启动
adb shell am start -n com.odyssey.app/.MainActivity

# 一条龙：构建 + 安装 + 端口转发 + 启动
./scripts/dev-android.sh
```

## 四、Wi-Fi ADB 配对与调试

Android 11+ 支持无线调试，不需要数据线。

### 1. 手机端开启无线调试

1. 设置 → 关于手机 → 连续点击「版本号」7 次，开启开发者选项。
2. 设置 → 系统 → 开发者选项 → 打开 **无线调试**。
3. 手机与电脑连接**同一个 Wi-Fi**。
4. 进入「无线调试」→「使用配对码配对设备」，记下：
   - 配对码（6 位数字）
   - IP 地址和端口（配对端口，每次不同）

### 2. 电脑端配对

```bash
adb pair <手机IP>:<配对端口>
# 按提示输入 6 位配对码
```

配对成功后连接（端口是「无线调试」主页显示的**连接端口**，不是配对端口）：

```bash
adb connect <手机IP>:<连接端口>
adb devices
```

看到类似下面即成功：

```
adb-ACMMVB4515012175-PkOAyY._adb-tls-connect._tcp    device
```

> 不同机型端口每次可能变化。断开重连后若 `adb devices` 显示
> `offline`，重新 `adb connect` 即可。手机重启后通常需要重新配对。

### 3. 安装、启动、看日志

```bash
adb install -r build/android/odyssey.apk
adb shell am start -n com.odyssey.app/.MainActivity

# 应用日志
adb logcat | grep -i odyssey

# 只看崩溃
adb logcat -b crash
```

### 4. 调试 WebView 界面（Chrome DevTools）

应用已开启 WebView 调试。步骤：

1. 手机打开应用。
2. 电脑 Chrome 访问 `chrome://inspect`。
3. 找到 `com.odyssey.app` 的 WebView，点击 **inspect**。

如果没有出现设备，先做端口转发：

```bash
# 找到 WebView 的 devtools socket
adb shell cat /proc/net/unix | grep webview_devtools

# 转发到本地 9222
adb forward tcp:9222 localabstract:webview_devtools_remote_<PID>
```

然后在 Chrome 打开 `chrome://inspect`，或直接用 CDP 调试
（`http://127.0.0.1:9222/json`）。PID 可在
`adb shell pidof com.odyssey.app` 查到。

### 5. 端口转发（推荐用于调试）

如果手机和电脑网络不通，或想固定用 `127.0.0.1`：

```bash
adb reverse tcp:8787 tcp:8787
```

这样手机访问 `http://127.0.0.1:8787` 会转发到电脑的 8787 端口。
在应用「服务器设置」里填 `http://127.0.0.1:8787` 即可。
`dev-android.sh` 会自动执行这一步。

> `adb reverse` 在拔线/重连后失效，需要重新执行。

## 五、应用内服务器设置

首次打开（尚未配置服务器）会显示设置页：

1. 填入服务器地址，例如 `http://192.168.10.65:8787`；
2. 保存后会测试连接；
3. 地址保存在本地，之后可随时在首页「服务器设置」修改。

登录状态保存在 WebView 的本地存储里：退出应用或重启手机后再打开，仍会
保持登录，直到在「设置」里手动退出。服务器暂时连不上时，应用会停留在
原来的页面（首页、设置等），请求失败时弹出提示，而不会跳转到「连不上
服务器」的错误页。

注意：

- 必须是 `http://` 或 `https://` 开头的完整地址；
- 端口要与服务端一致；
- 手机与服务器需在同一网络，或已做 `adb reverse`。

## 六、用 Gradle 构建（可选）

仓库也包含 Gradle 工程，适合用 Android Studio 打开或做正式发布构建：

```bash
cd android
./gradlew assembleDebug
```

Gradle 构建会在 `preBuild` 阶段把 `../web` 复制进 assets，并可通过
属性指定默认服务器：

```bash
./gradlew assembleDebug -PodysseyServer=http://192.168.10.65:8787
```

> 没有提交 `gradlew` 时，可用系统 Gradle，或在 Android Studio 中打开
> `android/` 目录自动同步。日常快速迭代推荐用 `build-android.sh`
> （不依赖 Gradle 和网络）。

## 七、常见问题

**`adb devices` 看不到手机**
- 确认手机和电脑在同一 Wi-Fi；
- 重新执行 `adb pair` / `adb connect`；
- `adb kill-server && adb start-server` 后再试；
- 部分路由器开启了「AP 隔离」，会阻止设备互访，需要在路由器关闭。

**安装报 `INSTALL_FAILED_UPDATE_INCOMPATIBLE`**
签名不一致。先卸载再装：

```bash
adb uninstall com.odyssey.app
adb install build/android/odyssey.apk
```

**应用白屏**
- 多半是服务器地址不对或服务未启动；
- 先在手机浏览器打开 `http://<电脑IP>:8787/app/` 验证；
- 用 `adb logcat | grep -i odyssey` 看错误。

**改完界面没变化**
Android 构建会把 `web/` 复制进 APK，需要重新
`./scripts/build-android.sh` 并安装。HTML5 版（`/app/`）刷新即可。

**构建提示缺少 SDK 工具**
运行 `./scripts/install-android-sdk.sh`，或检查
`ANDROID_SDK_ROOT` 下是否有 `build-tools/36.0.0` 与
`platforms/android-36`。

## 八、未来上 iOS / 纯 HTML5

- **HTML5**：直接用手机/电脑浏览器访问 `http://<服务器>:8787/app/`，
  功能与 Android 端完全一致。
- **iOS**：新建一个 Swift `WKWebView` 工程，加载同一个 `web/` 目录
  （打包进 App 或指向服务器 `/app/`），保留相同的原生外壳职责
  （系统栏、返回手势、调试开关）。业务代码无需重写。
