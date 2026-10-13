"""Writes ../../spawn_guide.md from out/spawns.csv (made by spawn_tiles.py).
Per map: games, spawns, coast share, top hotspot cells (grid of 1/20 of the longer map side), and the winners' spawn
tiles from the full-turn replays (x, y, coast). Full list of every spawn: out/spawns.csv.
Run: python -I tools/replay_tools/spawn_guide.py"""
import csv, os, collections, json, zlib, re

HERE = os.path.dirname(os.path.abspath(__file__))
TOOLS = os.path.dirname(HERE)
ROOT = os.path.dirname(TOOLS)
rows = list(csv.DictReader(open(os.path.join(HERE, "out", "spawns.csv"), encoding="utf-8")))
key = lambda n: re.sub(r"[^a-z0-9]", "", (n or "").lower())


def dims(mapname, size):
    v = "map4x" if size == "Compact" else "map"
    m = json.load(open(os.path.join(TOOLS, "maps", "%s_manifest.json" % key(mapname)), encoding="utf-8"))[v]
    return m["width"], m["height"]


by_map = collections.defaultdict(list)
for r in rows:
    by_map[(r["map"], r["size"])].append(r)

L = []
P = L.append
P("# Spawn guide: 30+ player FFA, default settings\n")
P("Built 2026-10-11 by tools/replay_tools/spawn_tiles.py + spawn_guide.py. Sources: 609 games (61 full in tools/replays, 85 world, 463 slim).")
P("Coordinates are map tiles, (0,0) top-left, 'coast yes' = ocean tile within 3 tiles. Full list: tools/replay_tools/out/spawns.csv (83,661 final spawn picks).")
P("Final pick only: players re-pick 3-7 times in the spawn phase; the last pick is what counts.\n")
P("## Summary by map (Normal unless marked Compact)\n")
P("| map | size | games | spawns | coast yes % | winners coast yes % | W - rest coast (pts) |")
P("|---|---|---|---|---|---|---|")
summary = sorted(by_map.items(), key=lambda kv: -len({r["gid"] for r in kv[1]}))
for (m, s), rs in summary:
    g = len({r["gid"] for r in rs})
    cy = 100.0 * sum(r["coast"] == "yes" for r in rs) / len(rs)
    wr = [r for r in rs if r["winner"] == "1"]
    wy = 100.0 * sum(r["coast"] == "yes" for r in wr) / len(wr) if wr else float("nan")
    rest = [r for r in rs if r["winner"] != "1"]
    ry = 100.0 * sum(r["coast"] == "yes" for r in rest) / len(rest) if rest else float("nan")
    P("| %s | %s | %d | %d | %.1f | %.1f | %+.1f |" % (m, s, g, len(rs), cy, wy, wy - ry))

P("\n## Hotspots (top 5 cells per map with >= 3 games, grid = 1/20 of the longer side)\n")
for (m, s), rs in summary[:12]:
    W, H = dims(m, s)
    cell = max(W, H) / 20.0
    cnt = collections.Counter()
    cnt_c = collections.Counter()
    for r in rs:
        cx, cy_ = int(int(r["x"]) // cell), int(int(r["y"]) // cell)
        cnt[(cx, cy_)] += 1
        if r["coast"] == "yes":
            cnt_c[(cx, cy_)] += 1
    P("**%s (%s)**, map %dx%d, cell %d tiles:" % (m, s, W, H, cell))
    for (cx, cy_), n in cnt.most_common(5):
        P("- cell x %d-%d, y %d-%d: %d spawns, %d coast (centre %d,%d)" % (cx * cell, (cx + 1) * cell, cy_ * cell, (cy_ + 1) * cell, n, cnt_c[(cx, cy_)], (cx + 0.5) * cell, (cy_ + 0.5) * cell))
    P("")

P("## Winners' final spawn tiles (full-turn games only: tools/replays + tools/replays_world)\n")
P("gameID | map | size | x | y | coast")
P("---|---|---|---|---|---")
for r in rows:
    if r["winner"] == "1" and r["src"] in ("full", "world"):
        P("%s | %s | %s | %s | %s | %s" % (r["gid"], r["map"], r["size"], r["x"], r["y"], r["coast"]))
P("\nSlim-file winners (463 games) are in out/spawns.csv with winner=1.")

open(os.path.join(ROOT, "spawn_guide.md"), "w", encoding="utf-8").write("\n".join(L) + "\n")
print("wrote spawn_guide.md lines", len(L))
