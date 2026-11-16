import hashlib
import json
import mimetypes
import os
import argparse
import collections
import re
import subprocess
import sys
import tempfile
import threading
import time
import traceback
from datetime import datetime
from email.parser import BytesParser
from email.policy import default as email_policy
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlparse

import numpy as np
import soundfile as sf

ROOT = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(ROOT, "static")
PROJECTS = os.path.join(ROOT, "projects")
SCENES = QUEUE = None
CACHE = os.path.join(ROOT, ".cache", "audio")
BIN = os.path.dirname(sys.executable)
FFMPEG = os.path.join(BIN, "ffmpeg") if os.path.exists(os.path.join(BIN, "ffmpeg")) else "ffmpeg"
VOICE, SPEED, SR = "af_heart", 0.88, 24000
HOST, PORT = "127.0.0.1", int(os.environ.get("BOARD_PORT", "8765"))
ACK_TEXT = "Good question. One moment."

os.makedirs(CACHE, exist_ok=True)


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


class TTS:
    def __init__(self):
        self.lock = threading.Lock()
        self.pipe = None
        self.device = None

    def _load(self, device):
        from kokoro import KPipeline
        self.pipe = KPipeline(lang_code="a", repo_id="hexgrad/Kokoro-82M", device=device)
        self.device = device
        log("kokoro loaded on", device)

    def load(self):
        with self.lock:
            if self.pipe is not None:
                return
            try:
                import torch
                self._load("cuda" if torch.cuda.is_available() else "cpu")
            except Exception as e:
                log("kokoro cuda load failed, using cpu:", e)
                self._load("cpu")

    def _synth(self, text, voice, speed):
        chunks = [np.asarray(a, np.float32) for _, _, a in self.pipe(text, voice=voice, speed=speed)]
        return np.concatenate(chunks) if chunks else np.zeros(int(0.2 * SR), np.float32)

    @staticmethod
    def cache_path(text, voice=VOICE, speed=SPEED):
        key = hashlib.sha1((voice + str(speed) + text).encode()).hexdigest()
        return os.path.join(CACHE, key + ".wav")

    def path(self, text, voice=VOICE, speed=SPEED):
        p = self.cache_path(text, voice, speed)
        if os.path.exists(p):
            return p
        self.load()
        with self.lock:
            if os.path.exists(p):
                return p
            t0 = time.time()
            clean = text.replace("$", "").strip() or "."
            try:
                audio = self._synth(clean, voice, speed)
            except Exception as e:
                if self.device == "cpu":
                    raise
                log("kokoro cuda synth failed, reloading on cpu:", e)
                self._load("cpu")
                audio = self._synth(clean, voice, speed)
            tmp = p + ".tmp.wav"
            sf.write(tmp, audio, SR, subtype="PCM_16")
            os.replace(tmp, p)
            log(f"tts {time.time() - t0:.2f}s {len(audio) / SR:.1f}s audio: {text[:60]!r}")
        return p


class ASR:
    def __init__(self):
        self.lock = threading.Lock()
        self.model = None

    def load(self):
        with self.lock:
            if self.model is not None:
                return
            from faster_whisper import WhisperModel
            try:
                self.model = WhisperModel("medium.en", device="cuda", compute_type="int8_float16")
                log("whisper medium.en loaded on cuda")
            except Exception as e:
                log("whisper cuda load failed, using small.en cpu:", e)
                self.model = WhisperModel("small.en", device="cpu", compute_type="int8")

    def transcribe(self, wav):
        self.load()
        with self.lock:
            try:
                segs, _ = self.model.transcribe(wav, language="en", beam_size=5)
                return " ".join(s.text.strip() for s in segs).strip()
            except Exception as e:
                log("whisper failed, falling back to small.en cpu:", e)
                from faster_whisper import WhisperModel
                self.model = WhisperModel("small.en", device="cpu", compute_type="int8")
                segs, _ = self.model.transcribe(wav, language="en", beam_size=5)
                return " ".join(s.text.strip() for s in segs).strip()


tts = TTS()
asr = ASR()
fb_lock = threading.Lock()


class Prewarm:
    def __init__(self):
        self.dq = collections.deque()
        self.cv = threading.Condition()

    def push(self, texts, front=False):
        texts = [t for t in dict.fromkeys(texts) if t and not os.path.exists(TTS.cache_path(t))]
        if not texts:
            return
        with self.cv:
            for t in texts:
                if t in self.dq:
                    self.dq.remove(t)
            if front:
                self.dq.extendleft(reversed(texts))
            else:
                self.dq.extend(texts)
            self.cv.notify()

    def pop(self):
        with self.cv:
            while not self.dq:
                self.cv.wait()
            return self.dq.popleft()


prewarm_q = Prewarm()


def load_scenes():
    order = []
    op = os.path.join(SCENES, "order.json")
    if os.path.exists(op):
        try:
            order = json.load(open(op)).get("order", [])
        except Exception as e:
            log("bad order.json:", e)
    scenes = {}
    for f in sorted(os.listdir(SCENES)):
        if not f.endswith(".json") or f == "order.json":
            continue
        try:
            s = json.load(open(os.path.join(SCENES, f)))
            scenes[s.get("id", f[:-5])] = s
        except Exception as e:
            scenes[f[:-5]] = {"id": f[:-5], "title": f"[invalid JSON: {e}]", "beats": [], "error": str(e)}
    return {"order": order, "scenes": scenes}


def load_scene(sid):
    p = os.path.join(SCENES, sid + ".json")
    if os.path.exists(p):
        return json.load(open(p))
    return load_scenes()["scenes"].get(sid)


def prewarm_worker():
    while True:
        text = prewarm_q.pop()
        try:
            tts.path(text)
        except Exception:
            traceback.print_exc()


def scene_watcher():
    stamps = {}
    first = True
    while True:
        try:
            order = []
            op = os.path.join(SCENES, "order.json")
            if os.path.exists(op):
                try:
                    order = json.load(open(op)).get("order", [])
                except Exception:
                    pass
            rank = {sid: i for i, sid in enumerate(order)}
            changed = []
            for f in os.listdir(SCENES):
                if not f.endswith(".json") or f == "order.json":
                    continue
                st = os.stat(os.path.join(SCENES, f))
                stamp = (st.st_mtime_ns, st.st_size)
                if stamps.get(f) != stamp:
                    changed.append((f, stamp))
            if first:
                changed.sort(key=lambda c: (rank.get(c[0][:-5], 10 ** 6), c[0]))
            else:
                changed.sort(key=lambda c: c[1][0])
            for f, stamp in changed:
                try:
                    s = json.load(open(os.path.join(SCENES, f)))
                except Exception:
                    continue
                stamps[f] = stamp
                says = [b["say"] for b in s.get("beats", []) if b.get("say")]
                if not first:
                    log(f"scene changed: {f} ({len(says)} beats, complete={s.get('complete', True)})")
                prewarm_q.push(says, front=not first)
            first = False
        except Exception:
            traceback.print_exc()
        time.sleep(0.2)


def next_fb_id():
    n = 0
    for f in os.listdir(QUEUE):
        m = re.match(r"fb_(\d+)\.", f)
        if m:
            n = max(n, int(m.group(1)))
    return f"fb_{n + 1}"


def parse_multipart(ctype, body):
    msg = BytesParser(policy=email_policy).parsebytes(
        b"Content-Type: " + ctype.encode() + b"\r\nMIME-Version: 1.0\r\n\r\n" + body)
    files, fields = {}, {}
    for part in msg.iter_parts():
        name = part.get_param("name", header="content-disposition")
        data = part.get_payload(decode=True) or b""
        if part.get_filename() is not None or not (part.get_content_type() or "").startswith("text/"):
            files[name] = data
        else:
            fields[name] = data.decode("utf-8", "replace")
    for k, v in list(files.items()):
        if k in ("json", "meta"):
            fields[k] = v.decode("utf-8", "replace")
            del files[k]
    return files, fields


def handle_feedback(audio_bytes, meta):
    with tempfile.TemporaryDirectory() as td:
        src = os.path.join(td, "in.bin")
        wav = os.path.join(td, "in16k.wav")
        open(src, "wb").write(audio_bytes)
        r = subprocess.run([FFMPEG, "-y", "-loglevel", "error", "-i", src, "-ar", "16000", "-ac", "1", wav],
                           capture_output=True)
        if r.returncode != 0:
            return 400, {"error": "ffmpeg failed: " + r.stderr.decode()[-400:]}
        t0 = time.time()
        text = asr.transcribe(wav)
        log(f"asr {time.time() - t0:.2f}s: {text!r}")
    if len(re.findall(r"[A-Za-z0-9']+", text)) < 3:
        return 200, {"id": None, "transcript": text, "rejected": True}
    scene_id = meta.get("scene")
    beat = meta.get("beat")
    scene = load_scenes()["scenes"].get(scene_id, {})
    beats = [b.get("say", "") for b in scene.get("beats", [])]
    beat_text = beats[beat] if isinstance(beat, int) and 0 <= beat < len(beats) else ""
    with fb_lock:
        fid = next_fb_id()
        rec = {"id": fid, "scene": scene_id, "beat": beat, "time": meta.get("time"), "beat_text": beat_text,
               "scene_beats": beats, "transcript": text, "created": datetime.now().isoformat(timespec="seconds")}
        tmp = os.path.join(QUEUE, fid + ".json.tmp")
        json.dump(rec, open(tmp, "w"), indent=1)
        os.replace(tmp, os.path.join(QUEUE, fid + ".json"))
    log("feedback queued", fid)
    return 200, {"id": fid, "transcript": text}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        if "/api/feedback/" in self.path and " 200 " in (fmt % args):
            return
        log(self.address_string(), fmt % args)

    def send(self, code, body, ctype="application/json", extra=None):
        if isinstance(body, (dict, list)):
            body = json.dumps(body).encode()
        elif isinstance(body, str):
            body = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def serve_file(self, path, ctype=None):
        ctype = ctype or mimetypes.guess_type(path)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript",):
            ctype += "; charset=utf-8"
        self.send(200, open(path, "rb").read(), ctype)

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        try:
            u = urlparse(self.path)
            p = u.path
            if p in ("/", "/index.html"):
                return self.serve_file(os.path.join(STATIC, "index.html"))
            if p.startswith("/static/"):
                f = os.path.realpath(os.path.join(STATIC, unquote(p[len("/static/"):])))
                if not f.startswith(STATIC + os.sep) or not os.path.isfile(f):
                    return self.send(404, {"error": "not found"})
                return self.serve_file(f)
            if p == "/api/scenes":
                return self.send(200, load_scenes())
            m = re.fullmatch(r"/api/scene/([A-Za-z0-9_\-]+)", p)
            if m:
                try:
                    sc = load_scene(m.group(1))
                except Exception as e:
                    return self.send(409, {"error": f"invalid JSON: {e}"})
                if sc is None:
                    return self.send(404, {"error": "no scene"})
                return self.send(200, sc)
            if p == "/api/tts":
                q = parse_qs(u.query)
                text = q.get("text", [""])[0]
                voice = q.get("voice", [VOICE])[0]
                speed = float(q.get("speed", [SPEED])[0])
                return self.serve_file(tts.path(text, voice, speed), "audio/wav")
            m = re.fullmatch(r"/api/feedback/([A-Za-z0-9_\-]+)", p)
            if m:
                fid = m.group(1)
                done = os.path.join(QUEUE, fid + ".done.json")
                if os.path.exists(done):
                    try:
                        d = json.load(open(done))
                    except Exception:
                        return self.send(200, {"status": "pending"})
                    d.setdefault("status", "done")
                    return self.send(200, d)
                if os.path.exists(os.path.join(QUEUE, fid + ".json")):
                    return self.send(200, {"status": "pending"})
                return self.send(404, {"status": "unknown", "error": f"no feedback {fid}"})
            if p == "/favicon.ico":
                return self.send(204, b"", "image/x-icon")
            self.send(404, {"error": "not found"})
        except BrokenPipeError:
            pass
        except Exception as e:
            traceback.print_exc()
            self.send(500, {"error": str(e)})

    def do_POST(self):
        try:
            u = urlparse(self.path)
            if u.path != "/api/feedback":
                return self.send(404, {"error": "not found"})
            n = int(self.headers.get("Content-Length", "0"))
            body = self.rfile.read(n)
            ctype = self.headers.get("Content-Type", "")
            meta = {}
            if ctype.startswith("multipart/"):
                files, fields = parse_multipart(ctype, body)
                for k in ("json", "meta"):
                    if k in fields:
                        meta.update(json.loads(fields[k]))
                for k in ("scene", "beat", "time"):
                    if k in fields:
                        meta[k] = fields[k]
                audio = files.get("audio") or next(iter(files.values()), b"")
            else:
                audio = body
                q = parse_qs(u.query)
                meta = {k: v[0] for k, v in q.items()}
            if isinstance(meta.get("beat"), str) and meta["beat"].lstrip("-").isdigit():
                meta["beat"] = int(meta["beat"])
            if not audio:
                return self.send(400, {"error": "no audio"})
            code, res = handle_feedback(audio, meta)
            self.send(code, res)
        except Exception as e:
            traceback.print_exc()
            self.send(500, {"error": str(e)})


def main():
    global SCENES, QUEUE, PORT
    ap = argparse.ArgumentParser()
    ap.add_argument("--project", help="video folder: a path, or a name under projects/ (e.g. gd-averaging, distance-concentration/v2)")
    ap.add_argument("--scenes")
    ap.add_argument("--queue")
    ap.add_argument("--port", type=int, default=PORT)
    a = ap.parse_args()
    if a.project:
        v = a.project if os.path.isdir(a.project) else os.path.join(PROJECTS, a.project)
        if not os.path.isfile(os.path.join(v, "scenes", "order.json")):
            sys.exit(f"no video at {v} (expected scenes/order.json)")
        a.scenes, a.queue = a.scenes or os.path.join(v, "scenes"), a.queue or os.path.join(v, "queue")
    if not a.scenes:
        sys.exit("pass --project NAME (a folder under projects/ with scenes/order.json) or --scenes DIR --queue DIR")
    a.queue = a.queue or os.path.join(os.path.dirname(os.path.abspath(a.scenes)), "queue")
    SCENES, QUEUE, PORT = os.path.abspath(a.scenes), os.path.abspath(a.queue), a.port
    for d in (QUEUE, SCENES):
        os.makedirs(d, exist_ok=True)
    prewarm_q.push([ACK_TEXT], front=True)
    threading.Thread(target=tts.load, daemon=True).start()
    threading.Thread(target=asr.load, daemon=True).start()
    threading.Thread(target=prewarm_worker, daemon=True).start()
    threading.Thread(target=scene_watcher, daemon=True).start()
    srv = ThreadingHTTPServer((HOST, PORT), Handler)
    srv.daemon_threads = True
    log(f"board server on http://{HOST}:{PORT} scenes={SCENES} queue={QUEUE}")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
