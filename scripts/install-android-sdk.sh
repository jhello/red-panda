#!/usr/bin/env bash
# Install the Android SDK command-line tools, platform 36 and build-tools 36.
set -euo pipefail

SDK="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-$HOME/Android/Sdk}}"
CMDLINE_VERSION="${CMDLINE_VERSION:-13114758}"

if ! command -v java >/dev/null; then
  echo "需要 JDK 17+。Arch: sudo pacman -S jdk17-openjdk" >&2
  exit 1
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "==> 下载 Android command-line tools ($CMDLINE_VERSION)"
curl -fL "https://dl.google.com/android/repository/commandlinetools-linux-${CMDLINE_VERSION}_latest.zip" \
  -o "$TMP/tools.zip"
unzip -q "$TMP/tools.zip" -d "$TMP"

mkdir -p "$SDK/cmdline-tools"
rm -rf "$SDK/cmdline-tools/latest"
mv "$TMP/cmdline-tools" "$SDK/cmdline-tools/latest"

export ANDROID_SDK_ROOT="$SDK"
export ANDROID_HOME="$SDK"
SDKMANAGER="$SDK/cmdline-tools/latest/bin/sdkmanager"

echo "==> 接受许可并安装 platform-tools / android-36 / build-tools 36.0.0"
yes | "$SDKMANAGER" --sdk_root="$SDK" --licenses >/dev/null || true
"$SDKMANAGER" --sdk_root="$SDK" \
  "platform-tools" \
  "platforms;android-36" \
  "build-tools;36.0.0"

echo ""
echo "SDK 已安装到: $SDK"
echo "现在可以运行: ./scripts/build-android.sh"
