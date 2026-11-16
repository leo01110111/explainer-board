"""Share your explainer-board questions to the public Hugging Face dataset.

    bash share.sh              # review, confirm, upload (opens a PR unless you own the dataset)
    bash share.sh --dry-run    # write the file locally, upload nothing

Needs a Hugging Face login with a write token: `hf auth login`.
Records already on the hub (same question, time and scene) are skipped, so rerunning is safe.
"""
import argparse
import datetime as dt
import hashlib
import json
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import export_dataset as ex  # noqa: E402

REPO = os.environ.get("BOARD_HF_DATASET", "leokswang/explainer-questions")
CARD = os.path.join(HERE, "hf_card.md")


def key(r):
    return hashlib.sha1(json.dumps([r["question"], r["created"], r["watched_scene_id"], r["beat"]]).encode()).hexdigest()[:16]


def js(o):
    return None if o is None else json.dumps(o, ensure_ascii=False)


def flat(r, user):
    w, resp, fl = r["watched"], r.get("response") or {}, r.get("flags") or {}
    out = {
        "contributor": user, "video": r["video"], "format": r["format"], "created": r["created"],
        "question": r["question"],
        "watched_scene_id": w.get("scene_id"), "beat": w.get("beat"), "beat_text": w.get("beat_text"),
        "time_in_scene_s": w.get("time_in_scene_s"), "watched_scene": js(w.get("scene")),
        "available_scenes": js(r.get("available_scenes")),
        "response_kind": resp.get("kind", "unanswered"), "response_scene_id": resp.get("scene_id"),
        "response_note": resp.get("note"), "placed_after": resp.get("placed_after"), "response_scene": js(resp.get("scene")),
        "latency_s": r.get("latency_s"), "followup_questions": r.get("followup_questions_on_response") or [],
        "fidelity": r.get("fidelity"),
        "response_modified_after_answer": fl.get("response_modified_after_answer"),
        "watched_modified_after_question": fl.get("watched_modified_after_question"),
    }
    out["key"] = key(out)
    return out


def unanswered():
    recs = []
    for video, root in ex.VIDEOS:
        q, sd = os.path.join(root, "queue"), os.path.join(root, "scenes")
        for f in ex.fb_files(q):
            if os.path.exists(os.path.join(q, f.replace(".json", ".done.json"))):
                continue
            fb = ex.jl(os.path.join(q, f))
            recs.append({"id": f"{video}/{fb['id']}", "video": video, "format": "board_json", "created": fb["created"],
                         "question": fb["transcript"],
                         "watched": {"scene_id": fb["scene"], "beat": fb["beat"], "beat_text": fb.get("beat_text"),
                                     "time_in_scene_s": fb.get("time"), "scene": ex.jl(os.path.join(sd, f"{fb['scene']}.json"))},
                         "response": None, "fidelity": "final_file"})
    return recs


def hub_keys(api, files):
    from huggingface_hub import hf_hub_download
    keys = set()
    for f in files:
        if f.startswith("data/") and f.endswith(".jsonl"):
            for line in open(hf_hub_download(REPO, f, repo_type="dataset")):
                if line.strip():
                    keys.add(json.loads(line).get("key"))
    return keys


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--yes", action="store_true", help="skip the confirmation prompt")
    ap.add_argument("--pr", action="store_true", help="open a PR even if you own the dataset")
    ap.add_argument("--no-unanswered", action="store_true", help="only share questions that got an answer scene")
    a = ap.parse_args()

    from huggingface_hub import HfApi
    from huggingface_hub.utils import RepositoryNotFoundError
    api = HfApi()
    try:
        user = api.whoami()["name"]
    except Exception:
        sys.exit("Not logged in to Hugging Face. Run:  hf auth login   (paste a token with WRITE access)")
    owner = REPO.split("/")[0] == user

    recs = ex.board_records() + ex.manim_records() + ([] if a.no_unanswered else unanswered())
    rows = [flat(r, user) for r in recs]
    by_local = {r["id"]: row["key"] for r, row in zip(recs, rows)}
    for r, row in zip(recs, rows):
        row["followup_questions"] = [by_local.get(f"{r['video']}/{f}", f) for f in row["followup_questions"]]

    try:
        files = api.list_repo_files(REPO, repo_type="dataset")
        exists = True
    except RepositoryNotFoundError:
        files, exists = [], False
        if not owner:
            sys.exit(f"Dataset {REPO} does not exist yet. Ask its owner to create it first.")
    seen = hub_keys(api, files) if exists else set()
    new = [r for r in rows if r["key"] not in seen]
    new.sort(key=lambda r: r["created"])
    if not new:
        print(f"Nothing new to share: all {len(rows)} local questions are already on {REPO}.")
        return

    print(f"{len(new)} new question(s) to share as '{user}' -> https://huggingface.co/datasets/{REPO}\n")
    for r in new:
        tag = r["response_kind"]
        print(f"  [{r['created'][:16]}] {r['video']}/{r['watched_scene_id']} ({tag}): {r['question'][:110]}")
    print("\nThis is PUBLIC. Shared: question transcripts, the scenes on screen, and the answer scenes (no audio).")

    stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    path_in_repo = f"data/{user}/{stamp}.jsonl"
    tmp = os.path.join(tempfile.mkdtemp(), "upload.jsonl")
    with open(tmp, "w") as f:
        f.writelines(json.dumps(r, ensure_ascii=False) + "\n" for r in new)
    if a.dry_run:
        print(f"\nDry run: wrote {tmp} (would upload to {path_in_repo}).")
        return
    if not a.yes and input("\nUpload? [y/N] ").strip().lower() not in ("y", "yes"):
        print("Cancelled.")
        return

    if not exists:
        api.create_repo(REPO, repo_type="dataset", private=False)
        api.upload_file(path_or_fileobj=CARD, path_in_repo="README.md", repo_id=REPO, repo_type="dataset",
                        commit_message="Add dataset card")
    pr = a.pr or not owner
    info = api.upload_file(path_or_fileobj=tmp, path_in_repo=path_in_repo, repo_id=REPO, repo_type="dataset",
                           commit_message=f"Add {len(new)} question(s) from {user}", create_pr=pr)
    if pr:
        print(f"\nOpened a pull request: {info.pr_url}\nThe dataset owner will merge it. Thanks!")
    else:
        print(f"\nUploaded {len(new)} record(s) to https://huggingface.co/datasets/{REPO}/blob/main/{path_in_repo}")


if __name__ == "__main__":
    main()
