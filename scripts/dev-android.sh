#!/usr/bin/env bash
# Build, install, launch and (optionally) forward the server port over adb.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APK="$ROOT/build/android/red-panda.apk"

"$ROOT/scripts/build-android.sh"

if ! adb get-state >/dev/null 2>&1; then
  echo "没有已连接的设备。先执行 adb devices 查看，或重新配对无线调试。" >&2
  exit 1
fi

echo "==> 安装 APK"
adb install -r "$APK"

echo "==> 转发 8787 端口（手机可用 http://127.0.0.1:8787）"
adb reverse tcp:8787 tcp:8787 || true

echo "==> 启动应用"
adb shell am start -n com.redpanda.app/.MainActivity

echo ""
echo "已启动。查看日志: adb logcat | grep -i red-panda"
