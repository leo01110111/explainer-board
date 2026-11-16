#!/usr/bin/env bash
# usage: PORT=8765 shot.sh scene beat   (screenshot of one beat from a running server)
out="${OUT_DIR:-$(dirname "$0")}/${1}_b${2}.png"
port="${PORT:-8765}"
timeout 60 google-chrome --headless=new --disable-gpu --hide-scrollbars --user-data-dir="${TMPDIR:-/tmp}/board_chprof_${port}_$1_$2" --screenshot="$out" --window-size=1600,1062 --virtual-time-budget=6000 "http://127.0.0.1:$port/?scene=$1&beat=$2&autoplay=0" >/dev/null 2>&1
echo "$out"
