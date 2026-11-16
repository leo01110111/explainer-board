# Sourced by run.sh / share.sh: pick the Python that has the board's deps.
if [ -n "${BOARD_PYTHON:-}" ]; then PY="$BOARD_PYTHON"
elif [ -x "$PWD/.venv/bin/python" ]; then PY="$PWD/.venv/bin/python"
elif [ -x "$HOME/miniconda3/envs/explain-video/bin/python" ]; then PY="$HOME/miniconda3/envs/explain-video/bin/python"
else PY="$(command -v python3)"; fi
