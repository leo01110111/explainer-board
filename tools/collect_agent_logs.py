#!/usr/bin/env python3
"""Copy raw agent session logs (Claude Code, Codex, Cursor) that mention given paths into agent_logs/.

Files are copied byte for byte. A copy is replaced only when the source has grown, so logs that the agent
later deletes (Claude Code cleans up after 30 days by default) survive here.

    python3 tools/collect_agent_logs.py                       # logs mentioning this repo
    python3 tools/collect_agent_logs.py --also ~/musings/scaling
"""
import argparse
import glob
import os
import shutil

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HOME = os.path.expanduser("~")
SOURCES = {
    "claude": (os.path.join(HOME, ".claude", "projects"), ["**/*.jsonl"]),
    "codex": (os.path.join(HOME, ".codex", "sessions"), ["**/*.jsonl"]),
    "cursor": (os.path.join(HOME, ".cursor", "projects"), ["*/agent-transcripts/**/*.jsonl", "*/agent-transcripts/**/*.txt"]),
}


def mentions(path, needles):
    with open(path, "rb") as f:
        data = f.read()
    return any(n in data for n in needles)


def collect(paths, dest=None, quiet=False):
    dest = dest or os.path.join(ROOT, "agent_logs")
    needles = [os.path.realpath(os.path.expanduser(p)).encode() for p in paths]
    copied = 0
    for tool, (base, pats) in SOURCES.items():
        if not os.path.isdir(base):
            continue
        for pat in pats:
            for src in glob.glob(os.path.join(base, pat), recursive=True):
                rel = os.path.relpath(src, base)
                dst = os.path.join(dest, tool, rel)
                size = os.path.getsize(src)
                if os.path.exists(dst) and os.path.getsize(dst) >= size:
                    continue
                if not mentions(src, needles):
                    continue
                os.makedirs(os.path.dirname(dst), exist_ok=True)
                shutil.copy2(src, dst + ".tmp")
                os.replace(dst + ".tmp", dst)
                copied += 1
                if not quiet:
                    print(f"{tool}: {rel} ({size / 1e6:.1f} MB)")
    return copied


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--also", nargs="*", default=[], help="more paths whose agent logs to keep")
    ap.add_argument("--dest")
    a = ap.parse_args()
    n = collect([ROOT, *a.also], a.dest)
    print(f"{n} file(s) copied")
