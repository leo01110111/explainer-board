# Agent guide: Explainer Board

You are working in the Explainer Board repo: a browser player for narrated, live-animated math explainers.
Read [SPEC.md](SPEC.md) for the scene format and server API before writing scenes.

## 1. Install (do this first on a new machine)

```bash
# the only system package: ffmpeg (converts recorded questions to 16 kHz WAV). macOS: brew install ffmpeg
sudo apt-get install -y ffmpeg
bash setup.sh --prefetch     # creates ./.venv, installs requirements.txt + spaCy en_core_web_sm,
                             # downloads Kokoro TTS and Whisper weights (~1.8 GB), checks they load
```

- Needs Python 3.10-3.12 (kokoro does not support 3.13). `setup.sh` uses `uv` if present, else `python3.1x -m venv`.
- If `sudo` is not available, stop and ask the user to install ffmpeg; do not try to build it.
- espeak-ng (used by the TTS for unknown words) and libsndfile come bundled with the pip packages.
- A GPU is optional. With CUDA: TTS on GPU, Whisper `medium.en`. Without: everything falls back to CPU and Whisper `small.en`.
- `run.sh` and `share.sh` pick Python in this order: `$BOARD_PYTHON`, `./.venv`, `~/miniconda3/envs/explain-video`, `python3`.

Verify the install:

```bash
bash run.sh --project <name> --port 8765 --no-browser
curl -s http://127.0.0.1:8765/api/scenes | head -c 200          # scene list
curl -s -o /tmp/t.wav "http://127.0.0.1:8765/api/tts?text=Hello" && file /tmp/t.wav   # WAV audio
tail server.log                                                  # "kokoro loaded on ...", "whisper ... loaded"
```

## 2. Layout

- Tool (tracked): `server.py`, `run.sh`, `setup.sh`, `share.sh`, `static/` (player), `tools/`.
- `projects/` is **gitignored**: each user's explainers. A video is any folder with `scenes/order.json` and `queue/`:
  `projects/<project>/<video>/` or `projects/<project>/` for a single video. Keep a project's generator and
  experiment scripts inside the project with paths relative to the script, never absolute.
- `.cache/audio/` is the shared TTS cache, keyed by sentence text. Never delete it casually: re-synthesis is slow.
- Do not commit anything under `projects/`, `dataset/`, `.cache/`, or `.venv/`.

New video: create `projects/<name>/scenes/order.json` (`{"order": []}`), add scene files, then
`bash run.sh --project <name>`. Check a beat visually with `PORT=8765 OUT_DIR=/tmp bash tools/shot.sh <scene_id> <beat>`.

## 3. Answering a viewer's question

The viewer presses Ctrl+Space and speaks. The server writes `<video>/queue/fb_N.json` with the transcript, the scene
and beat on screen, and that scene's sentences. The player waits until `fb_N.done.json` appears. To answer:

```bash
P="--root <project or project/video>"
python3 tools/answer.py start fb_N <new_scene_id> --after <watched_scene_id> $P < first_beats.json  # player jumps here at once
python3 tools/answer.py add <new_scene_id> $P < more_beats.json                                     # stream more beats
python3 tools/answer.py end <new_scene_id> $P
python3 tools/answer.py jump fb_N <existing_scene_id> $P        # an existing scene already answers it
python3 tools/answer.py snapshot fb_N <scene_id> edit|remake $P # after hand-editing or remaking a scene
```

Write the first 1-2 beats fast (first narration within seconds), then append. Beats already written never change.

Style the viewers expect: motivate before deriving (what question this answers, why it matters); derive every step
on screen, never assert; define every symbol; one idea per sentence; 2-D example before d dimensions; give each term
of an expansion its own color and keep it on later lines; "with high probability", not "always"; be explicit about
relative vs absolute quantities.

## 4. Dataset

Every answered question is a training example. `.venv/bin/python tools/export_dataset.py` builds `dataset/raw.jsonl` and
`dataset/sft.jsonl` from all projects. `bash share.sh` uploads new questions to the public Hugging Face dataset
`leokswang/explainer-questions` (a pull request for anyone but the owner). It needs `hf auth login` with a write
token and asks for confirmation; it is public, so run it only when the user asks.
