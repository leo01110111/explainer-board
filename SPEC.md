# Board: live-animated explainer player

Goal: an explainer video whose scenes are JSON, animated live in the browser (no video rendering),
narrated per sentence with local TTS, interruptible with Ctrl+Space (voice question), with new scenes
appearing within seconds of being written.

## Files
```
explainer-board/     repo root (the tool)
  server.py          stdlib ThreadingHTTPServer; run with ~/miniconda3/envs/explain-video/bin/python
                     flags: --project NAME|PATH (a video folder with scenes/order.json; names resolve under projects/),
                     or --scenes DIR --queue DIR; --port N (default 8765)
  run.sh             starts server.py if the port is free; passes args through; pid/log: server.pid/server.log
                     for 8765, server_<port>.pid/.log otherwise; --no-browser skips opening Chrome
  share.sh           share questions to the public Hugging Face dataset (tools/share.py)
  static/            player page (index.html, engine.js, style.css)
  tools/             answer.py (writer helper, --root VIDEO), export_dataset.py, share.py, shot.sh, hf_card.md
  projects/          gitignored. projects/<project>/<video>/ or projects/<project>/ when it has one video:
    <video>/scenes/order.json   {"order": ["s01_intro", ...]}
    <video>/scenes/<id>.json    one scene each (schema below)
    <video>/queue/              fb_N.json (feedback), fb_N.done.json (answer ready)
    <project>/gen*, exp*        the project's own generators and experiments (relative paths)
  .cache/audio/      <sha1(voice+speed+text)>.wav  (TTS cache, shared by all projects; gitignored)
  dataset/           export_dataset.py output (gitignored)
```

## Scene schema
```json
{"id": "s05b_joint", "title": "Two coordinates: the joint density",
 "layout": "split",                       // "full" | "split" (left/right halves) | "stack" (top/bottom)
 "beats": [
   {"say": "One sentence of narration.",
    "do": [ <op>, <op>, ... ]}            // ops start at the beat's start, run in sequence
 ]}
```
Beat duration = TTS audio duration of `say` + 0.8 s pause. Ops in a beat run one after another
(default 0.8 s each, `"dur"` overrides); `"at": 0.5` starts an op at that fraction of the beat instead.
Every visible object has an `"id"` (unique within the scene) so later ops can refer to it.
The board persists across beats inside a scene; a new scene starts empty.

### Regions and automatic layout
Logical canvas 1600x900. Regions: `title` (top band), `full`, `left`, `right`, `top`, `bottom`
(left/right exist for layout "split", top/bottom for "stack"). `text`/`math` objects stack
top-to-bottom inside their region (a column); `"region"` defaults to `left` in split, `full` otherwise.
If a column overflows, the engine scales the whole column down to fit (never off-screen, never overlap).
`plot` objects take a fixed slot in their region (`"slot": "top"|"bottom"|"fill"`, default fill)
and text in the same region flows around (stacks above it).

### Ops
| op | fields | effect |
|----|--------|--------|
| `title` | text | set the title band |
| `text` | id, text, region?, color?, size? | plain text line, fades/types in |
| `math` | id, tex, region?, color?, size?, label? | KaTeX display line; `label` = small gray note to its right |
| `replace` | id, tex or text, color? | morph object into new content in place (cross-fade + width tween) |
| `highlight` | id, color? | pulse + temporary outline |
| `box` | id, color? | persistent surrounding box |
| `color` | id, color | recolor |
| `remove` | ids: [..] | fade out; column re-flows |
| `clear` | region? | fade out everything (in region) |
| `plot` | id, region?, slot?, x:[min,max], y:[min,max], xlabel?, ylabel?, xticks?:[..], grid?:bool, equal?:bool, items:[<item>] | axes + items; items draw on in order |
| `add` | id (plot id), items:[<item>] | add items to an existing plot, drawn on |
| `update` | id (plot id), x?, y?, items?: {itemId: {...partial}} | animate axis range changes and item changes (bars tween, curves morph) |
| `table` | id, rows:[[cells]], region?, header?:bool | small table; cells are TeX |
| `show_row` | id, row | reveal a table row |

### Plot items (all in data coordinates; each may have "id", "color", "label")
| type | fields |
|------|--------|
| `curve` | fn: JS expression in `x` using Math.* (e.g. `"Math.exp(-x*x/4)/Math.sqrt(4*Math.PI)"`), range?:[a,b], width? |
| `hist` | gen: <generator>, bins:int, range:[a,b], norm: "density" \| "max1" \| "count", opacity? |
| `points` | gen: <generator> \| pts:[[x,y],..], size? |
| `point` | at:[x,y], label?, size? |
| `line` | from:[x,y], to:[x,y], dashed?, width? |
| `arrow` | from, to |
| `vline` | x, dashed? |
| `circle` | center:[x,y], r |
| `ring` | center, r1, r2, opacity? |
| `rect` | from:[x,y], to:[x,y], opacity? (filled band) |
| `band` | fn_lo, fn_hi (JS exprs in x), range? (shaded area between) |
| `walks` | n: number of random walks, steps, gen:"chi1x2-2" (cumulative sum of 2*chi2_1 - 2), offset?: JS expr in i |
| `note` | at:[x,y], tex (KaTeX label placed in data coords) |

### Generators (sampled in the browser, seeded so every playback is identical)
`{"kind": K, "n": samples, "seed": s, "d": dim}` with K in:
- `dist` : ||x - y|| for x, y ~ N(0, I_d)
- `dist_scaled` : ||x - y|| / sqrt(2d)
- `S` : sum of d squared N(0,2) draws (= 2 chi2_d)
- `S_scaled` : S / (2d)
- `D2` : one N(0,2) draw squared
- `gauss2d` : points (a, b) with a, b ~ N(0, sigma^2), field `"sigma"`
- `rayleigh` : |D| for D ~ N(0, 2 I_2)
For large d*n the engine may use exact chi-square identities (||x-y||^2 = 2 chi2_d) instead of drawing every coordinate.

### Colors
Named palette: `teal` (distances / D), `blue` (x), `yellow` (y, means, results), `orange` (widths), `red` (warnings),
`green` (checks), `gray` (notes), `white`. Dark background #1c1c28.

## Server API
- `GET /` -> static/index.html; `GET /static/*`
- `GET /api/scenes` -> {"order": [...], "scenes": {id: scene}} (re-read from disk each call; cheap)
- `GET /api/scene/<id>` -> just that scene (re-read from disk; 409 while the file is mid-write/invalid)
- `GET /api/tts?text=...` -> wav (Kokoro af_heart, speed 0.88, 24 kHz); cached in audio_cache by sha1; first call ~0.5-1 s
- `POST /api/feedback` (multipart: audio blob + json {scene, beat, time}) -> server converts to 16 kHz wav (ffmpeg),
  transcribes (faster-whisper medium.en, cuda, int8_float16; fall back to small.en cpu), writes queue/fb_N.json
  `{"id","scene","beat","beat_text","scene_beats","transcript","created"}`, returns {"id","transcript"}.
  Transcripts with < 3 words are rejected (no queue file) and returned with "rejected": true.
- `GET /api/feedback/<id>` -> {"status": "pending"} or the content of queue/<id>.done.json:
  `{"status": "done", "action": "insert"|"replace", "scene": id, "note": "..."}` -> player reloads /api/scenes and jumps to that scene.
- Writers add scenes by writing <video>/scenes/<id>.json and rewriting scenes/order.json, then queue/<fb>.done.json.
  The server pre-warms TTS for every beat of a scene as soon as the scene file appears or changes (see Streaming scenes).

## Player behavior
- Plays scenes in order; per beat: fetch TTS for this beat (prefetch next 2), play audio, run ops; wait audio + 0.8 s.
- Bottom bar: scene title, beat k/N, a scrubber by scene, current sentence as caption (toggle C).
- Ctrl+Space (toggle, non-repeating, 0.6 s debounce): 1st press pauses audio+animation and records mic (MediaRecorder);
  2nd press stops, uploads, shows transcript and a waiting timer, and plays the pre-cached line
  "Good question. One moment."; Esc cancels and resumes. Space alone pauses/resumes.
  The answer is polled every 250 ms; when done, jump to the new/rewritten scene immediately (even with 1 beat) and play.
- Left/right arrows: previous/next beat (re-render scene state up to that beat instantly, no animation).
  Seeking must rebuild board state deterministically by replaying ops of beats 0..k-1 with zero duration.
- Libraries from CDN with pinned versions (jsdelivr): KaTeX 0.16.11 (css+js). Everything else hand-written SVG + requestAnimationFrame. No build step.

## Streaming scenes
Goal: first narrated answer sentence ~2 beats of writing after a question, not a whole scene.
- A scene may carry `"complete": false`. The writer writes the scene with its first 1-2 beats (and inserts it into
  order.json), writes queue/fb_N.done.json at once, then rewrites the same scene file with more beats appended
  (earlier beats never change; write to a tmp file and rename), and finally sets `"complete": true` (or drops the field).
- Player: at the end of the available beats of an incomplete scene it does not advance; it polls `GET /api/scene/<id>`
  every 250 ms and continues with the appended beats on the same board (no reset). The bottom bar shows "writing…"
  while waiting and "beat k/N+" for incomplete scenes. Once complete with no beats left: reload /api/scenes, then advance.
- Server: the watcher polls scene mtimes (+size) every 0.2 s; a changed scene's uncached sentences go to the front of the
  TTS queue (newest file first, beat order), ahead of the startup backlog. "Good question. One moment." is warmed at start.
- Measured: scene file written with 1 new beat -> its TTS wav cached in 0.16-0.36 s (short sentence); player waiting on
  the scene starts that beat ~0.25 s after the write.
- Debug: `document.body.dataset.playLog` lists every started beat as `scene:k`; `dataset.errorLog` holds console errors.
