#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PIDFILE="$ROOT/data/server.pid"

if [[ -f "$ROOT/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  . "$ROOT/.env"
  set +a
fi
PORT="${PORT:-8787}"

if [[ -f "$PIDFILE" ]] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  echo "运行中 (PID $(cat "$PIDFILE"))"
else
  echo "未运行"
fi

echo -n "健康检查: "
curl -fsS --max-time 3 "http://127.0.0.1:$PORT/api/health" || echo "无法连接 127.0.0.1:$PORT"
echo ""
