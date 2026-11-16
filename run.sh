#!/usr/bin/env bash
cd "$(dirname "$0")"
. tools/python.sh
PORT=8765
BROWSER=1
ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --no-browser) BROWSER=0 ;;
    --port) PORT="$2"; ARGS+=("$1" "$2"); shift ;;
    --port=*) PORT="${1#--port=}"; ARGS+=("$1") ;;
    *) ARGS+=("$1") ;;
  esac
  shift
done
if [ "$PORT" = 8765 ]; then PID=server.pid; LOG=server.log; else PID="server_$PORT.pid"; LOG="server_$PORT.log"; fi
URL="http://127.0.0.1:$PORT"
if ! curl -s -o /dev/null "$URL/api/scenes"; then
  nohup "$PY" -u server.py "${ARGS[@]}" >> "$LOG" 2>&1 &
  echo $! > "$PID"
  for _ in $(seq 1 60); do curl -s -o /dev/null "$URL/api/scenes" && break; sleep 0.5; done
fi
echo "server: $URL (log: $(pwd)/$LOG, pid: $(cat "$PID" 2>/dev/null))"
[ "$BROWSER" = 0 ] || (nohup google-chrome "$URL" >/dev/null 2>&1 &)
