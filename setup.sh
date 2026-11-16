#!/usr/bin/env bash
# Install everything the board needs into ./.venv and check it works.
#   bash setup.sh             install + verify
#   bash setup.sh --prefetch  also download the TTS and speech-to-text model weights now (~1.8 GB)
set -euo pipefail
cd "$(dirname "$0")"
PREFETCH=0; [ "${1:-}" = "--prefetch" ] && PREFETCH=1

missing=()
for c in ffmpeg; do command -v "$c" >/dev/null || missing+=("$c"); done
if [ ${#missing[@]} -gt 0 ]; then
  echo "Missing system packages: ${missing[*]}"
  echo "  Ubuntu/Debian: sudo apt-get install -y ffmpeg"
  echo "  macOS:         brew install ffmpeg"
  exit 1
fi

if command -v uv >/dev/null; then
  [ -x .venv/bin/python ] || uv venv --python 3.11 .venv
  uv pip install --python .venv/bin/python -r requirements.txt
  uv pip install --python .venv/bin/python pip  # spacy's model download uses pip
else
  PY=""
  for p in python3.12 python3.11 python3.10; do command -v "$p" >/dev/null && { PY="$p"; break; }; done
  [ -n "$PY" ] || { echo "Need Python 3.10-3.12 (or install uv: https://docs.astral.sh/uv/)"; exit 1; }
  [ -x .venv/bin/python ] || "$PY" -m venv .venv
  .venv/bin/python -m pip install -q --upgrade pip
  .venv/bin/python -m pip install -q -r requirements.txt
fi
.venv/bin/python -c "import spacy; spacy.util.get_package_path('en_core_web_sm')" 2>/dev/null \
  || .venv/bin/python -m spacy download en_core_web_sm

.venv/bin/python - <<'EOF'
import os, sys, espeakng_loader
if len(os.path.realpath(espeakng_loader.get_data_path())) >= 160:
    sys.exit("The repo path is too deep: espeak-ng (used by the TTS) cannot read data paths of 160+ characters.\n"
             "Clone the repo somewhere shorter (e.g. ~/explainer-board), delete .venv, and rerun setup.sh.")
import torch, numpy, soundfile, kokoro, faster_whisper, huggingface_hub
print("ok: python deps import; cuda available:", torch.cuda.is_available())
EOF

if [ "$PREFETCH" = 1 ]; then
  .venv/bin/python - <<'EOF'
from kokoro import KPipeline
from faster_whisper import WhisperModel
import torch
dev = "cuda" if torch.cuda.is_available() else "cpu"
pipe = KPipeline(lang_code="a", repo_id="hexgrad/Kokoro-82M", device=dev)
n = sum(len(a) for _, _, a in pipe("Setup works.", voice="af_heart", speed=0.88))
print("ok: kokoro synthesized", n, "samples on", dev)
for name, d, ct in (("medium.en", "cuda", "int8_float16"), ("small.en", "cpu", "int8")):
    if d == "cuda" and dev != "cuda":
        continue
    WhisperModel(name, device=d, compute_type=ct)
    print("ok: whisper", name, "on", d)
EOF
fi
echo "Setup done. Run: bash run.sh --project <name>"
