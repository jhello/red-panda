#!/usr/bin/env bash
# Build an installable debug APK without Gradle.
# Uses only the Android SDK build-tools + platform android.jar + JDK.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SDK="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-$HOME/Android/Sdk}}"
BUILD_TOOLS_VERSION="${BUILD_TOOLS_VERSION:-36.0.0}"
PLATFORM_VERSION="${PLATFORM_VERSION:-android-36}"
BT="$SDK/build-tools/$BUILD_TOOLS_VERSION"
ANDROID_JAR="$SDK/platforms/$PLATFORM_VERSION/android.jar"
APP_DIR="$ROOT/android/app/src/main"
OUT_DIR="$ROOT/build/android"

for tool in aapt2 d8 apksigner zipalign; do
  if [[ ! -x "$BT/$tool" ]]; then
    echo "缺少 Android SDK 工具: $BT/$tool" >&2
    echo "请先运行 ./scripts/install-android-sdk.sh，或设置 ANDROID_SDK_ROOT。" >&2
    exit 1
  fi
done
if [[ ! -f "$ANDROID_JAR" ]]; then
  echo "缺少 Android 平台: $ANDROID_JAR" >&2
  echo "请先运行 ./scripts/install-android-sdk.sh，或设置 ANDROID_SDK_ROOT。" >&2
  exit 1
fi
if [[ -n "${JAVA_HOME:-}" && -x "$JAVA_HOME/bin/javac" ]]; then
  export PATH="$JAVA_HOME/bin:$PATH"
fi
if ! command -v javac >/dev/null; then
  for candidate in /usr/lib/jvm/java-21-openjdk /usr/lib/jvm/java-17-openjdk /usr/lib/jvm/java-25-openjdk; do
    if [[ -x "$candidate/bin/javac" ]]; then
      export JAVA_HOME="$candidate"
      export PATH="$candidate/bin:$PATH"
      break
    fi
  done
fi
if ! command -v javac >/dev/null || ! command -v keytool >/dev/null; then
  echo "缺少 JDK 17+（javac / keytool）。Arch: sudo pacman -S jdk21-openjdk" >&2
  exit 1
fi
if ! command -v zip >/dev/null; then
  echo "缺少 zip。Arch: sudo pacman -S zip" >&2
  exit 1
fi

if [[ -n "${RED_PANDA_SERVER_URL+x}" ]]; then
  DEFAULT_SERVER="$RED_PANDA_SERVER_URL"
else
  LAN_IP="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{print $7; exit}' || true)"
  DEFAULT_SERVER="http://${LAN_IP:-127.0.0.1}:${PORT:-8787}"
fi

echo "==> 准备资源"
rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR/res" "$OUT_DIR/gen" "$OUT_DIR/classes" "$OUT_DIR/dex" "$OUT_DIR/assets/www"

# Shared web UI is the single source of truth.
cp -a "$ROOT/web/." "$OUT_DIR/assets/www/"
node -e '
const fs = require("node:fs");
const [server, file] = process.argv.slice(1);
fs.writeFileSync(file, `window.REDPANDA_CONFIG = ${JSON.stringify({ defaultServer: server, version: "1.0.0" }, null, 2)};\n`);
' "$DEFAULT_SERVER" "$OUT_DIR/assets/www/config.js"

# aapt2 needs a package attribute; AGP 9 wants it out of the source manifest.
sed 's/<manifest /<manifest package="com.redpanda.app" /' \
  "$APP_DIR/AndroidManifest.xml" > "$OUT_DIR/AndroidManifest.xml"

echo "==> 编译资源"
"$BT/aapt2" compile --dir "$APP_DIR/res" -o "$OUT_DIR/res.zip"
"$BT/aapt2" link \
  -o "$OUT_DIR/app-unsigned.apk" \
  -I "$ANDROID_JAR" \
  --manifest "$OUT_DIR/AndroidManifest.xml" \
  -R "$OUT_DIR/res.zip" \
  -A "$OUT_DIR/assets" \
  --java "$OUT_DIR/gen" \
  --auto-add-overlay \
  --min-sdk-version 26 \
  --target-sdk-version 36 \
  --version-code "${VERSION_CODE:-1}" \
  --version-name "${VERSION_NAME:-1.0.0}"

echo "==> 编译 Java"
mapfile -t SOURCES < <(find "$OUT_DIR/gen" "$APP_DIR/java" -name '*.java' -print)
javac -encoding UTF-8 -source 17 -target 17 \
  -classpath "$ANDROID_JAR" \
  -d "$OUT_DIR/classes" \
  "${SOURCES[@]}"

echo "==> D8 dex"
mapfile -t CLASSES < <(find "$OUT_DIR/classes" -name '*.class' -print)
"$BT/d8" --release --lib "$ANDROID_JAR" --min-api 26 \
  --output "$OUT_DIR/dex" "${CLASSES[@]}"

(
  cd "$OUT_DIR/dex"
  zip -q -j "$OUT_DIR/app-unsigned.apk" classes.dex
)

echo "==> 对齐与签名"
"$BT/zipalign" -f 4 "$OUT_DIR/app-unsigned.apk" "$OUT_DIR/app-aligned.apk"

KEYSTORE="${RED_PANDA_KEYSTORE:-$HOME/.red-panda/red-panda-dev.jks}"
mkdir -p "$(dirname "$KEYSTORE")"
if [[ ! -f "$KEYSTORE" ]]; then
  echo "    生成开发签名证书: $KEYSTORE"
  keytool -genkeypair \
    -keystore "$KEYSTORE" \
    -storepass red-panda \
    -keypass red-panda \
    -alias red-panda \
    -keyalg RSA \
    -keysize 2048 \
    -validity 10000 \
    -dname "CN=Red Panda Dev, OU=Red Panda, O=Red Panda, L=Local, ST=Local, C=CN" \
    >/dev/null 2>&1
fi

"$BT/apksigner" sign \
  --ks "$KEYSTORE" \
  --ks-key-alias red-panda \
  --ks-pass pass:red-panda \
  --key-pass pass:red-panda \
  --out "$OUT_DIR/red-panda.apk" \
  "$OUT_DIR/app-aligned.apk"

"$BT/apksigner" verify "$OUT_DIR/red-panda.apk" >/dev/null
rm -f "$OUT_DIR/app-aligned.apk"

echo ""
echo "完成: $OUT_DIR/red-panda.apk"
echo "默认服务器: $DEFAULT_SERVER"
echo "安装到已连接手机: adb install -r \"$OUT_DIR/red-panda.apk\""
echo "启动: adb shell am start -n com.redpanda.app/.MainActivity"
