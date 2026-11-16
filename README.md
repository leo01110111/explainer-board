# Explainer Board

A live-animated, narrated math explainer player. Scenes are JSON; the browser animates them (KaTeX + SVG),
a local TTS voice (Kokoro) narrates each sentence, and the viewer can press **Ctrl+Space** at any moment
to ask a spoken question (transcribed with faster-whisper). An author, usually Claude, answers by writing
a new scene, which appears in the player within seconds.

## Run

```bash
bash run.sh --project gd-averaging              # http://127.0.0.1:8765, opens Chrome
bash run.sh --project distance-concentration/v2 --port 8768 --no-browser
```

Python env: `~/miniconda3/envs/explain-video` (kokoro, faster-whisper, numpy, soundfile; ffmpeg on PATH).
Keys: Space pause/resume, ←/→ previous/next beat, C captions, Ctrl+Space ask a question, Esc cancel.

## Layout

- `server.py`, `run.sh`, `static/`: the player. Scene format and server API: [SPEC.md](SPEC.md).
- `tools/answer.py`: answer a queued question with a (streaming) scene: `answer.py start|add|end|jump|snapshot ... --root VIDEO`.
- `projects/` (gitignored): your explainers. A video is any folder with `scenes/order.json` and `queue/`;
  `--project` takes a path or a name under `projects/`.

## Share your questions

Every question you ask is a training example (question + scene on screen + answer scene). Share them with the
public dataset [leokswang/explainer-questions](https://huggingface.co/datasets/leokswang/explainer-questions):

```bash
hf auth login        # once; free account, token with write access
bash share.sh        # lists your new questions, asks to confirm, opens a pull request
```

Duplicates are skipped, so rerunning is safe. Transcripts and scenes are public; audio is never uploaded.
`tools/export_dataset.py` builds the local export (`dataset/raw.jsonl`, `sft.jsonl`) from all projects.
