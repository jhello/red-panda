#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA="$ROOT/data"
PIDFILE="$DATA/server.pid"
LOG="$DATA/server.log"

mkdir -p "$DATA"

if [[ -f "$PIDFILE" ]] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  echo "服务已在运行 (PID $(cat "$PIDFILE"))"
  exit 0
fi

if [[ -f "$ROOT/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  . "$ROOT/.env"
  set +a
fi

cd "$ROOT"
nohup node server/src/server.js >>"$LOG" 2>&1 &
PID=$!
echo "$PID" >"$PIDFILE"

sleep 1
if kill -0 "$PID" 2>/dev/null; then
  echo "服务已启动 (PID $PID)"
  echo "日志: $LOG"
  grep -E '控制台|HTML5 应用|管理员令牌|AI' "$LOG" | tail -5 || true
else
  echo "启动失败，最近日志：" >&2
  tail -30 "$LOG" >&2
  rm -f "$PIDFILE"
  exit 1
fi
