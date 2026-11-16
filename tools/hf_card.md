---
license: cc-by-4.0
language:
- en
pretty_name: Explainer Questions
tags:
- education
- math
- explainer
- question-answering
configs:
- config_name: default
  data_files: "data/**/*.jsonl"
---

# Explainer Questions

Questions that people asked while watching live, narrated math explainers, together with the
scene they were watching and the scene that answered them.

The player (the "board") animates each explainer from JSON scenes and narrates it sentence by sentence.
At any moment a viewer presses **Ctrl+Space**, asks a question out loud, and the question is transcribed (Whisper).
An author (usually Claude) answers by writing a new scene, jumping to an existing scene, editing the scene, or remaking it.
Each row is one question.

## Load

```python
from datasets import load_dataset
ds = load_dataset("leokswang/explainer-questions", split="train")
```

## Fields

| field | meaning |
|---|---|
| `key` | stable id (hash of question, time, scene, beat); used to skip duplicates |
| `contributor` | Hugging Face username of the person who shared it |
| `video` | which explainer (folder name in the board) |
| `format` | `board_json` (JSON scenes) or `manim` (rendered video) |
| `created` | when the question was asked (local time) |
| `question` | transcript of the spoken question |
| `watched_scene_id`, `beat`, `beat_text`, `time_in_scene_s` | where the viewer paused |
| `watched_scene` | the scene on screen, as a JSON string |
| `available_scenes` | the scene list at question time, as a JSON string |
| `response_kind` | `new_scene`, `jump_existing`, `edit_scene`, `remake_scene`, or `unanswered` |
| `response_scene_id`, `response_note`, `placed_after` | the answer |
| `response_scene` | the answer scene, as a JSON string (null for `jump_existing` and `unanswered`) |
| `latency_s` | seconds from question to answer |
| `followup_questions` | `key`s of later questions asked on the answer scene (a weak "did not land" signal) |
| `fidelity` | `snapshot` (frozen at answer time), `final_file` (scene file as it is now), `lossy_edit` |
| `response_modified_after_answer`, `watched_modified_after_question` | staleness flags from file times |

Scene JSON follows the board's scene format (title, layout, beats of `say` + animation ops).

## Contribute your questions

1. Watch any board explainer and ask questions with Ctrl+Space.
2. Log in once: `hf auth login` (a free account; create a token with **write** access).
3. From the repo root run `bash share.sh`. It lists your new questions, asks you to confirm,
   and opens a pull request on this dataset. Duplicates are skipped, so running it again is safe.

Contributions land in `data/<your-username>/`. Everything here is public: question transcripts and scenes
are shared, audio is not. Don't ask questions that contain anything you wouldn't post publicly.
Every record was shared by the person who asked it, who reviewed the list and confirmed the upload. Questions
asked with recording turned off on the board's start screen are never exported.
