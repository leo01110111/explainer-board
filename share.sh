#!/usr/bin/env bash
# Share your board questions to the public Hugging Face dataset (see tools/share.py).
cd "$(dirname "$0")"
PY="$HOME/miniconda3/envs/explain-video/bin/python"
[ -x "$PY" ] || PY=python3
if ! "$PY" -c "import huggingface_hub" 2>/dev/null; then
  echo "Installing huggingface_hub..."; "$PY" -m pip install -q huggingface_hub || exit 1
fi
if ! "$PY" -c "from huggingface_hub import HfApi; HfApi().whoami()" >/dev/null 2>&1; then
  echo "Log in to Hugging Face first (free account; token needs WRITE access):"
  HF="$(dirname "$PY")/hf"; [ -x "$HF" ] || HF=hf
  "$HF" auth login || exit 1
fi
exec "$PY" tools/share.py "$@"
