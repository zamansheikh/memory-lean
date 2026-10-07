#!/usr/bin/env python3
"""Lint and compact the memory graph (memory.jsonl).

  graph-compact.py            dry run: report entities over budget and projected sizes
  graph-compact.py --apply    back up, move overflow observations to archive/<entity>.md

Compaction per non-rule entity: keep undated observations (identity facts) plus the
newest KEEP_DATED dated ones; the rest are appended to archive/<entity>.md, not lost.
Stop any agent session using the memory server before --apply (it rewrites the file).
The graph file is MEMORY_FILE_PATH, or ~/.claude/memory-graph/memory.jsonl.
"""
import json, re, sys, os, shutil, datetime

GRAPH = os.environ.get("MEMORY_FILE_PATH") or os.path.expanduser("~/.claude/memory-graph/memory.jsonl")
ROOT = os.path.dirname(GRAPH)
ARCHIVE = os.path.join(ROOT, "archive")
KEEP_DATED = 10
MAX_OBS = 15
MAX_OBS_CHARS = 250
DATE = re.compile(r"(20\d\d-\d\d-\d\d)")

def load():
    with open(GRAPH) as f:
        return [json.loads(l) for l in f if l.strip()]

def split(obs):
    dated = [(m.group(1), i, o) for i, o in enumerate(obs) if (m := DATE.search(o))]
    undated = [o for o in obs if not DATE.search(o)]
    dated.sort(key=lambda t: (t[0], t[1]))
    keep = {i for _, i, _ in dated[-KEEP_DATED:]}
    kept = [o for i, o in enumerate(obs) if not DATE.search(o) or i in keep]
    moved = [o for _, i, o in dated if i not in keep]
    return kept, moved

def main(apply):
    rows = load()
    ents = [r for r in rows if r.get("type") == "entity"]
    before = sum(len(json.dumps(r)) for r in rows)
    moved_total = {}
    for e in ents:
        obs = e.get("observations", [])
        long_ = sum(len(o) > MAX_OBS_CHARS for o in obs)
        if len(obs) > MAX_OBS or long_:
            print(f"{len(obs):4} obs {long_:3} long  {len(json.dumps(e)):6} B  [{e['entityType']}] {e['name']}")
        if e["entityType"] != "rule" and len(obs) > MAX_OBS:
            kept, moved = split(obs)
            if moved:
                moved_total[e["name"]] = moved
                e["observations"] = kept
    after = sum(len(json.dumps(r)) for r in rows)
    n = sum(map(len, moved_total.values()))
    print(f"\ngraph {before:,} B -> {after:,} B; {n} observations from {len(moved_total)} entities to archive/")
    if not apply:
        print("dry run; pass --apply to write"); return
    stamp = datetime.datetime.now().strftime("%Y-%m-%d-%H%M%S")
    shutil.copy2(GRAPH, f"{GRAPH}.bak-{stamp}")
    os.makedirs(ARCHIVE, exist_ok=True)
    for name, moved in moved_total.items():
        fn = os.path.join(ARCHIVE, re.sub(r"[^\w.-]+", "_", name) + ".md")
        with open(fn, "a") as f:
            f.write(f"\n## archived {stamp} from entity `{name}`\n" + "".join(f"- {o}\n" for o in moved))
    tmp = GRAPH + ".tmp"
    with open(tmp, "w") as f:
        f.write("\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + "\n")
    os.replace(tmp, GRAPH)
    print(f"written; backup at {GRAPH}.bak-{stamp}")

if __name__ == "__main__":
    main("--apply" in sys.argv)
