"""Export viewer-question -> answer interactions as a BC dataset.

python export_dataset.py [OUT_DIR] [--manim DIR]   (default OUT_DIR: <repo>/dataset)
Videos: every folder under projects/ that has scenes/order.json and queue/. --manim adds the old Manim player queue.
Writes raw.jsonl (one record per answered question, full context), sft.jsonl (chat format, board scenes only),
and stats.json.
"""
import ast
import datetime as dt
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
BOARD = os.path.dirname(HERE)
PROJECTS = os.path.join(BOARD, "projects")
_args = sys.argv[1:]
MANIM = ""
if "--manim" in _args:
    i = _args.index("--manim"); MANIM = os.path.abspath(_args[i + 1]); del _args[i:i + 2]
MANIM = MANIM or os.environ.get("BOARD_MANIM_DIR", "")
OUT = os.path.abspath(_args[0]) if _args else os.path.join(BOARD, "dataset")
VIDEOS = sorted(
    (os.path.relpath(d, PROJECTS), d) for d, subs, files in os.walk(PROJECTS)
    if "queue" in subs and os.path.exists(os.path.join(d, "scenes", "order.json"))) if os.path.isdir(PROJECTS) else []
BASE_RE = re.compile(r"^(s\d\d[a-z]?|v\d\d)_[a-z]")
SKIP = (".done.json", ".ignored.json", ".context.json", ".response.json", ".tmp")


def jl(p):
    return json.load(open(p)) if os.path.exists(p) else None


def ts(s):
    return dt.datetime.fromisoformat(s.replace(" ", "T")).timestamp()


def fb_files(q):
    if not os.path.isdir(q):
        return []
    fs = [f for f in os.listdir(q) if re.fullmatch(r"fb_\d+\.json", f) and consented(os.path.join(q, f))]
    return sorted(fs, key=lambda f: int(f[3:-5]))


def consented(path):
    try:
        return json.load(open(path)).get("consent", True) is not False
    except Exception:
        return True


def board_records():
    recs = []
    ms = jl(os.path.join(MANIM, "script.json")) if MANIM else None
    manim_ids = {s["id"] for s in ms["scenes"]} if ms else set()
    for video, root in VIDEOS:
        q, sd = os.path.join(root, "queue"), os.path.join(root, "scenes")
        order = jl(os.path.join(sd, "order.json"))["order"]
        fbs = []
        for f in fb_files(q):
            fb = jl(os.path.join(q, f))
            done = jl(os.path.join(q, f.replace(".json", ".done.json")))
            fbs.append((fb, done, os.path.join(q, f.replace(".json", ".done.json"))))
        fbs.sort(key=lambda x: ts(x[0]["created"]))
        author = {}
        for fb, done, _ in fbs:
            if done and done.get("scene") and not BASE_RE.match(done["scene"]) and done["scene"] not in manim_ids \
                    and done["scene"] != fb["scene"]:
                author.setdefault(done["scene"], (fb["id"], ts(fb["created"])))
        titles = {}
        for sid in set(order) | set(author):
            s = jl(os.path.join(sd, f"{sid}.json"))
            if s:
                titles[sid] = s.get("title", "")
        for fb, done, done_p in fbs:
            if not done:
                continue
            t0 = ts(fb["created"])
            rid = done.get("scene")
            ctx = jl(os.path.join(q, f"{fb['id']}.context.json"))
            resp = jl(os.path.join(q, f"{fb['id']}.response.json"))
            watched = ctx["watched_scene"] if ctx else jl(os.path.join(sd, f"{fb['scene']}.json"))
            response = resp["scene"] if resp else jl(os.path.join(sd, f"{rid}.json"))
            if rid == fb["scene"]:
                kind = "edit_scene"
            elif done.get("action") == "replace":
                kind = "remake_scene"
            elif author.get(rid, (None,))[0] == fb["id"]:
                kind = "new_scene"
            else:
                kind = "jump_existing"
            avail = ctx["order"] if ctx else [s for s in order if author.get(s, (None, 0))[1] < t0 or s not in author]
            pos = order.index(rid) if rid in order else None
            follow = [o["id"] for o, _, _ in fbs if o["scene"] == rid and ts(o["created"]) > t0]
            fidelity = "snapshot" if (ctx and resp) else ("lossy_edit" if kind == "edit_scene" else "final_file")
            done_t = os.path.getmtime(done_p)
            rp, wp = os.path.join(sd, f"{rid}.json"), os.path.join(sd, f"{fb['scene']}.json")
            flags = {"response_modified_after_answer": bool(not resp and os.path.exists(rp) and os.path.getmtime(rp) > done_t + 120),
                     "watched_modified_after_question": bool(not ctx and os.path.exists(wp) and os.path.getmtime(wp) > t0 + 5)}
            recs.append({
                "id": f"{video}/{fb['id']}", "video": video, "format": "board_json", "created": fb["created"],
                "question": fb["transcript"],
                "watched": {"scene_id": fb["scene"], "beat": fb["beat"], "beat_text": fb.get("beat_text"),
                            "time_in_scene_s": fb.get("time"), "scene": watched},
                "available_scenes": [{"id": s, "title": titles.get(s, "")} for s in avail],
                "response": {"kind": kind, "action": done.get("action"), "scene_id": rid, "note": done.get("note"),
                             "placed_after": order[pos - 1] if pos else None, "scene": None if kind == "jump_existing" else response},
                "latency_s": round(os.path.getmtime(done_p) - t0, 1),
                "followup_questions_on_response": follow,
                "fidelity": fidelity, "flags": flags,
            })
    return recs


def manim_records():
    if not MANIM or not os.path.exists(os.path.join(MANIM, "script.json")):
        return []
    script = {s["id"]: s for s in jl(os.path.join(MANIM, "script.json"))["scenes"]}
    src = open(os.path.join(MANIM, "scenes.py")).read()
    tree = ast.parse(src)
    code = {n.name: ast.get_source_segment(src, n) for n in tree.body if isinstance(n, ast.ClassDef)}
    q = os.path.join(MANIM, "queue")
    recs = []
    for f in fb_files(q):
        fb = jl(os.path.join(q, f))
        done_p = os.path.join(q, f.replace(".json", ".done.json"))
        done = jl(done_p)
        if not done:
            continue
        rid = None
        man = jl(os.path.splitext(done["video"])[0] + ".json")
        if man:
            rid = next((s["id"] for s in man["scenes"] if abs(s["start"] - done["resume"]) < 0.05), None)
        recs.append({
            "id": f"manim/{fb['id']}", "video": "part1_manim", "format": "manim", "created": fb["created"],
            "question": fb["transcript"],
            "watched": {"scene_id": fb["scene"], "beat": fb["beat"], "beat_text": fb.get("beat_text"),
                        "scene": {"beats": script.get(fb["scene"], {}).get("beats"), "code": code.get(fb["scene"])}},
            "response": {"kind": "new_scene", "scene_id": rid, "note": done.get("note"),
                         "scene": {"beats": script.get(rid, {}).get("beats"), "code": code.get(rid)} if rid else None},
            "latency_s": round(os.path.getmtime(done_p) - ts(fb["created"]), 1),
            "fidelity": "final_file",
        })
    return recs


SYSTEM = """You write scenes for a live-animated math explainer player. A viewer paused the video and asked a spoken question.
Decide how to respond, then output JSON: {"kind": "new_scene" | "jump_existing" | "edit_scene" | "remake_scene", "scene_id": ..., "scene": <scene JSON or null for jump_existing>}.
Style: derive every step from first principles on screen, one idea per sentence, define every symbol, start with a 2-D example before generalizing, color each term of an expansion and keep its color, say "with high probability" not "always", be precise about relative vs absolute.
Scene format (SPEC):
"""


def sft(recs):
    spec = open(os.path.join(BOARD, "SPEC.md")).read()
    out = []
    for r in recs:
        if r["format"] != "board_json" or r["fidelity"] == "lossy_edit":
            continue
        user = {"available_scenes": r["available_scenes"], "watched_scene": r["watched"]["scene"],
                "paused_at_beat": r["watched"]["beat"], "beat_text": r["watched"]["beat_text"], "question": r["question"]}
        resp = {"kind": r["response"]["kind"], "scene_id": r["response"]["scene_id"], "scene": r["response"]["scene"]}
        out.append({"id": r["id"], "messages": [{"role": "system", "content": SYSTEM + spec},
                                                {"role": "user", "content": json.dumps(user, ensure_ascii=False)},
                                                {"role": "assistant", "content": json.dumps(resp, ensure_ascii=False)}],
                    "meta": {"followups": r["followup_questions_on_response"], "fidelity": r["fidelity"], "flags": r["flags"], "latency_s": r["latency_s"]}})
    return out


def main():
    os.makedirs(OUT, exist_ok=True)
    recs = sorted(board_records() + manim_records(), key=lambda r: ts(r["created"]))
    s = sft(recs)
    with open(os.path.join(OUT, "raw.jsonl"), "w") as f:
        f.writelines(json.dumps(r, ensure_ascii=False) + "\n" for r in recs)
    with open(os.path.join(OUT, "sft.jsonl"), "w") as f:
        f.writelines(json.dumps(r, ensure_ascii=False) + "\n" for r in s)
    stats = {"records": len(recs), "sft_examples": len(s),
             "by_kind": {}, "by_video": {}, "by_fidelity": {}, "with_followups": sum(1 for r in recs if r.get("followup_questions_on_response")),
             "response_modified_after_answer": sum(1 for r in recs if r.get("flags", {}).get("response_modified_after_answer")),
             "watched_modified_after_question": sum(1 for r in recs if r.get("flags", {}).get("watched_modified_after_question"))}
    for r in recs:
        for k, v in (("by_kind", r["response"]["kind"]), ("by_video", r["video"]), ("by_fidelity", r["fidelity"])):
            stats[k][v] = stats[k].get(v, 0) + 1
    json.dump(stats, open(os.path.join(OUT, "stats.json"), "w"), indent=1)
    print(json.dumps(stats, indent=1))


if __name__ == "__main__":
    main()
