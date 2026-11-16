"""Writer helper for answering a viewer question with a (streaming) scene.

  answer.py start FB SCENE_ID --after AFTER_ID  < first_beats.json   # {"title","layout","beats":[...]}
  answer.py add SCENE_ID                         < more_beats.json   # {"beats":[...]}
  answer.py end SCENE_ID
  answer.py jump FB SCENE_ID                                         # answer with an existing scene
  answer.py snapshot FB SCENE_ID [ACTION]                            # freeze a hand-edited answer for the dataset

start: validates, writes scenes/SCENE_ID.json (complete: false), inserts it into order.json after AFTER_ID
(or replaces AFTER_ID if --replace), and writes queue/FB.done.json so the player jumps there at once.
"""
import json
import os
import sys

B = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OPS = {"title", "text", "math", "replace", "highlight", "box", "color", "remove", "clear", "plot", "add", "update",
       "table", "show_row"}
ITEMS = {"curve", "hist", "points", "point", "line", "arrow", "vline", "circle", "ring", "rect", "band", "walks", "note"}
GENS = {"dist", "dist_scaled", "S", "S_scaled", "D2", "gauss2d", "rayleigh"}
REFS = {"replace", "highlight", "box", "color", "add", "update", "show_row"}
MAX_COL = 9


def wjson(path, obj):
    with open(path + ".tmp", "w") as f:
        json.dump(obj, f, indent=1)
    os.replace(path + ".tmp", path)


def validate(scene):
    errs, ids, cols = [], set(), {}
    for bi, b in enumerate(scene["beats"]):
        if not b.get("say"):
            errs.append(f"beat {bi}: empty say")
        for op in b.get("do", []):
            o = op.get("op")
            if o not in OPS:
                errs.append(f"beat {bi}: unknown op {o}")
                continue
            if o in REFS and op.get("id") not in ids:
                errs.append(f"beat {bi}: {o} refers to unknown id {op.get('id')}")
            if o == "remove":
                for i in op.get("ids", []):
                    ids.discard(i)
                    for c in cols.values():
                        c.discard(i)
            if o == "clear":
                r = op.get("region")
                for k in list(cols):
                    if r is None or k == r:
                        cols[k] = set()
            if o in ("text", "math", "plot", "table"):
                if op.get("id") in ids and o != "plot":
                    errs.append(f"beat {bi}: duplicate id {op.get('id')}")
                ids.add(op.get("id"))
            if o in ("text", "math"):
                r = op.get("region", "left" if scene.get("layout") == "split" else "full")
                cols.setdefault(r, set()).add(op["id"])
                if len(cols[r]) > MAX_COL:
                    errs.append(f"beat {bi}: region {r} has {len(cols[r])} lines; clear/remove some")
            for it in op.get("items", []) if isinstance(op.get("items"), list) else []:
                if it.get("type") not in ITEMS:
                    errs.append(f"beat {bi}: unknown item {it.get('type')}")
                g = it.get("gen")
                if isinstance(g, dict) and g.get("kind") not in GENS:
                    errs.append(f"beat {bi}: unknown generator {g.get('kind')}")
    return errs


def snap_context(fb):
    q = os.path.join(B, "queue")
    fbj = json.load(open(os.path.join(q, f"{fb}.json")))
    sp = os.path.join(B, "scenes", f"{fbj['scene']}.json")
    ctx = {"fb": fbj, "watched_scene": json.load(open(sp)) if os.path.exists(sp) else None,
           "order": json.load(open(os.path.join(B, "scenes/order.json")))["order"]}
    p = os.path.join(q, f"{fb}.context.json")
    if not os.path.exists(p):
        wjson(p, ctx)


def snap_response(fb, sid, action):
    q = os.path.join(B, "queue")
    sp = os.path.join(B, "scenes", f"{sid}.json")
    wjson(os.path.join(q, f"{fb}.response.json"),
          {"fb": fb, "action": action, "scene_id": sid, "scene": json.load(open(sp)) if os.path.exists(sp) else None})


def fbmap(sid, fb=None):
    p = os.path.join(B, "queue", ".fbmap.json")
    m = json.load(open(p)) if os.path.exists(p) else {}
    if fb:
        m[sid] = fb
        wjson(p, m)
    return m.get(sid)


def main():
    global B
    if "--root" not in sys.argv:
        sys.exit("pass --root VIDEO (a path, or a name under projects/, e.g. gd-averaging)")
    i = sys.argv.index("--root")
    r = sys.argv[i + 1]
    B = r if os.path.isdir(os.path.join(r, "scenes")) else os.path.join(B, "projects", r)
    del sys.argv[i:i + 2]
    cmd = sys.argv[1]
    order_p = os.path.join(B, "scenes/order.json")
    if cmd == "jump":
        fb, sid = sys.argv[2], sys.argv[3]
        snap_context(fb)
        wjson(os.path.join(B, "queue", f"{fb}.done.json"), {"status": "done", "action": "insert", "scene": sid})
        snap_response(fb, sid, "jump")
        print("jump", fb, "->", sid)
        return
    if cmd == "snapshot":
        fb, sid, action = sys.argv[2], sys.argv[3], (sys.argv[4] if len(sys.argv) > 4 else "edit")
        snap_response(fb, sid, action)
        print("snapshot", fb, sid, action)
        return
    sid = sys.argv[3] if cmd == "start" else sys.argv[2]
    p = os.path.join(B, "scenes", f"{sid}.json")
    if cmd == "start":
        fb = sys.argv[2]
        snap_context(fb)
        fbmap(sid, fb)
        after = sys.argv[sys.argv.index("--after") + 1]
        new = json.load(sys.stdin)
        scene = {"id": sid, "title": new.get("title", ""), "layout": new.get("layout", "split"),
                 "complete": False, "beats": new["beats"]}
    else:
        scene = json.load(open(p))
        if cmd == "add":
            scene["beats"] += json.load(sys.stdin)["beats"]
        elif cmd == "end":
            scene["complete"] = True
    errs = validate(scene)
    if errs:
        print("INVALID:\n  " + "\n  ".join(errs))
        sys.exit(1)
    wjson(p, scene)
    if cmd == "start":
        o = json.load(open(order_p))
        if sid not in o["order"]:
            if "--replace" in sys.argv:
                o["order"][o["order"].index(after)] = sid
            else:
                o["order"].insert(o["order"].index(after) + 1, sid)
        wjson(order_p, o)
        wjson(os.path.join(B, "queue", f"{fb}.done.json"),
              {"status": "done", "action": "replace" if "--replace" in sys.argv else "insert", "scene": sid,
               "note": scene["title"]})
    if cmd == "end" and fbmap(sid):
        snap_response(fbmap(sid), sid, "insert")
    print(f"{cmd} {sid}: {len(scene['beats'])} beats, complete={scene.get('complete', True)}")


if __name__ == "__main__":
    main()
