#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PIDFILE="$ROOT/data/server.pid"

if [[ ! -f "$PIDFILE" ]]; then
  echo "服务未在运行（没有 PID 文件）"
  exit 0
fi

PID="$(cat "$PIDFILE")"
if ! kill -0 "$PID" 2>/dev/null; then
  echo "进程 $PID 已不存在，清理 PID 文件"
  rm -f "$PIDFILE"
  exit 0
fi

echo "正在停止服务 (PID $PID)…"
kill "$PID" 2>/dev/null || true
for _ in $(seq 1 25); do
  if ! kill -0 "$PID" 2>/dev/null; then
    rm -f "$PIDFILE"
    echo "服务已停止"
    exit 0
  fi
  sleep 0.2
done

echo "进程未在 5 秒内退出，强制结束"
kill -9 "$PID" 2>/dev/null || true
rm -f "$PIDFILE"
echo "服务已停止"
